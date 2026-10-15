import type { DatabaseSync } from "node:sqlite";
import type {
  MiniMeBelief,
  MiniMeEvidence,
  MiniMeSource,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { normalizeMiniMeValue } from "./learning.js";
import {
  MiniMePersistenceError,
  miniMeOperationFingerprint,
  type MiniMeContentScope,
  type MiniMeContentWorkerOperations,
} from "./persistence.types.js";

// An unrelated append changes the source cursor, not the evidence the owner undid.
// Keep the original revision in each belief for lineage; inference replay and undo
// are keyed on the supporting excerpt. Direct owner statements keep event identity.
function suppressionKey(origin: MiniMeBelief["origin"], evidence: MiniMeEvidence): string {
  return miniMeOperationFingerprint(
    origin === "inferred"
      ? ["excerpt-v1", normalizeMiniMeValue(evidence.excerpt)]
      : ["revision-v1", evidence.sourceRevision],
  );
}
function learningKey(belief: MiniMeBelief): string {
  if (belief.origin !== "inferred") {
    return miniMeOperationFingerprint({
      preference: belief.preference,
      origin: belief.origin,
      evidence: belief.evidence,
    });
  }
  const preference = belief.preference;
  return miniMeOperationFingerprint({
    origin: belief.origin,
    preference: {
      document: preference.document,
      scope: normalizeMiniMeValue(preference.scope),
      statement: normalizeMiniMeValue(preference.statement),
      preferred: preference.preferred
        .map(normalizeMiniMeValue)
        .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      avoided: preference.avoided
        .map(normalizeMiniMeValue)
        .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    },
    evidence: belief.evidence
      .map((evidence) => [evidence.sourceId, suppressionKey(belief.origin, evidence)])
      .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  });
}
function writeBelief(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  belief: MiniMeBelief,
  insert: boolean,
): void {
  const k = getNodeSqliteKysely<DB>(db);
  if (insert) {
    executeSqliteQuerySync(
      db,
      k.insertInto("mini_me_beliefs").values({
        owner_id: scope.ownerId,
        mini_me_id: scope.miniMeId,
        belief_id: belief.id,
        scope: normalizeMiniMeValue(belief.preference.scope),
        origin: belief.origin,
        status: belief.status,
        created_at: belief.createdAt,
        payload_json: JSON.stringify(belief),
      }),
    );
  } else {
    executeSqliteQuerySync(
      db,
      k
        .updateTable("mini_me_beliefs")
        .set({ status: belief.status, payload_json: JSON.stringify(belief) })
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("belief_id", "=", belief.id),
    );
  }
}
export function learnBeliefBatch(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  input: MiniMeContentWorkerOperations["learnBatch"]["input"],
  contentRevision: number,
  charge: (additional: number) => void,
): MiniMeContentWorkerOperations["learnBatch"]["output"] {
  const k = getNodeSqliteKysely<DB>(db);
  let source: MiniMeSource | undefined;
  if (input.sourceId) {
    const selected = executeSqliteQueryTakeFirstSync(
      db,
      k
        .selectFrom("mini_me_sources")
        .selectAll()
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("source_id", "=", input.sourceId),
    );
    if (!selected || selected.cursor !== (input.expectedCursor ?? null)) {
      throw new MiniMePersistenceError("conflict", "Source cursor changed or source was removed");
    }
    // SAFETY: The typed content worker writes this source or belief JSON; scope and generation were checked before dispatch.
    source = JSON.parse(selected.payload_json) as MiniMeSource;
  }
  if (input.sourceStatus && !source) {
    throw new MiniMePersistenceError("invalid", "A source status requires a selected source");
  }
  if (input.sourceStatus?.detail && input.sourceStatus.detail.length > 512) {
    throw new MiniMePersistenceError("invalid", "Source status detail exceeds its bound");
  }
  const applied: MiniMeBelief[] = [];
  for (const belief of input.beliefs) {
    const evidenceKey = learningKey(belief);
    if (
      executeSqliteQueryTakeFirstSync(
        db,
        k
          .selectFrom("mini_me_learning_keys")
          .select("belief_id")
          .where("owner_id", "=", scope.ownerId)
          .where("mini_me_id", "=", scope.miniMeId)
          .where("evidence_key", "=", evidenceKey),
      )
    ) {
      continue;
    }
    const known = executeSqliteQueryTakeFirstSync(
      db,
      k
        .selectFrom("mini_me_beliefs")
        .select("payload_json")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("belief_id", "=", belief.id),
    );
    if (known) {
      if (
        miniMeOperationFingerprint(JSON.parse(known.payload_json) as unknown) !==
        miniMeOperationFingerprint(belief)
      ) {
        throw new MiniMePersistenceError("conflict", "Belief ID already names different evidence");
      }
      continue;
    }
    if (
      !belief.evidence.length ||
      belief.evidence.some(
        (e) =>
          !executeSqliteQueryTakeFirstSync(
            db,
            k
              .selectFrom("mini_me_sources")
              .select("source_id")
              .where("owner_id", "=", scope.ownerId)
              .where("mini_me_id", "=", scope.miniMeId)
              .where("source_id", "=", e.sourceId),
          ),
      )
    ) {
      throw new MiniMePersistenceError(
        "invalid",
        "Belief evidence must reference selected owner sources",
      );
    }
    const suppressed = belief.evidence.some((e) =>
      Boolean(
        executeSqliteQueryTakeFirstSync(
          db,
          k
            .selectFrom("mini_me_suppressions")
            .select("source_id")
            .where("owner_id", "=", scope.ownerId)
            .where("mini_me_id", "=", scope.miniMeId)
            .where("source_id", "=", e.sourceId)
            .where("evidence_key", "=", suppressionKey(belief.origin, e)),
        ),
      ),
    );
    if (suppressed) {
      continue;
    }
    charge(1);
    if (belief.supersedes) {
      const prior = executeSqliteQueryTakeFirstSync(
        db,
        k
          .selectFrom("mini_me_beliefs")
          .select("payload_json")
          .where("owner_id", "=", scope.ownerId)
          .where("mini_me_id", "=", scope.miniMeId)
          .where("belief_id", "=", belief.supersedes),
      );
      if (!prior) {
        throw new MiniMePersistenceError("not-found", "Corrected belief is unavailable");
      }
      // SAFETY: The typed content worker writes this source or belief JSON; scope and generation were checked before dispatch.
      const previous = JSON.parse(prior.payload_json) as MiniMeBelief;
      if (
        belief.origin !== "correction" ||
        normalizeMiniMeValue(previous.preference.scope) !==
          normalizeMiniMeValue(belief.preference.scope)
      ) {
        throw new MiniMePersistenceError(
          "invalid",
          "Only an owner correction may supersede a comparable belief",
        );
      }
      writeBelief(db, scope, { ...previous, status: "superseded" }, false);
    }
    writeBelief(db, scope, belief, true);
    executeSqliteQuerySync(
      db,
      k.insertInto("mini_me_learning_keys").values({
        owner_id: scope.ownerId,
        mini_me_id: scope.miniMeId,
        evidence_key: evidenceKey,
        belief_id: belief.id,
      }),
    );
    applied.push(belief);
  }
  if (input.sourceId && source) {
    const sourceStatus = input.sourceStatus ?? { status: "ready" as const, detail: null };
    executeSqliteQuerySync(
      db,
      k
        .updateTable("mini_me_sources")
        .set({
          cursor: input.cursor ?? null,
          payload_json: JSON.stringify({
            ...source,
            lastIngestedAt: Date.now(),
            ...sourceStatus,
          }),
        })
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("source_id", "=", input.sourceId),
    );
  }
  return { contentRevision: contentRevision + 1, applied };
}
/** Undo suppresses the supporting evidence so replayed learning cannot restore the belief. */
export function undoBelief(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  beliefId: string,
): MiniMeBelief {
  const k = getNodeSqliteKysely<DB>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_beliefs")
      .select("payload_json")
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("belief_id", "=", beliefId),
  );
  if (!row) {
    throw new MiniMePersistenceError("not-found", "Learned belief is unavailable");
  }
  // SAFETY: The typed content worker writes this source or belief JSON; scope and generation were checked before dispatch.
  const belief = JSON.parse(row.payload_json) as MiniMeBelief;
  for (const evidence of belief.evidence) {
    executeSqliteQuerySync(
      db,
      k
        .insertInto("mini_me_suppressions")
        .values({
          owner_id: scope.ownerId,
          mini_me_id: scope.miniMeId,
          source_id: evidence.sourceId,
          evidence_key: suppressionKey(belief.origin, evidence),
        })
        .onConflict((c) =>
          c.columns(["owner_id", "mini_me_id", "source_id", "evidence_key"]).doNothing(),
        ),
    );
  }
  const undone = { ...belief, status: "undone" as const };
  writeBelief(db, scope, undone, false);
  if (belief.supersedes) {
    const prior = executeSqliteQueryTakeFirstSync(
      db,
      k
        .selectFrom("mini_me_beliefs")
        .select("payload_json")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("belief_id", "=", belief.supersedes),
    );
    if (prior) {
      // SAFETY: The typed content worker writes this source or belief JSON; scope and generation were checked before dispatch.
      const previous = JSON.parse(prior.payload_json) as MiniMeBelief;
      if (previous.status === "superseded") {
        writeBelief(db, scope, { ...previous, status: "active" }, false);
      }
    }
  }
  return undone;
}
