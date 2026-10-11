import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { assert, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MiniMeBelief,
  MiniMePrediction,
  MiniMeSource,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { getOpenClawAgentMigrationSchema } from "../state/openclaw-agent-db-schema-helpers.js";
import { getOpenClawStateRuntimeSchema } from "../state/openclaw-state-schema-compatibility.js";
import { bindSqliteWorkerBackend } from "./persistence.agent-worker.js";
import { executeMiniMeStateCommand } from "./persistence.state-worker.js";
import type {
  MiniMeContentScope,
  MiniMeContentWorkerOperations,
  MiniMeProfileState,
  MiniMeStateWorkerOperations,
} from "./persistence.types.js";

const fixture = vi.hoisted(() => ({
  state: undefined as DatabaseSync | undefined,
  agent: undefined as DatabaseSync | undefined,
  reject: undefined as "transaction" | "commit" | undefined,
}));
function transaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = write();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
// mock-isolation: Use only the fixture-owned in-memory SQLite and transaction owner, not the process database lifecycle.
vi.mock("../state/openclaw-state-db.js", () => ({
  openOpenClawStateDatabase: () => ({ db: fixture.state, path: "/fixture/state.sqlite" }),
  runOpenClawStateWriteTransaction: (write: (current: { db: DatabaseSync }) => unknown) =>
    transaction(fixture.state!, () => write({ db: fixture.state! })),
}));
// mock-isolation: Use only the fixture-owned in-memory agent SQLite and transaction owner, not an admitted process store.
vi.mock("../state/openclaw-agent-db.js", () => ({
  getOpenClawAgentDatabaseIfOpen: () => ({ db: fixture.agent, path: "/fixture/agent.sqlite" }),
  runOpenClawAgentWriteTransaction: (write: (current: { db: DatabaseSync }) => unknown) =>
    transaction(fixture.agent!, () => write({ db: fixture.agent! })),
}));
// mock-isolation: Canonical test identities belong to this fixture; do not consult the process profile metadata cache.
vi.mock("../state/user-profiles-internal.js", () => ({
  selectResolvedUserProfileMetadataById: (_db: DatabaseSync, id: string) =>
    ["alice", "bob"].includes(id) ? { id } : undefined,
}));
// mock-isolation: The inline worker fixture supplies its own environment and never captures operator worker state.
vi.mock("../infra/sqlite-worker-state-context.js", () => ({
  getSqliteWorkerStateContext: () => ({ environment: {} }),
}));
// mock-isolation: Control the transaction and commit revocation seams independently of process worker admission.
vi.mock("../infra/sqlite-worker-operation-admission.js", () => ({
  requestSqliteWorkerOperationAdmission: ({ stage }: { stage: string }) => {
    if (stage === fixture.reject) {
      throw new Error("captured authority revoked");
    }
  },
}));
// mock-isolation: Supply schema facts from the fixture database without borrowing the resident admission cache.
vi.mock("../infra/sqlite-schema-facts.js", () => ({
  getAdmittedSqliteSchemaFacts: (db: DatabaseSync) => ({
    tables: new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all()
        .map((row) => String(row.name)),
    ),
    indexes: new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='index'")
        .all()
        .map((row) => String(row.name)),
    ),
  }),
  runSqliteReadOperationSync: (_db: DatabaseSync, read: () => unknown) => read(),
}));
let state: DatabaseSync, agent: DatabaseSync;
let backend: ReturnType<typeof bindSqliteWorkerBackend>;
function shared<Key extends keyof MiniMeStateWorkerOperations>(
  type: Key,
  input: MiniMeStateWorkerOperations[Key]["input"],
): MiniMeStateWorkerOperations[Key]["output"] {
  // SAFETY: Tests call the same paired command union as the public worker facade.
  return executeMiniMeStateCommand(
    { type, input } as Parameters<typeof executeMiniMeStateCommand>[0],
    {},
  ) as MiniMeStateWorkerOperations[Key]["output"];
}
function content<Key extends keyof MiniMeContentWorkerOperations>(
  type: Key,
  input: MiniMeContentWorkerOperations[Key]["input"],
): MiniMeContentWorkerOperations[Key]["output"] {
  // SAFETY: Tests call the same paired command union as the public worker facade.
  return backend.execute({ type, input } as Parameters<
    typeof backend.execute
  >[0]) as MiniMeContentWorkerOperations[Key]["output"];
}
const models = { conversationModel: null, decisionModel: null, allowInference: false };
function create(ownerId = "alice") {
  return shared("miniMe.beginCreate", {
    ownerId,
    operationId: `create-${ownerId}`,
    name: "Colt",
    models,
  });
}
const scope: MiniMeContentScope = {
  ownerId: "alice",
  miniMeId: "mini-me-fixture",
  agentId: "mini-me-agent",
  generation: 0,
};
const source: MiniMeSource = {
  id: "manual",
  selection: { kind: "manual", label: "Owner preferences" },
  revision: 0,
  status: "ready",
  lastIngestedAt: null,
  detail: null,
};
function initialize() {
  content("initialize", { scope, operationId: "init" });
  content("addSource", { scope, operationId: "source", source });
}
function belief(
  id = "belief",
  origin: MiniMeBelief["origin"] = "direct",
  revision = "r1",
): MiniMeBelief {
  return {
    id,
    preference: {
      document: "PREFERENCES.md",
      scope: "coffee",
      statement: "Choose tea",
      preferred: ["tea"],
      avoided: ["coffee"],
    },
    origin,
    evidence: [{ sourceId: "manual", sourceRevision: revision, excerpt: "I prefer tea" }],
    status: "active",
    supersedes: null,
    createdAt: 1,
  };
}
function prediction(id = "prediction"): MiniMePrediction {
  return {
    id,
    agentId: "hq",
    choice: {
      scope: "coffee",
      question: "Tea or coffee?",
      options: [
        { id: "tea", label: "Tea", value: "tea" },
        { id: "coffee", label: "Coffee", value: "coffee" },
      ],
    },
    optionId: "tea",
    explanation: "Owner prefers tea",
    uncertainty: "low",
    evidence: belief().evidence,
    beliefIds: ["belief"],
    correctionApplied: false,
    provider: "local-rule",
    rubricVersion: "owner-preference-v1",
    providerRuntimeGeneration: null,
    createdAt: 2,
    profileGeneration: 0,
    contentRevision: content("readSnapshot", { scope }).contentRevision,
    authority: "advisory",
  };
}
beforeEach(() => {
  state = new DatabaseSync(":memory:");
  agent = new DatabaseSync(":memory:");
  state.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE user_profiles(id TEXT PRIMARY KEY) STRICT;INSERT INTO user_profiles VALUES('alice'),('bob');",
  );
  agent.exec("PRAGMA foreign_keys=ON");
  fixture.state = state;
  fixture.agent = agent;
  fixture.reject = undefined;
  backend = bindSqliteWorkerBackend(
    { agentId: scope.agentId },
    {
      database: agent,
      databasePath: "/fixture/agent.sqlite",
      admit(stage) {
        if (stage === fixture.reject) {
          throw new Error("captured authority revoked");
        }
      },
    },
  );
});
afterEach(() => {
  state.close();
  agent.close();
  fixture.state = undefined;
  fixture.agent = undefined;
});
describe("Mini Me typed persistence boundaries", () => {
  it("leaves feature tables absent on deferral and isolates the canonical person", () => {
    expect(shared("miniMe.read", { ownerId: "alice" })).toBeNull();
    expect(
      state.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'mini_me_%'").all(),
    ).toEqual([]);
    expect(getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: true })).not.toContain(
      "CREATE TABLE IF NOT EXISTS mini_me_",
    );
    expect(getOpenClawAgentMigrationSchema(25)).not.toContain(
      "CREATE TABLE IF NOT EXISTS mini_me_",
    );
    const profile = create();
    expect(shared("miniMe.read", { ownerId: "bob", miniMeId: profile.id })).toBeNull();
    expect(create()).toEqual(profile);
    expect(() =>
      shared("miniMe.beginCreate", {
        ownerId: "alice",
        operationId: "another",
        name: "Other",
        models,
      }),
    ).toThrow("already has");
    expect(() =>
      shared("miniMe.beginCreate", {
        ownerId: "alice",
        operationId: "create-alice",
        name: "Changed",
        models,
      }),
    ).toThrow("different input");
    expect(create("bob").id).not.toBe(profile.id);
  });
  it("commits the belief batch, cursor and dedup receipt together, with generation and owner fences", () => {
    initialize();
    fixture.reject = "commit";
    expect(() =>
      content("learnBatch", {
        scope,
        operationId: "learn",
        beliefs: [belief()],
        sourceId: "manual",
        expectedCursor: null,
        cursor: "event1",
      }),
    ).toThrow("revoked");
    fixture.reject = undefined;
    expect(content("sourceCursor", { scope, sourceId: "manual" })).toBeNull();
    expect(content("readSnapshot", { scope }).beliefs).toEqual([]);
    const learned = content("learnBatch", {
      scope,
      operationId: "learn",
      beliefs: [belief()],
      sourceId: "manual",
      expectedCursor: null,
      cursor: "event1",
    });
    expect(
      content("learnBatch", {
        scope,
        operationId: "learn",
        beliefs: [belief()],
        sourceId: "manual",
        expectedCursor: null,
        cursor: "event1",
      }),
    ).toEqual(learned);
    expect(content("sourceCursor", { scope, sourceId: "manual" })).toBe("event1");
    expect(() => content("readSnapshot", { scope: { ...scope, ownerId: "bob" } })).toThrow(
      "unavailable",
    );
    expect(() => content("readSnapshot", { scope: { ...scope, agentId: "another" } })).toThrow(
      "another agent",
    );
    content("initialize", { scope: { ...scope, generation: 1 }, operationId: "generation1" });
    expect(() => content("readSnapshot", { scope })).toThrow("generation changed");
  });
  it("retains correction priority and suppresses undo evidence during later replay", () => {
    initialize();
    content("learnBatch", { scope, operationId: "learn", beliefs: [belief()] });
    const corrected = {
      ...belief("correction", "correction", "r2"),
      preference: {
        ...belief().preference,
        statement: "Choose coffee",
        preferred: ["coffee"],
        avoided: ["tea"],
      },
      supersedes: "belief",
      createdAt: 2,
    };
    content("learnBatch", { scope, operationId: "correct", beliefs: [corrected] });
    expect(content("readBeliefs", { scope, topic: "coffee" }).map((b) => b.id)).toEqual([
      "correction",
    ]);
    content("undo", { scope, operationId: "undo", beliefId: "correction" });
    expect(content("readBeliefs", { scope, topic: "coffee" }).map((b) => b.id)).toEqual(["belief"]);
    expect(
      content("learnBatch", {
        scope,
        operationId: "replay",
        beliefs: [{ ...corrected, id: "relearned" }],
      }).applied,
    ).toEqual([]);
  });
  it("keeps inferred undo and dedup stable when unrelated source text changes", () => {
    initialize();
    const inferred = belief("inferred", "inferred", "document-r1");
    expect(
      content("learnBatch", { scope, operationId: "first-inference", beliefs: [inferred] }).applied,
    ).toHaveLength(1);
    const repeated = {
      ...inferred,
      id: "inferred-r2",
      evidence: [{ ...inferred.evidence[0]!, sourceRevision: "document-r2" }],
      createdAt: 2,
    };
    expect(
      content("learnBatch", { scope, operationId: "unrelated-edit", beliefs: [repeated] }).applied,
    ).toEqual([]);
    content("undo", { scope, operationId: "undo-inference", beliefId: inferred.id });
    // The model may paraphrase the same rejected excerpt on another extraction.
    const paraphrased = {
      ...repeated,
      id: "paraphrased-r3",
      preference: { ...repeated.preference, statement: "Tea is the preferred drink" },
      evidence: [{ ...inferred.evidence[0]!, sourceRevision: "document-r3" }],
    };
    expect(
      content("learnBatch", {
        scope,
        operationId: "replay-rejected-excerpt",
        beliefs: [paraphrased],
      }).applied,
    ).toEqual([]);
    expect(content("readBeliefs", { scope, topic: "coffee" })).toEqual([]);
    // A genuinely different supporting statement remains eligible, with its real lineage.
    const newEvidence = {
      ...paraphrased,
      id: "new-support",
      evidence: [
        {
          sourceId: "manual",
          sourceRevision: "document-r4",
          excerpt: "For my morning drink, choose tea.",
        },
      ],
    };
    expect(
      content("learnBatch", { scope, operationId: "new-evidence", beliefs: [newEvidence] }).applied,
    ).toEqual([newEvidence]);
    expect(content("readBeliefs", { scope, topic: "coffee" })[0]?.evidence).toEqual(
      newEvidence.evidence,
    );
  });
  it("freezes advisory predictions and stores genuine owner outcomes distinctly from delegated outcomes", () => {
    initialize();
    content("learnBatch", { scope, operationId: "learn", beliefs: [belief()] });
    const frozen = prediction();
    content("freezePrediction", { scope, operationId: "predict", prediction: frozen });
    expect(() =>
      content("freezePrediction", {
        scope,
        operationId: "change",
        prediction: { ...frozen, optionId: "coffee" },
      }),
    ).toThrow();
    content("appendOutcome", {
      scope,
      operationId: "owner-choice",
      outcome: {
        id: "owner",
        predictionId: frozen.id,
        optionId: "tea",
        origin: "owner",
        matched: true,
        correctionId: null,
        createdAt: 3,
      },
    });
    content("appendOutcome", {
      scope,
      operationId: "delegated-choice",
      outcome: {
        id: "delegated",
        predictionId: frozen.id,
        optionId: "tea",
        origin: "delegated",
        matched: true,
        correctionId: null,
        createdAt: 4,
      },
    });
    expect(
      content("readSnapshot", { scope })
        .outcomes.map((o) => o.origin)
        .toSorted(),
    ).toEqual(["delegated", "owner"]);
  });
  it("requires current explicit grants and atomically retains consumed/unknown budgets", () => {
    const profile = create(),
      owner = { ownerId: "alice", miniMeId: profile.id };
    shared("miniMe.activate", { scope: owner, operationId: "active", expectedRevision: 0 });
    const grant = {
      id: "edit",
      effect: "workspace.edit" as const,
      resources: ["workspace:one"],
      maxActions: 1,
      maxBytes: 8,
      expiresAt: Date.now() + 60000,
    };
    const attachment = shared("miniMe.setAttachment", {
      scope: owner,
      operationId: "attach",
      agentId: "hq",
      expectedRevision: 0,
      mode: "safe",
      grants: [grant],
    });
    const current = shared("miniMe.read", { ownerId: "alice" }) as MiniMeProfileState;
    const actionScope = {
      ...owner,
      targetAgentId: "hq",
      profileGeneration: current.profile.generation,
      attachmentRevision: attachment.revision,
    };
    const reserve = {
      scope: actionScope,
      actionId: "action",
      predictionId: "predicted-yes",
      optionId: "yes",
      grant: { ...grant, maxActions: 10000 },
      action: {
        effect: "workspace.edit" as const,
        resource: "workspace:one",
        fingerprint: "exact-action",
        bytes: 8,
      },
    };
    const reserved = shared("miniMe.reserve", reserve);
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") {
      throw new Error("expected reservation");
    }
    expect(
      shared("miniMe.consume", {
        scope: actionScope,
        actionId: "action",
        reservationId: reserved.reservationId,
      }),
    ).toEqual({ kind: "consumed" });
    shared("miniMe.settle", {
      scope: actionScope,
      actionId: "action",
      reservationId: reserved.reservationId,
      state: "unknown",
    });
    expect(shared("miniMe.reserve", { ...reserve, actionId: "second" }).kind).toBe("denied");
    expect(shared("miniMe.reserve", reserve)).toEqual({ kind: "existing", state: "unknown" });
    expect(
      shared("miniMe.reserve", {
        ...reserve,
        actionId: "ungranted",
        grant: { ...grant, id: "prediction-grant" },
      }).kind,
    ).toBe("denied");
    const replacement = shared("miniMe.setAttachment", {
      scope: owner,
      operationId: "mode-change",
      agentId: "hq",
      expectedRevision: attachment.revision,
      mode: "auto",
      grants: [grant],
    });
    const changed = shared("miniMe.read", { ownerId: "alice" }) as MiniMeProfileState;
    expect(
      shared("miniMe.reserve", {
        ...reserve,
        actionId: "third",
        scope: {
          ...actionScope,
          profileGeneration: changed.profile.generation,
          attachmentRevision: replacement.revision,
        },
      }).kind,
    ).toBe("denied");
  });
  it("records pending source removal before admitting new generation work and erases dependent excerpts", () => {
    const profile = create(),
      owner = { ownerId: "alice", miniMeId: profile.id };
    shared("miniMe.activate", { scope: owner, operationId: "active", expectedRevision: 0 });
    const changed = shared("miniMe.advanceGeneration", {
      scope: owner,
      operationId: "remove-manual",
      expectedRevision: 1,
      change: { kind: "remove-source", sourceId: "manual" },
    });
    expect(shared("miniMe.readPendingDataChanges", { scope: owner })).toEqual([
      {
        id: "remove-manual",
        generation: changed.generation,
        change: { kind: "remove-source", sourceId: "manual" },
      },
    ]);
    initialize();
    content("learnBatch", { scope, operationId: "learn", beliefs: [belief()] });
    content("freezePrediction", { scope, operationId: "predict", prediction: prediction() });
    content("reviseDocument", {
      scope,
      operationId: "projection",
      name: "PREFERENCES.md",
      expectedRevision: 0,
      content: "I prefer tea",
      evidenceSourceIds: ["manual"],
    });
    content("undo", { scope, operationId: "undo-before-remove", beliefId: "belief" });
    for (const table of ["mini_me_learning_keys", "mini_me_suppressions"]) {
      expect(agent.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(1);
    }
    content("removeSource", { scope, operationId: "remove", sourceId: "manual" });
    const snapshot = content("readExport", { scope });
    expect(snapshot.beliefs).toEqual([]);
    expect(snapshot.predictions).toEqual([]);
    expect(snapshot.documents.some((d) => d.content.includes("tea"))).toBe(false);
    for (const table of ["mini_me_learning_keys", "mini_me_suppressions"]) {
      expect(agent.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
    shared("miniMe.completeDataChange", {
      scope: owner,
      operationId: "removed",
      dataChangeId: "remove-manual",
    });
    expect(shared("miniMe.readPendingDataChanges", { scope: owner })).toEqual([]);
  });
  it("keeps normal reads bounded and history keysets distinct from explicit export", () => {
    initialize();
    const beliefs = Array.from({ length: 60 }, (_, i) => ({
      ...belief(`b${String(i).padStart(2, "0")}`, "direct", `r${i}`),
      createdAt: i,
    }));
    content("learnBatch", { scope, operationId: "batch", beliefs });
    expect(content("readSnapshot", { scope }).beliefs).toHaveLength(50);
    expect(content("readBeliefs", { scope, topic: "coffee" })).toHaveLength(33);
    expect(content("readExport", { scope }).beliefs).toHaveLength(60);
    const first = content("history", { scope });
    expect(first.beliefs).toHaveLength(50);
    expect(first.historyCursor).not.toBeNull();
    const last = content("history", { scope, cursor: first.historyCursor ?? undefined });
    expect(last.beliefs).toHaveLength(10);
    expect(new Set([...first.beliefs, ...last.beliefs].map((b) => b.id)).size).toBe(60);
  });
  it("stops before cursor publication at capacity and persists private reversible preimages", () => {
    initialize();
    const before = "private original",
      sha256 = createHash("sha256").update(before).digest("hex");
    const record = {
      scope,
      operationId: "preimage",
      actionId: "edit1",
      targetAgentId: "hq",
      resource: "workspace:one",
      before: { utf8: before, sha256 },
      afterSha256: "a".repeat(64),
      createdAt: 1,
    };
    const receipt = content("recordActionRestore", record);
    expect(content("recordActionRestore", record)).toEqual(receipt);
    expect(content("readActionRestore", { scope, receiptId: receipt.receiptId })?.before.utf8).toBe(
      before,
    );
    expect(JSON.stringify(content("readSnapshot", { scope }))).not.toContain(before);
    expect(() =>
      content("recordActionRestore", {
        ...record,
        operationId: "bad",
        actionId: "bad",
        before: { utf8: before, sha256: "b".repeat(64) },
      }),
    ).toThrow("invalid");
    agent.prepare("UPDATE mini_me_content SET record_count=9999").run();
    expect(() =>
      content("learnBatch", {
        scope,
        operationId: "full",
        beliefs: [belief()],
        sourceId: "manual",
        expectedCursor: null,
        cursor: "advanced",
      }),
    ).toThrow("limit");
    expect(content("sourceCursor", { scope, sourceId: "manual" })).toBeNull();
    content("purge", { scope, operationId: "purge" });
    expect(content("purge", { scope, operationId: "purge" })).toBeNull();
    expect(agent.prepare("SELECT * FROM mini_me_action_restores").all()).toEqual([]);
    expect(agent.prepare("SELECT result_json FROM mini_me_content_operations").all()).toEqual([
      { result_json: "null" },
    ]);
  });
  it("releases one never-dispatched preimage at capacity behind owner and generation fences", () => {
    initialize();
    const preimage = (actionId: string, utf8: string) => ({
      scope,
      operationId: `preimage-${actionId}`,
      actionId,
      targetAgentId: "hq",
      resource: `workspace:${actionId}`,
      before: { utf8, sha256: createHash("sha256").update(utf8).digest("hex") },
      afterSha256: "a".repeat(64),
      createdAt: 1,
    });
    const released = content("recordActionRestore", preimage("refused", "private draft"));
    const kept = content("recordActionRestore", preimage("dispatched", "kept original"));
    const release = { scope, operationId: "release", actionId: "refused" };
    expect(() =>
      content("releaseActionRestore", { ...release, scope: { ...scope, ownerId: "mallory" } }),
    ).toThrow("unavailable");
    expect(() =>
      content("releaseActionRestore", { ...release, scope: { ...scope, generation: 1 } }),
    ).toThrow("generation changed");
    agent.prepare("UPDATE mini_me_content SET record_count=9999").run();
    expect(content("releaseActionRestore", release)).toBeNull();
    const recordCount = () =>
      agent.prepare("SELECT record_count FROM mini_me_content").get()?.record_count;
    expect(recordCount()).toBe(9998);
    expect(content("readActionRestore", { scope, receiptId: released.receiptId })).toBeNull();
    expect(content("readActionRestore", { scope, receiptId: kept.receiptId })?.before.utf8).toBe(
      "kept original",
    );
    // Replays and retries after a lost acknowledgment are no-ops.
    expect(content("releaseActionRestore", release)).toBeNull();
    expect(content("releaseActionRestore", { ...release, operationId: "retry" })).toBeNull();
    expect(recordCount()).toBe(9998);
    expect(
      JSON.stringify(agent.prepare("SELECT * FROM mini_me_action_restores").all()) +
        JSON.stringify(agent.prepare("SELECT * FROM mini_me_content_operations").all()),
    ).not.toContain("private draft");
  });
  it("retains root receipt timestamp/pre-operation profile through deletion and rejects cross-root ID reuse", () => {
    const profile = create();
    const owned = { ownerId: "alice", miniMeId: profile.id };
    const input = {
      scope: owned,
      operationId: "root-delete",
      kind: "delete",
      requestFingerprint: "fingerprint",
    };
    const root = shared("miniMe.beginOperation", input);
    expect(root.state).toBe("pending");
    expect(root.profile).toEqual(profile);
    expect(shared("miniMe.beginOperation", input)).toEqual(root);
    expect(() => shared("miniMe.beginOperation", { ...input, kind: "configure" })).toThrow(
      "another request",
    );
    const closing = shared("miniMe.closeLifecycle", {
      scope: owned,
      operationId: "delete-close",
      expectedRevision: 0,
      lifecycle: "deleting",
    });
    shared("miniMe.finalizeLifecycle", {
      scope: owned,
      operationId: "delete-finish",
      expectedRevision: closing.revision,
      lifecycle: "deleted",
    });
    shared("miniMe.finishOperation", input);
    expect(shared("miniMe.read", { ownerId: "alice" })).toBeNull();
    expect(
      shared("miniMe.operationLookup", { ownerId: "alice", operationId: "root-delete" }),
    ).toEqual({ ...root, state: "complete", miniMeId: profile.id });
    expect(
      shared("miniMe.operationLookup", { ownerId: "bob", operationId: "root-delete" }),
    ).toBeNull();
    expect(() =>
      shared("miniMe.beginOperation", { ...input, scope: { ownerId: "alice", miniMeId: "" } }),
    ).toThrow("another profile");
    expect(shared("miniMe.privateMetadata", {}).profiles).toEqual([
      {
        ownerId: "alice",
        miniMeId: profile.id,
        agentId: profile.agentId,
        lifecycle: "deleted",
        generation: 1,
        revision: 2,
      },
    ]);
  });
  it("metadata preparation never installs first-use feature tables and source status changes retain cursor", () => {
    expect(shared("miniMe.privateMetadata", {})).toEqual({ profiles: [], attachments: [] });
    expect(
      state.prepare("SELECT name FROM sqlite_schema WHERE name='mini_me_profiles'").get(),
    ).toBeUndefined();
    initialize();
    const result = content("updateSourceStatus", {
      scope,
      operationId: "unavailable",
      sourceId: "manual",
      status: "unavailable",
      detail: "Owner source is unavailable",
    });
    expect(result.status).toBe("unavailable");
    expect(content("sourceCursor", { scope, sourceId: "manual" })).toBeNull();
    content("learnBatch", {
      scope,
      operationId: "ingest",
      beliefs: [belief()],
      sourceId: "manual",
      cursor: "r1",
    });
    const updated = content("readSnapshot", { scope }).sources[0];
    assert(updated);
    expect(updated.status).toBe("ready");
    expect(updated.detail).toBeNull();
    expect(updated.lastIngestedAt).not.toBeNull();
  });
  it("keeps undo, status, generation mirroring and explicit source removal available at learned-history capacity", () => {
    initialize();
    content("learnBatch", { scope, operationId: "learn-at-cap", beliefs: [belief()] });
    agent.prepare("UPDATE mini_me_content SET record_count=10000").run();
    const unavailable = content("updateSourceStatus", {
      scope,
      operationId: "limit-status",
      sourceId: "manual",
      status: "limit-reached",
      detail: "Inspect or remove learned data",
    });
    expect(unavailable.status).toBe("limit-reached");
    expect(content("undo", { scope, operationId: "undo-at-cap", beliefId: "belief" }).status).toBe(
      "undone",
    );
    const next = { ...scope, generation: 1 };
    content("initialize", { scope: next, operationId: "mirror-at-cap" });
    expect(agent.prepare("SELECT record_count FROM mini_me_content").get()?.record_count).toBe(
      10000,
    );
    content("removeSource", { scope: next, operationId: "remove-at-cap", sourceId: "manual" });
    expect(content("readSnapshot", { scope: next }).sources).toEqual([]);
    expect(
      Number(agent.prepare("SELECT record_count FROM mini_me_content").get()?.record_count),
    ).toBeLessThan(10000);
    content("addSource", {
      scope: next,
      operationId: "replacement-source",
      source: { ...source, id: "replacement" },
    });
    content("purge", { scope: next, operationId: "purge-after-cap" });
  });
  it("reattaches from visible absent revision zero without resurrecting grants or refunding a fresh budget", () => {
    const p = create(),
      owned = { ownerId: "alice", miniMeId: p.id };
    shared("miniMe.activate", {
      scope: owned,
      operationId: "activate-reattach",
      expectedRevision: 0,
    });
    const grant = {
      id: "edit",
      effect: "workspace.edit" as const,
      resources: ["workspace:one"],
      maxActions: 1,
      maxBytes: 8,
      expiresAt: Date.now() + 60000,
    };
    const first = shared("miniMe.setAttachment", {
      scope: owned,
      operationId: "attach-first",
      agentId: "hq",
      expectedRevision: 0,
      mode: "safe",
      grants: [grant],
    });
    const found = shared("miniMe.read", { ownerId: "alice" })!;
    const old = {
      ...owned,
      targetAgentId: "hq",
      profileGeneration: found.profile.generation,
      attachmentRevision: first.revision,
    };
    const action = {
      scope: old,
      actionId: "old-action",
      predictionId: "old-prediction",
      optionId: "yes",
      grant,
      action: {
        effect: "workspace.edit" as const,
        resource: "workspace:one",
        fingerprint: "old",
        bytes: 8,
      },
    };
    const reserved = shared("miniMe.reserve", action);
    if (reserved.kind !== "reserved") {
      throw new Error("expected reservation");
    }
    shared("miniMe.detachAttachment", { scope: owned, operationId: "detach-first", agentId: "hq" });
    expect(shared("miniMe.read", { ownerId: "alice" })?.attachments).toEqual([]);
    const fresh = shared("miniMe.setAttachment", {
      scope: owned,
      operationId: "reattach-without-grants",
      agentId: "hq",
      expectedRevision: 0,
      mode: "safe",
      grants: [],
    });
    expect(fresh.grants).toEqual([]);
    expect(fresh.revision).toBeGreaterThan(first.revision);
    expect(
      shared("miniMe.consume", {
        scope: old,
        actionId: "old-action",
        reservationId: reserved.reservationId,
      }).kind,
    ).toBe("denied");
    shared("miniMe.setAttachment", {
      scope: owned,
      operationId: "new-explicit-grant",
      agentId: "hq",
      expectedRevision: fresh.revision,
      mode: "safe",
      grants: [grant],
    });
    const latest = shared("miniMe.read", { ownerId: "alice" })!;
    assert(latest.attachments[0]);
    const nextScope = {
      ...old,
      profileGeneration: latest.profile.generation,
      attachmentRevision: latest.attachments[0].revision,
    };
    expect(
      shared("miniMe.reserve", {
        ...action,
        scope: nextScope,
        actionId: "fresh-action",
        action: { ...action.action, fingerprint: "fresh" },
      }).kind,
    ).toBe("reserved");
    shared("miniMe.settle", {
      scope: old,
      actionId: "old-action",
      reservationId: reserved.reservationId,
      state: "not-dispatched",
    });
    expect(
      shared("miniMe.reserve", {
        ...action,
        scope: nextScope,
        actionId: "over-budget",
        action: { ...action.action, fingerprint: "extra" },
      }).kind,
    ).toBe("denied");
    expect(() =>
      shared("miniMe.setAttachment", {
        scope: owned,
        operationId: "stale-visible-revision",
        agentId: "hq",
        expectedRevision: 0,
        mode: "safe",
        grants: [],
      }),
    ).toThrow("changed");
  });
});
