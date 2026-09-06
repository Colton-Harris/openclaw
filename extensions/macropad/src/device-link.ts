/**
 * Owns the device connection: connect, reconnect with backoff, repaint, close.
 *
 * Two behaviours are load-bearing and easy to get wrong:
 *
 * 1. **Inertness.** `linux-node` is bundled and enabled by default and is
 *    simply inert off-Linux; this plugin holds the same bar. With no device
 *    attached it must produce no throw, no crash, and no log spam - which means
 *    repeated identical connect failures are logged once, not once per retry.
 * 2. **Volatile lighting.** The device drifts and forgets. A periodic full
 *    repaint is mandatory, and it is a FULL repaint every time, because the
 *    firmware blanks any key omitted from a write.
 *
 * The backoff mirrors `extensions/imap/src/watcher.ts`: exponential from a
 * configurable base, capped, jittered, and `unref`'d so a dark macropad never
 * holds the Gateway's event loop open at shutdown.
 */
import type { MacropadDeviceStatus } from "./contract-types.js";
import { assertFullFrame, framesEqual, type MacropadFullFrame } from "./frame-compositor.js";
import type { DeviceInputEvent, DeviceTransport, DeviceTransportFactory } from "./transport.js";

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;

export type DeviceLinkLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type DeviceLinkOptions = {
  createTransport: DeviceTransportFactory;
  deviceSerial?: string;
  /** Produces the frame to paint. Called on connect, on repaint, and on resync. */
  renderFrame: () => MacropadFullFrame;
  /** The frame painted on a clean teardown, so the device does not stay lit. */
  renderBlankFrame: () => MacropadFullFrame;
  onStatusChange: (status: MacropadDeviceStatus) => void;
  onInput?: (event: DeviceInputEvent) => void;
  resyncIntervalMs: number;
  reconnectBaseMs?: number;
  maxReconnectDelayMs?: number;
  logger?: DeviceLinkLogger;
  /** Injected for deterministic backoff assertions; defaults to real jitter. */
  jitter?: (delay: number) => number;
};

const DISCONNECTED: MacropadDeviceStatus = {
  connected: false,
  slotCount: 0,
  inputPermissionRequired: false,
};

export class MacropadDeviceLink {
  private transport: DeviceTransport | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private resyncTimer: ReturnType<typeof setInterval> | undefined;
  private activeConnection: Promise<void> | undefined;
  private stopping = false;
  private failures = 0;
  /** Last failure text already logged, so a dead device is quiet after the first line. */
  private lastLoggedFailure: string | undefined;
  private unsubscribeInput: (() => void) | undefined;
  private lastFrame: MacropadFullFrame | undefined;
  private currentStatus: MacropadDeviceStatus = DISCONNECTED;
  /** True once a device has answered, so a later drop is worth a warning. */
  private everConnected = false;

  constructor(private readonly options: DeviceLinkOptions) {}

  get status(): MacropadDeviceStatus {
    return this.currentStatus;
  }

  get connected(): boolean {
    return this.currentStatus.connected;
  }

  start(): void {
    this.stopping = false;
    this.openConnection();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    const transport = this.transport;
    this.transport = undefined;
    this.unsubscribeInput?.();
    this.unsubscribeInput = undefined;
    this.lastFrame = undefined;
    if (transport?.connected === true) {
      // Best-effort blank: a device left lit after shutdown looks like a hang.
      await transport.setFrame(this.options.renderBlankFrame()).catch(() => undefined);
    }
    await transport?.close().catch(() => undefined);
    await this.activeConnection?.catch(() => undefined);
    this.setStatus(DISCONNECTED);
  }

  /**
   * Paint the current frame now.
   *
   * Skips the write when the composed frame is byte-identical to the last one,
   * so a burst of agent events on one session does not become a burst of USB
   * writes. The resync loop repaints unconditionally, which is what actually
   * corrects drift.
   */
  async repaint(options: { force?: boolean } = {}): Promise<void> {
    const transport = this.transport;
    if (!transport) {
      return;
    }
    if (!transport.connected) {
      // The device went away without a write surfacing the error. Without this
      // the link would sit "connected" forever against an empty port and never
      // schedule a reconnect.
      this.handleFailure(new Error("device disconnected"));
      return;
    }
    const frame = this.options.renderFrame();
    assertFullFrame(frame);
    if (options.force !== true && this.lastFrame && framesEqual(this.lastFrame, frame)) {
      return;
    }
    try {
      await transport.setFrame(frame);
      this.lastFrame = frame;
    } catch (error) {
      this.lastFrame = undefined;
      this.handleFailure(error);
    }
  }

  /** Flash every key. Resolves `false` when no device is attached. */
  async identify(): Promise<boolean> {
    const transport = this.transport;
    if (!transport?.connected) {
      return false;
    }
    try {
      await transport.identify();
      // The flash overwrites our frame, so restore it rather than leaving the
      // device showing whatever `identify` painted last.
      await this.repaint({ force: true });
      return true;
    } catch (error) {
      this.handleFailure(error);
      return false;
    }
  }

  private openConnection(): void {
    if (this.stopping || this.activeConnection) {
      return;
    }
    const serial = this.options.deviceSerial;
    const logger = this.options.logger;
    const transport = this.options.createTransport({
      ...(serial === undefined ? {} : { deviceSerial: serial }),
      // Driver-level drops reach the plugin's real logger, not a debug flag.
      ...(logger === undefined ? {} : { warn: (message: string) => logger.warn(message) }),
    });
    if (!transport) {
      // No driver on this platform. Not a failure, and not worth retrying:
      // stay inert and silent until something restarts the service.
      this.options.logger?.debug?.("macropad: no device transport on this platform; staying inert");
      this.setStatus(DISCONNECTED);
      return;
    }
    this.transport = transport;
    const pending = this.connect(transport).catch((error: unknown) => {
      this.handleFailure(error);
    });
    this.activeConnection = pending.finally(() => {
      this.activeConnection = undefined;
    });
  }

  private async connect(transport: DeviceTransport): Promise<void> {
    // `connect` resolves only after a verified round-trip. A successful write
    // proves nothing here: the firmware drops malformed writes and reports OK.
    const identity = await transport.connect();
    if (this.stopping || this.transport !== transport) {
      await transport.close().catch(() => undefined);
      return;
    }
    this.failures = 0;
    this.lastLoggedFailure = undefined;
    this.lastFrame = undefined;
    this.unsubscribeInput?.();
    this.unsubscribeInput = transport.onInput((event) => {
      this.options.onInput?.(event);
    });
    this.setStatus({
      connected: true,
      slotCount: identity.slotCount,
      inputPermissionRequired: identity.inputPermissionRequired === true,
      ...(identity.serial === undefined ? {} : { serial: identity.serial }),
      ...(identity.firmware === undefined ? {} : { firmware: identity.firmware }),
      ...(identity.product === undefined ? {} : { product: identity.product }),
      ...(identity.batteryPercent === undefined ? {} : { batteryPercent: identity.batteryPercent }),
      ...(identity.charging === undefined ? {} : { charging: identity.charging }),
    });
    if (!this.everConnected) {
      this.everConnected = true;
      this.options.logger?.info(
        `macropad: connected product=${identity.product ?? "unknown"} firmware=${identity.firmware ?? "unknown"} slots=${identity.slotCount}`,
      );
    }
    this.startResyncTimer();
    await this.repaint({ force: true });
  }

  private startResyncTimer(): void {
    this.clearResyncTimer();
    // Unconditional full repaints: this loop exists precisely because the
    // device forgets, so skipping "unchanged" frames here would defeat it.
    this.resyncTimer = setInterval(() => {
      void this.repaint({ force: true });
    }, this.options.resyncIntervalMs);
    this.resyncTimer.unref?.();
  }

  private handleFailure(error: unknown): void {
    if (this.stopping) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (this.everConnected) {
      // A device that was here and left is a real event worth one warning.
      this.options.logger?.warn(`macropad: device lost: ${message}`);
      this.everConnected = false;
    } else if (this.lastLoggedFailure !== message) {
      // First sighting of this failure only. Retrying forever against an empty
      // USB port must not fill the Gateway log.
      this.options.logger?.debug?.(`macropad: device unavailable: ${message}`);
    }
    this.lastLoggedFailure = message;
    this.clearResyncTimer();
    this.unsubscribeInput?.();
    this.unsubscribeInput = undefined;
    this.lastFrame = undefined;
    const transport = this.transport;
    this.transport = undefined;
    void transport?.close().catch(() => undefined);
    this.setStatus({ ...DISCONNECTED, lastError: message.slice(0, 512) });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) {
      return;
    }
    const base = this.options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    const cap = this.options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    const delay = Math.min(base * 2 ** this.failures++, cap);
    const jitter = this.options.jitter
      ? this.options.jitter(delay)
      : Math.floor(Math.random() * Math.max(1, delay / 4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openConnection();
    }, delay + jitter);
    this.reconnectTimer.unref?.();
  }

  private clearResyncTimer(): void {
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearResyncTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private setStatus(status: MacropadDeviceStatus): void {
    const changed =
      this.currentStatus.connected !== status.connected ||
      this.currentStatus.serial !== status.serial ||
      this.currentStatus.firmware !== status.firmware ||
      this.currentStatus.product !== status.product ||
      this.currentStatus.slotCount !== status.slotCount ||
      this.currentStatus.inputPermissionRequired !== status.inputPermissionRequired ||
      this.currentStatus.lastError !== status.lastError;
    this.currentStatus = status;
    if (changed) {
      this.options.onStatusChange(status);
    }
  }
}
