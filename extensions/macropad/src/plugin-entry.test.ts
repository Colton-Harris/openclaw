/**
 * Registration smoke tests.
 *
 * The bar these hold is "bundled, enabled by default, and completely inert
 * without its hardware" - the same posture `linux-node` has off-Linux. A user
 * with no macropad must never see a throw, a crash, or a log line from this
 * plugin.
 */
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MACROPAD_SLOT_COUNT } from "../contract.js";
import macropadPlugin from "../index.js";

type SessionAction = {
  id: string;
  requiredScopes?: string[];
  handler: (action: { payload: unknown }) => Promise<{ ok?: boolean; result?: unknown }>;
};

function register(overrides: Partial<OpenClawPluginApi> = {}) {
  const services: OpenClawPluginService[] = [];
  const actions = new Map<string, SessionAction>();
  const subscriptions: Array<{ id: string; streams?: string[] }> = [];
  const logs: string[] = [];
  const api = createTestPluginApi({
    id: "macropad",
    name: "macropad",
    logger: {
      debug: (message: string) => logs.push(`debug:${message}`),
      info: (message: string) => logs.push(`info:${message}`),
      warn: (message: string) => logs.push(`warn:${message}`),
      error: (message: string) => logs.push(`error:${message}`),
    },
    registerService: (service: OpenClawPluginService) => {
      services.push(service);
    },
    registerSessionAction: (action: unknown) => {
      const typed = action as SessionAction;
      actions.set(typed.id, typed);
    },
    registerAgentEventSubscription: (subscription: unknown) => {
      subscriptions.push(subscription as { id: string; streams?: string[] });
    },
    runtime: {
      gateway: {
        isAvailable: () => Promise.resolve(false),
        request: () => Promise.reject(new Error("no gateway in this test")),
      },
      state: {
        openKeyedStore: () => ({
          register: () => Promise.resolve(),
          delete: () => Promise.resolve(false),
          entries: () => Promise.resolve([]),
        }),
      },
    } as unknown as OpenClawPluginApi["runtime"],
    ...overrides,
  });

  macropadPlugin.register(api);

  return { api, services, actions, subscriptions, logs };
}

const SERVICE_CONTEXT = {
  config: {},
  stateDir: "/tmp/macropad-test",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
} as unknown as OpenClawPluginServiceContext;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("plugin registration", () => {
  it("registers without throwing", () => {
    expect(() => register()).not.toThrow();
  });

  it("exposes every contract operation as a scoped session action", () => {
    const { actions } = register();

    expect([...actions.keys()].toSorted()).toEqual([
      "device.get",
      "device.identify",
      "slots.bind",
      "slots.list",
      "slots.unbind",
    ]);
    expect(actions.get("slots.list")?.requiredScopes).toEqual(["operator.read"]);
    expect(actions.get("slots.bind")?.requiredScopes).toEqual(["operator.write"]);
  });

  it("registers the device service and the feature-event service", () => {
    const { services } = register();

    expect(services.map((service) => service.id).toSorted()).toEqual([
      "macropad-device",
      "macropad:feature-events",
    ]);
  });

  it("subscribes only to the streams that describe liveness", () => {
    const { subscriptions } = register();

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.streams).toEqual([
      "lifecycle",
      "approval",
      "thinking",
      "assistant",
      "error",
    ]);
  });

  it("opens no device outside full registration mode", () => {
    // Discovery and setup-only passes must not touch hardware. The SDK still
    // registers its own feature-event service; ours is the one that must not
    // appear.
    const { services, subscriptions } = register({ registrationMode: "discovery" });

    expect(services.map((service) => service.id)).toEqual(["macropad:feature-events"]);
    expect(subscriptions).toEqual([]);
  });
});

describe("inert with no device attached", () => {
  it("starts and stops its service silently", async () => {
    const { services, logs } = register();
    const device = services.find((service) => service.id === "macropad-device");

    await device?.start(SERVICE_CONTEXT);
    await vi.advanceTimersByTimeAsync(120_000);
    await device?.stop?.(SERVICE_CONTEXT);

    expect(logs).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers device.get with a disconnected status", async () => {
    const { services, actions } = register();
    await services.find((service) => service.id === "macropad-device")?.start(SERVICE_CONTEXT);
    await vi.advanceTimersByTimeAsync(0);

    const result = await actions.get("device.get")?.handler({ payload: {} });

    expect(result?.ok).toBe(true);
    expect(result?.result).toEqual({
      connected: false,
      slotCount: 0,
      inputPermissionRequired: false,
    });
  });

  it("answers slots.list with a full, empty key set", async () => {
    const { services, actions } = register();
    await services.find((service) => service.id === "macropad-device")?.start(SERVICE_CONTEXT);
    await vi.advanceTimersByTimeAsync(0);

    const result = (await actions.get("slots.list")?.handler({ payload: {} })) as {
      result: { slots: unknown[] };
    };

    expect(result.result.slots).toHaveLength(MACROPAD_SLOT_COUNT);
  });

  it("reports identify as a no-op rather than failing", async () => {
    const { services, actions } = register();
    await services.find((service) => service.id === "macropad-device")?.start(SERVICE_CONTEXT);
    await vi.advanceTimersByTimeAsync(0);

    const result = await actions.get("device.identify")?.handler({ payload: {} });

    expect(result?.result).toEqual({ ok: false });
  });

  it("answers before its service has started instead of throwing", async () => {
    // Registration and service start are separate phases; a query that lands in
    // between must degrade, not fail.
    const { actions } = register();

    const device = await actions.get("device.get")?.handler({ payload: {} });
    const slots = (await actions.get("slots.list")?.handler({ payload: {} })) as {
      result: { slots: unknown[] };
    };

    expect(device?.result).toMatchObject({ connected: false });
    expect(slots.result.slots).toEqual([]);
  });

  it("still binds and unbinds keys with no device present", async () => {
    const { services, actions } = register();
    await services.find((service) => service.id === "macropad-device")?.start(SERVICE_CONTEXT);
    await vi.advanceTimersByTimeAsync(0);

    const bound = (await actions
      .get("slots.bind")
      ?.handler({ payload: { sessionKey: "agent:main:x", index: 3 } })) as {
      result: { slots: Array<{ sessionKey?: string }> };
    };

    expect(bound.result.slots[3]?.sessionKey).toBe("agent:main:x");
    await expect(
      actions.get("slots.unbind")?.handler({ payload: { index: 3 } }),
    ).resolves.toBeDefined();
  });

  it("rejects a payload the contract does not allow", async () => {
    const { services, actions } = register();
    await services.find((service) => service.id === "macropad-device")?.start(SERVICE_CONTEXT);

    const result = await actions.get("slots.bind")?.handler({ payload: { index: 99 } });

    expect(result?.ok).toBe(false);
  });
});

describe("config", () => {
  it("leaves the device closed when the plugin is disabled", async () => {
    const { services, logs } = register({
      pluginConfig: { enabled: false },
    });
    const device = services.find((service) => service.id === "macropad-device");

    await device?.start(SERVICE_CONTEXT);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(logs).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the service when its own config subtree changes", () => {
    const { services } = register();

    expect(services.find((service) => service.id === "macropad-device")?.reload).toEqual({
      configPrefixes: ["plugins.entries.macropad.config"],
    });
  });
});

describe("battery fields", () => {
  it("omits battery entirely when no device is attached", async () => {
    // Both fields are optional; `additionalProperties: false` means emitting
    // them as undefined would fail contract validation.
    const { services, actions } = register();
    await services.find((service) => service.id === "macropad-device")?.start(SERVICE_CONTEXT);
    await vi.advanceTimersByTimeAsync(0);

    const result = await actions.get("device.get")?.handler({ payload: {} });

    expect(result?.ok).toBe(true);
    expect(Object.keys(result?.result as object).toSorted()).toEqual([
      "connected",
      "inputPermissionRequired",
      "slotCount",
    ]);
  });
});
