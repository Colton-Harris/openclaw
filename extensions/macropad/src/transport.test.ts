import { describe, expect, it } from "vitest";
import { MACROPAD_SLOT_COUNT } from "../contract.js";
import { composeFrame, type MacropadLighting } from "./frame-compositor.js";
import { FakeTransport, type DeviceInputEvent } from "./transport.js";

const LIGHTING: MacropadLighting = {
  brightness: 0.8,
  idleBrightness: 0.15,
  colorThinking: 0x4c_8d_ff,
  colorAwaitingApproval: 0xff_b0_20,
  colorError: 0xff_4d_4d,
  useSessionColors: false,
};

describe("FakeTransport", () => {
  it("starts disconnected and connects on demand", async () => {
    const transport = new FakeTransport();
    expect(transport.connected).toBe(false);

    const identity = await transport.connect();

    expect(transport.connected).toBe(true);
    expect(identity.slotCount).toBe(MACROPAD_SLOT_COUNT);
    expect(transport.connectCount).toBe(1);
  });

  it("records every frame in order so a test can assert exact lighting", async () => {
    const transport = new FakeTransport();
    await transport.connect();

    await transport.setFrame(composeFrame([], LIGHTING));
    await transport.setFrame(
      composeFrame([{ index: 0, activity: "error", pinned: false }], LIGHTING),
    );

    expect(transport.frames).toHaveLength(2);
    expect(transport.frames[0]?.[0]?.brightness).toBe(0);
    expect(transport.lastFrame?.[0]?.color).toBe(LIGHTING.colorError);
  });

  it("refuses writes before connect and after close", async () => {
    const transport = new FakeTransport();

    await expect(transport.setFrame(composeFrame([], LIGHTING))).rejects.toThrow(/not connected/u);
    await transport.connect();
    await transport.close();
    await expect(transport.setFrame(composeFrame([], LIGHTING))).rejects.toThrow(/not connected/u);
  });

  it("fails scripted connects in order and then succeeds", async () => {
    const transport = new FakeTransport({ connectFailures: [true, false] });

    await expect(transport.connect()).rejects.toThrow(/no device found/u);
    await expect(transport.connect()).resolves.toMatchObject({ slotCount: 6 });
  });

  it("can be scripted to fail writes, modelling a mid-write unplug", async () => {
    const transport = new FakeTransport({ failWrites: true });
    await transport.connect();

    await expect(transport.setFrame(composeFrame([], LIGHTING))).rejects.toThrow(/write failed/u);
    expect(transport.frames).toEqual([]);
  });

  it("delivers input to every listener and honours unsubscribe", async () => {
    const transport = new FakeTransport();
    await transport.connect();
    const first: DeviceInputEvent[] = [];
    const second: DeviceInputEvent[] = [];
    const stopFirst = transport.onInput((event) => first.push(event));
    transport.onInput((event) => second.push(event));

    transport.emitInput({ type: "key", key: "AG00", action: 1 });
    stopFirst();
    transport.emitInput({ type: "radial", angle: 90, distance: 12 });

    expect(first).toEqual([{ type: "key", key: "AG00", action: 1 }]);
    expect(second).toHaveLength(2);
    expect(second[1]).toEqual({ type: "radial", angle: 90, distance: 12 });
  });

  it("drops listeners on close", async () => {
    const transport = new FakeTransport();
    await transport.connect();
    const seen: DeviceInputEvent[] = [];
    transport.onInput((event) => seen.push(event));

    await transport.close();
    transport.emitInput({ type: "key", key: "AG00", action: 1 });

    expect(seen).toEqual([]);
    expect(transport.closeCount).toBe(1);
  });

  it("models a device vanishing without a clean close", async () => {
    const transport = new FakeTransport();
    await transport.connect();

    transport.drop();

    expect(transport.connected).toBe(false);
    expect(transport.closeCount).toBe(0);
  });

  it("refuses identify while disconnected", async () => {
    const transport = new FakeTransport();

    await expect(transport.identify()).rejects.toThrow(/not connected/u);
  });

  it("reports battery through a device.status round-trip", async () => {
    const transport = new FakeTransport();
    await transport.connect();

    await expect(transport.status?.()).resolves.toMatchObject({
      batteryPercent: 100,
      charging: false,
    });
    expect(transport.statusCount).toBe(1);
  });

  it("reflects a battery that moved between round-trips", async () => {
    const transport = new FakeTransport();
    await transport.connect();

    transport.setIdentity({ batteryPercent: 42, charging: true });

    await expect(transport.status?.()).resolves.toMatchObject({
      batteryPercent: 42,
      charging: true,
    });
  });

  it("can model a driver that implements only connect", async () => {
    const transport = new FakeTransport({ omitStatus: true });
    await transport.connect();

    expect(transport.status).toBeUndefined();
  });
});
