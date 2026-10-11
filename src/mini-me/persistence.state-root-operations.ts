import type { DatabaseSync } from "node:sqlite";
import type { MiniMeProfile } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { getProfile, profileFromRow } from "./persistence.state-profile.js";
import {
  MiniMePersistenceError,
  type MiniMeStateWorkerOperations,
  type MiniMeRootOperation,
} from "./persistence.types.js";

export function beginRootOperation(
  db: DatabaseSync,
  ownerId: string,
  miniMeId: string,
  input: MiniMeStateWorkerOperations["miniMe.beginOperation"]["input"],
) {
  const k = getNodeSqliteKysely<DB>(db);
  const conflictingRoot = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_root_operations")
      .select("mini_me_id")
      .where("owner_id", "=", ownerId)
      .where("operation_id", "=", input.operationId),
  );
  if (conflictingRoot && conflictingRoot.mini_me_id !== miniMeId) {
    throw new MiniMePersistenceError(
      "operation-conflict",
      "Root operation ID belongs to another profile",
    );
  }
  const existingRoot = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_root_operations")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .where("mini_me_id", "=", miniMeId)
      .where("operation_id", "=", input.operationId),
  );
  if (existingRoot) {
    if (
      existingRoot.kind !== input.kind ||
      existingRoot.request_fingerprint !== input.requestFingerprint
    ) {
      throw new MiniMePersistenceError(
        "operation-conflict",
        "Root operation ID belongs to another request",
      );
    }
    return {
      kind: existingRoot.kind,
      requestFingerprint: existingRoot.request_fingerprint,
      predictionId: existingRoot.prediction_id,
      state: existingRoot.state,
      createdAt: existingRoot.created_at,
      // SAFETY: The root-operation writer persists only its typed pending/complete state and captured MiniMeProfile or null.
      profile: JSON.parse(existingRoot.profile_json) as MiniMeProfile | null,
    };
  }
  const profile = miniMeId ? profileFromRow(getProfile(db, input.scope)) : null,
    createdAt = Date.now();
  executeSqliteQuerySync(
    db,
    k.insertInto("mini_me_root_operations").values({
      owner_id: ownerId,
      mini_me_id: miniMeId,
      operation_id: input.operationId,
      kind: input.kind,
      request_fingerprint: input.requestFingerprint,
      prediction_id: null,
      state: "pending",
      created_at: createdAt,
      profile_json: JSON.stringify(profile),
    }),
  );
  return {
    kind: input.kind,
    requestFingerprint: input.requestFingerprint,
    predictionId: null,
    state: "pending",
    createdAt,
    profile,
  };
}
export function finishRootOperation(
  db: DatabaseSync,
  ownerId: string,
  miniMeId: string,
  input: MiniMeStateWorkerOperations["miniMe.finishOperation"]["input"],
): null {
  const k = getNodeSqliteKysely<DB>(db);
  const root = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_root_operations")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .where("mini_me_id", "=", miniMeId)
      .where("operation_id", "=", input.operationId),
  );
  if (
    !root ||
    root.kind !== input.kind ||
    root.request_fingerprint !== input.requestFingerprint ||
    (root.state === "complete" && root.prediction_id !== (input.predictionId ?? null))
  ) {
    throw new MiniMePersistenceError(
      "operation-conflict",
      "Root operation ID belongs to another request",
    );
  }
  executeSqliteQuerySync(
    db,
    k
      .updateTable("mini_me_root_operations")
      .set({ state: "complete", prediction_id: input.predictionId ?? null })
      .where("owner_id", "=", ownerId)
      .where("mini_me_id", "=", miniMeId)
      .where("operation_id", "=", input.operationId),
  );
  return null;
}
export function lookupRootOperation(
  db: DatabaseSync,
  input: MiniMeStateWorkerOperations["miniMe.operationLookup"]["input"],
): MiniMeStateWorkerOperations["miniMe.operationLookup"]["output"] {
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("mini_me_root_operations")
      .selectAll()
      .where("owner_id", "=", input.ownerId)
      .where("operation_id", "=", input.operationId)
      .limit(2),
  ).rows;
  if (rows.length > 1) {
    throw new MiniMePersistenceError(
      "operation-conflict",
      "Operation ID belongs to multiple roots",
    );
  }
  const row = rows[0];
  return row
    ? {
        miniMeId: row.mini_me_id,
        kind: row.kind,
        requestFingerprint: row.request_fingerprint,
        predictionId: row.prediction_id,
        // SAFETY: The root-operation writer persists only its typed pending/complete state and captured MiniMeProfile or null.
        state: row.state as MiniMeRootOperation["state"],
        createdAt: row.created_at,
        // SAFETY: The root-operation writer persists only its typed pending/complete state and captured MiniMeProfile or null.
        profile: JSON.parse(row.profile_json) as MiniMeProfile | null,
      }
    : null;
}
export function readRootOperationStatus(
  db: DatabaseSync,
  input: MiniMeStateWorkerOperations["miniMe.operationStatus"]["input"],
): MiniMeStateWorkerOperations["miniMe.operationStatus"]["output"] {
  const { scope, operationId } = input;
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("mini_me_root_operations")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("operation_id", "=", operationId),
  );
  return row
    ? {
        kind: row.kind,
        requestFingerprint: row.request_fingerprint,
        predictionId: row.prediction_id,
        // SAFETY: The root-operation writer persists only its typed pending/complete state and captured MiniMeProfile or null.
        state: row.state as MiniMeRootOperation["state"],
        createdAt: row.created_at,
        // SAFETY: The root-operation writer persists only its typed pending/complete state and captured MiniMeProfile or null.
        profile: JSON.parse(row.profile_json) as MiniMeProfile | null,
      }
    : null;
}
