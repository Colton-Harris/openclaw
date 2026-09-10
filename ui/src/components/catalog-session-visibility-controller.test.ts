import type { ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import { CatalogSessionVisibilityController } from "./catalog-session-visibility-controller.ts";

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

const controllers: CatalogSessionVisibilityController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.hostDisconnected();
  }
});

function fixture(entries: Record<string, unknown> = {}) {
  const session: SessionCatalogSession = {
    threadId: "Same:Thread",
    sourceHomeId: "home-a",
    sourceRevision: "revision-a",
    status: "stored",
    updatedAt: 100,
    createdAt: 50,
    archived: false,
    canContinue: true,
    canArchive: false,
  };
  const catalogs: SessionCatalog[] = [
    {
      id: "claude",
      label: "Claude",
      capabilities: { continueSession: true, archive: false },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local",
          kind: "gateway",
          connected: true,
          sessions: [session],
        },
      ],
    },
  ];
  const listeners = new Set<(event: GatewayEventFrame) => void>();
  let listed = catalogs;
  let selectedKey = "";
  let durable = true;
  const owner: GatewaySessionRow = {
    key: "agent:main:closed",
    sessionId: "closed-session-id",
    kind: "direct",
    updatedAt: 100,
    archived: true,
    status: "done",
    hasActiveRun: false,
    activeRunIds: [],
    hasActiveSubagentRun: false,
    subagentRunState: "historical",
    placement: {
      state: "local",
      generation: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
      stateChangedAtMs: 1,
    },
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.prefs.get") {
      return durable
        ? { status: "ok", entries: { ...entries } }
        : { status: "no_durable_identity" };
    }
    if (method === "users.prefs.set") {
      for (const [key, value] of Object.entries(
        (params as { entries: Record<string, unknown> }).entries,
      )) {
        if (value === null) {
          delete entries[key];
        } else {
          entries[key] = value;
        }
      }
      return { status: "ok" };
    }
    if (method === "sessions.catalog.list") {
      return { catalogs: listed };
    }
    if (method === "sessions.list") {
      return { sessions: [owner], hasMore: false, nextOffset: null };
    }
    throw new Error(`Unexpected side effect: ${method}`);
  });
  const gateway = {
    snapshot: { phase: "connected", selfUser: { id: "profile-a" }, client: { request } },
    subscribeEvents: (listener: (event: GatewayEventFrame) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as ApplicationGateway;
  const create = async () => {
    const host: ReactiveControllerHost = {
      addController: () => {},
      removeController: () => {},
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    };
    const controller = new CatalogSessionVisibilityController(host, {
      gateway: () => gateway,
      catalogs: () => catalogs,
      selectedKey: () => selectedKey,
    });
    controllers.push(controller);
    controller.hostUpdate();
    await vi.waitFor(() =>
      expect(controller.action(menu())).toBe(entriesCount() ? "restore" : "hide"),
    );
    return controller;
  };
  const entriesCount = () => Object.keys(entries).length;
  const menu = (): CatalogSessionMenuRequest => ({
    key: { catalogId: "claude", hostId: "gateway:local", threadId: session.threadId },
    sourceHomeId: session.sourceHomeId,
    sourceRevision: session.sourceRevision,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    agentId: "main",
    routeId: "chat",
    navigation: {},
    meta: "",
    canOpenTerminal: true,
  });
  return {
    entries,
    session,
    catalogs,
    request,
    gateway,
    owner,
    create,
    menu,
    setListed: (value: SessionCatalog[]) => {
      listed = value;
    },
    select: () => {
      selectedKey = buildCatalogSessionKey(menu().key);
    },
    selectOwner: () => {
      selectedKey = owner.key;
    },
    loseIdentity: () => {
      durable = false;
    },
    changed: () => {
      for (const listener of listeners) {
        listener({
          event: "users.prefs.changed",
          payload: { profileId: "profile-a", keys: Object.keys(entries) },
        } as GatewayEventFrame);
      }
    },
    ownerChanged: () => {
      for (const listener of listeners) {
        listener({ event: "sessions.changed", payload: { key: owner.key } } as GatewayEventFrame);
      }
    },
  };
}

const rows = (controller: CatalogSessionVisibilityController, catalogs: SessionCatalog[]) =>
  controller.project(catalogs).flatMap((catalog) => catalog.hosts.flatMap((host) => host.sessions));

describe("personal catalog session visibility", () => {
  it.each([
    { sessionId: "replacement-session" },
    { archived: false },
    { status: "queued" },
    { hasActiveRun: true },
    { hasActiveRun: undefined },
    { activeRunIds: ["new-run"] },
    { activeRunIds: undefined },
    { hasActiveSubagentRun: true },
    { subagentRunState: "active" },
    { pinned: true },
    { hasAutomation: true },
    { placement: undefined },
  ])(
    "revalidates explicit closed-owner receipts and reveals changed owners: %j",
    async (change) => {
      const f = fixture();
      const controller = await f.create();
      await controller.set(f.menu(), "hide");
      f.session.sessionKey = f.owner.key;
      expect(rows(controller, f.catalogs)).toEqual([f.session]);
      const saved = Object.values(f.entries)[0] as Record<string, unknown>;
      saved.closedOwner = { key: f.owner.key, sessionId: f.owner.sessionId };
      f.changed();
      await vi.waitFor(() => expect(rows(controller, f.catalogs)).toEqual([]));
      Object.assign(f.owner, change);
      f.ownerChanged();
      expect(rows(controller, f.catalogs)).toEqual([f.session]);
      await vi.waitFor(() =>
        expect(f.request).toHaveBeenCalledWith("sessions.list", {
          archived: true,
          limit: 100,
          offset: 0,
        }),
      );
      await Promise.resolve();
      expect(rows(controller, f.catalogs)).toEqual([f.session]);
      await controller.set(f.menu(), "restore");
      expect(f.entries).toEqual({});
    },
  );
  it("persists only an exact revision preference, leaves the source readable, and restores after reload", async () => {
    const f = fixture();
    const controller = await f.create();
    await controller.set(f.menu(), "hide");
    expect(rows(controller, f.catalogs)).toEqual([]);
    expect(f.catalogs[0]!.hosts[0]!.sessions).toEqual([f.session]);
    expect(Object.values(f.entries)).toEqual([
      {
        identity: JSON.stringify(["claude", "gateway:local", "home-a", "Same:Thread"]),
        sourceRevision: "revision-a",
        updatedAt: 100,
        createdAt: 50,
      },
    ]);
    controller.hostDisconnected();
    const reloaded = await f.create();
    expect(rows(reloaded, f.catalogs)).toEqual([]);
    reloaded.toggleShowHidden("claude");
    expect(rows(reloaded, f.catalogs)).toEqual([f.session]);
    await reloaded.set(f.menu(), "restore");
    reloaded.toggleShowHidden("claude");
    expect(rows(reloaded, f.catalogs)).toEqual([f.session]);
    expect(f.entries).toEqual({});
    expect(new Set(f.request.mock.calls.map(([method]) => method))).toEqual(
      new Set(["users.prefs.get", "users.prefs.set", "sessions.catalog.list"]),
    );
  });

  it("does not conflate identical thread IDs from another home, host, or provider", async () => {
    const f = fixture();
    const controller = await f.create();
    await controller.set(f.menu(), "hide");
    const otherHome = { ...f.session, sourceHomeId: "home-b" };
    const otherHost = {
      ...f.catalogs[0]!.hosts[0]!,
      hostId: "node:local",
      sessions: [{ ...f.session }],
    };
    const otherProvider = {
      ...f.catalogs[0]!,
      id: "codex",
      hosts: [{ ...f.catalogs[0]!.hosts[0]!, sessions: [{ ...f.session }] }],
    };
    f.catalogs[0]!.hosts[0]!.sessions.push(otherHome);
    f.catalogs[0]!.hosts.push(otherHost);
    f.catalogs.push(otherProvider);
    expect(rows(controller, f.catalogs)).toEqual([
      otherHome,
      ...otherHost.sessions,
      ...otherProvider.hosts[0]!.sessions,
    ]);
  });

  it.each([
    { sourceRevision: "revision-b" },
    { sourceRevision: undefined },
    { sourceHomeId: undefined },
    { updatedAt: 101 },
    { createdAt: 51 },
    { status: "running" },
    { status: "pending" },
    { status: "unknown" },
    { status: "notLoaded" },
    { sessionKey: "agent:main:adopted" },
  ])("reveals and protects changed or owned source rows: %j", async (change) => {
    const f = fixture();
    const controller = await f.create();
    const staleMenu = f.menu();
    await controller.set(staleMenu, "hide");
    Object.assign(f.session, change);
    expect(rows(controller, f.catalogs)).toEqual([f.session]);
    await controller.set(staleMenu, "hide");
    expect(f.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1);
  });

  it("rejects a stale menu even when source timestamps did not change", async () => {
    const f = fixture();
    const controller = await f.create();
    const stale = f.menu();
    f.session.sourceRevision = "revision-b";
    expect(controller.action(stale)).toBeNull();
    await controller.set(stale, "hide");
    expect(f.entries).toEqual({});
  });

  it.each([{ sourceRevision: "revision-b" }, { sourceHomeId: "home-b" }, { status: "running" }])(
    "rechecks the provider before hiding despite an unchanged UI snapshot: %j",
    async (change) => {
      const f = fixture();
      const controller = await f.create();
      f.setListed([
        {
          ...f.catalogs[0]!,
          hosts: [{ ...f.catalogs[0]!.hosts[0]!, sessions: [{ ...f.session, ...change }] }],
        },
      ]);
      await controller.set(f.menu(), "hide");
      expect(f.entries).toEqual({});
    },
  );

  it("keeps selected and disconnected rows visible and clears stale preferences after identity loss", async () => {
    const f = fixture();
    const controller = await f.create();
    await controller.set(f.menu(), "hide");
    f.catalogs[0]!.hosts[0]!.connected = false;
    expect(rows(controller, f.catalogs)).toEqual([f.session]);
    f.catalogs[0]!.hosts[0]!.connected = true;
    f.loseIdentity();
    f.changed();
    await vi.waitFor(() => expect(rows(controller, f.catalogs)).toEqual([f.session]));
    expect(controller.action(f.menu())).toBeNull();
  });

  it.each([false, true])(
    "keeps the currently open hidden history visible (adopted: %s)",
    async (adopted) => {
      const f = fixture();
      const controller = await f.create();
      await controller.set(f.menu(), "hide");
      if (adopted) {
        f.session.sessionKey = f.owner.key;
        const saved = Object.values(f.entries)[0] as Record<string, unknown>;
        saved.closedOwner = { key: f.owner.key, sessionId: f.owner.sessionId };
        f.changed();
        await vi.waitFor(() => expect(rows(controller, f.catalogs)).toEqual([]));
        f.selectOwner();
      } else {
        f.select();
      }
      expect(rows(controller, f.catalogs)).toEqual([f.session]);
    },
  );
});
