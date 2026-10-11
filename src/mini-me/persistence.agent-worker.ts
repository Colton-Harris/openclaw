import type { DatabaseSync } from "node:sqlite";
import { MINI_ME_DOCUMENT_NAMES } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend, SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../state/openclaw-agent-execution-domain.js";
import { MINI_ME_LIMITS } from "./learning.js";
import { learnBeliefBatch, undoBelief } from "./persistence.content-learning.js";
import {
  readActionRestores,
  readActiveBeliefs,
  readContentHistory,
  readContentMeta,
  readContentSnapshot,
  readExactPrediction,
  readSourceCursor,
} from "./persistence.content-read.js";
import {
  appendOutcome,
  freezePrediction,
  recordActionRestore,
  releaseActionRestore,
  reviseDocument,
} from "./persistence.content-records.js";
import {
  addContentSource,
  removeContentSource,
  updateContentSourceStatus,
} from "./persistence.content-sources.js";
import { ensureMiniMeAgentSchema } from "./persistence.schema.js";
import {
  MiniMePersistenceError,
  miniMeOperationFingerprint,
  type MiniMeContentWorkerOperations,
} from "./persistence.types.js";

function executeContent(
  db: DatabaseSync,
  inputAgentId: string,
  command: SqliteWorkerCommand<MiniMeContentWorkerOperations>,
): unknown {
  const k = getNodeSqliteKysely<DB>(db),
    scope = command.input.scope;
  if (scope.agentId !== inputAgentId) {
    throw new MiniMePersistenceError("conflict", "Mini Me command targets another agent");
  }
  if ("operationId" in command.input) {
    const fingerprint = miniMeOperationFingerprint(command);
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      k
        .selectFrom("mini_me_content_operations")
        .selectAll()
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("operation_id", "=", command.input.operationId),
    );
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new MiniMePersistenceError(
          "operation-conflict",
          "Operation ID was reused with different input",
        );
      }
      return JSON.parse(existing.result_json) as unknown;
    }
  }
  if (command.type === "initialize") {
    const binding = executeSqliteQueryTakeFirstSync(
      db,
      k.selectFrom("mini_me_content").selectAll().where("agent_id", "=", scope.agentId),
    );
    if (
      binding &&
      (binding.owner_id !== scope.ownerId ||
        binding.mini_me_id !== scope.miniMeId ||
        binding.generation > scope.generation)
    ) {
      throw new MiniMePersistenceError(
        "conflict",
        "Mini Me agent store belongs to another owner or generation",
      );
    }
    if (!binding) {
      executeSqliteQuerySync(
        db,
        k.insertInto("mini_me_content").values({
          owner_id: scope.ownerId,
          mini_me_id: scope.miniMeId,
          agent_id: scope.agentId,
          generation: scope.generation,
          revision: 0,
          record_count: MINI_ME_DOCUMENT_NAMES.length,
        }),
      );
      for (const name of MINI_ME_DOCUMENT_NAMES) {
        executeSqliteQuerySync(
          db,
          k.insertInto("mini_me_documents").values({
            owner_id: scope.ownerId,
            mini_me_id: scope.miniMeId,
            name,
            revision: 0,
            content: "",
            updated_at: Date.now(),
            source_ids_json: "[]",
          }),
        );
      }
    } else if (binding.generation < scope.generation) {
      executeSqliteQuerySync(
        db,
        k
          .updateTable("mini_me_content")
          .set({ generation: scope.generation })
          .where("owner_id", "=", scope.ownerId)
          .where("mini_me_id", "=", scope.miniMeId)
          .where("agent_id", "=", scope.agentId),
      );
    }
  }
  const current = readContentMeta(db, scope);
  if (command.type === "readActionRestore" || command.type === "readActionRestores") {
    return readActionRestores(db, scope, command);
  }
  if (command.type === "readSnapshot") {
    return {
      ...readContentSnapshot(db, scope),
      historyCursor: readContentHistory(db, scope).historyCursor,
    };
  }
  if (command.type === "readExactPrediction") {
    return readExactPrediction(db, scope, command.input.predictionId);
  }
  if (command.type === "readExport") {
    return readContentSnapshot(db, scope, true);
  }
  if (command.type === "history") {
    return readContentHistory(db, scope, command.input.cursor);
  }
  if (command.type === "readBeliefs") {
    return readActiveBeliefs(db, scope, command.input.topic);
  }
  if (command.type === "sourceCursor") {
    return readSourceCursor(db, scope, command.input.sourceId);
  }
  const fingerprint = miniMeOperationFingerprint(command);
  // This cap protects retained learned payload history; durable control receipts are metadata,
  // not a hard total SQLite size cap. Revocation/undo/status, preimage release and generation mirroring work at capacity.
  const controlMutation = [
    "purge",
    "initialize",
    "updateSourceStatus",
    "undo",
    "removeSource",
    "releaseActionRestore",
  ].includes(command.type);
  let cost = controlMutation ? 0 : 1,
    retainedCount = current.record_count,
    result: unknown = null;
  // A write and its receipt commit together; never prune to make a capacity check pass.
  const charge = (additional = 0) => {
    cost += additional;
    if (current.record_count + cost > MINI_ME_LIMITS.retainedEvents) {
      throw new MiniMePersistenceError(
        "limit-reached",
        "Mini Me retained data limit is reached; inspect or delete learned data",
      );
    }
  };
  if (!controlMutation) {
    charge();
  }
  switch (command.type) {
    case "recordActionRestore":
      result = recordActionRestore(db, scope, command.input, charge);
      break;
    case "releaseActionRestore":
      retainedCount = Math.max(
        0,
        current.record_count - releaseActionRestore(db, scope, command.input),
      );
      break;
    case "initialize":
      result = readContentSnapshot(db, scope);
      break;
    case "addSource":
      result = addContentSource(db, scope, command.input.source, charge);
      break;
    case "updateSourceStatus":
      result = updateContentSourceStatus(db, scope, command.input);
      break;
    case "removeSource":
      retainedCount = removeContentSource(db, scope, command.input.sourceId);
      break;
    case "learnBatch":
      result = learnBeliefBatch(db, scope, command.input, current.revision, charge);
      break;
    case "reviseDocument":
      result = reviseDocument(db, scope, command.input, charge);
      break;
    case "undo":
      result = undoBelief(db, scope, command.input.beliefId);
      break;
    case "freezePrediction":
      result = freezePrediction(db, scope, command.input.prediction, current.revision, charge);
      break;
    case "appendOutcome":
      result = appendOutcome(db, scope, command.input.outcome, charge);
      break;
    case "purge":
      executeSqliteQuerySync(
        db,
        k
          .deleteFrom("mini_me_content")
          .where("owner_id", "=", scope.ownerId)
          .where("mini_me_id", "=", scope.miniMeId)
          .where("agent_id", "=", scope.agentId),
      );
      executeSqliteQuerySync(
        db,
        k
          .deleteFrom("mini_me_content_operations")
          .where("owner_id", "=", scope.ownerId)
          .where("mini_me_id", "=", scope.miniMeId),
      );
      break;
  }
  if (command.type !== "purge") {
    executeSqliteQuerySync(
      db,
      k
        .updateTable("mini_me_content")
        .set({ revision: current.revision + 1, record_count: retainedCount + cost })
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("agent_id", "=", scope.agentId)
        .where("generation", "=", scope.generation),
    );
  }
  if (command.type === "initialize") {
    result = { ...readContentSnapshot(db, scope), contentRevision: current.revision + 1 };
  }
  executeSqliteQuerySync(
    db,
    k.insertInto("mini_me_content_operations").values({
      owner_id: scope.ownerId,
      mini_me_id: scope.miniMeId,
      operation_id: command.input.operationId,
      fingerprint,
      result_json: JSON.stringify(result ?? null),
    }),
  );
  return result;
}
export function bindSqliteWorkerBackend(
  input: { agentId: string },
  bound: {
    database: DatabaseSync;
    databasePath: string;
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction): void;
  },
): SqliteWorkerBackend<MiniMeContentWorkerOperations> {
  const options = {
    agentId: input.agentId,
    path: bound.databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database || database.db !== bound.database) {
    throw new Error("Mini Me lost its canonical agent database owner");
  }
  return {
    execute(command) {
      if (
        command.type === "readSnapshot" ||
        command.type === "sourceCursor" ||
        command.type === "readExport" ||
        command.type === "readExactPrediction" ||
        command.type === "readBeliefs" ||
        command.type === "history" ||
        command.type === "readActionRestore" ||
        command.type === "readActionRestores"
      ) {
        return executeContent(
          bound.database,
          input.agentId,
          command,
          // SAFETY: executeContent dispatches the closed paired command union to its typed output owner.
        ) as MiniMeContentWorkerOperations[keyof MiniMeContentWorkerOperations]["output"];
      }
      return runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== bound.database) {
            throw new Error("Mini Me agent database owner changed");
          }
          bound.admit("transaction");
          ensureMiniMeAgentSchema(current.db);
          const result = executeContent(current.db, input.agentId, command);
          bound.admit("commit");
          // SAFETY: The paired command union owns the worker output shape.
          return result as MiniMeContentWorkerOperations[keyof MiniMeContentWorkerOperations]["output"];
        },
        options,
        { operationLabel: `miniMe.${command.type}` },
      );
    },
    assertSettled() {
      assertTransactionUsable(bound.database);
      if (bound.database.isTransaction) {
        throw new Error("Mini Me transaction did not settle");
      }
    },
    close() {},
  };
}
