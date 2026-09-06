/**
 * Safety-allowlist and status-parsing tests. NO DEVICE REQUIRED.
 *
 * These are device-free because `hid-darwin.ts` resolves its IOKit symbols
 * lazily: constructing a transport touches no native code, and the allowlist is
 * checked BEFORE the "is the device open?" guard precisely so that a forbidden
 * method is unreachable whether or not hardware is attached.
 *
 * This is the ported version of the spike's `demo-roundtrip.ts` safety
 * assertion, which needed a device to run. Being device-free is the point: a
 * regression that opened `sys.bootloader` must fail CI, not wait for someone to
 * plug a macropad in.
 */
import { describe, expect, it } from "vitest";
import { Channel, encodePackets, REPORT_ID } from "./framing.js";
import {
  ALLOWED_METHODS,
  CODEX_MICRO_PRODUCT_ID,
  CODEX_MICRO_VENDOR_ID,
  CodexMicroTransport,
  ForbiddenMethodError,
  parseDeviceStatus,
  type RadialEvent,
} from "./rpc-transport.js";

/**
 * Everything on this channel that can brick, reflash, or rewrite the device.
 * If a future edit widens `ALLOWED_METHODS`, this list is what catches it.
 */
const DESTRUCTIVE_METHODS = [
  "sys.bootloader",
  "sys.selftest",
  "sys.reset",
  "fs.write",
  "fs.read",
  "fs.remove",
  "wl_device_programmer.start",
  "wl_device_programmer.write",
  "wl_device_programmer.finish",
];

describe("safety allowlist", () => {
  it("permits exactly the four methods this plugin needs, and nothing else", () => {
    expect([...ALLOWED_METHODS].toSorted()).toEqual([
      "device.status",
      "sys.version",
      "v.oai.rgbcfg",
      "v.oai.thstatus",
    ]);
  });

  it("refuses every destructive method before it can reach the wire", async () => {
    const transport = new CodexMicroTransport();
    for (const method of DESTRUCTIVE_METHODS) {
      await expect(transport.request(method)).rejects.toBeInstanceOf(ForbiddenMethodError);
      expect(() => transport.notify(method)).toThrow(ForbiddenMethodError);
    }
  });

  it("checks the allowlist BEFORE the open check, so it cannot be bypassed by state", async () => {
    // A closed transport rejects everything - but a forbidden method must fail
    // with ForbiddenMethodError specifically, proving the allowlist ran first
    // and the method never got as far as being encoded.
    const transport = new CodexMicroTransport();
    expect(transport.isOpen).toBe(false);

    await expect(transport.request("sys.bootloader")).rejects.toThrow(ForbiddenMethodError);
    await expect(transport.request("sys.version")).rejects.toThrow(/transport is not open/);
  });

  it("names the destructive surface in the error, so widening it is a conscious act", async () => {
    const transport = new CodexMicroTransport();
    await expect(transport.request("fs.write")).rejects.toThrow(/safety allowlist/);
    await expect(transport.request("fs.write")).rejects.toThrow(/deliberate code change/);
  });

  it("never sends a report while refusing", async () => {
    const transport = new CodexMicroTransport();
    await expect(transport.request("sys.bootloader")).rejects.toThrow(ForbiddenMethodError);
    expect(transport.setReportCount).toBe(0);
  });
});

describe("device identity constants", () => {
  it("targets the Codex Micro's USB ids", () => {
    expect(CODEX_MICRO_VENDOR_ID).toBe(0x30_3a);
    expect(CODEX_MICRO_PRODUCT_ID).toBe(0x83_60);
  });
});

describe("parseDeviceStatus", () => {
  it("maps the firmware's snake_case reply onto the identity fields", () => {
    // Verbatim shape observed live on firmware v0.4.1.
    expect(
      parseDeviceStatus({
        version: "v0.4.1",
        profile_index: 0,
        layer_index: 1,
        battery: 100,
        is_charging: false,
      }),
    ).toEqual({
      version: "v0.4.1",
      profileIndex: 0,
      layerIndex: 1,
      battery: 100,
      isCharging: false,
    });
  });

  it("degrades field by field rather than throwing on an unexpected reply", () => {
    // A firmware that renames a field must cost us battery display, not the
    // connection: `connect()` treats any parsed reply as proof of life.
    expect(parseDeviceStatus({ version: "v9.0.0" })).toEqual({ version: "v9.0.0" });
    expect(parseDeviceStatus({ battery: "full" })).toEqual({});
    expect(parseDeviceStatus(null)).toEqual({});
    expect(parseDeviceStatus("nope")).toEqual({});
    expect(parseDeviceStatus(undefined)).toEqual({});
  });

  it("keeps a zero battery distinguishable from an absent one", () => {
    expect(parseDeviceStatus({ battery: 0 }).battery).toBe(0);
    expect(parseDeviceStatus({}).battery).toBeUndefined();
  });
});

/**
 * Inbound-path tests. NO DEVICE REQUIRED.
 *
 * These drive `ingestInputReport` directly with real encoded packets, which is
 * the same door the HID read callback uses. They exist because the input half
 * of this driver failed SILENTLY: the parser accepted only the long `method`
 * spelling, every compact notification became null, and the drop was reported
 * through a debug sink that is off by default. Nothing turned red.
 */
describe("inbound input path", () => {
  function packetsFor(line: string): Uint8Array[] {
    return encodePackets(`${line}\n`, Channel.Rpc);
  }

  it("ACCEPTANCE: delivers a radial event from the exact captured device bytes", () => {
    const radial: RadialEvent[] = [];
    const notifications: Array<{ method: string; params: unknown }> = [];
    const transport = new CodexMicroTransport({
      events: {
        radial: (event) => radial.push(event),
        notification: (method, params) => notifications.push({ method, params }),
      },
    });

    for (const packet of packetsFor('{"m":"v.oai.rad","p":{"a":0.085069,"d":0.006819}}')) {
      transport.ingestInputReport(REPORT_ID, packet);
    }

    expect(radial).toEqual([{ a: 0.085069, d: 0.006819 }]);
    expect(notifications).toEqual([{ method: "v.oai.rad", params: { a: 0.085069, d: 0.006819 } }]);
  });

  it("ACCEPTANCE: an unparsable line WARNS rather than vanishing", () => {
    // The regression that cost a day: this line arrived, was dropped, and said
    // nothing at a level anyone had switched on.
    const warnings: string[] = [];
    const transport = new CodexMicroTransport({ warn: (message) => warnings.push(message) });

    for (const packet of packetsFor("{not json at all")) {
      transport.ingestInputReport(REPORT_ID, packet);
    }

    expect(warnings, "a dropped device line must reach the default-on sink").toHaveLength(1);
    expect(warnings[0]).toContain("dropped unparsable device line");
    expect(warnings[0]).toContain("{not json at all");
  });

  it("warns WITHOUT a debug sink attached - the drop is not debug-gated", () => {
    const warnings: string[] = [];
    // No `debug` option at all: this is the production shape before anyone
    // turns tracing on, and it must still surface the drop.
    const transport = new CodexMicroTransport({ warn: (message) => warnings.push(message) });

    for (const packet of packetsFor('{"unrelated":1}')) {
      transport.ingestInputReport(REPORT_ID, packet);
    }

    expect(warnings).toHaveLength(1);
  });

  it("ignores reports from the other collections sharing this device", () => {
    const warnings: string[] = [];
    const transport = new CodexMicroTransport({ warn: (message) => warnings.push(message) });

    for (const packet of packetsFor("{not json at all")) {
      transport.ingestInputReport(REPORT_ID + 1, packet);
    }

    // Keyboard/consumer/mouse traffic is not ours to warn about.
    expect(warnings).toEqual([]);
  });

  it("still routes a long-form notification", () => {
    const radial: RadialEvent[] = [];
    const transport = new CodexMicroTransport({
      events: { radial: (event) => radial.push(event) },
    });

    for (const packet of packetsFor('{"method":"v.oai.rad","params":{"a":1.5,"d":0.25}}')) {
      transport.ingestInputReport(REPORT_ID, packet);
    }

    expect(radial).toEqual([{ a: 1.5, d: 0.25 }]);
  });
});
