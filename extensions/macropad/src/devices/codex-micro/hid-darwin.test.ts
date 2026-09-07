import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  allocations: new Set<object>(),
  events: [] as string[],
  failEnumeration: false,
  callback: 123n,
}));

vi.mock("koffi", () => ({
  default: {
    load: () => ({
      func: (name: string) => () => {
        native.events.push(name);
        if (name === "CFSetGetCount") {
          return 1;
        }
        if (name === "IOHIDManagerCreate" || name === "IOHIDManagerCopyDevices") {
          return {};
        }
        if (name === "CFSetGetValues" && native.failEnumeration) {
          throw new Error("read failed");
        }
        if (name === "IOHIDDeviceGetProperty") {
          return null;
        }
        return 0;
      },
    }),
    proto: () => "callback",
    pointer: (type: unknown) => type,
    out: (type: unknown) => type,
    alloc: () => {
      const pointer = {};
      native.allocations.add(pointer);
      return pointer;
    },
    free: (pointer: object) => {
      expect(native.allocations.delete(pointer)).toBe(true);
      native.events.push("free");
    },
    decode: () => ({}),
    sizeof: () => 8,
    register: () => native.callback,
    unregister: (pointer: bigint) => {
      expect(pointer).toBe(native.callback);
      native.events.push("unregister");
    },
  },
}));

// Stub only the native boundary: no IOKit call or hardware is opened on any OS.
beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  native.events.length = 0;
  native.allocations.clear();
  native.failEnumeration = false;
});
afterEach(() => vi.restoreAllMocks());

it("releases the stable input allocation after native close and unregisters the bigint once", async () => {
  const { HidDevice } = await import("./hid-darwin.js");
  const device = new HidDevice({
    handle: {},
    vendorId: 1,
    productId: 2,
    product: null,
    serialNumber: null,
    primaryUsagePage: null,
    primaryUsage: null,
    maxInputReportSize: 64,
    maxOutputReportSize: 64,
  });
  device.open();
  device.startReading(() => {});
  expect(native.allocations.size).toBe(1);
  device.close();
  device.close();
  expect(native.allocations.size).toBe(0);
  expect(native.events.filter((event) => event === "unregister")).toHaveLength(1);
  expect(native.events.indexOf("IOHIDDeviceClose")).toBeLessThan(native.events.indexOf("free"));
});

it.each([false, true])(
  "releases enumeration storage even when reading fails (%s)",
  async (fail) => {
    native.failEnumeration = fail;
    const { enumerateDevices } = await import("./hid-darwin.js");
    if (fail) {
      expect(() => enumerateDevices()).toThrow("read failed");
    } else {
      expect(enumerateDevices()).toHaveLength(1);
    }
    expect(native.allocations.size).toBe(0);
    expect(native.events).toContain("CFRelease");
  },
);
