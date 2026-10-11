import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  MiniMeBelief,
  MiniMeDocument,
  MiniMePrediction,
  MiniMeOutcome,
  MiniMeSource,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { MINI_ME_DOCUMENT_NAMES } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { MINI_ME_LIMITS, normalizeMiniMeValue } from "./learning.js";
import {
  MiniMePersistenceError,
  type MiniMeContentScope,
  type MiniMeActionRestore,
  type MiniMeContentSnapshot,
  type MiniMeContentWorkerOperations,
} from "./persistence.types.js";

// Every content read and write enters through this generation fence for the bound agent.
export function readContentMeta(db: DatabaseSync, scope: MiniMeContentScope) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("mini_me_content")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("agent_id", "=", scope.agentId),
  );
  if (!row) {
    throw new MiniMePersistenceError(
      "not-found",
      "Mini Me content is unavailable for this owner and agent",
    );
  }
  if (row.generation !== scope.generation) {
    throw new MiniMePersistenceError("conflict", "Mini Me content generation changed");
  }
  return row;
}
export function readContentSnapshot(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  full = false,
): MiniMeContentSnapshot {
  const row = readContentMeta(db, scope),
    k = getNodeSqliteKysely<DB>(db);
  const documents: MiniMeDocument[] = MINI_ME_DOCUMENT_NAMES.flatMap((name) => {
    const document = executeSqliteQueryTakeFirstSync(
      db,
      k
        .selectFrom("mini_me_documents")
        .selectAll()
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("name", "=", name)
        .orderBy("revision", "desc")
        .limit(1),
    );
    return document
      ? [
          {
            name,
            content: document.content,
            revision: document.revision,
            updatedAt: document.updated_at,
          },
        ]
      : [];
  });
  const limit = full ? MINI_ME_LIMITS.retainedEvents : 50;
  return {
    contentRevision: row.revision,
    historyCursor: null,
    documents,
    sources: executeSqliteQuerySync(
      db,
      k
        .selectFrom("mini_me_sources")
        .select("payload_json")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .limit(MINI_ME_LIMITS.sources),
      // SAFETY: The typed content worker owns this table payload; this query is bound to the checked owner and Mini Me scope.
    ).rows.map((r) => JSON.parse(r.payload_json) as MiniMeSource),
    beliefs: executeSqliteQuerySync(
      db,
      k
        .selectFrom("mini_me_beliefs")
        .select("payload_json")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .orderBy("created_at", "desc")
        .orderBy("belief_id", "desc")
        .limit(limit),
      // SAFETY: The typed content worker owns this table payload; this query is bound to the checked owner and Mini Me scope.
    ).rows.map((r) => JSON.parse(r.payload_json) as MiniMeBelief),
    predictions: executeSqliteQuerySync(
      db,
      k
        .selectFrom("mini_me_predictions")
        .select("payload_json")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .orderBy("created_at", "desc")
        .orderBy("prediction_id", "desc")
        .limit(limit),
      // SAFETY: The typed content worker owns this table payload; this query is bound to the checked owner and Mini Me scope.
    ).rows.map((r) => JSON.parse(r.payload_json) as MiniMePrediction),
    outcomes: executeSqliteQuerySync(
      db,
      k
        .selectFrom("mini_me_outcomes")
        .select("payload_json")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .orderBy("created_at", "desc")
        .orderBy("outcome_id", "desc")
        .limit(limit),
      // SAFETY: The typed content worker owns this table payload; this query is bound to the checked owner and Mini Me scope.
    ).rows.map((r) => JSON.parse(r.payload_json) as MiniMeOutcome),
  };
}
type HistoryPosition = { at: number; id: string } | null;
type HistoryCursor = {
  beliefs?: HistoryPosition;
  predictions?: HistoryPosition;
  outcomes?: HistoryPosition;
};
export function readContentHistory(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  cursor?: string,
): MiniMeContentWorkerOperations["history"]["output"] {
  const positions: HistoryCursor = {};
  if (cursor) {
    try {
      if (cursor.length > 2048) {
        throw new Error("long cursor");
      }
      const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (!isRecord(parsed)) {
        throw new Error("bad cursor");
      }
      for (const key of ["beliefs", "predictions", "outcomes"] as const) {
        const p = parsed[key];
        if (
          p !== undefined &&
          p !== null &&
          (!isRecord(p) ||
            typeof p.at !== "number" ||
            !Number.isSafeInteger(p.at) ||
            typeof p.id !== "string" ||
            p.id.length > 128)
        ) {
          throw new Error("bad cursor");
        }
        if (p === null || p === undefined) {
          positions[key] = p;
        } else if (isRecord(p) && typeof p.at === "number" && typeof p.id === "string") {
          positions[key] = { at: p.at, id: p.id };
        }
      }
    } catch {
      throw new MiniMePersistenceError("invalid", "Mini Me history cursor is invalid");
    }
  }
  const k = getNodeSqliteKysely<DB>(db);
  let beliefs = k
    .selectFrom("mini_me_beliefs")
    .select(["belief_id", "created_at", "payload_json"])
    .where("owner_id", "=", scope.ownerId)
    .where("mini_me_id", "=", scope.miniMeId);
  let predictions = k
    .selectFrom("mini_me_predictions")
    .select(["prediction_id", "created_at", "payload_json"])
    .where("owner_id", "=", scope.ownerId)
    .where("mini_me_id", "=", scope.miniMeId);
  let outcomes = k
    .selectFrom("mini_me_outcomes")
    .select(["outcome_id", "created_at", "payload_json"])
    .where("owner_id", "=", scope.ownerId)
    .where("mini_me_id", "=", scope.miniMeId);
  const bp = positions.beliefs,
    pp = positions.predictions,
    op = positions.outcomes;
  if (bp) {
    beliefs = beliefs.where((eb) =>
      eb.or([
        eb("created_at", "<", bp.at),
        eb.and([eb("created_at", "=", bp.at), eb("belief_id", "<", bp.id)]),
      ]),
    );
  }
  if (pp) {
    predictions = predictions.where((eb) =>
      eb.or([
        eb("created_at", "<", pp.at),
        eb.and([eb("created_at", "=", pp.at), eb("prediction_id", "<", pp.id)]),
      ]),
    );
  }
  if (op) {
    outcomes = outcomes.where((eb) =>
      eb.or([
        eb("created_at", "<", op.at),
        eb.and([eb("created_at", "=", op.at), eb("outcome_id", "<", op.id)]),
      ]),
    );
  }
  const b =
    bp === null
      ? []
      : executeSqliteQuerySync(
          db,
          beliefs.orderBy("created_at", "desc").orderBy("belief_id", "desc").limit(51),
        ).rows;
  const p =
    pp === null
      ? []
      : executeSqliteQuerySync(
          db,
          predictions.orderBy("created_at", "desc").orderBy("prediction_id", "desc").limit(51),
        ).rows;
  const o =
    op === null
      ? []
      : executeSqliteQuerySync(
          db,
          outcomes.orderBy("created_at", "desc").orderBy("outcome_id", "desc").limit(51),
        ).rows;
  const bLast = b[49],
    pLast = p[49],
    oLast = o[49];
  const next: HistoryCursor = {
    beliefs: b.length > 50 && bLast ? { at: bLast.created_at, id: bLast.belief_id } : null,
    predictions: p.length > 50 && pLast ? { at: pLast.created_at, id: pLast.prediction_id } : null,
    outcomes: o.length > 50 && oLast ? { at: oLast.created_at, id: oLast.outcome_id } : null,
  };
  return {
    // SAFETY: The typed content worker owns this table payload; this query is bound to the checked owner and Mini Me scope.
    beliefs: b.slice(0, 50).map((row) => JSON.parse(row.payload_json) as MiniMeBelief),
    // SAFETY: The typed content worker owns this table payload; this query is bound to the checked owner and Mini Me scope.
    predictions: p.slice(0, 50).map((row) => JSON.parse(row.payload_json) as MiniMePrediction),
    // SAFETY: The typed content worker owns this table payload; this query is bound to the checked owner and Mini Me scope.
    outcomes: o.slice(0, 50).map((row) => JSON.parse(row.payload_json) as MiniMeOutcome),
    historyCursor: Object.values(next).some(Boolean)
      ? Buffer.from(JSON.stringify(next), "utf8").toString("base64url")
      : null,
  };
}
export function readActionRestores(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  command: SqliteWorkerCommand<
    Pick<MiniMeContentWorkerOperations, "readActionRestore" | "readActionRestores">
  >,
) {
  let query = getNodeSqliteKysely<DB>(db)
    .selectFrom("mini_me_action_restores")
    .selectAll()
    .where("owner_id", "=", scope.ownerId)
    .where("mini_me_id", "=", scope.miniMeId);
  if (command.type === "readActionRestore") {
    query = query.where("receipt_id", "=", command.input.receiptId);
  } else if (command.input.cursor) {
    query = query.where("receipt_id", ">", command.input.cursor);
  }
  const rows = executeSqliteQuerySync(
    db,
    query.orderBy("receipt_id", "asc").limit(command.type === "readActionRestore" ? 1 : 51),
  ).rows;
  const receipts: MiniMeActionRestore[] = rows.slice(0, 50).map((row) => ({
    receiptId: row.receipt_id,
    actionId: row.action_id,
    targetAgentId: row.target_agent_id,
    resource: row.resource,
    before: { utf8: row.before_utf8, sha256: row.before_sha256 },
    afterSha256: row.after_sha256,
    createdAt: row.created_at,
  }));
  return command.type === "readActionRestore"
    ? (receipts[0] ?? null)
    : { receipts, cursor: rows.length > 50 ? (receipts[49]?.receiptId ?? null) : null };
}
export function readExactPrediction(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  predictionId: string,
): MiniMePrediction | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("mini_me_predictions")
      .select("payload_json")
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("prediction_id", "=", predictionId),
  );
  // SAFETY: The typed content worker owns this table payload; this query is bound to the checked owner and Mini Me scope.
  return row ? (JSON.parse(row.payload_json) as MiniMePrediction) : null;
}
export function readActiveBeliefs(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  topic: string,
): MiniMeBelief[] {
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("mini_me_beliefs")
      .select("payload_json")
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("scope", "=", normalizeMiniMeValue(topic))
      .where("status", "=", "active")
      .orderBy("created_at", "desc")
      .orderBy("belief_id", "desc")
      .limit(33),
    // SAFETY: The typed content worker owns this table payload; this query is bound to the checked owner and Mini Me scope.
  ).rows.map((row) => JSON.parse(row.payload_json) as MiniMeBelief);
}
export function readSourceCursor(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  sourceId: string,
): string | null {
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("mini_me_sources")
        .select("cursor")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("source_id", "=", sourceId),
    )?.cursor ?? null
  );
}
