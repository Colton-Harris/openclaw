import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MACROPAD_EFFECTS, MACROPAD_SLOT_COUNT } from "../contract.js";
import { createMemoryBindingStore, type PersistedBinding } from "./binding-store.js";
import { MACROPAD_SESSION_COLOR_RGB } from "./colors.js";
import { resolveMacropadConfig, type MacropadConfig } from "./config.js";
import type { MacropadDeviceStatus, MacropadSlotList } from "./contract-types.js";
import { BufferedFeatureEmitter, MacropadService, normalizeSessionRows } from "./service.js";
import type { SessionRowLike } from "./session-status.js";
import { FakeTransport } from "./transport.js";

const CONFIG: MacropadConfig = resolveMacropadConfig({ resyncIntervalSeconds: 10 });

type Harness = {
  service: MacropadService;
  transport: FakeTransport;
  devices: MacropadDeviceStatus[];
  slots: MacropadSlotList[];
  /** Everything the service sent to a default-on logger level. */
  logs: string[];
  advance: () => Promise<void>;
};

function createHarness(
  overrides: {
    config?: Partial<MacropadConfig>;
    sessions?: readonly SessionRowLike[];
    listSessions?: () => Promise<readonly SessionRowLike[] | undefined>;
    seed?: readonly PersistedBinding[];
    noDevice?: boolean;
  } = {},
): Harness {
  const transport = new FakeTransport();
  const devices: MacropadDeviceStatus[] = [];
  const slots: MacropadSlotList[] = [];
  const logs: string[] = [];
  let clock = 1_000;
  const store = createMemoryBindingStore(overrides.seed ?? []);
  const service = new MacropadService({
    config: { ...CONFIG, ...overrides.config },
    createTransport: () => (overrides.noDevice === true ? undefined : transport),
    openBindingStore: () => store,
    ...(overrides.listSessions
      ? { listSessions: overrides.listSessions }
      : overrides.sessions
        ? { listSessions: () => Promise.resolve(overrides.sessions) }
        : {}),
    emitDeviceChanged: (status) => devices.push(status),
    emitSlotsChanged: (list) => slots.push(list),
    now: () => ++clock,
    reconnectBaseMs: 1_000,
    jitter: () => 0,
    // `debug` is intentionally omitted: anything these tests assert on must be
    // visible at a level that is on by default.
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });
  return {
    service,
    transport,
    devices,
    slots,
    logs,
    advance: async () => {
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("slots.list", () => {
  it("always returns every key, bound or not", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.advance();

    const list = harness.service.listSlots();

    expect(list.slots).toHaveLength(MACROPAD_SLOT_COUNT);
    expect(list.slots.map((slot) => slot.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(list.slots.every((slot) => slot.activity === "unbound")).toBe(true);
    expect(list.slots.every((slot) => !slot.pinned)).toBe(true);
  });

  it("carries the rendered frame for each key so the UI mirrors the device", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.service.bind({ sessionKey: "s0", index: 0 });

    const slot = harness.service.listSlots().slots[0];

    expect(slot).toMatchObject({ sessionKey: "s0", activity: "idle" });
    expect(slot?.frame.effect).toBe(MACROPAD_EFFECTS.solid);
  });
});

describe("binding through the contract operations", () => {
  it("binds, persists, and repaints", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.advance();
    const painted = harness.transport.frames.length;

    const list = await harness.service.bind({ sessionKey: "s0", index: 2, pinned: true });

    expect(list.slots[2]).toMatchObject({ sessionKey: "s0", pinned: true });
    expect(harness.transport.frames.length).toBeGreaterThan(painted);
    expect(harness.transport.lastFrame).toHaveLength(MACROPAD_SLOT_COUNT);
  });

  it("restores bindings across a restart", async () => {
    const store = createMemoryBindingStore();
    const first = new MacropadService({
      config: CONFIG,
      createTransport: () => undefined,
      openBindingStore: () => store,
      emitDeviceChanged: () => undefined,
      emitSlotsChanged: () => undefined,
    });
    await first.start();
    await first.bind({ sessionKey: "survivor", index: 4, pinned: true });
    await first.stop();

    const second = new MacropadService({
      config: CONFIG,
      createTransport: () => undefined,
      openBindingStore: () => store,
      emitDeviceChanged: () => undefined,
      emitSlotsChanged: () => undefined,
    });
    await second.start();

    expect(second.listSlots().slots[4]).toMatchObject({
      sessionKey: "survivor",
      pinned: true,
    });
  });

  it("reports a useful error when every key is pinned", async () => {
    const harness = createHarness({
      seed: Array.from({ length: MACROPAD_SLOT_COUNT }, (_, index) => ({
        index,
        sessionKey: `s${index}`,
        pinned: true,
        lastActiveAt: index,
      })),
    });
    await harness.service.start();

    await expect(harness.service.bind({ sessionKey: "newcomer" })).rejects.toThrow(
      /every key is pinned/u,
    );
  });

  it("rejects a key index the device does not have", async () => {
    const harness = createHarness();
    await harness.service.start();

    await expect(
      harness.service.bind({ sessionKey: "s", index: MACROPAD_SLOT_COUNT }),
    ).rejects.toThrow(/key index must be 0-5/u);
  });

  it("unbinds by index and by session, idempotently", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.service.bind({ sessionKey: "s0", index: 0 });
    await harness.service.bind({ sessionKey: "s1", index: 1 });

    expect((await harness.service.unbind({ index: 0 })).slots[0]?.activity).toBe("unbound");
    expect((await harness.service.unbind({ sessionKey: "s1" })).slots[1]?.activity).toBe("unbound");
    await expect(harness.service.unbind({ index: 0 })).resolves.toBeDefined();
  });
});

describe("agent events drive the lighting", () => {
  it("auto-binds a newly active session and lights its key", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.advance();

    harness.service.handleAgentEvent({
      stream: "lifecycle",
      sessionKey: "s0",
      ts: 10,
      data: { phase: "start" },
    });
    await harness.advance();

    const slot = harness.service.listSlots().slots[0];
    expect(slot).toMatchObject({ sessionKey: "s0", activity: "thinking" });
    expect(harness.transport.lastFrame?.[0]?.effect).toBe(MACROPAD_EFFECTS.shallowBreath);
  });

  it("walks a session through thinking, approval, and error", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.advance();

    harness.service.handleAgentEvent({
      stream: "lifecycle",
      sessionKey: "s0",
      ts: 10,
      data: { phase: "start" },
    });
    harness.service.handleAgentEvent({
      stream: "approval",
      sessionKey: "s0",
      ts: 20,
      data: { phase: "requested", status: "pending" },
    });
    await harness.advance();
    expect(harness.transport.lastFrame?.[0]?.effect).toBe(MACROPAD_EFFECTS.breath);

    harness.service.handleAgentEvent({
      stream: "lifecycle",
      sessionKey: "s0",
      ts: 30,
      data: { phase: "error" },
    });
    await harness.advance();

    expect(harness.service.listSlots().slots[0]?.activity).toBe("error");
    expect(harness.transport.lastFrame?.[0]?.color).toBe(CONFIG.lighting.colorError);
  });

  it("does not auto-bind when the operator turned it off", async () => {
    const harness = createHarness({ config: { autoBind: false } });
    await harness.service.start();

    harness.service.handleAgentEvent({
      stream: "lifecycle",
      sessionKey: "s0",
      ts: 10,
      data: { phase: "start" },
    });

    expect(harness.service.listSlots().slots.every((slot) => slot.activity === "unbound")).toBe(
      true,
    );
  });

  it("evicts the least recently used key once all six are busy", async () => {
    const harness = createHarness();
    await harness.service.start();
    for (let index = 0; index < MACROPAD_SLOT_COUNT; index++) {
      harness.service.handleAgentEvent({
        stream: "lifecycle",
        sessionKey: `s${index}`,
        ts: 10 + index,
        data: { phase: "start" },
      });
    }

    harness.service.handleAgentEvent({
      stream: "lifecycle",
      sessionKey: "newcomer",
      ts: 100,
      data: { phase: "start" },
    });

    const keys = harness.service.listSlots().slots.map((slot) => slot.sessionKey);
    expect(keys).not.toContain("s0");
    expect(keys).toContain("newcomer");
    expect(keys.filter(Boolean)).toHaveLength(MACROPAD_SLOT_COUNT);
  });

  it("ignores a stream that says nothing about liveness", async () => {
    const harness = createHarness();
    await harness.service.start();

    harness.service.handleAgentEvent({ stream: "usage", sessionKey: "s0", ts: 10 });

    expect(harness.service.listSlots().slots.every((slot) => slot.activity === "unbound")).toBe(
      true,
    );
  });
});

describe("session colours", () => {
  it("tints a key with the session's own sidebar colour", async () => {
    const harness = createHarness({
      sessions: [{ key: "s0", color: "purple", status: "done", label: "Refactor" }],
    });
    await harness.service.start();
    await harness.service.bind({ sessionKey: "s0", index: 0 });
    await harness.advance();

    const slot = harness.service.listSlots().slots[0];
    expect(slot?.label).toBe("Refactor");
    expect(slot?.frame.color).toBe(MACROPAD_SESSION_COLOR_RGB.purple);
  });

  it("falls back to status colours when tinting is disabled", async () => {
    const harness = createHarness({
      config: { lighting: { ...CONFIG.lighting, useSessionColors: false } },
      sessions: [{ key: "s0", color: "purple", status: "running" }],
    });
    await harness.service.start();
    await harness.service.bind({ sessionKey: "s0", index: 0 });

    expect(harness.service.listSlots().slots[0]?.frame.color).toBe(CONFIG.lighting.colorThinking);
  });

  it("seeds cold-start status from session rows after a restart", async () => {
    const harness = createHarness({
      seed: [{ index: 1, sessionKey: "s1", pinned: false, lastActiveAt: 5 }],
      sessions: [{ key: "s1", status: "failed", lastActivityAt: 10 }],
    });

    await harness.service.start();

    expect(harness.service.listSlots().slots[1]?.activity).toBe("error");
  });

  it("survives an unavailable Gateway", async () => {
    const harness = createHarness({ listSessions: () => Promise.resolve(undefined) });

    await expect(harness.service.start()).resolves.toBeUndefined();
    expect(harness.service.listSlots().slots).toHaveLength(MACROPAD_SLOT_COUNT);
  });

  it("survives a session read that throws", async () => {
    const harness = createHarness({
      listSessions: () => Promise.reject(new Error("gateway is down")),
    });

    await expect(harness.service.start()).resolves.toBeUndefined();
  });
});

describe("inert with no device", () => {
  it("still answers every operation without a transport", async () => {
    const harness = createHarness({ noDevice: true });
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.service.deviceStatus.connected).toBe(false);
    expect(harness.service.listSlots().slots).toHaveLength(MACROPAD_SLOT_COUNT);
    await expect(harness.service.identify()).resolves.toBe(false);
    await expect(harness.service.bind({ sessionKey: "s0" })).resolves.toBeDefined();
    await expect(harness.service.stop()).resolves.toBeUndefined();
  });
});

describe("device identify", () => {
  it("reports success only when a device answered", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.advance();

    await expect(harness.service.identify()).resolves.toBe(true);
    expect(harness.transport.identifyCount).toBe(1);
  });
});

describe("event emission", () => {
  it("publishes slot and device snapshots", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.advance();
    await harness.service.bind({ sessionKey: "s0", index: 0 });

    expect(harness.devices.at(-1)?.connected).toBe(true);
    expect(harness.slots.at(-1)?.slots[0]).toMatchObject({ sessionKey: "s0" });
  });
});

describe("BufferedFeatureEmitter", () => {
  it("delivers immediately when the emitter is open", () => {
    const sent: string[] = [];
    const emitter = new BufferedFeatureEmitter();

    emitter.send("slots_changed", () => sent.push("slots"));

    expect(sent).toEqual(["slots"]);
    expect(emitter.pendingCount).toBe(0);
  });

  it("buffers instead of crashing while the Gateway service has not started", () => {
    // `defineFeaturePlugin`'s emitter throws until its own service starts, and
    // a fast device would otherwise take the plugin down on its first event.
    const sent: string[] = [];
    let open = false;
    const emitter = new BufferedFeatureEmitter();
    const deliver = (name: string) => () => {
      if (!open) {
        throw new Error("Feature event emitter is unavailable until its Gateway service starts");
      }
      sent.push(name);
    };

    emitter.send("device_changed", deliver("device"));
    emitter.send("slots_changed", deliver("slots"));
    expect(sent).toEqual([]);
    expect(emitter.pendingCount).toBe(2);

    open = true;
    emitter.flush();

    expect(sent).toEqual(["device", "slots"]);
    expect(emitter.pendingCount).toBe(0);
  });

  it("keeps only the newest payload per event name", () => {
    const sent: string[] = [];
    let open = false;
    const emitter = new BufferedFeatureEmitter();
    const deliver = (name: string) => () => {
      if (!open) {
        throw new Error("closed");
      }
      sent.push(name);
    };

    emitter.send("slots_changed", deliver("first"));
    emitter.send("slots_changed", deliver("second"));
    emitter.send("slots_changed", deliver("third"));
    expect(emitter.pendingCount).toBe(1);

    open = true;
    emitter.flush();

    expect(sent).toEqual(["third"]);
  });

  it("flushes buffered events on the next successful send", () => {
    const sent: string[] = [];
    let open = false;
    const emitter = new BufferedFeatureEmitter();
    const deliver = (name: string) => () => {
      if (!open) {
        throw new Error("closed");
      }
      sent.push(name);
    };

    emitter.send("device_changed", deliver("early-device"));
    open = true;
    emitter.send("slots_changed", deliver("later-slots"));

    expect(sent).toEqual(["early-device", "later-slots"]);
  });

  it("leaves the queue intact when the emitter is still closed", () => {
    const emitter = new BufferedFeatureEmitter();
    const boom = () => {
      throw new Error("closed");
    };

    emitter.send("device_changed", boom);
    emitter.flush();

    expect(emitter.pendingCount).toBe(1);
  });
});

describe("normalizeSessionRows", () => {
  it("reads the fields the plugin needs from an untyped Gateway payload", () => {
    const rows = normalizeSessionRows({
      sessions: [
        {
          key: "s0",
          agentId: "main",
          derivedTitle: "Fix the build",
          color: "cyan",
          status: "running",
          lastActivityAt: 42,
          lastRunError: "boom",
          somethingElse: true,
        },
      ],
    });

    expect(rows).toEqual([
      {
        key: "s0",
        agentId: "main",
        label: "Fix the build",
        color: "cyan",
        status: "running",
        lastRunError: "boom",
        lastActivityAt: 42,
      },
    ]);
  });

  it("skips rows with no session key rather than lighting a nameless slot", () => {
    expect(normalizeSessionRows({ sessions: [{ key: "" }, { key: 7 }, null, "x"] })).toEqual([]);
  });

  it("returns undefined for a payload that is not a session list", () => {
    expect(normalizeSessionRows(undefined)).toBeUndefined();
    expect(normalizeSessionRows(null)).toBeUndefined();
    expect(normalizeSessionRows({})).toBeUndefined();
    expect(normalizeSessionRows({ sessions: "nope" })).toBeUndefined();
  });
});

/**
 * The service must actually CONSUME the input stream.
 *
 * `device-link.ts` has always subscribed to `transport.onInput` and forwarded to
 * its `onInput` option - but `service.ts` never passed one, so a real event
 * travelled the whole stack and fell on the floor at the last hop with nothing
 * logged. These lock the last hop shut.
 */
describe("device input", () => {
  it("ACCEPTANCE: records a radial event at a default-on level", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.advance();

    harness.transport.emitInput({ type: "radial", angle: 0.085069, distance: 0.006819 });

    const line = harness.logs.find((entry) => entry.includes("v.oai.rad"));
    expect(line, "a radial event must be visible without enabling debug").toBeDefined();
    expect(line).toContain("angle=0.085069");
    expect(line).toContain("distance=0.006819");

    await harness.service.stop();
  });

  it("records a key event without binding it to any session action", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.advance();

    harness.transport.emitInput({ type: "key", key: "AG00", action: 1 });

    const line = harness.logs.find((entry) => entry.includes("v.oai.hid"));
    expect(line).toBeDefined();
    expect(line).toContain("key=AG00");
    expect(line).toContain("action=1");

    await harness.service.stop();
  });

  it("tears the subscription down on stop", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.advance();

    await harness.service.stop();
    const afterStop = harness.logs.length;

    // The device keeps talking after teardown; a leaked listener would log.
    harness.transport.emitInput({ type: "radial", angle: 1, distance: 1 });

    expect(harness.logs).toHaveLength(afterStop);
  });
});
