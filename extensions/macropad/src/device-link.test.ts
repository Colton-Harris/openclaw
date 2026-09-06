import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MACROPAD_SLOT_COUNT } from "../contract.js";
import type { MacropadDeviceStatus } from "../contract.js";
import { MacropadDeviceLink, type DeviceLinkLogger } from "./device-link.js";
import {
  composeBlankFrame,
  composeFrame,
  type MacropadLighting,
  type MacropadSlotShadow,
} from "./frame-compositor.js";
import { FakeTransport, type DeviceTransport } from "./transport.js";

const LIGHTING: MacropadLighting = {
  brightness: 0.8,
  idleBrightness: 0.15,
  colorThinking: 0x4c_8d_ff,
  colorAwaitingApproval: 0xff_b0_20,
  colorError: 0xff_4d_4d,
  useSessionColors: false,
};

function createLogger() {
  const lines: Array<{ level: string; message: string }> = [];
  const record = (level: string) => (message: string) => {
    lines.push({ level, message });
  };
  const logger: DeviceLinkLogger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
  return { logger, lines };
}

type Harness = {
  link: MacropadDeviceLink;
  statuses: MacropadDeviceStatus[];
  lines: Array<{ level: string; message: string }>;
  setSlots: (slots: readonly MacropadSlotShadow[]) => void;
};

function createLink(
  createTransport: (params: { deviceSerial?: string }) => DeviceTransport | undefined,
  overrides: { resyncIntervalMs?: number; reconnectBaseMs?: number } = {},
): Harness {
  const statuses: MacropadDeviceStatus[] = [];
  const { logger, lines } = createLogger();
  let slots: readonly MacropadSlotShadow[] = [];
  const link = new MacropadDeviceLink({
    createTransport,
    renderFrame: () => composeFrame(slots, LIGHTING),
    renderBlankFrame: () => composeBlankFrame(LIGHTING),
    onStatusChange: (status) => statuses.push(status),
    resyncIntervalMs: overrides.resyncIntervalMs ?? 10_000,
    reconnectBaseMs: overrides.reconnectBaseMs ?? 1_000,
    // Deterministic backoff: real jitter would make delay assertions flaky.
    jitter: () => 0,
    logger,
  });
  return {
    link,
    statuses,
    lines,
    setSlots: (next) => {
      slots = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("inert with no device", () => {
  it("connects nothing, throws nothing, and logs nothing at info or above", async () => {
    const harness = createLink(() => undefined);

    harness.link.start();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(harness.link.connected).toBe(false);
    expect(harness.lines.filter((line) => line.level !== "debug")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers repaint and identify without a device instead of throwing", async () => {
    const harness = createLink(() => undefined);
    harness.link.start();

    await expect(harness.link.repaint()).resolves.toBeUndefined();
    await expect(harness.link.identify()).resolves.toBe(false);
  });

  it("stops cleanly when it never started a device", async () => {
    const harness = createLink(() => undefined);
    harness.link.start();

    await expect(harness.link.stop()).resolves.toBeUndefined();
  });
});

describe("connect and paint", () => {
  it("paints a full frame as soon as the device answers", async () => {
    const transport = new FakeTransport();
    const harness = createLink(() => transport);
    harness.setSlots([{ index: 0, activity: "thinking", pinned: false, sessionKey: "s0" }]);

    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.link.connected).toBe(true);
    expect(transport.frames).toHaveLength(1);
    expect(transport.lastFrame).toHaveLength(MACROPAD_SLOT_COUNT);
    expect(transport.lastFrame?.[0]?.color).toBe(LIGHTING.colorThinking);
  });

  it("reports firmware identity from the verified round-trip", async () => {
    const transport = new FakeTransport({
      identity: {
        serial: "CM2-77",
        firmware: "0.6.0",
        product: "Codex Micro",
        slotCount: 6,
        inputPermissionRequired: true,
      },
    });
    const harness = createLink(() => transport);

    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.link.status).toEqual({
      connected: true,
      serial: "CM2-77",
      firmware: "0.6.0",
      product: "Codex Micro",
      slotCount: 6,
      inputPermissionRequired: true,
    });
  });

  it("skips a write when the composed frame has not changed", async () => {
    const transport = new FakeTransport();
    const harness = createLink(() => transport);
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    await harness.link.repaint();
    await harness.link.repaint();

    expect(transport.frames).toHaveLength(1);
  });

  it("writes again once the frame actually changes", async () => {
    const transport = new FakeTransport();
    const harness = createLink(() => transport);
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    harness.setSlots([{ index: 1, activity: "error", pinned: false, sessionKey: "s1" }]);
    await harness.link.repaint();

    expect(transport.frames).toHaveLength(2);
    expect(transport.lastFrame?.[1]?.color).toBe(LIGHTING.colorError);
  });
});

describe("resync loop", () => {
  it("repaints unconditionally on the interval, because lighting drifts", async () => {
    const transport = new FakeTransport();
    const harness = createLink(() => transport, { resyncIntervalMs: 5_000 });
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.frames).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15_000);

    // Nothing changed, yet three more full frames went out. That is the point.
    expect(transport.frames).toHaveLength(4);
    expect(transport.frames.every((frame) => frame.length === MACROPAD_SLOT_COUNT)).toBe(true);
  });

  it("stops repainting once the link is stopped", async () => {
    const transport = new FakeTransport();
    const harness = createLink(() => transport, { resyncIntervalMs: 5_000 });
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    await harness.link.stop();
    const painted = transport.frames.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(transport.frames).toHaveLength(painted);
  });
});

describe("reconnect with backoff", () => {
  it("retries on an exponential schedule capped at the maximum", async () => {
    // 1s, 2s, 4s, 8s ... each attempt fires only after its own delay.
    const transport = new FakeTransport({
      connectFailures: [true, true, true, false],
    });
    const harness = createLink(() => transport, { reconnectBaseMs: 1_000 });

    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.connectCount).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(transport.connectCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.connectCount).toBe(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(transport.connectCount).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.connectCount).toBe(3);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(transport.connectCount).toBe(4);
    expect(harness.link.connected).toBe(true);
  });

  it("caps the delay rather than backing off forever", async () => {
    const transport = new FakeTransport({
      connectFailures: Array.from({ length: 40 }, () => true),
    });
    const harness = createLink(() => transport, { reconnectBaseMs: 1_000 });
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    // Long enough to blow past 2**n for any sane n if the cap were missing.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const attemptsAtCap = transport.connectCount;
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    // With a 60s cap, ten more minutes buys roughly ten more attempts.
    expect(transport.connectCount - attemptsAtCap).toBeGreaterThanOrEqual(9);
    expect(transport.connectCount - attemptsAtCap).toBeLessThanOrEqual(11);
  });

  it("resets the backoff after a successful connect", async () => {
    const transport = new FakeTransport({ connectFailures: [true, true, false] });
    const harness = createLink(() => transport, { reconnectBaseMs: 1_000 });
    harness.link.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.link.connected).toBe(true);

    // Device drops; the next retry must start from the base delay again.
    transport.drop();
    await harness.link.repaint({ force: true });
    expect(harness.link.connected).toBe(false);
    const attempts = transport.connectCount;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(transport.connectCount).toBe(attempts + 1);
  });

  it("does not spam the log while retrying against an empty port", async () => {
    const transport = new FakeTransport({
      connectFailures: Array.from({ length: 20 }, () => true),
    });
    const harness = createLink(() => transport, { reconnectBaseMs: 1_000 });

    harness.link.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(transport.connectCount).toBeGreaterThan(5);
    expect(harness.lines.filter((line) => line.level !== "debug")).toEqual([]);
    // Identical failures collapse to a single debug line.
    expect(harness.lines.filter((line) => line.level === "debug")).toHaveLength(1);
  });

  it("warns exactly once when a device that was present goes away", async () => {
    const transport = new FakeTransport({ connectFailures: [false, true, true, true] });
    const harness = createLink(() => transport, { reconnectBaseMs: 1_000 });
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    transport.drop();
    await harness.link.repaint({ force: true });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.lines.filter((line) => line.level === "warn")).toHaveLength(1);
    expect(harness.lines.find((line) => line.level === "warn")?.message).toMatch(/device lost/u);
  });

  it("publishes a disconnected status carrying the failure reason", async () => {
    const transport = new FakeTransport({ connectFailures: [true] });
    const harness = createLink(() => transport);

    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.statuses.at(-1)).toEqual({
      connected: false,
      slotCount: 0,
      inputPermissionRequired: false,
      lastError: "fake transport: no device found",
    });
  });

  it("stops retrying once the link is stopped", async () => {
    const transport = new FakeTransport({
      connectFailures: Array.from({ length: 20 }, () => true),
    });
    const harness = createLink(() => transport, { reconnectBaseMs: 1_000 });
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    await harness.link.stop();
    const attempts = transport.connectCount;
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(transport.connectCount).toBe(attempts);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("status change notifications", () => {
  it("only fires when something actually changed", async () => {
    const transport = new FakeTransport();
    const harness = createLink(() => transport, { resyncIntervalMs: 1_000 });
    harness.link.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.statuses).toHaveLength(1);
    expect(harness.statuses[0]?.connected).toBe(true);
  });
});

describe("identify", () => {
  it("flashes the device and then restores the frame it overwrote", async () => {
    const transport = new FakeTransport();
    const harness = createLink(() => transport);
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);
    const painted = transport.frames.length;

    await expect(harness.link.identify()).resolves.toBe(true);

    expect(transport.identifyCount).toBe(1);
    expect(transport.frames).toHaveLength(painted + 1);
  });
});

describe("teardown", () => {
  it("blanks the keys and closes the device", async () => {
    const transport = new FakeTransport();
    const harness = createLink(() => transport);
    harness.setSlots([{ index: 0, activity: "thinking", pinned: false, sessionKey: "s0" }]);
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    await harness.link.stop();

    // A device left lit after shutdown reads as a hang.
    expect(transport.lastFrame?.every((key) => key.brightness === 0)).toBe(true);
    expect(transport.closeCount).toBe(1);
    expect(harness.link.status.connected).toBe(false);
  });

  it("stops input delivery", async () => {
    const transport = new FakeTransport();
    const received: unknown[] = [];
    const { logger } = createLogger();
    const link = new MacropadDeviceLink({
      createTransport: () => transport,
      renderFrame: () => composeFrame([], LIGHTING),
      renderBlankFrame: () => composeBlankFrame(LIGHTING),
      onStatusChange: () => undefined,
      onInput: (input) => received.push(input),
      resyncIntervalMs: 10_000,
      logger,
    });
    link.start();
    await vi.advanceTimersByTimeAsync(0);
    transport.emitInput({ type: "key", key: "AG00", action: 1 });
    expect(received).toHaveLength(1);

    await link.stop();
    transport.emitInput({ type: "key", key: "AG01", action: 1 });

    expect(received).toHaveLength(1);
  });
});

describe("battery and live status", () => {
  it("carries battery from the connect round-trip", async () => {
    const transport = new FakeTransport();
    const harness = createLink(() => transport);

    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.link.status).toMatchObject({ batteryPercent: 100, charging: false });
  });

  it("re-reads device.status rather than serving a stale battery", async () => {
    // Battery moves under the operator's hands; a connect-time snapshot is
    // wrong within minutes.
    const transport = new FakeTransport();
    const harness = createLink(() => transport);
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    transport.setIdentity({ batteryPercent: 37, charging: true });
    const refreshed = await harness.link.refreshStatus();

    expect(refreshed).toMatchObject({ batteryPercent: 37, charging: true });
    expect(transport.statusCount).toBe(1);
  });

  it("publishes a status change when only the battery moved", async () => {
    const transport = new FakeTransport();
    const harness = createLink(() => transport);
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = harness.statuses.length;

    transport.setIdentity({ batteryPercent: 12 });
    await harness.link.refreshStatus();

    expect(harness.statuses).toHaveLength(before + 1);
    expect(harness.statuses.at(-1)?.batteryPercent).toBe(12);
  });

  it("does not re-notify when the battery has not moved", async () => {
    const transport = new FakeTransport();
    const harness = createLink(() => transport);
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = harness.statuses.length;

    await harness.link.refreshStatus();

    expect(harness.statuses).toHaveLength(before);
  });

  it("keeps the connect-time identity when the driver has no status round-trip", async () => {
    // The koffi driver may land implementing only connect(); that must not
    // erase the firmware and battery it already proved.
    const transport = new FakeTransport({ omitStatus: true });
    const harness = createLink(() => transport);
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    const refreshed = await harness.link.refreshStatus();

    expect(refreshed).toMatchObject({ connected: true, batteryPercent: 100 });
  });

  it("returns a disconnected status without a device", async () => {
    const harness = createLink(() => undefined);
    harness.link.start();

    await expect(harness.link.refreshStatus()).resolves.toMatchObject({ connected: false });
  });

  it("treats a failed status round-trip as a device failure and reconnects", async () => {
    const transport = new FakeTransport({ failStatus: true });
    const harness = createLink(() => transport, { reconnectBaseMs: 1_000 });
    harness.link.start();
    await vi.advanceTimersByTimeAsync(0);

    const result = await harness.link.refreshStatus();

    expect(result.connected).toBe(false);
    expect(result.lastError).toMatch(/status round-trip failed/u);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.connectCount).toBe(2);
  });
});
