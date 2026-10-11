import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  MiniMeDocument,
  MiniMeOutcome,
  MiniMePrediction,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { MINI_ME_LIMITS } from "./learning.js";
import {
  MiniMePersistenceError,
  miniMeOperationFingerprint,
  type MiniMeContentScope,
  type MiniMeContentWorkerOperations,
} from "./persistence.types.js";

// Append-only owner records: a replayed identical record is accepted, a changed one conflicts.

export function recordActionRestore(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  input: MiniMeContentWorkerOperations["recordActionRestore"]["input"],
  charge: (additional: number) => void,
): MiniMeContentWorkerOperations["recordActionRestore"]["output"] {
  const k = getNodeSqliteKysely<DB>(db);
  if (
    Buffer.byteLength(input.before.utf8, "utf8") > MINI_ME_LIMITS.documentBytes ||
    createHash("sha256").update(input.before.utf8, "utf8").digest("hex") !== input.before.sha256 ||
    !/^[a-f0-9]{64}$/.test(input.afterSha256)
  ) {
    throw new MiniMePersistenceError(
      "invalid",
      "Workspace restore preimage or content hash is invalid",
    );
  }
  const previous = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_action_restores")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("action_id", "=", input.actionId),
  );
  if (previous) {
    if (
      previous.target_agent_id !== input.targetAgentId ||
      previous.resource !== input.resource ||
      previous.before_sha256 !== input.before.sha256 ||
      previous.after_sha256 !== input.afterSha256 ||
      previous.before_utf8 !== input.before.utf8
    ) {
      throw new MiniMePersistenceError(
        "operation-conflict",
        "Action restore receipt already belongs to different content",
      );
    }
    return { receiptId: previous.receipt_id };
  }
  charge(1);
  const receiptId = randomUUID();
  executeSqliteQuerySync(
    db,
    k.insertInto("mini_me_action_restores").values({
      owner_id: scope.ownerId,
      mini_me_id: scope.miniMeId,
      receipt_id: receiptId,
      action_id: input.actionId,
      target_agent_id: input.targetAgentId,
      resource: input.resource,
      before_utf8: input.before.utf8,
      before_sha256: input.before.sha256,
      after_sha256: input.afterSha256,
      created_at: input.createdAt,
    }),
  );
  return { receiptId };
}
/**
 * Keyed by action, not receipt, so a record whose acknowledgment was lost is still found.
 * An absent row is already released; returns the number of retained rows removed.
 */
export function releaseActionRestore(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  input: MiniMeContentWorkerOperations["releaseActionRestore"]["input"],
): number {
  const k = getNodeSqliteKysely<DB>(db);
  return Number(
    executeSqliteQuerySync(
      db,
      k
        .deleteFrom("mini_me_action_restores")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("action_id", "=", input.actionId),
    ).numAffectedRows ?? 0n,
  );
}
export function reviseDocument(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  input: MiniMeContentWorkerOperations["reviseDocument"]["input"],
  charge: (additional: number) => void,
): MiniMeDocument {
  const k = getNodeSqliteKysely<DB>(db);
  if (Buffer.byteLength(input.content, "utf8") > MINI_ME_LIMITS.documentBytes) {
    throw new MiniMePersistenceError("limit-reached", "Mini Me document byte limit is reached");
  }
  const prior = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_documents")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("name", "=", input.name)
      .orderBy("revision", "desc")
      .limit(1),
  );
  if (!prior || prior.revision !== input.expectedRevision) {
    throw new MiniMePersistenceError("conflict", "Document changed; inspect its current revision");
  }
  charge(1);
  const document: MiniMeDocument = {
    name: input.name,
    content: input.content,
    revision: prior.revision + 1,
    updatedAt: Date.now(),
  };
  executeSqliteQuerySync(
    db,
    k.insertInto("mini_me_documents").values({
      owner_id: scope.ownerId,
      mini_me_id: scope.miniMeId,
      name: document.name,
      revision: document.revision,
      content: document.content,
      updated_at: document.updatedAt,
      source_ids_json: JSON.stringify(input.evidenceSourceIds ?? []),
    }),
  );
  return document;
}
export function freezePrediction(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  prediction: MiniMePrediction,
  contentRevision: number,
  charge: (additional: number) => void,
): null {
  const k = getNodeSqliteKysely<DB>(db);
  if (
    prediction.authority !== "advisory" ||
    prediction.profileGeneration !== scope.generation ||
    prediction.contentRevision !== contentRevision ||
    (prediction.optionId !== null &&
      !prediction.choice.options.some((o) => o.id === prediction.optionId))
  ) {
    throw new MiniMePersistenceError(
      "invalid",
      "Prediction is not grounded in the current advisory snapshot",
    );
  }
  const prior = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_predictions")
      .select("payload_json")
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("prediction_id", "=", prediction.id),
  );
  if (prior) {
    if (
      miniMeOperationFingerprint(JSON.parse(prior.payload_json) as unknown) !==
      miniMeOperationFingerprint(prediction)
    ) {
      throw new MiniMePersistenceError("conflict", "Frozen prediction cannot be changed");
    }
    return null;
  }
  for (const beliefId of prediction.beliefIds) {
    const belief = executeSqliteQueryTakeFirstSync(
      db,
      k
        .selectFrom("mini_me_beliefs")
        .select("status")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("belief_id", "=", beliefId),
    );
    if (!belief || belief.status !== "active") {
      throw new MiniMePersistenceError("conflict", "Prediction evidence changed");
    }
  }
  charge(1);
  executeSqliteQuerySync(
    db,
    k.insertInto("mini_me_predictions").values({
      owner_id: scope.ownerId,
      mini_me_id: scope.miniMeId,
      prediction_id: prediction.id,
      created_at: prediction.createdAt,
      payload_json: JSON.stringify(prediction),
    }),
  );
  return null;
}
export function appendOutcome(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  outcome: MiniMeOutcome,
  charge: (additional: number) => void,
): MiniMeOutcome {
  const k = getNodeSqliteKysely<DB>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_predictions")
      .select("payload_json")
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("prediction_id", "=", outcome.predictionId),
  );
  if (!row) {
    throw new MiniMePersistenceError("not-found", "Frozen prediction is unavailable");
  }
  // SAFETY: freezePrediction writes this typed prediction payload; the exact owner and prediction row were selected above.
  const prediction = JSON.parse(row.payload_json) as MiniMePrediction;
  if (
    outcome.createdAt <= prediction.createdAt ||
    !prediction.choice.options.some((o) => o.id === outcome.optionId) ||
    outcome.matched !== (prediction.optionId === outcome.optionId)
  ) {
    throw new MiniMePersistenceError("invalid", "Outcome does not match the frozen choice");
  }
  const prior = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_outcomes")
      .select("payload_json")
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("prediction_id", "=", outcome.predictionId)
      .where("origin", "=", outcome.origin),
  );
  if (prior) {
    if (
      miniMeOperationFingerprint(JSON.parse(prior.payload_json) as unknown) !==
      miniMeOperationFingerprint(outcome)
    ) {
      throw new MiniMePersistenceError("conflict", "Decision outcome is already recorded");
    }
    return outcome;
  }
  charge(1);
  executeSqliteQuerySync(
    db,
    k.insertInto("mini_me_outcomes").values({
      owner_id: scope.ownerId,
      mini_me_id: scope.miniMeId,
      outcome_id: outcome.id,
      prediction_id: outcome.predictionId,
      origin: outcome.origin,
      created_at: outcome.createdAt,
      payload_json: JSON.stringify(outcome),
    }),
  );
  return outcome;
}
