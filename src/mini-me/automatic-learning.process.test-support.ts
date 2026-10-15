import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { MiniMeSource } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { learnBeliefBatch } from "./persistence.content-learning.js";
import {
  readContentMeta,
  readContentSnapshot,
  readSourceCursor,
} from "./persistence.content-read.js";
import { ensureMiniMeAgentSchema } from "./persistence.schema.js";
import {
  miniMeOperationFingerprint,
  type MiniMeContentScope,
  type MiniMeContentWorkerOperations,
} from "./persistence.types.js";

// Synthetic process-boundary fixture for the production content persistence functions.
// Gateway admission remains covered separately by automatic-learning.test.ts.
export const miniMeLearningProcessEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "automatic-learning.process.test-support",
  distWorkerPath: "mini-me/automatic-learning.process.test-support.js",
} as const;

const scope: MiniMeContentScope = {
  ownerId: "synthetic-owner",
  miniMeId: "synthetic-mini-me",
  agentId: "synthetic-agent",
  generation: 0,
};
const source: MiniMeSource = {
  id: "synthetic-ongoing-source",
  selection: {
    kind: "conversation",
    sessionKey: "agent:main:synthetic-conversation",
    mode: "ongoing",
  },
  revision: 0,
  status: "pending",
  lastIngestedAt: null,
  detail: null,
};
const continuingDetail =
  "Mini Me is still learning from this conversation; it continues from where it stopped.";

function readFacts(db: DatabaseSync) {
  const current = readContentSnapshot(db, scope);
  return {
    cursor: readSourceCursor(db, scope, source.id),
    source: current.sources.find((item) => item.id === source.id),
  };
}

function commitPage(
  db: DatabaseSync,
  input: MiniMeContentWorkerOperations["learnBatch"]["input"],
): void {
  const before = readContentMeta(db, scope);
  const command = { type: "learnBatch" as const, input };
  const fingerprint = miniMeOperationFingerprint(command);
  let cost = 1;
  const result = learnBeliefBatch(db, scope, input, before.revision, (additional) => {
    cost += additional;
  });
  db.prepare(
    "UPDATE mini_me_content SET revision = ?, record_count = ? WHERE owner_id = ? AND mini_me_id = ? AND agent_id = ? AND generation = ?",
  ).run(
    before.revision + 1,
    before.record_count + cost,
    scope.ownerId,
    scope.miniMeId,
    scope.agentId,
    scope.generation,
  );
  db.prepare(
    "INSERT INTO mini_me_content_operations (owner_id, mini_me_id, operation_id, fingerprint, result_json) VALUES (?, ?, ?, ?, ?)",
  ).run(scope.ownerId, scope.miniMeId, input.operationId, fingerprint, JSON.stringify(result));
}

function withWriteTransaction(db: DatabaseSync, write: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    write();
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}

function run(action: string, databasePath: string) {
  if (action === "commit-first-page") {
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      ensureMiniMeAgentSchema(db);
      withWriteTransaction(db, () => {
        db.prepare(
          "INSERT INTO mini_me_content (owner_id, mini_me_id, agent_id, generation, revision, record_count) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(scope.ownerId, scope.miniMeId, scope.agentId, scope.generation, 0, 1);
        db.prepare(
          "INSERT INTO mini_me_sources (owner_id, mini_me_id, source_id, cursor, payload_json) VALUES (?, ?, ?, NULL, ?)",
        ).run(scope.ownerId, scope.miniMeId, source.id, JSON.stringify(source));
        commitPage(db, {
          scope,
          operationId: "synthetic-page-1",
          beliefs: [],
          sourceId: source.id,
          expectedCursor: null,
          cursor: "page-1",
          sourceStatus: { status: "pending", detail: continuingDetail },
        });
      });
      return readFacts(db);
    } finally {
      db.close();
    }
  }

  if (action === "read") {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return readFacts(db);
    } finally {
      db.close();
    }
  }

  if (action === "resume-next-page") {
    const db = new DatabaseSync(databasePath);
    try {
      const facts = readFacts(db);
      if (facts.cursor !== "page-1" || facts.source?.status !== "pending") {
        throw new Error("Fresh process did not receive the committed pending page");
      }
      withWriteTransaction(db, () => {
        const currentCursor = readSourceCursor(db, scope, source.id);
        const current = readContentMeta(db, scope);
        commitPage(db, {
          scope,
          operationId: "synthetic-page-2",
          beliefs: [],
          sourceId: source.id,
          expectedCursor: currentCursor,
          cursor: "page-2",
          sourceStatus: { status: "ready", detail: null },
        });
        if (current.revision < 1) {
          throw new Error("Fresh process observed an invalid content revision");
        }
      });
      return readFacts(db);
    } finally {
      db.close();
    }
  }

  throw new Error("Unknown synthetic Mini Me persistence action");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    const [action, databasePath] = process.argv.slice(2);
    if (!action || !databasePath) {
      throw new Error("Expected an action and isolated database path");
    }
    process.stdout.write(`${JSON.stringify(run(action, databasePath))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
