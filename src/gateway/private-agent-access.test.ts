import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MiniMePrivateMetadata } from "../mini-me/persistence.types.js";
import {
  invalidateMiniMePrivateAgentProjection,
  prepareMiniMePrivateAgentProjection,
  hasActiveMiniMeAttachment,
} from "../mini-me/private-agent-projection.js";
import {
  authorizePrivateMiniMeAgent,
  assertPrivateMiniMeAgentAccess,
} from "./private-agent-access.js";
import type { GatewayClient } from "./server-methods/types.js";
const fixture = vi.hoisted(() => ({
  metadata: { profiles: [], attachments: [] } as MiniMePrivateMetadata,
  reads: 0,
  current: true,
  identities: new Map<string, string>(),
}));
// mock-isolation: Give the fixture a physical store identity without resolving the operator state directory.
vi.mock("../state/openclaw-state-db.paths.js", () => ({
  resolveDatabasePath: () => "/fixture/private.sqlite",
}));
// mock-isolation: Keep process database lifecycle subscriptions out of the synthetic projection fixture.
vi.mock("../state/openclaw-state-db-cache.js", () => ({
  registerOpenClawStateDatabaseLifecycleListener: () => () => {},
}));
// mock-isolation: Control retained read admission without opening a real database worker.
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  prepareOpenClawStateReadSource: () => ({
    workerContext: () => ({}),
    current: () => ({
      admission: {
        assertCurrent: () => {
          if (!fixture.current) {
            throw new Error("physical store replaced");
          }
        },
      },
    }),
  }),
}));
// mock-isolation: Publish fixture-owned metadata through a controlled worker port; no real worker starts.
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: async (
    _context: unknown,
    operation: (scope: unknown) => unknown,
  ) =>
    operation({
      execute: () => {
        fixture.reads++;
        return structuredClone(fixture.metadata);
      },
    }),
}));
// mock-isolation: The fixture owns canonical identity relinking and revocation, independently of the resident profile catalog.
vi.mock("../state/user-profile-list.js", () => ({
  readResidentUserProfileId: (id: string) => fixture.identities.get(id),
  captureResidentUserProfileAccess: (id: string) => ({
    assertCurrent: () => {
      if (!fixture.identities.has(id)) {
        throw new Error("identity unavailable");
      }
    },
    readCurrentFacts: () => ({ profileId: fixture.identities.get(id) }),
  }),
}));
function client(profileId: string, admin = false): GatewayClient {
  // SAFETY: The fixture includes only the authoritative fields consumed by this boundary.
  return {
    authenticatedUserProfile: { profileId },
    connect: { scopes: admin ? ["operator.admin"] : [] },
  } as GatewayClient;
}
const cfg: OpenClawConfig = {
  agents: {
    entries: { colt: { miniMe: { ownerProfileId: "alice", profileId: "colt-profile" } }, main: {} },
  },
};
function mapped(lifecycle: MiniMePrivateMetadata["profiles"][number]["lifecycle"] = "active") {
  fixture.metadata = {
    profiles: [
      {
        ownerId: "alice",
        miniMeId: "colt-profile",
        agentId: "colt",
        lifecycle,
        generation: 1,
        revision: 2,
      },
    ],
    attachments:
      lifecycle === "active"
        ? [
            {
              ownerId: "alice",
              miniMeId: "colt-profile",
              targetAgentId: "main",
              profileGeneration: 1,
              attachmentRevision: 3,
            },
          ]
        : [],
  };
}
beforeEach(() => {
  fixture.reads = 0;
  fixture.current = true;
  fixture.identities = new Map([
    ["alice", "alice"],
    ["bob", "bob"],
  ]);
  fixture.metadata = { profiles: [], attachments: [] };
  invalidateMiniMePrivateAgentProjection();
});
describe("private Mini Me agent owner boundary", () => {
  it("prepares once and leaves deferred ordinary agents usable without further worker reads", async () => {
    await prepareMiniMePrivateAgentProjection();
    await prepareMiniMePrivateAgentProjection();
    expect(
      authorizePrivateMiniMeAgent({ cfg, client: client("bob", true), agentId: "main" }),
    ).toBeNull();
    expect(hasActiveMiniMeAttachment("alice", "main")).toBe(false);
    expect(fixture.reads).toBe(1);
  });
  it("keeps cold ownership closed for representable IDs while unrepresentable IDs stay ordinary", async () => {
    // Gateway startup and request pre-dispatch hydrate first; a cold reader never guesses absence.
    const admin = client("bob", true);
    expect(authorizePrivateMiniMeAgent({ cfg, client: admin, agentId: "main" })).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(authorizePrivateMiniMeAgent({ cfg, client: admin, agentId: "агент✨" })).toBeNull();
    expect(fixture.reads).toBe(0);
    await prepareMiniMePrivateAgentProjection();
    expect(authorizePrivateMiniMeAgent({ cfg, client: admin, agentId: "main" })).toBeNull();
    expect(authorizePrivateMiniMeAgent({ cfg, client: null, agentId: "missing" })).toBeNull();
  });
  it("denies unprepared or physically revoked facts without fallback hydration", async () => {
    expect(
      authorizePrivateMiniMeAgent({ cfg, client: client("alice"), agentId: "colt" }),
    ).not.toBeNull();
    expect(hasActiveMiniMeAttachment("alice", "main")).toBe(false);
    expect(fixture.reads).toBe(0);
    mapped();
    await prepareMiniMePrivateAgentProjection();
    fixture.current = false;
    expect(
      authorizePrivateMiniMeAgent({ cfg, client: client("alice"), agentId: "colt" }),
    ).not.toBeNull();
    expect(fixture.reads).toBe(1);
  });
  it("allows only current canonical owner despite admin and wildcard-style scope", async () => {
    mapped();
    await prepareMiniMePrivateAgentProjection();
    expect(
      authorizePrivateMiniMeAgent({ cfg, client: client("alice"), agentId: "colt" }),
    ).toBeNull();
    expect(
      authorizePrivateMiniMeAgent({ cfg, client: client("bob", true), agentId: "colt" }),
    ).not.toBeNull();
    expect(authorizePrivateMiniMeAgent({ cfg, client: null, agentId: "colt" })).not.toBeNull();
    expect(hasActiveMiniMeAttachment("alice", "main")).toBe(true);
    fixture.identities.set("alice", "bob");
    expect(
      authorizePrivateMiniMeAgent({ cfg, client: client("bob", true), agentId: "colt" }),
    ).not.toBeNull();
    expect(hasActiveMiniMeAttachment("alice", "main")).toBe(false);
  });
  it("configuration removal cannot bypass durable ownership or deleted tombstones", async () => {
    mapped("disabled");
    await prepareMiniMePrivateAgentProjection();
    const noMarker: OpenClawConfig = { agents: { entries: { colt: {} } } };
    expect(
      authorizePrivateMiniMeAgent({ cfg: noMarker, client: client("alice"), agentId: "colt" }),
    ).toBeNull();
    expect(
      authorizePrivateMiniMeAgent({ cfg: noMarker, client: client("bob", true), agentId: "colt" }),
    ).not.toBeNull();
    expect(
      authorizePrivateMiniMeAgent({ cfg: noMarker, client: client("bob", true), agentId: "COLT" }),
    ).not.toBeNull();
    invalidateMiniMePrivateAgentProjection();
    mapped("deleted");
    await prepareMiniMePrivateAgentProjection();
    expect(
      authorizePrivateMiniMeAgent({ cfg: noMarker, client: client("alice"), agentId: "colt" }),
    ).not.toBeNull();
  });
  it("routes the owner's generic agent updates and deletion through Mini Me lifecycle controls", async () => {
    mapped();
    await prepareMiniMePrivateAgentProjection();
    expect(
      authorizePrivateMiniMeAgent({
        cfg,
        client: client("alice"),
        agentId: "colt",
        ordinaryAgentMutation: true,
      }),
    ).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("Mini Me settings"),
    });
    expect(
      authorizePrivateMiniMeAgent({
        cfg,
        client: client("bob", true),
        agentId: "colt",
        ordinaryAgentMutation: true,
      }),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      authorizePrivateMiniMeAgent({
        cfg,
        client: client("alice"),
        agentId: "main",
        ordinaryAgentMutation: true,
      }),
    ).toBeNull();
  });
  it("accepts only the current original owner authority across lifecycle service calls", async () => {
    mapped();
    await prepareMiniMePrivateAgentProjection();
    let current = true;
    const owner = createAdmittedRunOperatorAuthority({
      profileId: "alice",
      scopes: ["operator.write"],
      assertCurrent() {
        if (!current) {
          throw new Error("revoked");
        }
      },
    });
    const foreign = createAdmittedRunOperatorAuthority({
      profileId: "bob",
      scopes: ["operator.admin"],
      assertCurrent() {},
    });
    expect(
      authorizePrivateMiniMeAgent({
        cfg,
        client: null,
        agentId: "colt",
        operatorAuthority: owner,
        authorityProfileId: "alice",
      }),
    ).toBeNull();
    expect(
      authorizePrivateMiniMeAgent({
        cfg,
        client: null,
        agentId: "colt",
        operatorAuthority: foreign,
        authorityProfileId: "bob",
      }),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      authorizePrivateMiniMeAgent({
        cfg,
        client: null,
        agentId: "colt",
        operatorAuthority: { profileId: "alice", scopes: ["operator.admin"], assertCurrent() {} },
        authorityProfileId: "alice",
      }),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      authorizePrivateMiniMeAgent({
        cfg,
        client: null,
        agentId: "colt",
        operatorAuthority: owner,
        authorityProfileId: "bob",
      }),
    ).toMatchObject({ code: "FORBIDDEN" });
    current = false;
    expect(
      authorizePrivateMiniMeAgent({
        cfg,
        client: null,
        agentId: "colt",
        operatorAuthority: owner,
        authorityProfileId: "alice",
      }),
    ).toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps ordinary agents available while a Mini Me metadata mutation closes private admission", async () => {
    mapped();
    await prepareMiniMePrivateAgentProjection();
    invalidateMiniMePrivateAgentProjection({}, true);
    expect(authorizePrivateMiniMeAgent({ cfg, client: client("bob"), agentId: "main" })).toBeNull();
    expect(
      authorizePrivateMiniMeAgent({ cfg, client: client("alice"), agentId: "colt" }),
    ).not.toBeNull();
    fixture.current = false;
    expect(
      authorizePrivateMiniMeAgent({ cfg, client: client("bob"), agentId: "main" }),
    ).not.toBeNull();
  });
  it("a configuration marker alone cannot confer ownership and forged synthetic approval is rejected", async () => {
    await prepareMiniMePrivateAgentProjection();
    expect(
      authorizePrivateMiniMeAgent({ cfg, client: client("alice"), agentId: "colt" }),
    ).not.toBeNull();
    invalidateMiniMePrivateAgentProjection();
    mapped();
    await prepareMiniMePrivateAgentProjection();
    const synthetic = client("alice", true);
    synthetic.internal = { syntheticClient: true };
    expect(authorizePrivateMiniMeAgent({ cfg, client: synthetic, agentId: "colt" })).not.toBeNull();
  });
  it("requires branded current run authority and rechecks revocation after awaits", async () => {
    mapped();
    await prepareMiniMePrivateAgentProjection();
    const synthetic = client("alice");
    synthetic.internal = {
      syntheticClient: true,
      operatorRoleActor: { kind: "operator", profileId: "alice" },
      operatorRunAuthority: createAdmittedRunOperatorAuthority({
        profileId: "alice",
        scopes: ["operator.write"],
        assertCurrent: () => {
          if (!fixture.current) {
            throw new Error("revoked");
          }
        },
      }),
    };
    assertPrivateMiniMeAgentAccess({ cfg, client: synthetic, agentId: "colt" });
    await Promise.resolve();
    invalidateMiniMePrivateAgentProjection();
    expect(() =>
      assertPrivateMiniMeAgentAccess({ cfg, client: synthetic, agentId: "colt" }),
    ).toThrow();
  });
});
