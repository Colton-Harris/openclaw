import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as M from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  inspectMiniMeDocument,
  inspectMiniMeDocuments,
  projectMiniMeDocuments,
  removeMiniMeDocuments,
} from "./documents.js";
import { MiniMeLifecycleOwner } from "./lifecycle.js";
import { bindSqliteWorkerBackend } from "./persistence.agent-worker.js";
import { executeMiniMeStateCommand } from "./persistence.state-worker.js";
import type {
  MiniMeContentWorkerOperations,
  MiniMeStateWorkerOperations,
} from "./persistence.types.js";
import { predictMiniMeBaseline } from "./prediction.js";
import { miniMeStage } from "./service-operation.js";
import { createMiniMeService } from "./service.js";
import type {
  MiniMeContentStore,
  MiniMeServiceDependencies,
  MiniMeStateStore,
} from "./service.types.js";

// The transport adapters below dispatch the real production SQLite commands.
// They do not simulate receipts, revisions, learning, or the filesystem projector.
const databases = vi.hoisted(() => ({
  state: undefined as DatabaseSync | undefined,
  agent: undefined as DatabaseSync | undefined,
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
  openOpenClawStateDatabase: () => ({ db: databases.state, path: "/fixture/state.sqlite" }),
  runOpenClawStateWriteTransaction: (write: (current: { db: DatabaseSync }) => unknown) =>
    transaction(databases.state!, () => write({ db: databases.state! })),
}));
// mock-isolation: Use only the fixture-owned in-memory agent SQLite and transaction owner, not an admitted process store.
vi.mock("../state/openclaw-agent-db.js", () => ({
  getOpenClawAgentDatabaseIfOpen: () => ({ db: databases.agent, path: "/fixture/agent.sqlite" }),
  runOpenClawAgentWriteTransaction: (write: (current: { db: DatabaseSync }) => unknown) =>
    transaction(databases.agent!, () => write({ db: databases.agent! })),
}));
// mock-isolation: Canonical test identities belong to this fixture; do not consult the process profile metadata cache.
vi.mock("../state/user-profiles-internal.js", () => ({
  selectResolvedUserProfileMetadataById: (_db: DatabaseSync, id: string) =>
    id === "owner-fixture" ? { id } : undefined,
}));
// mock-isolation: The inline worker fixture supplies its own environment and never captures operator worker state.
vi.mock("../infra/sqlite-worker-state-context.js", () => ({
  getSqliteWorkerStateContext: () => ({ environment: {} }),
}));
// mock-isolation: Control the transaction and commit revocation seams independently of process worker admission.
vi.mock("../infra/sqlite-worker-operation-admission.js", () => ({
  requestSqliteWorkerOperationAdmission: () => {},
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

let failFinish: string | undefined;
let failFinalize = false;
async function executeState<K extends keyof MiniMeStateWorkerOperations>(
  type: K,
  input: MiniMeStateWorkerOperations[K]["input"],
): Promise<MiniMeStateWorkerOperations[K]["output"]> {
  if (type === "miniMe.finishOperation" && "kind" in input && input.kind === failFinish) {
    failFinish = undefined;
    throw new Error("Injected interruption before the final receipt");
  }
  if (type === "miniMe.finalizeLifecycle" && failFinalize) {
    failFinalize = false;
    throw new Error("Injected revocation before the lifecycle finalized");
  }
  // SAFETY: The paired command/input generic is the production worker union.
  return executeMiniMeStateCommand(
    { type, input } as Parameters<typeof executeMiniMeStateCommand>[0],
    {},
  ) as MiniMeStateWorkerOperations[K]["output"];
}
const stateStore: MiniMeStateStore = {
  execute: executeState,
  read: (ownerId, miniMeId) => executeState("miniMe.read", { ownerId, miniMeId }),
  beginCreate: (input) => executeState("miniMe.beginCreate", input),
  activate: (input) => executeState("miniMe.activate", input),
  configure: (input) => executeState("miniMe.configure", input),
  advanceGeneration: (input) => executeState("miniMe.advanceGeneration", input),
  readPendingDataChanges: (scope) => executeState("miniMe.readPendingDataChanges", { scope }),
  completeDataChange: (input) => executeState("miniMe.completeDataChange", input),
  setAttachment: (input) => executeState("miniMe.setAttachment", input),
  detachAttachment: (input) => executeState("miniMe.detachAttachment", input),
  closeLifecycle: (input) => executeState("miniMe.closeLifecycle", input),
  finalizeLifecycle: (input) => executeState("miniMe.finalizeLifecycle", input),
  beginOperation: (input) => executeState("miniMe.beginOperation", input),
  finishOperation: (input) => executeState("miniMe.finishOperation", input),
  operationLookup: (input) => executeState("miniMe.operationLookup", input),
  operationStatus: (input) => executeState("miniMe.operationStatus", input),
  reserve: (input) => executeState("miniMe.reserve", input),
  consume: (input) => executeState("miniMe.consume", input),
  settle: (input) => executeState("miniMe.settle", input),
};
function contentStore(agentId: string): MiniMeContentStore {
  const backend = bindSqliteWorkerBackend(
    { agentId },
    {
      database: databases.agent!,
      databasePath: "/fixture/agent.sqlite",
      admit() {},
    },
  );
  async function execute<K extends keyof MiniMeContentWorkerOperations>(
    type: K,
    input: MiniMeContentWorkerOperations[K]["input"],
  ): Promise<MiniMeContentWorkerOperations[K]["output"]> {
    // SAFETY: This adapter preserves the production command/input pairing.
    return backend.execute({ type, input } as Parameters<
      typeof backend.execute
    >[0]) as MiniMeContentWorkerOperations[K]["output"];
  }
  return {
    execute,
    initialize: (input) => execute("initialize", input),
    recordActionRestore: (input) => execute("recordActionRestore", input),
    releaseActionRestore: (input) => execute("releaseActionRestore", input),
    readActionRestore: (input) => execute("readActionRestore", input),
    readActionRestores: (input) => execute("readActionRestores", input),
    readSnapshot: (scope) => execute("readSnapshot", { scope }),
    readExactPrediction: (input) => execute("readExactPrediction", input),
    readExport: (scope) => execute("readExport", { scope }),
    readBeliefs: (input) => execute("readBeliefs", input),
    history: (input) => execute("history", input),
    addSource: (input) => execute("addSource", input),
    updateSourceStatus: (input) => execute("updateSourceStatus", input),
    removeSource: (input) => execute("removeSource", input),
    sourceCursor: (input) => execute("sourceCursor", input),
    learnBatch: (input) => execute("learnBatch", input),
    reviseDocument: (input) => execute("reviseDocument", input),
    undo: (input) => execute("undo", input),
    freezePrediction: (input) => execute("freezePrediction", input),
    appendOutcome: (input) => execute("appendOutcome", input),
    purge: (input) => execute("purge", input),
  };
}

const ownerId = "owner-fixture";
const createParams: M.MiniMeCreateParams = {
  operationId: "create-fixture",
  name: "Mini fixture",
  models: { conversationModel: null, decisionModel: null, allowInference: false },
  sources: [],
  attachments: [],
};
const preference: M.MiniMePreference = {
  document: "PREFERENCES.md",
  scope: "drink",
  statement: "Choose my stated drink",
  preferred: ["tea"],
  avoided: ["coffee"],
};
const choice: M.MiniMeChoice = {
  scope: "drink",
  question: "Choose a drink",
  options: [
    { id: "tea", label: "Tea", value: "tea" },
    { id: "coffee", label: "Coffee", value: "coffee" },
  ],
};
let directory: string;
let deps: MiniMeServiceDependencies;
let service: ReturnType<typeof createMiniMeService>;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "mini-me-service-"));
  databases.state = new DatabaseSync(":memory:");
  databases.agent = new DatabaseSync(":memory:");
  databases.state.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE user_profiles(id TEXT PRIMARY KEY) STRICT; INSERT INTO user_profiles VALUES('owner-fixture');",
  );
  databases.agent.exec("PRAGMA foreign_keys=ON");
  failFinish = undefined;
  failFinalize = false;
  let clock = 100;
  vi.spyOn(Date, "now").mockImplementation(() => ++clock);
  deps = {
    ownerId,
    humanRequest: true,
    lifecycle: new MiniMeLifecycleOwner(() => {}),
    assertCurrent() {},
    state: () => stateStore,
    withContent: async (profile, assertCurrent, consume) => {
      assertCurrent();
      return consume(contentStore(profile.agentId));
    },
    provision: vi.fn(async () => {}),
    configureAgent: async () => {},
    deleteAgent: async () => {},
    project: (profile, store, assertCurrent) =>
      projectMiniMeDocuments({ ownerId, profile, store, workspaceDir: directory, assertCurrent }),
    inspectDocuments: (profile, documents, assertCurrent) =>
      inspectMiniMeDocuments({ profile, documents, workspaceDir: directory, assertCurrent }),
    assertAgentAllowed() {},
    prepareGrants: async (_agentId, grants) => grants,
    validateSource: async () => {},
    availableSources: async () => ({ conversations: [] }),
    predict: vi.fn(async (_profile, input) => predictMiniMeBaseline(input)),
    queueLearning() {},
    capabilities: { effects: [], maxSources: 16, maxDocumentBytes: 65536, maxOptions: 8 },
  };
  service = createMiniMeService(deps);
});
afterEach(async () => {
  await deps.lifecycle.retire();
  databases.state?.close();
  databases.agent?.close();
  databases.state = undefined;
  databases.agent = undefined;
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("Mini Me service recovery through real persistence", () => {
  it("finishes a create receipt after activation without reprovisioning", async () => {
    failFinish = "create";
    await expect(service.create(createParams)).rejects.toThrow("Injected interruption");
    expect((await service.get()).profile?.lifecycle).toBe("active");
    expect(await service.operation(createParams.operationId)).toEqual({ status: "pending" });
    const result = await service.create(createParams);
    expect(result.profile?.lifecycle).toBe("active");
    expect(deps.provision).toHaveBeenCalledTimes(1);
    expect(await service.operation(createParams.operationId)).toEqual({ status: "completed" });
  });

  it("returns the frozen prediction and finishes its interrupted receipt", async () => {
    await service.create(createParams);
    await service.learn({ operationId: "learn", preference });
    const params = { operationId: "prediction", choice };
    failFinish = "predict";
    await expect(service.predict(params)).rejects.toThrow("Injected interruption");
    const original = (await service.get()).predictions[0];
    expect(original?.optionId).toBe("tea");
    const replay = await service.predict(params);
    expect(replay).toEqual(original);
    expect(deps.predict).toHaveBeenCalledTimes(1);
    expect(await service.operation(params.operationId)).toEqual({
      status: "completed",
      prediction: original,
    });
  });

  it("keeps delete receipts reachable and cannot revive a deleted profile on replay", async () => {
    const created = await service.create(createParams);
    const params = { operationId: "delete", expectedRevision: created.profile!.revision };
    failFinish = "delete";
    await expect(service.delete(params)).rejects.toThrow("Injected interruption");
    expect((await service.get()).profile).toBeNull();
    expect(await service.operation(params.operationId)).toEqual({ status: "pending" });
    expect((await service.delete(params)).profile).toBeNull();
    expect(await service.operation(params.operationId)).toEqual({ status: "completed" });
    expect((await service.delete(params)).profile).toBeNull();
    expect((await service.create(createParams)).profile).toBeNull();
  });

  it.each(["original", "new"] as const)(
    "resumes after its erasure receipt on an %s-operation retry without reopening retired content",
    async (retryWith) => {
      const original = (await service.create(createParams)).profile!;
      // Completed canonical cleanup retires the agent database; the host's retry-safe cleanup
      // then completes from that journal, and only the erasure receipt avoids the content owner.
      const retired = new Set<string>();
      const withContent = deps.withContent;
      const deleteAgent = vi.fn(async (profile: M.MiniMeProfile, assertCurrent: () => void) => {
        await removeMiniMeDocuments({ workspaceDir: directory, assertCurrent });
        retired.add(profile.agentId);
      });
      deps.deleteAgent = deleteAgent;
      deps.withContent = (profile, assertCurrent, consume) => {
        if (retired.has(profile.agentId)) {
          throw new Error(`agent ${profile.agentId} database is unavailable while it is deleted`);
        }
        return withContent(profile, assertCurrent, consume);
      };
      const params = { operationId: "delete", expectedRevision: original.revision };
      failFinalize = true;
      await expect(service.delete(params)).rejects.toThrow("Injected revocation");
      const pending = (await stateStore.read(ownerId, original.id))!.profile;
      expect(pending.lifecycle).toBe("deleting");
      await expect(service.get()).rejects.toThrow("removal is pending");
      expect(await service.operation(params.operationId)).toEqual({ status: "pending" });

      const retry =
        retryWith === "original"
          ? params
          : { operationId: "delete-retry", expectedRevision: pending.revision };
      expect((await service.delete(retry)).profile).toBeNull();
      expect((await service.delete(params)).profile).toBeNull();
      expect(await service.operation(params.operationId)).toEqual({ status: "completed" });
      expect(await service.operation(retry.operationId)).toEqual({ status: "completed" });
      expect(deleteAgent).toHaveBeenCalledTimes(2);

      const later = (await service.create({ ...createParams, operationId: "opt-in-again" }))
        .profile!;
      expect(later).toMatchObject({ lifecycle: "active" });
      expect(later.id).not.toBe(original.id);
      expect((await stateStore.read(ownerId, original.id))?.profile.lifecycle).toBe("deleted");
    },
  );

  it("erases private content itself when generic agent cleanup already completed", async () => {
    const original = (await service.create(createParams)).profile!;
    const learned = await service.learn({ operationId: "private-preference", preference });
    // An offline generic delete may complete its journal with deleteFiles=false and leave this
    // database; the host then merely skips its canonical step, which is no erasure evidence.
    const deleteAgent = vi.fn(async () => {});
    deps.deleteAgent = deleteAgent;
    const erasure = {
      scope: { ownerId, miniMeId: original.id },
      operationId: miniMeStage(original.id, "content-erased"),
    };
    const count = (table: string) =>
      databases.agent!.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count;
    const params = { operationId: "delete", expectedRevision: learned.profile!.revision };
    failFinish = "delete.content-erased";
    await expect(service.delete(params)).rejects.toThrow("Injected interruption");
    expect(count("mini_me_beliefs")).toBe(0);
    expect(await stateStore.operationStatus(erasure)).toMatchObject({ state: "pending" });
    expect(deleteAgent).not.toHaveBeenCalled();

    // The same-ID retry re-initializes the purged store; it must purge again, not replay.
    expect((await service.delete(params)).profile).toBeNull();
    expect(count("mini_me_content")).toBe(0);
    expect(count("mini_me_documents")).toBe(0);
    expect(count("mini_me_beliefs")).toBe(0);
    expect(await stateStore.operationStatus(erasure)).toMatchObject({ state: "complete" });
    expect(deleteAgent).toHaveBeenCalledTimes(1);
  });

  it("admits new direct evidence after undo and applies an explicit correction after abstention", async () => {
    await service.create(createParams);
    const learned = await service.learn({ operationId: "first-preference", preference });
    await service.undo({ operationId: "undo", beliefId: learned.beliefs[0]!.id });
    const changed = await service.learn({
      operationId: "new-preference",
      preference: { ...preference, preferred: ["coffee"], avoided: ["tea"] },
    });
    expect(changed.beliefs.filter((item) => item.status === "active")).toHaveLength(1);
    expect((await service.predict({ operationId: "changed-choice", choice })).optionId).toBe(
      "coffee",
    );
    const unknownChoice = { ...choice, scope: "evening drink" };
    const abstention = await service.predict({ operationId: "abstention", choice: unknownChoice });
    expect(abstention.optionId).toBeNull();
    const outcome = await service.outcome({
      operationId: "owner-correction",
      predictionId: abstention.id,
      optionId: "tea",
      correction: { ...preference, scope: unknownChoice.scope },
    });
    const recorded = outcome.outcomes.find((item) => item.predictionId === abstention.id)!;
    expect(outcome.beliefs.find((item) => item.id === recorded.correctionId)?.origin).toBe(
      "correction",
    );
    const later = await service.predict({
      operationId: "later-comparable-choice",
      choice: unknownChoice,
    });
    expect(later).toMatchObject({
      optionId: "tea",
      correctionApplied: true,
      authority: "advisory",
    });
    expect(later.evidence).not.toEqual([]);
    expect((await service.get()).predictions.find((item) => item.id === abstention.id)).toEqual(
      abstention,
    );
  });

  it("rejects deterministic invalid requests before admitting a pending operation", async () => {
    const current = await service.create(createParams);
    const document = current.documents.find((item) => item.name === "PREFERENCES.md")!;
    await expect(
      service.documentSet({
        operationId: "too-large",
        name: document.name,
        expectedRevision: document.revision,
        content: "x".repeat(65536),
      }),
    ).rejects.toThrow("projection limit");
    await expect(
      service.outcome({
        operationId: "missing-prediction",
        predictionId: "not-present",
        optionId: "tea",
      }),
    ).rejects.toThrow("Frozen choice");
    await expect(
      service.configure({ operationId: "old-revision", expectedRevision: 999, name: "Changed" }),
    ).rejects.toThrow("current revision");
    for (const operationId of ["too-large", "missing-prediction", "old-revision"]) {
      expect(await service.operation(operationId)).toEqual({ status: "unknown" });
    }
    expect((await service.get()).profile?.revision).toBe(current.profile?.revision);
  });

  it("applies an explicit decision-file correction without rewriting the frozen prediction or inventing an owner choice", async () => {
    await service.create(createParams);
    await service.learn({ operationId: "initial", preference });
    const first = await service.predict({ operationId: "before-file-correction", choice });
    expect(first.optionId).toBe("tea");
    const correction = {
      ...preference,
      statement: "Choose coffee instead",
      preferred: ["coffee"],
      avoided: ["tea"],
    };
    const text =
      "Owner annotation\n\n```mini-me-correction\n" + JSON.stringify(correction) + "\n```\n";
    const current = await service.documentSet({
      operationId: "file-correction",
      name: "DECISIONS.md",
      expectedRevision: 0,
      content: text,
    });
    expect(
      current.beliefs.some(
        (belief) => belief.origin === "correction" && belief.preference.preferred[0] === "coffee",
      ),
    ).toBe(true);
    expect(current.predictions.find((prediction) => prediction.id === first.id)).toEqual(first);
    expect(current.outcomes).toEqual([]);
    const later = await service.predict({ operationId: "after-file-correction", choice });
    expect(later).toMatchObject({ optionId: "coffee", correctionApplied: true });
    const disk = await fs.readFile(path.join(directory, "DECISIONS.md"), "utf8");
    expect(disk).toContain(first.id);
    expect(disk).toContain(later.id);
    expect(inspectMiniMeDocument(disk, current.profile!, "DECISIONS.md").authored).toBe(text);
    const edited = await service.documentSet({
      operationId: "annotation-only",
      name: "DECISIONS.md",
      expectedRevision: 1,
      content: text + "Unrelated note\n",
    });
    expect(edited.beliefs.filter((belief) => belief.origin === "correction")).toHaveLength(1);
    await expect(
      service.documentSet({
        operationId: "unclosed",
        name: "DECISIONS.md",
        expectedRevision: 2,
        content: "```mini-me-correction\n{}",
      }),
    ).rejects.toThrow("Close each");
    expect(await service.operation("unclosed")).toEqual({ status: "unknown" });
  });

  it("removes only the six private projections before agent cleanup and tolerates replay", async () => {
    await service.create(createParams);
    await fs.writeFile(path.join(directory, "owner-note.txt"), "keep");
    await removeMiniMeDocuments({ workspaceDir: directory, assertCurrent() {} });
    await removeMiniMeDocuments({ workspaceDir: directory, assertCurrent() {} });
    expect(await fs.readdir(directory)).toEqual(["owner-note.txt"]);
  });

  it("preserves external authored and raw edits until their exact version is explicitly imported", async () => {
    let current = await service.create(createParams);
    let document = current.documents.find((item) => item.name === "PREFERENCES.md")!;
    const filePath = path.join(directory, document.name);
    const projected = await fs.readFile(filePath, "utf8");
    const external = projected.replace(
      "\n<!-- openclaw-mini-me learned -->",
      "External owner note\n<!-- openclaw-mini-me learned -->",
    );
    await fs.writeFile(filePath, external);
    current = await service.get();
    document = current.documents.find((item) => item.name === document.name)!;
    expect(document.external?.content).toBe(`${document.content}External owner note`);
    await expect(
      service.documentSet({
        operationId: "unreviewed-overwrite",
        name: document.name,
        expectedRevision: document.revision,
        content: "Other draft",
      }),
    ).rejects.toThrow("external file edit");
    expect(await service.operation("unreviewed-overwrite")).toEqual({ status: "unknown" });
    expect(await fs.readFile(filePath, "utf8")).toBe(external);
    current = await service.documentSet({
      operationId: "import-authored",
      name: document.name,
      expectedRevision: document.revision,
      content: document.external!.content,
    });
    document = current.documents.find((item) => item.name === document.name)!;
    expect(document.external).toBeUndefined();
    expect(
      inspectMiniMeDocument(await fs.readFile(filePath, "utf8"), current.profile!, document.name)
        .authored,
    ).toBe(document.content);
    const raw = "A manually replaced personal file with no revision header.";
    await fs.writeFile(filePath, raw);
    current = await service.get();
    document = current.documents.find((item) => item.name === document.name)!;
    expect(document.external).toEqual({ content: raw, baseRevision: null });
    current = await service.documentSet({
      operationId: "import-raw",
      name: document.name,
      expectedRevision: document.revision,
      content: raw,
    });
    expect(current.documents.find((item) => item.name === document.name)).toMatchObject({
      content: raw,
      revision: document.revision + 1,
    });
    expect(
      inspectMiniMeDocument(await fs.readFile(filePath, "utf8"), current.profile!, document.name)
        .authored,
    ).toBe(raw);
  });
});
