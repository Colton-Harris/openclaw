/**
 * The Codex Micro driver, adapted to the plugin's `DeviceTransport` seam.
 *
 * Everything below this file is USB: `hid-darwin.ts` (koffi -> IOKit),
 * `framing.ts` (64-byte packets), `correlator.ts` (id ring), `rpc-transport.ts`
 * (requests, allowlist), `lighting.ts` (frame serialisation). Everything above
 * it - `device-link.ts`, `service.ts`, the Control UI - is device-free and was
 * already tested against `FakeTransport`.
 *
 * Three properties of this device shape the adapter and are easy to regress:
 *
 * 1. **A successful write proves nothing.** `IOHIDDeviceSetReport` returns
 *    success for frames the firmware then silently drops. So `connect()`
 *    resolves only after a `device.status` ROUND-TRIP, and `setFrame` awaits
 *    the firmware's `{"ok":1}` rather than the OS's return code.
 * 2. **`v.oai.thstatus` is a full-frame repaint.** Omitted key ids go dark.
 *    `setFrame` therefore takes only `MacropadFullFrame`, the branded six-tuple
 *    that `composeFrame` alone can mint, and there is no partial-update path.
 * 3. **Lighting is volatile** (~30s firmware resync, plus the ChatGPT app
 *    reasserting). `device-link.ts` owns the repaint loop; this file adds no
 *    second timer.
 */
import { MACROPAD_EFFECTS, MACROPAD_SLOT_COUNT } from "../../../contract.js";
import type { MacropadFullFrame } from "../../frame-compositor.js";
import type { DeviceIdentity, DeviceInputEvent, DeviceTransport } from "../../transport.js";
import { isDarwinHidAvailable } from "./hid-darwin.js";
import { fullFrameToParams, frameToParams, uniformFrame } from "./lighting.js";
import {
  CODEX_MICRO_PRODUCT_ID,
  CODEX_MICRO_VENDOR_ID,
  CodexMicroTransport,
  findCodexMicro,
  type KeyEvent,
  type RadialEvent,
} from "./rpc-transport.js";

/** How long a `device.status` proof-of-life may take before we call the device absent. */
const CONNECT_TIMEOUT_MS = 3000;

/** `identify()` flashes this, then `device-link.ts` repaints the real frame over it. */
const IDENTIFY_FRAME = uniformFrame({
  color: 0xff_ff_ff,
  brightness: 1,
  effect: MACROPAD_EFFECTS.solid,
});

/**
 * The firmware's own key ids, as the contract's `DeviceKeyEvent.key` wants them.
 *
 * `v.oai.hid` reports a bare index; the plugin's binder and the Control UI
 * speak `AG00`-style ids, so the mapping happens here rather than leaking a raw
 * integer through the seam.
 */
function agentKeyId(index: number): string {
  return `AG${String(index).padStart(2, "0")}`;
}

class CodexMicroDeviceTransport implements DeviceTransport {
  readonly #rpc: CodexMicroTransport;
  readonly #listeners = new Set<(event: DeviceInputEvent) => void>();
  #open = false;

  constructor(options: {
    serialNumber?: string;
    debug?: (message: string) => void;
    warn?: (message: string) => void;
  }) {
    this.#rpc = new CodexMicroTransport({
      ...(options.serialNumber === undefined ? {} : { serialNumber: options.serialNumber }),
      ...(options.debug === undefined ? {} : { debug: options.debug }),
      ...(options.warn === undefined ? {} : { warn: options.warn }),
      events: {
        key: (event: KeyEvent) => {
          if (typeof event?.k !== "number" || typeof event?.act !== "number") {
            return;
          }
          this.#emit({ type: "key", key: agentKeyId(event.k), action: event.act });
        },
        radial: (event: RadialEvent) => {
          if (typeof event?.a !== "number" || typeof event?.d !== "number") {
            return;
          }
          this.#emit({ type: "radial", angle: event.a, distance: event.d });
        },
      },
    });
  }

  get connected(): boolean {
    return this.#open && this.#rpc.isOpen;
  }

  /**
   * Open the device and prove it with a round-trip.
   *
   * `device.status` rather than `sys.version` because one call carries firmware
   * AND battery, so the identity is complete without a second exchange.
   */
  async connect(): Promise<DeviceIdentity> {
    this.#rpc.open();
    let status;
    try {
      status = await this.#rpc.status(CONNECT_TIMEOUT_MS);
    } catch (error) {
      // A half-open device is worse than a closed one: the pump timer would
      // keep running against a port nobody is listening to.
      this.#rpc.close();
      throw error;
    }
    this.#open = true;

    const info = this.#rpc.deviceInfo;
    return {
      slotCount: MACROPAD_SLOT_COUNT,
      // A reply only reached us because input reports are flowing - RPC replies
      // ride the same IOKit input path as key presses. So a successful connect
      // is itself proof that macOS is not withholding input, and this flag can
      // only ever be true if that invariant breaks.
      inputPermissionRequired: this.#rpc.inputReportCount === 0,
      ...(info?.serialNumber == null ? {} : { serial: info.serialNumber }),
      ...(status.version === undefined ? {} : { firmware: status.version }),
      ...(info?.product == null ? {} : { product: info.product }),
      ...(status.battery === undefined
        ? {}
        : { batteryPercent: Math.max(0, Math.min(100, Math.round(status.battery))) }),
      ...(status.isCharging === undefined ? {} : { charging: status.isCharging }),
    };
  }

  /**
   * Repaint all six keys.
   *
   * Resolves on the firmware's acknowledgement, not on the write, because this
   * device accepts and silently discards malformed frames.
   */
  async setFrame(frame: MacropadFullFrame): Promise<void> {
    await this.#rpc.request("v.oai.thstatus", fullFrameToParams(frame));
  }

  /**
   * Flash every key white.
   *
   * Deliberately leaves the flash lit: `device-link.identify()` immediately
   * repaints the composed frame over it, so the operator sees a blink rather
   * than this method racing a restore against its own write.
   */
  async identify(): Promise<void> {
    await this.#rpc.request("v.oai.thstatus", frameToParams(IDENTIFY_FRAME));
  }

  onInput(listener: (event: DeviceInputEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): Promise<void> {
    this.#open = false;
    this.#listeners.clear();
    this.#rpc.close();
    return Promise.resolve();
  }

  #emit(event: DeviceInputEvent): void {
    // Iterate a copy: a listener may unsubscribe itself while being called.
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(event);
      } catch {
        // One bad subscriber must not stop the others, and must never unwind
        // into the koffi callback that delivered this report.
      }
    }
  }
}

/**
 * Detects Vitest/test execution from the env shape used by local and worker
 * processes.
 *
 * Mirrors core's `src/infra/test-runtime-env.ts` predicate. It is duplicated
 * rather than imported because `extensions/AGENTS.md` forbids reaching into
 * `src/**`, and no `openclaw/plugin-sdk/*` subpath re-exports it.
 */
function isVitestRuntimeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.VITEST === "true" ||
    env.VITEST === "1" ||
    env.VITEST_POOL_ID !== undefined ||
    env.VITEST_WORKER_ID !== undefined ||
    env.NODE_ENV === "test"
  );
}

/**
 * Open a transport for the attached Codex Micro, or `undefined` when this
 * machine has no device support at all.
 *
 * `undefined` is the INERT path, and it is deliberately wider than "no macOS":
 * a Gateway whose koffi prebuild is missing for its architecture must also stay
 * silent rather than retry a native loader forever. `device-link.ts` treats
 * `undefined` as "no driver here" and stops - it does not schedule a reconnect -
 * which is why device *presence* is decided here too rather than being left to
 * a `connect()` rejection.
 *
 * A TEST RUNNER IS ALSO THE INERT PATH, for the same reason core guards
 * `browser-open`, `restart`, and `gateway-lock`: a unit suite must not reach
 * real hardware. Without this, a developer who happens to have a macropad
 * plugged in gets a *different* test result from CI - `plugin-entry.test.ts`
 * asserts the service is silent and holds no timers, which is only true when
 * nothing opened a device. Worse, the suite would drive real LEDs and pump a
 * CFRunLoop under `vi.useFakeTimers()`, where 120s of virtual time becomes
 * 30,000 real IOKit round-trips. Hardware belongs in the live proof script, not
 * in `vitest`.
 */
export function createCodexMicroTransport(params: {
  deviceSerial?: string;
  /**
   * Protocol trace sink. Off by default.
   *
   * Wider than the `DeviceTransportFactory` params on purpose: the seam never
   * passes it, but it is what lets a diagnostic run quote the firmware's own
   * parsed replies without reaching around the driver into the raw RPC layer.
   */
  debug?: (message: string) => void;
  /** Default-on sink for input the driver could not parse. See `DeviceTransportFactory`. */
  warn?: (message: string) => void;
}): DeviceTransport | undefined {
  if (isVitestRuntimeEnv()) {
    return undefined;
  }
  if (!isDarwinHidAvailable()) {
    return undefined;
  }
  let present: boolean;
  try {
    present =
      findCodexMicro(
        params.deviceSerial === undefined ? {} : { serialNumber: params.deviceSerial },
      ) !== null;
  } catch {
    // Enumeration itself failed (no IOHIDManager, sandboxed process). Inert.
    return undefined;
  }
  if (!present) {
    return undefined;
  }
  return new CodexMicroDeviceTransport({
    ...(params.deviceSerial === undefined ? {} : { serialNumber: params.deviceSerial }),
    ...(params.debug === undefined ? {} : { debug: params.debug }),
    ...(params.warn === undefined ? {} : { warn: params.warn }),
  });
}

export { CODEX_MICRO_PRODUCT_ID, CODEX_MICRO_VENDOR_ID };
