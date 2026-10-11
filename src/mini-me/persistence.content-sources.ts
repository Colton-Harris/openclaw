import type { DatabaseSync } from "node:sqlite";
import type { MiniMeSource } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { MINI_ME_LIMITS } from "./learning.js";
import { readContentSnapshot } from "./persistence.content-read.js";
import {
  MiniMePersistenceError,
  type MiniMeContentScope,
  type MiniMeContentWorkerOperations,
} from "./persistence.types.js";

export function addContentSource(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  source: MiniMeSource,
  charge: (additional: number) => void,
): MiniMeSource {
  const k = getNodeSqliteKysely<DB>(db);
  const existingSource = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_sources")
      .select("source_id")
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("source_id", "=", source.id),
  );
  if (existingSource) {
    throw new MiniMePersistenceError("conflict", "Source ID is already selected");
  }
  const count =
    executeSqliteQueryTakeFirstSync(
      db,
      k
        .selectFrom("mini_me_sources")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId),
    )?.count ?? 0;
  if (count >= MINI_ME_LIMITS.sources) {
    throw new MiniMePersistenceError("limit-reached", "Mini Me selected source limit is reached");
  }
  charge(1);
  executeSqliteQuerySync(
    db,
    k.insertInto("mini_me_sources").values({
      owner_id: scope.ownerId,
      mini_me_id: scope.miniMeId,
      source_id: source.id,
      cursor: null,
      payload_json: JSON.stringify(source),
    }),
  );
  return source;
}
export function updateContentSourceStatus(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  input: MiniMeContentWorkerOperations["updateSourceStatus"]["input"],
): MiniMeSource {
  const k = getNodeSqliteKysely<DB>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_sources")
      .select("payload_json")
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("source_id", "=", input.sourceId),
  );
  if (!row) {
    throw new MiniMePersistenceError("not-found", "Selected source is unavailable");
  }
  if (input.detail && input.detail.length > 512) {
    throw new MiniMePersistenceError("invalid", "Source status detail exceeds its bound");
  }
  const source = {
    // SAFETY: The typed content worker owns source payloads and document source-ID arrays in this checked scope.
    ...(JSON.parse(row.payload_json) as MiniMeSource),
    status: input.status,
    detail: input.detail,
  };
  executeSqliteQuerySync(
    db,
    k
      .updateTable("mini_me_sources")
      .set({ payload_json: JSON.stringify(source) })
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("source_id", "=", input.sourceId),
  );
  return source;
}
/** Erases a revoked source and everything derived from it; returns the recounted retained records. */
export function removeContentSource(
  db: DatabaseSync,
  scope: MiniMeContentScope,
  sourceId: string,
): number {
  const k = getNodeSqliteKysely<DB>(db);
  // Erase retained excerpts and comparisons derived from the removed source as one transaction.
  for (const prediction of readContentSnapshot(db, scope, true).predictions.filter((p) =>
    p.evidence.some((e) => e.sourceId === sourceId),
  )) {
    executeSqliteQuerySync(
      db,
      k
        .deleteFrom("mini_me_outcomes")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("prediction_id", "=", prediction.id),
    );
    executeSqliteQuerySync(
      db,
      k
        .deleteFrom("mini_me_predictions")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("prediction_id", "=", prediction.id),
    );
  }
  for (const belief of readContentSnapshot(db, scope, true).beliefs.filter((b) =>
    b.evidence.some((e) => e.sourceId === sourceId),
  )) {
    executeSqliteQuerySync(
      db,
      k
        .deleteFrom("mini_me_learning_keys")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("belief_id", "=", belief.id),
    );
    executeSqliteQuerySync(
      db,
      k
        .deleteFrom("mini_me_beliefs")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("belief_id", "=", belief.id),
    );
  }
  executeSqliteQuerySync(
    db,
    k
      .deleteFrom("mini_me_suppressions")
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("source_id", "=", sourceId),
  );
  executeSqliteQuerySync(
    db,
    k
      .deleteFrom("mini_me_sources")
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("source_id", "=", sourceId),
  );
  const revisions = executeSqliteQuerySync(
    db,
    k
      .selectFrom("mini_me_documents")
      .select(["name", "revision", "source_ids_json"])
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId),
  ).rows;
  for (const revision of revisions)
  // SAFETY: The typed content worker owns source payloads and document source-ID arrays in this checked scope.
  {
    if ((JSON.parse(revision.source_ids_json) as string[]).includes(sourceId)) {
      executeSqliteQuerySync(
        db,
        k
          .deleteFrom("mini_me_documents")
          .where("owner_id", "=", scope.ownerId)
          .where("mini_me_id", "=", scope.miniMeId)
          .where("name", "=", revision.name)
          .where("revision", "=", revision.revision),
      );
    }
  }
  // Old operation replies can contain source text; discard them on explicit revocation.
  executeSqliteQuerySync(
    db,
    k
      .deleteFrom("mini_me_content_operations")
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId),
  );
  return (
    [
      "mini_me_sources",
      "mini_me_beliefs",
      "mini_me_documents",
      "mini_me_predictions",
      "mini_me_outcomes",
      "mini_me_action_restores",
    ] as const
  ).reduce(
    (total, table) =>
      total +
      (executeSqliteQueryTakeFirstSync(
        db,
        k
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("owner_id", "=", scope.ownerId)
          .where("mini_me_id", "=", scope.miniMeId),
      )?.count ?? 0),
    0,
  );
}
