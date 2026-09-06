/**
 * The device seam.
 *
 * This module deliberately contains NO USB or HID code. A real transport
 * (koffi FFI to IOKit on macOS, `hid.dll` on Windows) is being proven
 * separately; it drops in behind `DeviceTransport` without any other file in
 * this plugin changing. Everything above this line is testable with
 * `FakeTransport` and no hardware.
 *
 * Two properties of the real device shape this interface:
 *
 * 1. A malformed write returns success and is silently dropped, so a successful
 *    `setFrame` proves nothing. `connect()` must therefore resolve only after a
 *    verified round-trip (`device.status`), never after a write.
 * 2. Lighting is a full-frame repaint and is volatile. `setFrame` takes a
 *    `MacropadFullFrame` - a branded six-tuple only `composeFrame` can mint -
 *    so no caller can express "update key 3".
 */
import type { MacropadFullFrame } from "./frame-compositor.js";

/** Identity proven by a `device.status` round-trip, not by enumeration. */
export type DeviceIdentity = {
  serial?: string;
  firmware?: string;
  product?: string;
  /** Slots the attached device actually lights. May be fewer than `MACROPAD_SLOT_COUNT`. */
  slotCount: number;
  /**
   * True when the OS withholds input reports pending user consent (macOS Input
   * Monitoring). Output lighting still works, so this is a capability flag, not
   * a connection failure.
   */
  inputPermissionRequired?: boolean;
  /**
   * Battery percentage, when the round-trip reports one.
   *
   * Lives on the identity rather than in a separate poll because this device's
   * proof-of-life call already carries it: `device.status` returns firmware AND
   * battery together, so asking twice would be a second USB exchange for data
   * we already hold.
   */
  batteryPercent?: number;
  charging?: boolean;
};

/** A physical key press or release. `key` is the firmware's own id, e.g. `AG00`. */
export type DeviceKeyEvent = {
  type: "key";
  key: string;
  /** Firmware `act`: 1 is press, 0 is release. */
  action: number;
};

/** Dial or analog-stick position, from the firmware's `v.oai.rad` reports. */
export type DeviceRadialEvent = {
  type: "radial";
  angle: number;
  distance: number;
};

export type DeviceInputEvent = DeviceKeyEvent | DeviceRadialEvent;

export type DeviceTransport = {
  /** Resolves only after a verified round-trip. Rejects when no device answers. */
  connect(): Promise<DeviceIdentity>;
  /** Writes a FULL frame - every slot, every call. Partial writes blank the rest. */
  setFrame(frame: MacropadFullFrame): Promise<void>;
  /** Briefly flash every key so an operator can tell which device this is. */
  identify(): Promise<void>;
  /** Returns an unsubscribe function. */
  onInput(listener: (event: DeviceInputEvent) => void): () => void;
  close(): Promise<void>;
  readonly connected: boolean;
};

/**
 * Opens a transport for the configured device, or returns `undefined` when this
 * platform or build has no device support at all.
 *
 * `undefined` is the inert path: the plugin stays completely silent rather than
 * entering a reconnect loop against a driver that does not exist.
 */
export type DeviceTransportFactory = (params: {
  deviceSerial?: string;
  /**
   * Default-ON sink for input the driver could not turn into an event.
   *
   * Deliberately NOT the `debug` trace sink. A line the device sent and the
   * driver dropped is the one failure that is invisible from the outside - the
   * LEDs keep working while every key press disappears - so it warns rather
   * than tracing. Cost a full day once; it does not get to be quiet again.
   */
  warn?: (message: string) => void;
}) => DeviceTransport | undefined;

export type FakeTransportOptions = {
  identity?: DeviceIdentity;
  /**
   * Fails the next `connect()` calls in order. `true` fails, `false` succeeds.
   * Exhausted entries fall through to success.
   */
  connectFailures?: readonly boolean[];
  /** Reject every `setFrame` - models a device unplugged mid-write. */
  failWrites?: boolean;
};

const DEFAULT_IDENTITY: DeviceIdentity = {
  serial: "FAKE-0001",
  firmware: "0.6.0",
  product: "Fake Macropad",
  slotCount: 6,
};

/**
 * In-memory transport for tests.
 *
 * Records every frame it is given so a test can assert the exact lighting the
 * device would have received, including the frames the plugin sends on
 * teardown.
 */
export class FakeTransport implements DeviceTransport {
  /** Every frame written, oldest first. */
  readonly frames: MacropadFullFrame[] = [];
  connectCount = 0;
  identifyCount = 0;
  closeCount = 0;

  private open = false;
  private readonly listeners = new Set<(event: DeviceInputEvent) => void>();
  private readonly connectFailures: boolean[];

  constructor(private readonly options: FakeTransportOptions = {}) {
    this.connectFailures = [...(options.connectFailures ?? [])];
  }

  get connected(): boolean {
    return this.open;
  }

  /** The most recent frame, or `undefined` if the device was never written to. */
  get lastFrame(): MacropadFullFrame | undefined {
    return this.frames.at(-1);
  }

  connect(): Promise<DeviceIdentity> {
    this.connectCount++;
    if (this.connectFailures.shift() === true) {
      return Promise.reject(new Error("fake transport: no device found"));
    }
    this.open = true;
    return Promise.resolve(this.options.identity ?? DEFAULT_IDENTITY);
  }

  setFrame(frame: MacropadFullFrame): Promise<void> {
    if (this.options.failWrites === true) {
      return Promise.reject(new Error("fake transport: write failed"));
    }
    if (!this.open) {
      return Promise.reject(new Error("fake transport: not connected"));
    }
    this.frames.push(frame);
    return Promise.resolve();
  }

  identify(): Promise<void> {
    if (!this.open) {
      return Promise.reject(new Error("fake transport: not connected"));
    }
    this.identifyCount++;
    return Promise.resolve();
  }

  onInput(listener: (event: DeviceInputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): Promise<void> {
    this.closeCount++;
    this.open = false;
    this.listeners.clear();
    return Promise.resolve();
  }

  /** Test hook: deliver an input report as the device would. */
  emitInput(event: DeviceInputEvent): void {
    // Iterate a copy: a listener may unsubscribe itself while being called.
    for (const listener of Array.from(this.listeners)) {
      listener(event);
    }
  }

  /** Test hook: model the device vanishing without a clean close. */
  drop(): void {
    this.open = false;
  }
}
