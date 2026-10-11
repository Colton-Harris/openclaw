import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MiniMeProfile } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { ensureMiniMeStateSchema } from "./persistence.schema.js";
import { executeMiniMeAction } from "./persistence.state-actions.js";
import {
  assertCanonicalOwner,
  executeProfileMutation,
  getProfile,
  pendingChanges,
  profileFromRow,
  readAttachments,
} from "./persistence.state-profile.js";
import {
  beginRootOperation,
  finishRootOperation,
  lookupRootOperation,
  readRootOperationStatus,
} from "./persistence.state-root-operations.js";
import {
  MiniMePersistenceError,
  miniMeOperationFingerprint,
  type MiniMeStateWorkerOperations,
} from "./persistence.types.js";

function executeMutation(
  db: DatabaseSync,
  command: SqliteWorkerCommand<MiniMeStateWorkerOperations>,
): unknown {
  const k = getNodeSqliteKysely<DB>(db);
  if (
    command.type === "miniMe.reserve" ||
    command.type === "miniMe.consume" ||
    command.type === "miniMe.settle"
  ) {
    return executeMiniMeAction(db, command);
  }
  if (
    command.type === "miniMe.privateMetadata" ||
    command.type === "miniMe.read" ||
    command.type === "miniMe.operationStatus" ||
    command.type === "miniMe.operationLookup" ||
    command.type === "miniMe.readPendingDataChanges"
  ) {
    throw new Error("Read operation entered Mini Me mutation");
  }
  const ownerId =
    command.type === "miniMe.beginCreate" ? command.input.ownerId : command.input.scope.ownerId;
  assertCanonicalOwner(db, ownerId);
  const miniMeId = command.type === "miniMe.beginCreate" ? "" : command.input.scope.miniMeId;
  const fingerprint = miniMeOperationFingerprint(command);
  const receipt = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_state_operations")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .where("mini_me_id", "=", miniMeId)
      .where("operation_id", "=", command.input.operationId),
  );
  if (
    receipt &&
    command.type !== "miniMe.beginOperation" &&
    command.type !== "miniMe.finishOperation"
  ) {
    if (receipt.fingerprint !== fingerprint) {
      throw new MiniMePersistenceError(
        "operation-conflict",
        "Operation ID was reused with different input",
      );
    }
    return JSON.parse(receipt.result_json) as unknown;
  }
  // Root operations own their pending-to-complete state in the root table.
  // They intentionally reuse one ID across begin/finish; stage receipts are immutable.
  if (command.type === "miniMe.beginOperation") {
    return beginRootOperation(db, ownerId, miniMeId, command.input);
  }
  if (command.type === "miniMe.finishOperation") {
    return finishRootOperation(db, ownerId, miniMeId, command.input);
  }
  let result: unknown;
  if (command.type === "miniMe.beginCreate") {
    const live = executeSqliteQueryTakeFirstSync(
      db,
      k
        .selectFrom("mini_me_profiles")
        .select("mini_me_id")
        .where("owner_id", "=", ownerId)
        .where("lifecycle", "!=", "deleted"),
    );
    if (live) {
      throw new MiniMePersistenceError("conflict", "This owner already has a Mini Me");
    }
    const id = randomUUID(),
      now = Date.now();
    executeSqliteQuerySync(
      db,
      k.insertInto("mini_me_profiles").values({
        owner_id: ownerId,
        mini_me_id: id,
        agent_id: `mini-me-${id}`,
        name: command.input.name,
        lifecycle: "preparing",
        learning_paused: 0,
        generation: 0,
        revision: 0,
        models_json: JSON.stringify(command.input.models),
        created_at: now,
        updated_at: now,
      }),
    );
    result = profileFromRow(getProfile(db, { ownerId, miniMeId: id }));
  } else {
    result = executeProfileMutation(db, command);
  }
  executeSqliteQuerySync(
    db,
    k.insertInto("mini_me_state_operations").values({
      owner_id: ownerId,
      mini_me_id: miniMeId,
      operation_id: command.input.operationId,
      fingerprint,
      result_json: JSON.stringify(result ?? null),
    }),
  );
  return result;
}
export function executeMiniMeStateCommand(
  command: SqliteWorkerCommand<MiniMeStateWorkerOperations>,
  options: OpenClawStateDatabaseOptions,
): MiniMeStateWorkerOperations[keyof MiniMeStateWorkerOperations]["output"] {
  const database = openOpenClawStateDatabase(options);
  if (command.type === "miniMe.privateMetadata") {
    if (!getAdmittedSqliteSchemaFacts(database.db)?.tables.has("mini_me_profiles")) {
      return { profiles: [], attachments: [] };
    }
    const k = getNodeSqliteKysely<DB>(database.db);
    const profiles = executeSqliteQuerySync(
      database.db,
      k
        .selectFrom("mini_me_profiles")
        .select(["owner_id", "mini_me_id", "agent_id", "lifecycle", "generation", "revision"]),
    ).rows.map((row) => ({
      ownerId: row.owner_id,
      miniMeId: row.mini_me_id,
      agentId: row.agent_id,
      // SAFETY: The typed profile lifecycle writer owns this field; generated SQLite types retain only string.
      lifecycle: row.lifecycle as MiniMeProfile["lifecycle"],
      generation: row.generation,
      revision: row.revision,
    }));
    const attachments = executeSqliteQuerySync(
      database.db,
      k
        .selectFrom("mini_me_attachments as a")
        .innerJoin("mini_me_profiles as p", (join) =>
          join.onRef("p.owner_id", "=", "a.owner_id").onRef("p.mini_me_id", "=", "a.mini_me_id"),
        )
        .select(["a.owner_id", "a.mini_me_id", "a.target_agent_id", "a.revision", "p.generation"])
        .where("a.detached", "=", 0)
        .where("p.lifecycle", "=", "active"),
    ).rows.map((row) => ({
      ownerId: row.owner_id,
      miniMeId: row.mini_me_id,
      targetAgentId: row.target_agent_id,
      profileGeneration: row.generation,
      attachmentRevision: row.revision,
    }));
    return { profiles, attachments };
  }
  if (
    command.type === "miniMe.read" ||
    command.type === "miniMe.operationStatus" ||
    command.type === "miniMe.operationLookup" ||
    command.type === "miniMe.readPendingDataChanges"
  ) {
    if (!getAdmittedSqliteSchemaFacts(database.db)?.tables.has("mini_me_profiles")) {
      return command.type === "miniMe.readPendingDataChanges" ? [] : null;
    }
    if (command.type === "miniMe.readPendingDataChanges") {
      return pendingChanges(database.db, command.input.scope);
    }
    if (command.type === "miniMe.operationLookup") {
      return lookupRootOperation(database.db, command.input);
    }
    if (command.type === "miniMe.operationStatus") {
      return readRootOperationStatus(database.db, command.input);
    }
    const { ownerId, miniMeId } = command.input;
    let query = getNodeSqliteKysely<DB>(database.db)
      .selectFrom("mini_me_profiles")
      .selectAll()
      .where("owner_id", "=", ownerId);
    query = miniMeId
      ? query.where("mini_me_id", "=", miniMeId)
      : query.where("lifecycle", "!=", "deleted");
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      query.orderBy("updated_at", "desc").limit(1),
    );
    return row
      ? {
          profile: profileFromRow(row),
          attachments: readAttachments(database.db, { ownerId, miniMeId: row.mini_me_id }),
          pendingDataChanges: pendingChanges(database.db, { ownerId, miniMeId: row.mini_me_id }),
        }
      : null;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      ensureMiniMeStateSchema(db);
      const result = executeMutation(db, command);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      // SAFETY: The paired command union defines the exact output for this worker dispatch.
      return result as MiniMeStateWorkerOperations[keyof MiniMeStateWorkerOperations]["output"];
    },
    options,
    { operationLabel: command.type },
  );
}
