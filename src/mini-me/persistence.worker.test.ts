import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  MINI_ME_DOCUMENT_NAMES,
  type MiniMeBelief,
  type MiniMeEvidence,
  type MiniMePrediction,
  type MiniMePreference,
  type MiniMeProfile,
  type MiniMeSource,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { withMiniMeContent } from "./host-storage.js";
import { createMiniMeStatePersistence, type MiniMeContentScope } from "./persistence.js";
import { MINI_ME_STATE_TABLES } from "./persistence.schema.js";
import { readMiniMePrivateAgentMetadata } from "./private-agent-projection.js";
import type { MiniMeContentStore } from "./service.types.js";

// Unlike persistence.test.ts and service.test.ts, nothing here replaces the state
// writer, agent executor, content Worker, admission, or canonical profile lookup.
// One isolated state root serves one ordered flow: each step consumes the durable
// result of the previous one, including a full close and reopen of both stores.
let testState: OpenClawTestState | undefined;
let ownerId = "";
let otherOwnerId = "";
beforeAll(async () => {
  testState = await createOpenClawTestState({ layout: "state-only", label: "mini-me-worker" });
  ownerId = (await ensureCanonicalUserProfileForEmail("mini-me-owner@example.test")).id;
  otherOwnerId = (await ensureCanonicalUserProfileForEmail("mini-me-other@example.test")).id;
});
afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await testState?.cleanup();
});

// The live request fence; owner identity still resolves in the state writer.
const assertCurrent = () => {};
const models = { conversationModel: null, decisionModel: null, allowInference: false };
const ownedBy = (profile: MiniMeProfile) => ({ ownerId, miniMeId: profile.id });
const scopeOf = (profile: MiniMeProfile): MiniMeContentScope => ({
  ownerId,
  miniMeId: profile.id,
  agentId: profile.agentId,
  generation: profile.generation,
});
// Exercise the production content owner and its canonical executor references.
async function withContent<T>(
  profile: MiniMeProfile,
  consume: (store: MiniMeContentStore) => Promise<T>,
): Promise<T> {
  return withMiniMeContent(profile, assertCurrent, consume);
}
// A separate read-only observer; it never participates in the writer's transactions.
function miniMeStateTables(): string[] {
  const db = new DatabaseSync(resolveOpenClawStateSqlitePath(), { readOnly: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'mini_me_*'")
      .all()
      .map((row) => String(row.name))
      .toSorted();
  } finally {
    db.close();
  }
}

const manualSource: MiniMeSource = {
  id: "manual-fixture",
  selection: { kind: "manual", label: "Fixture preferences" },
  revision: 0,
  status: "ready",
  lastIngestedAt: null,
  detail: null,
};
const teaPreference: MiniMePreference = {
  document: "PREFERENCES.md",
  scope: "drink",
  statement: "Choose tea",
  preferred: ["tea"],
  avoided: ["coffee"],
};
const direct: MiniMeBelief = {
  id: "belief-tea",
  preference: teaPreference,
  origin: "direct",
  evidence: [{ sourceId: manualSource.id, sourceRevision: "r1", excerpt: "I prefer tea" }],
  status: "active",
  supersedes: null,
  createdAt: 1,
};
const correctionEvidence: MiniMeEvidence = {
  sourceId: manualSource.id,
  sourceRevision: "r2",
  excerpt: "Actually, choose coffee",
};
const correction: MiniMeBelief = {
  id: "belief-coffee",
  preference: {
    ...teaPreference,
    statement: "Choose coffee",
    preferred: ["coffee"],
    avoided: ["tea"],
  },
  origin: "correction",
  evidence: [correctionEvidence],
  status: "active",
  supersedes: direct.id,
  createdAt: 3,
};
function advisoryPrediction(contentRevision: number): MiniMePrediction {
  return {
    id: "prediction-drink",
    agentId: null,
    choice: {
      scope: "drink",
      question: "Tea or coffee?",
      options: [
        { id: "tea", label: "Tea", value: "tea" },
        { id: "coffee", label: "Coffee", value: "coffee" },
      ],
    },
    optionId: "tea",
    explanation: "The owner stated a tea preference",
    uncertainty: "low",
    evidence: direct.evidence,
    beliefIds: [direct.id],
    correctionApplied: false,
    provider: "local-rule",
    rubricVersion: "owner-preference-v1",
    providerRuntimeGeneration: null,
    createdAt: 2,
    profileGeneration: 0,
    contentRevision,
    authority: "advisory",
  };
}

it("persists one owner's Mini Me through the real state writer and per-agent content Worker", async () => {
  const state = createMiniMeStatePersistence({ assertCurrent });

  // Before opt-in: a read and a refused non-canonical opt-in leave feature tables absent.
  expect(await state.read(ownerId)).toBeNull();
  await expect(
    state.beginCreate({
      ownerId: "not-a-canonical-profile",
      operationId: "non-canonical-create",
      name: "Unowned",
      models,
    }),
  ).rejects.toThrow("Owner identity changed");
  expect(miniMeStateTables()).toEqual([]);

  // Opt-in: state tables appear with the profile; the private agent store appears only
  // when content initializes, holding the six empty canonical documents.
  const created = await state.beginCreate({
    ownerId,
    operationId: "create",
    name: "Fixture adviser",
    models,
  });
  expect(created).toMatchObject({ lifecycle: "preparing", generation: 0, revision: 0 });
  expect(miniMeStateTables()).toEqual([...MINI_ME_STATE_TABLES].toSorted());
  const agentPath = resolveOpenClawAgentSqlitePath({ agentId: created.agentId });
  expect(existsSync(agentPath)).toBe(false);
  const initialized = await withContent(created, (store) =>
    store.initialize({ scope: scopeOf(created), operationId: "initialize-0" }),
  );
  expect(
    initialized.documents.map(({ name, content, revision }) => ({ name, content, revision })),
  ).toEqual(MINI_ME_DOCUMENT_NAMES.map((name) => ({ name, content: "", revision: 0 })));
  expect(existsSync(agentPath)).toBe(true);
  const active = await state.activate({
    scope: ownedBy(created),
    operationId: "activate",
    expectedRevision: created.revision,
  });
  expect(active).toMatchObject({ lifecycle: "active", generation: 0, revision: 1 });
  expect(readMiniMePrivateAgentMetadata(active.agentId)).toEqual({
    ownerId,
    miniMeId: active.id,
    agentId: active.agentId,
    lifecycle: "active",
    generation: 0,
    revision: 1,
  });

  // Cleanup of known never-dispatched bytes survives requester revocation through the same
  // captured database, while that requester can no longer read content or record new work.
  let requesterCurrent = true;
  await withMiniMeContent(
    active,
    () => {
      if (!requesterCurrent) {
        throw new Error("Synthetic requester revoked");
      }
    },
    async (store, custody) => {
      const before = "SYNTHETIC unused preimage";
      const receipt = await store.recordActionRestore({
        scope: scopeOf(active),
        operationId: "preimage-before-revocation",
        actionId: "never-dispatched-action",
        targetAgentId: "main",
        resource: "workspace:synthetic/notes.txt",
        before: { utf8: before, sha256: createHash("sha256").update(before).digest("hex") },
        afterSha256: createHash("sha256").update("unused edit").digest("hex"),
        createdAt: 1,
      });
      requesterCurrent = false;
      await expect(
        store.readActionRestore({ scope: scopeOf(active), receiptId: receipt.receiptId }),
      ).rejects.toThrow("Synthetic requester revoked");
      await custody.releaseActionRestore(ownerId, "never-dispatched-action");
    },
  );
  expect(
    await withContent(active, (store) => store.readActionRestores({ scope: scopeOf(active) })),
  ).toEqual({ receipts: [], cursor: null });

  // Direct belief, frozen advisory prediction, then an owner correction and its undo.
  const scope = scopeOf(active);
  const frozen = await withContent(active, async (store) => {
    await store.addSource({ scope, operationId: "source", source: manualSource });
    const learned = await store.learnBatch({ scope, operationId: "learn", beliefs: [direct] });
    expect(learned.applied).toEqual([direct]);
    expect(await store.readBeliefs({ scope, topic: "drink" })).toEqual([direct]);

    const prediction = advisoryPrediction((await store.readSnapshot(scope)).contentRevision);
    await store.freezePrediction({ scope, operationId: "predict", prediction });
    const grounded = (await store.readSnapshot(scope)).contentRevision;
    await expect(
      store.freezePrediction({
        scope,
        operationId: "rewrite-prediction",
        prediction: { ...prediction, optionId: "coffee", contentRevision: grounded },
      }),
    ).rejects.toThrow("Frozen prediction cannot be changed");

    const corrected = await store.learnBatch({
      scope,
      operationId: "correct",
      beliefs: [correction],
    });
    expect(corrected.applied).toEqual([correction]);
    expect(await store.readBeliefs({ scope, topic: "drink" })).toEqual([correction]);
    expect(
      await store.undo({ scope, operationId: "undo-correction", beliefId: correction.id }),
    ).toEqual({ ...correction, status: "undone" });
    expect(await store.readBeliefs({ scope, topic: "drink" })).toEqual([direct]);
    // Undo suppresses the source revision, so a differently worded replay is not relearned.
    const replay = await store.learnBatch({
      scope,
      operationId: "replay-correction",
      beliefs: [
        {
          ...correction,
          id: "belief-coffee-replay",
          evidence: [{ ...correctionEvidence, excerpt: "Coffee, again" }],
        },
      ],
    });
    expect(replay.applied).toEqual([]);
    expect(await store.readExactPrediction({ scope, predictionId: prediction.id })).toEqual(
      prediction,
    );
    return prediction;
  });

  // Another canonical owner can neither read nor mutate this profile or its content.
  expect(await state.read(otherOwnerId, active.id)).toBeNull();
  await expect(
    state.configure({
      scope: { ownerId: otherOwnerId, miniMeId: active.id },
      operationId: "foreign-configure",
      expectedRevision: active.revision,
      patch: { name: "Taken" },
    }),
  ).rejects.toThrow("unavailable for this owner");
  await withContent(active, async (store) => {
    await expect(store.readSnapshot({ ...scope, ownerId: otherOwnerId })).rejects.toThrow(
      "unavailable for this owner and agent",
    );
  });

  // A generation change retires every content scope captured under the old generation.
  const paused = await state.configure({
    scope: ownedBy(active),
    operationId: "pause-learning",
    expectedRevision: active.revision,
    patch: { learningPaused: true },
  });
  expect(paused).toMatchObject({ learningPaused: true, generation: 1, revision: 2 });
  await withContent(paused, async (store) => {
    await store.initialize({ scope: scopeOf(paused), operationId: "initialize-1" });
    await expect(store.readSnapshot(scope)).rejects.toThrow("generation changed");
    await expect(
      store.learnBatch({
        scope,
        operationId: "stale-learn",
        beliefs: [
          {
            ...direct,
            id: "belief-stale",
            evidence: [{ sourceId: manualSource.id, sourceRevision: "r3", excerpt: "Stale" }],
          },
        ],
      }),
    ).rejects.toThrow("generation changed");
  });

  // Close both physical stores; fresh facades read the committed facts back.
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  const reopened = createMiniMeStatePersistence({ assertCurrent });
  expect(await reopened.read(ownerId)).toEqual({
    profile: paused,
    attachments: [],
    pendingDataChanges: [],
  });
  const exported = await withContent(paused, (store) => store.readExport(scopeOf(paused)));
  expect(exported.documents.map(({ name }) => name)).toEqual([...MINI_ME_DOCUMENT_NAMES]);
  expect(exported.sources).toEqual([manualSource]);
  expect(exported.beliefs).toEqual([{ ...correction, status: "undone" }, direct]);
  expect(exported.predictions).toEqual([frozen]);

  // After reopen, closing the lifecycle advances the generation and refuses reactivation.
  const disabling = await reopened.closeLifecycle({
    scope: ownedBy(paused),
    operationId: "disable",
    expectedRevision: paused.revision,
    lifecycle: "disabling",
  });
  expect(disabling).toMatchObject({ lifecycle: "disabling", generation: 2 });
  expect(readMiniMePrivateAgentMetadata(disabling.agentId)).toMatchObject({
    lifecycle: "disabling",
    generation: 2,
  });
  await expect(
    reopened.configure({
      scope: ownedBy(disabling),
      operationId: "configure-while-disabling",
      expectedRevision: disabling.revision,
      patch: { learningPaused: false },
    }),
  ).rejects.toThrow("lifecycle is closed");
  await expect(
    reopened.activate({
      scope: ownedBy(disabling),
      operationId: "reactivate",
      expectedRevision: disabling.revision,
    }),
  ).rejects.toThrow("not preparing");
  expect((await reopened.read(ownerId))?.profile).toEqual(disabling);
});
