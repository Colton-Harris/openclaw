/**
 * Request/response transport for the Codex Micro vendor channel.
 *
 * Sits on top of `hid-darwin.ts` (bytes) and `framing.ts` (wire format) and adds:
 *  - id correlation over the firmware's [0, 999) ring
 *  - timeouts (a silently-dropped malformed write must not hang a caller)
 *  - notification dispatch (`v.oai.hid`, `v.oai.rad`)
 *  - `device.status` / `sys.version` health checks
 *  - reconnect
 *  - a hard method allowlist (see SAFETY)
 *
 * Named `rpc-transport` rather than `transport` so it is never confused with
 * `src/transport.ts`, which owns the plugin's `DeviceTransport` seam.
 */
import { Correlator, RpcError, RpcTimeoutError } from "./correlator.js";
import { Channel, encodeRequest, parseRpcMessage, Reassembler, REPORT_ID } from "./framing.js";
import {
  findDevice,
  HidDevice,
  ioReturnHex,
  kCFRunLoopRunHandledSource,
  kIOReturnSuccess,
  pump,
  shutdownManager,
  type HidDeviceInfo,
} from "./hid-darwin.js";

export const CODEX_MICRO_VENDOR_ID = 0x30_3a;
export const CODEX_MICRO_PRODUCT_ID = 0x83_60;

// ---------------------------------------------------------------------------
// SAFETY
// ---------------------------------------------------------------------------

/**
 * The vendor channel also carries `sys.bootloader`, `fs.write`, `fs.read`,
 * `sys.selftest` and the `wl_device_programmer` methods. Emitting those can
 * enter DFU or overwrite firmware/device filesystem.
 *
 * This allowlist is enforced in `request()` and `notify()` so that the
 * destructive surface is unreachable through this module BY CONSTRUCTION, not
 * by convention: it is checked before anything is encoded, let alone written.
 * Widening it is a deliberate, reviewable edit - not something a caller can do
 * by passing a different string.
 */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "sys.version",
  "device.status",
  "v.oai.rgbcfg",
  "v.oai.thstatus",
]);

/**
 * Is a Codex Micro attached right now?
 *
 * Enumeration only - it neither opens nor writes to the device, so it is safe
 * to call on every reconnect attempt. Returns the matched collection so callers
 * can log which one they found.
 */
export function findCodexMicro(opts: { serialNumber?: string } = {}): HidDeviceInfo | null {
  return findDevice({
    vendorId: CODEX_MICRO_VENDOR_ID,
    productId: CODEX_MICRO_PRODUCT_ID,
    ...(opts.serialNumber === undefined ? {} : { serialNumber: opts.serialNumber }),
    usagePage: 0xff_00,
    usage: 0x01,
  });
}

export class ForbiddenMethodError extends Error {
  constructor(method: string) {
    super(
      `refusing to send "${method}": not in the safety allowlist ` +
        `[${[...ALLOWED_METHODS].join(", ")}]. The vendor channel also carries ` +
        `firmware-destructive methods; widening this list requires a deliberate code change.`,
    );
    this.name = "ForbiddenMethodError";
  }
}

export { RpcError, RpcTimeoutError };

/** `v.oai.hid` - a custom key event. */
export type KeyEvent = {
  /** key index */
  k: number;
  /** action code: 1 press, 0 release */
  act: number;
  /** agent slot */
  ag: number;
};

/** `v.oai.rad` - joystick / dial position. */
export type RadialEvent = {
  /** angle */
  a: number;
  /** distance from centre */
  d: number;
};

export type TransportEvents = {
  key?: (event: KeyEvent) => void;
  radial?: (event: RadialEvent) => void;
  /** Any notification, including ones we do not model. */
  notification?: (method: string, params: unknown) => void;
  /** Device debug/log channel (channel 1) lines. */
  log?: (line: string) => void;
};

export type CodexMicroTransportOptions = {
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
  /** Default per-request timeout. */
  timeoutMs?: number;
  /** CFRunLoop pump interval. Lower = lower latency, more wakeups. */
  pumpIntervalMs?: number;
  /** Seconds handed to `CFRunLoopRunInMode` per pump slice. */
  pumpSliceSeconds?: number;
  events?: TransportEvents;
  /** Protocol tracing sink. Omitted means silent. */
  debug?: (message: string) => void;
  /**
   * Default-ON sink for input this driver received but could not turn into an
   * event. Separate from `debug` on purpose: a dropped line is a defect, not a
   * trace, and it must be visible without anyone enabling anything.
   */
  warn?: (message: string) => void;
};

/** Parsed `device.status` reply. Verified live on firmware v0.4.1. */
export type DeviceStatusReply = {
  version?: string;
  profileIndex?: number;
  layerIndex?: number;
  battery?: number;
  isCharging?: boolean;
};

export class CodexMicroTransport {
  readonly #opts: Required<
    Omit<CodexMicroTransportOptions, "serialNumber" | "events" | "debug" | "warn">
  > &
    Pick<CodexMicroTransportOptions, "serialNumber" | "events" | "debug" | "warn">;

  #device: HidDevice | null = null;
  #reassembler = new Reassembler();
  #correlator = new Correlator({ startId: 1 });
  #pumpTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CodexMicroTransportOptions = {}) {
    this.#opts = {
      vendorId: opts.vendorId ?? CODEX_MICRO_VENDOR_ID,
      productId: opts.productId ?? CODEX_MICRO_PRODUCT_ID,
      serialNumber: opts.serialNumber,
      timeoutMs: opts.timeoutMs ?? 2000,
      pumpIntervalMs: opts.pumpIntervalMs ?? 4,
      pumpSliceSeconds: opts.pumpSliceSeconds ?? 0.002,
      events: opts.events,
      debug: opts.debug,
      warn: opts.warn,
    };
  }

  get isOpen(): boolean {
    return this.#device?.isOpen === true;
  }

  /** Reports IOKit delivered to us. 0 while writes succeed => TCC is withholding input. */
  get inputReportCount(): number {
    return this.#device?.inputReportCount ?? 0;
  }

  get setReportCount(): number {
    return this.#device?.setReportCount ?? 0;
  }

  get deviceInfo(): HidDeviceInfo | null {
    return this.#device?.info ?? null;
  }

  #log(message: string): void {
    this.#opts.debug?.(message);
  }

  /**
   * Report input this driver threw away.
   *
   * Also mirrors to `debug` so a protocol trace stays complete in one stream.
   */
  #warnDropped(message: string): void {
    this.#opts.warn?.(message);
    this.#opts.debug?.(message);
  }

  open(): void {
    if (this.isOpen) {
      return;
    }

    // The device presents a single IOHIDDevice whose primary usage is the
    // keyboard collection (0x01/0x06); the vendor channel is addressed by
    // report ID 6 on that same device. The `0xFF00` preference below is
    // expressed in case a future firmware splits the collections, and
    // `findDevice` falls back to the 64-byte-output collection, which is what
    // actually matches today.
    const info = findDevice({
      vendorId: this.#opts.vendorId,
      productId: this.#opts.productId,
      ...(this.#opts.serialNumber === undefined ? {} : { serialNumber: this.#opts.serialNumber }),
      usagePage: 0xff_00,
      usage: 0x01,
    });

    if (!info) {
      throw new Error(
        `Codex Micro not found (VID 0x${this.#opts.vendorId.toString(16)}, ` +
          `PID 0x${this.#opts.productId.toString(16)}). Is it plugged in?`,
      );
    }

    const device = new HidDevice(info);
    device.open(); // non-exclusive; never seize
    device.startReading((reportId, data) => {
      this.ingestInputReport(reportId, data);
    });
    this.#device = device;
    this.#reassembler.reset();
    this.#startPump();
    this.#log(`opened ${info.product ?? "unknown"} ${info.serialNumber ?? "no-serial"}`);
  }

  close(): void {
    this.#stopPump();
    this.#correlator.rejectAll("transport closed");
    this.#device?.close();
    this.#device = null;
    this.#reassembler.reset();
  }

  /** Full teardown including the shared IOHIDManager. */
  dispose(): void {
    this.close();
    shutdownManager();
  }

  /** Close and re-open. Used after a write failure or a failed health check. */
  reconnect(): void {
    this.#log("reconnecting");
    this.close();
    this.open();
  }

  #startPump(): void {
    if (this.#pumpTimer) {
      return;
    }
    this.#pumpTimer = setInterval(() => {
      // Drain everything currently queued rather than one source per tick,
      // otherwise a multi-packet reply trickles in one packet per interval.
      for (let i = 0; i < 32; i++) {
        if (pump(this.#opts.pumpSliceSeconds) !== kCFRunLoopRunHandledSource) {
          break;
        }
      }
    }, this.#opts.pumpIntervalMs);
    // DELIBERATELY NOT `unref`'d. This timer is the only thing dispatching
    // IOKit sources, so an unref'd pump lets a process with no other handles
    // exit between a request and its reply - the round-trip then never
    // completes and the device looks dead. It is live I/O, and it holds the
    // loop open for exactly as long as the device is open: `close()` always
    // clears it, and `device-link.stop()` always calls `close()`.
  }

  #stopPump(): void {
    if (this.#pumpTimer) {
      clearInterval(this.#pumpTimer);
      this.#pumpTimer = null;
    }
  }

  /**
   * The driver's inbound entry point: one raw HID input report from the device.
   *
   * Public because it is the ONLY door input comes through, which makes the
   * whole receive path - reassembly, parse, dispatch, and the drop warning -
   * provable without hardware attached. Normally called by the read callback
   * installed in `open()`.
   */
  ingestInputReport(reportId: number, data: Uint8Array): void {
    // Other collections (keyboard/consumer/mouse/gamepad) share this device.
    if (reportId !== REPORT_ID) {
      return;
    }

    let messages;
    try {
      messages = this.#reassembler.push(data);
    } catch (error) {
      this.#warnDropped(`macropad: reassembly error, input buffer dropped: ${String(error)}`);
      return;
    }

    for (const { channel, text } of messages) {
      if (channel === Channel.Debug) {
        this.#opts.events?.log?.(text);
        continue;
      }
      this.#dispatch(text);
    }
  }

  #dispatch(text: string): void {
    const message = parseRpcMessage(text);
    if (!message) {
      // Loud by default. This exact branch swallowed every notification the
      // device sent while the parser only accepted the long `method` spelling,
      // and because it was debug-gated the input path looked like dead hardware.
      this.#warnDropped(`macropad: dropped unparsable device line: ${text}`);
      return;
    }

    if (message.kind === "response") {
      // Trace the PARSED reply, not the raw line. On this device a reply is the
      // only evidence a write was not silently dropped, so it is the one thing
      // worth quoting when someone is proving the driver works.
      this.#log(`<- id ${message.id} ${JSON.stringify(message.error ?? message.result)}`);
      // A false return means a late reply after a timeout, or a reply belonging
      // to another process sharing this device. Dropping it is correct.
      if (!this.#correlator.settle(message.id, message.result, message.error)) {
        this.#log(`unmatched response id ${message.id}`);
      }
      return;
    }

    this.#opts.events?.notification?.(message.method, message.params);
    if (message.method === "v.oai.hid") {
      this.#opts.events?.key?.(message.params as KeyEvent);
    } else if (message.method === "v.oai.rad") {
      this.#opts.events?.radial?.(message.params as RadialEvent);
    }
  }

  /**
   * Send a request and await the correlated reply.
   *
   * Rejects with `RpcTimeoutError` if the device does not answer - which is the
   * only reliable signal that a frame was malformed, because `SetReport`
   * returns success for frames the firmware then silently discards.
   */
  async request(
    method: string,
    params?: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) {
      throw new ForbiddenMethodError(method);
    }
    if (!this.#device || !this.isOpen) {
      throw new Error("transport is not open");
    }

    const id = this.#correlator.allocateId();
    const timeoutMs = opts.timeoutMs ?? this.#opts.timeoutMs;
    const packets = encodeRequest({ method, params, id });

    const promise = this.#correlator.register(id, method, timeoutMs);

    this.#log(`-> ${method} id ${id} ${packets.length} packet(s)`);
    for (const packet of packets) {
      const result = this.#device.setOutputReport(packet);
      if (result !== kIOReturnSuccess) {
        this.#correlator.cancel(id);
        // The promise is now unsettled and unreferenced; swallow its rejection
        // path by throwing synchronously to the caller instead.
        promise.catch(() => undefined);
        throw new Error(`IOHIDDeviceSetReport failed for "${method}": ${ioReturnHex(result)}`);
      }
    }

    return await promise;
  }

  /**
   * Fire-and-forget. Only for cases where a reply is genuinely not expected;
   * prefer `request()` because a reply is the only proof of delivery.
   */
  notify(method: string, params?: unknown): void {
    if (!ALLOWED_METHODS.has(method)) {
      throw new ForbiddenMethodError(method);
    }
    if (!this.#device || !this.isOpen) {
      throw new Error("transport is not open");
    }
    const id = this.#correlator.allocateId();
    for (const packet of encodeRequest({ method, params, id })) {
      this.#device.setOutputReport(packet);
    }
  }

  /** Round-trip proof of life. Returns the parsed reply, throws on timeout. */
  async version(timeoutMs?: number): Promise<unknown> {
    return await this.request(
      "sys.version",
      undefined,
      timeoutMs === undefined ? {} : { timeoutMs },
    );
  }

  /**
   * `device.status` round-trip.
   *
   * One call carries firmware version AND battery, which is why `connect()`
   * uses it rather than `sys.version` for its proof of life.
   */
  async status(timeoutMs?: number): Promise<DeviceStatusReply> {
    const reply = await this.request(
      "device.status",
      undefined,
      timeoutMs === undefined ? {} : { timeoutMs },
    );
    return parseDeviceStatus(reply);
  }

  /**
   * True if the device answers. Tries `device.status`, falls back to
   * `sys.version` (firmware v0.4.1 answers both).
   */
  async healthy(timeoutMs = 1500): Promise<boolean> {
    try {
      await this.status(timeoutMs);
      return true;
    } catch {
      try {
        await this.version(timeoutMs);
        return true;
      } catch {
        return false;
      }
    }
  }

  /** Health check, reconnecting once if it fails. */
  async ensureHealthy(timeoutMs = 1500): Promise<boolean> {
    if (await this.healthy(timeoutMs)) {
      return true;
    }
    try {
      this.reconnect();
    } catch (error) {
      this.#log(`reconnect failed: ${String(error)}`);
      return false;
    }
    return await this.healthy(timeoutMs);
  }
}

/**
 * Normalise a `device.status` reply.
 *
 * Every field is optional on purpose: the reply is `unknown` off the wire, and
 * a firmware that renames `is_charging` must degrade to "battery unknown"
 * rather than reporting a device down.
 */
export function parseDeviceStatus(reply: unknown): DeviceStatusReply {
  if (typeof reply !== "object" || reply === null) {
    return {};
  }
  const record = reply as Record<string, unknown>;
  return {
    ...(typeof record.version === "string" ? { version: record.version } : {}),
    ...(typeof record.profile_index === "number" ? { profileIndex: record.profile_index } : {}),
    ...(typeof record.layer_index === "number" ? { layerIndex: record.layer_index } : {}),
    ...(typeof record.battery === "number" ? { battery: record.battery } : {}),
    ...(typeof record.is_charging === "boolean" ? { isCharging: record.is_charging } : {}),
  };
}
