// Synthetic Mini Me persistence child for test/mini-me-persistence.process.e2e.test.ts.
// Each command runs in a fresh OS process against the production storage owners: the
// shared-state writer broker, the per-agent content Worker, canonical people and the
// Doctor preflight. Every owner, belief and excerpt here is generated fixture data.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  MiniMeBelief,
  MiniMeEvidence,
  MiniMeModels,
  MiniMeProfile,
  MiniMeSource,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import type { DoctorDatabasePreflight } from "../../src/commands/doctor-database-preflight.js";
import type { MiniMeContentScope, MiniMeProfileState } from "../../src/mini-me/persistence.js";
import type { MiniMeContentStore } from "../../src/mini-me/service.types.js";

// Source mode resolves this file; the compiled-subprocess runner replaces this
// declaration with its compiled copy once listed in vitest-worker-declarations.mts.
export const miniMePersistenceProcessEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "mini-me-persistence-process.test-support",
  distWorkerPath: "test-support/mini-me-persistence-process.test-support.js",
} as const;

export const SYNTHETIC_OWNER_EMAIL = "synthetic-mini-me-owner@example.test";
export const SYNTHETIC_OTHER_EMAIL = "synthetic-mini-me-other@example.test";

export type BeliefStatus = { id: string; status: MiniMeBelief["status"] };
export type Outcome<T> = { ok: true; value: T } | { ok: false; name: string; message: string };
export type DatabaseFact = {
  kind: "agent" | "state";
  agentId?: string;
  foundVersion: number;
  supportedVersion: number;
};
export type PreflightSummary = {
  incompatible: DatabaseFact[];
  pending: DatabaseFact[];
  indeterminate: { kind: "agent" | "state"; agentId?: string; reason: string }[];
};
export type SeedFacts = {
  ownerId: string;
  otherOwnerId: string;
  created: MiniMeProfile;
  active: MiniMeProfile;
};

export type MiniMePersistenceCommand =
  | { action: "preflight"; scope?: "state" }
  | { action: "seed" }
  | { action: "reopen"; facts: SeedFacts }
  | { action: "after-disable"; facts: SeedFacts; disabled: MiniMeProfile }
  | { action: "after-delete"; facts: SeedFacts; deleted: MiniMeProfile }
  | { action: "restored"; facts: SeedFacts }
  | { action: "downgrade"; facts: SeedFacts };

export type SeedReply = SeedFacts & {
  kind: "seeded";
  preflight: PreflightSummary;
  readBeforeOptIn: MiniMeProfileState | null;
  nonCanonical: Outcome<MiniMeProfile>;
  beliefs: BeliefStatus[];
  activeBeliefs: { drink: string[]; milk: string[] };
  replayApplied: { correction: number; inferred: number };
};
export type ReopenReply = {
  kind: "reopened";
  read: MiniMeProfileState | null;
  metadataLifecycle: string | undefined;
  beliefs: BeliefStatus[];
  replayApplied: { correction: number; inferred: number };
  foreignRead: MiniMeProfileState | null;
  foreignConfigure: Outcome<MiniMeProfile>;
  foreignSnapshot: Outcome<unknown>;
  disabling: MiniMeProfile;
  disabled: MiniMeProfile;
};
export type AfterDisableReply = {
  kind: "after-disable";
  read: MiniMeProfileState | null;
  metadataLifecycle: string | undefined;
  runAssertion: Outcome<unknown>;
  staleLearn: Outcome<unknown>;
  replayActivate: Outcome<MiniMeProfile>;
  lifecycleAfterReplay: string | undefined;
  reactivate: Outcome<MiniMeProfile>;
  deleting: MiniMeProfile;
  deleted: MiniMeProfile;
};
export type AfterDeleteReply = {
  kind: "after-delete";
  read: MiniMeProfileState | null;
  metadataLifecycle: string | undefined;
  snapshot: Outcome<unknown>;
  replayLearn: Outcome<unknown>;
  recreated: MiniMeProfile;
  recreatedBeliefs: BeliefStatus[];
};
export type RestoredReply = {
  kind: "restored";
  read: MiniMeProfileState | null;
  metadataLifecycle: string | undefined;
  beliefs: BeliefStatus[];
  replayApplied: { correction: number; inferred: number };
};
export type DowngradeReply = {
  kind: "downgrade";
  preflight: Outcome<PreflightSummary>;
  read: Outcome<MiniMeProfileState | null>;
};
export type MiniMePersistenceReply =
  | (PreflightSummary & { kind: "preflight" })
  | SeedReply
  | ReopenReply
  | AfterDisableReply
  | AfterDeleteReply
  | RestoredReply
  | DowngradeReply;
export type MiniMePersistenceMessage =
  | { kind: "booted" }
  | { kind: "reply"; reply: MiniMePersistenceReply }
  | { kind: "error"; error: string };

const models: MiniMeModels = {
  conversationModel: null,
  decisionModel: null,
  allowInference: false,
};
const manualSource: MiniMeSource = {
  id: "synthetic-manual-source",
  selection: { kind: "manual", label: "Synthetic fixture preferences" },
  revision: 0,
  status: "ready",
  lastIngestedAt: null,
  detail: null,
};
const direct: MiniMeBelief = {
  id: "synthetic-belief-tea",
  preference: {
    document: "PREFERENCES.md",
    scope: "drink",
    statement: "Choose tea",
    preferred: ["tea"],
    avoided: ["coffee"],
  },
  origin: "direct",
  evidence: [
    {
      sourceId: manualSource.id,
      sourceRevision: "synthetic-r1",
      excerpt: "Synthetic: I prefer tea",
    },
  ],
  status: "active",
  supersedes: null,
  createdAt: 1,
};
const correctionEvidence: MiniMeEvidence = {
  sourceId: manualSource.id,
  sourceRevision: "synthetic-r2",
  excerpt: "Synthetic: actually, choose coffee",
};
const correction: MiniMeBelief = {
  id: "synthetic-belief-coffee",
  preference: {
    ...direct.preference,
    statement: "Choose coffee",
    preferred: ["coffee"],
    avoided: ["tea"],
  },
  origin: "correction",
  evidence: [correctionEvidence],
  status: "active",
  supersedes: direct.id,
  createdAt: 2,
};
const inferredEvidence: MiniMeEvidence = {
  sourceId: manualSource.id,
  sourceRevision: "synthetic-r3",
  excerpt: "Synthetic transcript: oat milk, please",
};
const inferred: MiniMeBelief = {
  id: "synthetic-belief-oat-milk",
  preference: {
    document: "PREFERENCES.md",
    scope: "milk",
    statement: "Choose oat milk",
    preferred: ["oat milk"],
    avoided: ["dairy milk"],
  },
  origin: "inferred",
  evidence: [inferredEvidence],
  status: "active",
  supersedes: null,
  createdAt: 3,
};

const assertCurrent = () => {};
const ownedBy = (ownerId: string, profile: MiniMeProfile) => ({ ownerId, miniMeId: profile.id });
const scopeOf = (ownerId: string, profile: MiniMeProfile): MiniMeContentScope => ({
  ownerId,
  miniMeId: profile.id,
  agentId: profile.agentId,
  generation: profile.generation,
});
const statuses = (beliefs: readonly MiniMeBelief[]): BeliefStatus[] =>
  beliefs.map(({ id, status }) => ({ id, status })).toSorted((a, b) => a.id.localeCompare(b.id));

async function outcome<T>(operation: () => Promise<T> | T): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return error instanceof Error
      ? { ok: false, name: error.name, message: error.message }
      : { ok: false, name: typeof error, message: String(error) };
  }
}

function summarizePreflight(result: DoctorDatabasePreflight): PreflightSummary {
  const fact = (row: DatabaseFact): DatabaseFact => ({
    kind: row.kind,
    ...(row.agentId ? { agentId: row.agentId } : {}),
    foundVersion: row.foundVersion,
    supportedVersion: row.supportedVersion,
  });
  const order = (a: DatabaseFact, b: DatabaseFact) =>
    `${a.kind}:${a.agentId ?? ""}`.localeCompare(`${b.kind}:${b.agentId ?? ""}`);
  return {
    incompatible: result.incompatible.map(fact).toSorted(order),
    pending: (result.pendingMigrations ?? []).map(fact).toSorted(order),
    indeterminate: result.indeterminate.map(({ kind, agentId, reason }) => ({
      kind,
      ...(agentId ? { agentId } : {}),
      reason,
    })),
  };
}

async function loadOwners() {
  const [hostStorage, projection, preflight, profiles] = await Promise.all([
    import("../../src/mini-me/host-storage.js"),
    import("../../src/mini-me/private-agent-projection.js"),
    import("../../src/commands/doctor-database-preflight.js"),
    import("../../src/state/user-profile-writes.js"),
  ]);
  const state = hostStorage.miniMeHostState(assertCurrent);
  const withContent = <T>(
    profile: MiniMeProfile,
    consume: (store: MiniMeContentStore) => Promise<T>,
  ): Promise<T> => hostStorage.withMiniMeContent(profile, assertCurrent, consume);
  return { state, withContent, projection, preflight, profiles };
}
type Owners = Awaited<ReturnType<typeof loadOwners>>;

/** Distinctly worded replays of undone evidence; fresh IDs never borrow a stored receipt. */
async function replayUndone(store: MiniMeContentStore, scope: MiniMeContentScope, phase: string) {
  const replayedCorrection = await store.learnBatch({
    scope,
    operationId: `synthetic-replay-correction-${phase}`,
    beliefs: [
      {
        ...correction,
        id: `synthetic-belief-coffee-replay-${phase}`,
        evidence: [{ ...correctionEvidence, excerpt: `Synthetic: coffee, again (${phase})` }],
      },
    ],
  });
  // A later cursor revision cites the same excerpt; the undo suppresses the excerpt itself.
  const replayedInference = await store.learnBatch({
    scope,
    operationId: `synthetic-replay-inferred-${phase}`,
    beliefs: [
      {
        ...inferred,
        id: `synthetic-belief-oat-milk-replay-${phase}`,
        preference: { ...inferred.preference, statement: `Prefer oat milk (${phase})` },
        evidence: [{ ...inferredEvidence, sourceRevision: `synthetic-r-${phase}` }],
      },
    ],
  });
  return {
    correction: replayedCorrection.applied.length,
    inferred: replayedInference.applied.length,
  };
}

async function seed(owners: Owners): Promise<SeedReply> {
  const { state, withContent } = owners;
  const preflight = summarizePreflight(await owners.preflight.prepareDoctorDatabasePreflight());
  const ownerId = (await owners.profiles.ensureCanonicalUserProfileForEmail(SYNTHETIC_OWNER_EMAIL))
    .id;
  const otherOwnerId = (
    await owners.profiles.ensureCanonicalUserProfileForEmail(SYNTHETIC_OTHER_EMAIL)
  ).id;
  const readBeforeOptIn = await state.read(ownerId);
  const nonCanonical = await outcome(() =>
    state.beginCreate({
      ownerId: "synthetic-non-canonical-person",
      operationId: "synthetic-non-canonical-create",
      name: "Unowned",
      models,
    }),
  );
  const created = await state.beginCreate({
    ownerId,
    operationId: "synthetic-create",
    name: "Synthetic adviser",
    models,
  });
  await withContent(created, (store) =>
    store.initialize({ scope: scopeOf(ownerId, created), operationId: "synthetic-initialize-0" }),
  );
  const active = await state.activate({
    scope: ownedBy(ownerId, created),
    operationId: "synthetic-activate",
    expectedRevision: created.revision,
  });
  const scope = scopeOf(ownerId, active);
  return await withContent(active, async (store) => {
    await store.addSource({ scope, operationId: "synthetic-source", source: manualSource });
    await store.learnBatch({ scope, operationId: "synthetic-learn-direct", beliefs: [direct] });
    await store.learnBatch({ scope, operationId: "synthetic-correct", beliefs: [correction] });
    await store.undo({ scope, operationId: "synthetic-undo-correction", beliefId: correction.id });
    await store.learnBatch({ scope, operationId: "synthetic-learn-inferred", beliefs: [inferred] });
    await store.undo({ scope, operationId: "synthetic-undo-inferred", beliefId: inferred.id });
    const replayApplied = await replayUndone(store, scope, "seed");
    const exported = await store.readExport(scope);
    return {
      kind: "seeded",
      preflight,
      ownerId,
      otherOwnerId,
      created,
      active,
      readBeforeOptIn,
      nonCanonical,
      beliefs: statuses(exported.beliefs),
      activeBeliefs: {
        drink: (await store.readBeliefs({ scope, topic: "drink" })).map(({ id }) => id),
        milk: (await store.readBeliefs({ scope, topic: "milk" })).map(({ id }) => id),
      },
      replayApplied,
    };
  });
}

async function reopen(owners: Owners, facts: SeedFacts): Promise<ReopenReply> {
  const { state, withContent, projection } = owners;
  const { ownerId, otherOwnerId, active } = facts;
  await projection.prepareMiniMePrivateAgentProjection();
  const read = await state.read(ownerId);
  const metadataLifecycle = projection.readMiniMePrivateAgentMetadata(active.agentId)?.lifecycle;
  const scope = scopeOf(ownerId, active);
  const { beliefs, replayApplied, foreignSnapshot } = await withContent(active, async (store) => ({
    beliefs: statuses((await store.readExport(scope)).beliefs),
    replayApplied: await replayUndone(store, scope, "reopen"),
    foreignSnapshot: await outcome(() => store.readSnapshot({ ...scope, ownerId: otherOwnerId })),
  }));
  const foreignRead = await state.read(otherOwnerId, active.id);
  const foreignConfigure = await outcome(() =>
    state.configure({
      scope: { ownerId: otherOwnerId, miniMeId: active.id },
      operationId: "synthetic-foreign-configure",
      expectedRevision: active.revision,
      patch: { name: "Taken" },
    }),
  );
  // The coordinated disable used by the service: close, mirror the generation, finalize.
  const disabling = await state.closeLifecycle({
    scope: ownedBy(ownerId, active),
    operationId: "synthetic-disable-close",
    expectedRevision: active.revision,
    lifecycle: "disabling",
  });
  await withContent(disabling, (store) =>
    store.initialize({
      scope: scopeOf(ownerId, disabling),
      operationId: "synthetic-initialize-disabling",
    }),
  );
  const disabled = await state.finalizeLifecycle({
    scope: ownedBy(ownerId, disabling),
    operationId: "synthetic-disabled",
    expectedRevision: disabling.revision,
    lifecycle: "disabled",
  });
  return {
    kind: "reopened",
    read,
    metadataLifecycle,
    beliefs,
    replayApplied,
    foreignRead,
    foreignConfigure,
    foreignSnapshot,
    disabling,
    disabled,
  };
}

async function afterDisable(
  owners: Owners,
  facts: SeedFacts,
  disabled: MiniMeProfile,
): Promise<AfterDisableReply> {
  const { state, withContent, projection } = owners;
  const { ownerId, created, active } = facts;
  await projection.prepareMiniMePrivateAgentProjection();
  const read = await state.read(ownerId, active.id);
  const metadataLifecycle = projection.readMiniMePrivateAgentMetadata(active.agentId)?.lifecycle;
  const runAssertion = await outcome(() =>
    projection.capturePrivateMiniMeRunAssertion({
      agentId: active.agentId,
      marker: { ownerProfileId: ownerId, profileId: active.id },
      ownerId,
    }),
  );
  const staleLearn = await outcome(() =>
    withContent(disabled, (store) =>
      store.learnBatch({
        scope: scopeOf(ownerId, active),
        operationId: "synthetic-stale-learn",
        beliefs: [{ ...direct, id: "synthetic-belief-stale" }],
      }),
    ),
  );
  // Replaying the original activation returns its stored receipt; it must not reopen consent.
  const replayActivate = await outcome(() =>
    state.activate({
      scope: ownedBy(ownerId, created),
      operationId: "synthetic-activate",
      expectedRevision: created.revision,
    }),
  );
  const lifecycleAfterReplay = (await state.read(ownerId, active.id))?.profile.lifecycle;
  const reactivate = await outcome(() =>
    state.activate({
      scope: ownedBy(ownerId, disabled),
      operationId: "synthetic-reactivate",
      expectedRevision: disabled.revision,
    }),
  );
  // The coordinated delete used by the service, minus Gateway-owned agent config removal.
  const deleting = await state.closeLifecycle({
    scope: ownedBy(ownerId, disabled),
    operationId: "synthetic-delete-close",
    expectedRevision: disabled.revision,
    lifecycle: "deleting",
  });
  await withContent(deleting, async (store) => {
    const scope = scopeOf(ownerId, deleting);
    await store.initialize({ scope, operationId: "synthetic-initialize-deleting" });
    await store.purge({ scope, operationId: "synthetic-purge" });
  });
  const deleted = await state.finalizeLifecycle({
    scope: ownedBy(ownerId, deleting),
    operationId: "synthetic-deleted",
    expectedRevision: deleting.revision,
    lifecycle: "deleted",
  });
  return {
    kind: "after-disable",
    read,
    metadataLifecycle,
    runAssertion,
    staleLearn,
    replayActivate,
    lifecycleAfterReplay,
    reactivate,
    deleting,
    deleted,
  };
}

async function afterDelete(
  owners: Owners,
  facts: SeedFacts,
  deleted: MiniMeProfile,
): Promise<AfterDeleteReply> {
  const { state, withContent, projection } = owners;
  const { ownerId, active } = facts;
  await projection.prepareMiniMePrivateAgentProjection();
  const read = await state.read(ownerId, active.id);
  const metadataLifecycle = projection.readMiniMePrivateAgentMetadata(active.agentId)?.lifecycle;
  const snapshot = await outcome(() =>
    withContent(deleted, (store) => store.readSnapshot(scopeOf(ownerId, deleted))),
  );
  // The purge removed content receipts, so the original learn operation cannot be replayed.
  const replayLearn = await outcome(() =>
    withContent(deleted, (store) =>
      store.learnBatch({
        scope: scopeOf(ownerId, active),
        operationId: "synthetic-learn-direct",
        beliefs: [direct],
      }),
    ),
  );
  const recreated = await state.beginCreate({
    ownerId,
    operationId: "synthetic-recreate",
    name: "Synthetic adviser again",
    models,
  });
  const recreatedBeliefs = await withContent(recreated, async (store) =>
    statuses(
      (
        await store.initialize({
          scope: scopeOf(ownerId, recreated),
          operationId: "synthetic-recreate-initialize",
        })
      ).beliefs,
    ),
  );
  return {
    kind: "after-delete",
    read,
    metadataLifecycle,
    snapshot,
    replayLearn,
    recreated,
    recreatedBeliefs,
  };
}

async function restored(owners: Owners, facts: SeedFacts): Promise<RestoredReply> {
  const { state, withContent, projection } = owners;
  const { ownerId, active } = facts;
  await projection.prepareMiniMePrivateAgentProjection();
  const read = await state.read(ownerId, active.id);
  const metadataLifecycle = projection.readMiniMePrivateAgentMetadata(active.agentId)?.lifecycle;
  const scope = scopeOf(ownerId, active);
  const content = await withContent(active, async (store) => ({
    beliefs: statuses((await store.readExport(scope)).beliefs),
    replayApplied: await replayUndone(store, scope, "restored"),
  }));
  return { kind: "restored", read, metadataLifecycle, ...content };
}

async function downgrade(owners: Owners, facts: SeedFacts): Promise<DowngradeReply> {
  return {
    kind: "downgrade",
    preflight: await outcome(async () =>
      summarizePreflight(await owners.preflight.prepareDoctorDatabasePreflight({ scope: "state" })),
    ),
    read: await outcome(() => owners.state.read(facts.ownerId)),
  };
}

async function run(command: MiniMePersistenceCommand): Promise<MiniMePersistenceReply> {
  const [agentDb, stateDb] = await Promise.all([
    import("../../src/state/openclaw-agent-db.js"),
    import("../../src/state/openclaw-state-db.js"),
  ]);
  try {
    const owners = await loadOwners();
    switch (command.action) {
      case "preflight":
        return {
          kind: "preflight",
          ...summarizePreflight(
            await owners.preflight.prepareDoctorDatabasePreflight(
              command.scope ? { scope: command.scope } : {},
            ),
          ),
        };
      case "seed":
        return await seed(owners);
      case "reopen":
        return await reopen(owners, command.facts);
      case "after-disable":
        return await afterDisable(owners, command.facts, command.disabled);
      case "after-delete":
        return await afterDelete(owners, command.facts, command.deleted);
      case "restored":
        return await restored(owners, command.facts);
      case "downgrade":
        return await downgrade(owners, command.facts);
      default:
        return assert.fail("Unknown Mini Me persistence qualification action");
    }
  } finally {
    // Join both writers before replying so the parent observes only committed, closed stores.
    await agentDb.closeOpenClawAgentDatabasesAsync();
    await stateDb.closeOpenClawStateDatabaseAsync();
  }
}

async function send(message: MiniMePersistenceMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    assert.ok(typeof process.send === "function");
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

function main(): void {
  process.once("message", (command: MiniMePersistenceCommand) => {
    void (async () => {
      try {
        await send({ kind: "reply", reply: await run(command) });
      } catch (error) {
        process.exitCode = 1;
        await send({
          kind: "error",
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      } finally {
        process.disconnect?.();
      }
    })();
  });
  send({ kind: "booted" }).catch((error: unknown) => {
    process.exitCode = 1;
    console.error(error);
    process.disconnect?.();
  });
}

// The parent imports this module only for its declaration; only the forked entry runs.
// Resolve argv too: a worktree's shared node_modules link can alias the entry path.
if (
  process.argv[1] &&
  pathToFileURL(fs.realpathSync(process.argv[1])).href ===
    pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href
) {
  main();
}
