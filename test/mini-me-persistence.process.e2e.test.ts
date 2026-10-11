// Fresh-OS-process qualification for Mini Me persistence, migration, refusal and restore.
// persistence.worker.test.ts closes and reopens the real stores inside one process; this
// flow crosses process boundaries and uses only synthetic generated fixture data.
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../src/infra/runtime-worker-url.js";
import {
  MINI_ME_AGENT_TABLES,
  MINI_ME_STATE_TABLES,
  withoutMiniMeAgentSchema,
} from "../src/mini-me/persistence.schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../src/state/openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../src/state/openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../src/state/openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../src/state/openclaw-state-schema.js";
import { createBoundedChildOutput } from "./helpers/bounded-child-output.js";
import {
  miniMePersistenceProcessEntrypoint,
  type MiniMePersistenceCommand,
  type MiniMePersistenceMessage,
  type MiniMePersistenceReply,
  type SeedFacts,
} from "./helpers/mini-me-persistence-process.test-support.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { withinTest } from "./helpers/promise.js";
import { runNodeScript } from "./helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// The pinned base (ec7c8bb9454) shipped shared v20 and agent v24. Their v21/v25
// successors only append the first-use Mini Me feature blocks, so removing those
// blocks from the current canonical SQL reproduces the base schemas exactly.
const PRIOR_STATE_SCHEMA_VERSION = 20;
const PRIOR_AGENT_SCHEMA_VERSION = 24;
const FUTURE_STATE_SCHEMA_VERSION = OPENCLAW_STATE_SCHEMA_VERSION + 1;
const DOCTOR_FIX = ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"];
const CLI_TIMEOUT_MS = 120_000;

function readSqlite<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
const userVersion = (db: DatabaseSync) =>
  Number(db.prepare("PRAGMA user_version").get()?.user_version);
const miniMeTables = (db: DatabaseSync) =>
  db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'mini_me_*'")
    .all()
    .map((row) => String(row.name))
    .toSorted();

/** Synthetic prior-release stores; no copied operator data. */
function writePriorSchemaStores(stateDir: string) {
  const statePath = path.join(stateDir, "state", "openclaw.sqlite");
  const mainAgentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.mkdirSync(path.dirname(mainAgentPath), { recursive: true });
  const insertMeta = `INSERT INTO schema_meta (
    meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
  ) VALUES ('primary', ?, ?, ?, NULL, 0, 0)`;
  const state = new DatabaseSync(statePath);
  try {
    // The feature block markers are shared by both canonical schema files.
    state.exec(withoutMiniMeAgentSchema(OPENCLAW_STATE_SCHEMA_SQL));
    state.exec(`PRAGMA user_version = ${PRIOR_STATE_SCHEMA_VERSION};`);
    state.prepare(insertMeta).run("global", PRIOR_STATE_SCHEMA_VERSION, null);
    state
      .prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES ('main', ?, ?, 0)",
      )
      .run(mainAgentPath, PRIOR_AGENT_SCHEMA_VERSION);
  } finally {
    state.close();
  }
  const agent = new DatabaseSync(mainAgentPath);
  try {
    agent.exec(withoutMiniMeAgentSchema(OPENCLAW_AGENT_SCHEMA_SQL));
    agent.prepare(insertMeta).run("agent", PRIOR_AGENT_SCHEMA_VERSION, "main");
    agent.exec(`PRAGMA user_version = ${PRIOR_AGENT_SCHEMA_VERSION};`);
  } finally {
    agent.close();
  }
  return { statePath, mainAgentPath };
}

/** Model a newer writer on an isolated copy; the refusal must leave these bytes alone. */
function writeFutureStateVersion(file: string): string {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA user_version = ${FUTURE_STATE_SCHEMA_VERSION};`);
    db.prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'").run(
      FUTURE_STATE_SCHEMA_VERSION,
    );
  } finally {
    // The last connection checkpoints its WAL into the main file before the hash.
    db.close();
  }
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

type ReplyOf<K extends MiniMePersistenceReply["kind"]> = Extract<
  MiniMePersistenceReply,
  { kind: K }
>;
function isReply<K extends MiniMePersistenceReply["kind"]>(
  reply: MiniMePersistenceReply,
  kind: K,
): reply is ReplyOf<K> {
  return reply.kind === kind;
}

/** IPC owns readiness; each child closes its writers before replying and must exit 0. */
async function runMiniMeChild<K extends MiniMePersistenceReply["kind"]>(
  command: MiniMePersistenceCommand,
  kind: K,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<ReplyOf<K>> {
  const url = resolveRuntimeWorkerUrl(miniMePersistenceProcessEntrypoint);
  const output = createBoundedChildOutput();
  const child = fork(fileURLToPath(url), [], {
    execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
    env,
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.on("data", output.append);
  child.stderr?.on("data", output.append);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  try {
    const reply = new Promise<MiniMePersistenceReply>((resolve, reject) => {
      child.once("error", reject);
      child.on("message", (message: MiniMePersistenceMessage) => {
        if (message.kind === "booted") {
          child.send(command, (error) => {
            if (error) {
              reject(error);
            }
          });
        } else if (message.kind === "error") {
          reject(new Error(`${command.action} child failed: ${message.error}\n${output.text()}`));
        } else {
          resolve(message.reply);
        }
      });
      void closed.then(({ code, signal: exitSignal }) =>
        reject(
          new Error(
            `${command.action} child exited before its reply (${exitSignal ?? code}): ${output.text()}`,
          ),
        ),
      );
    });
    const result = await withinTest(reply, signal);
    expect(await withinTest(closed, signal), output.text()).toEqual({ code: 0, signal: null });
    if (!isReply(result, kind)) {
      throw new Error(`${command.action} child replied ${result.kind}, expected ${kind}`);
    }
    return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function parseVerifiedArchive(stdout: string) {
  const value: unknown = JSON.parse(stdout);
  if (!isRecord(value) || typeof value.archivePath !== "string" || !Array.isArray(value.assets)) {
    throw new Error(`Unexpected backup create output: ${stdout}`);
  }
  const state = value.assets.find(
    (asset): asset is { kind: "state"; sourcePath: string; archivePath: string } =>
      isRecord(asset) &&
      asset.kind === "state" &&
      typeof asset.sourcePath === "string" &&
      typeof asset.archivePath === "string",
  );
  if (!state) {
    throw new Error(`Backup create recorded no state asset: ${stdout}`);
  }
  return { archivePath: value.archivePath, verified: value.verified, state };
}

/** Point every state-relative variable at the restored copy; nothing may reach the live root. */
function restoredEnvironment(instance: OpenClawTestInstance, restoredStateDir: string) {
  const live = instance.stateDir;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(instance.env)) {
    env[key] =
      value === live || value?.startsWith(`${live}${path.sep}`)
        ? path.join(restoredStateDir, path.relative(live, value))
        : value;
  }
  expect(
    Object.entries(env).filter(
      ([, value]) => value === live || value?.startsWith(`${live}${path.sep}`),
    ),
  ).toEqual([]);
  expect(fs.existsSync(env.OPENCLAW_CONFIG_PATH ?? "")).toBe(true);
  return env;
}

it(
  "keeps Mini Me state across fresh processes, migration, disable, delete and restore",
  { timeout: 600_000 },
  async ({ signal }) => {
    expect([OPENCLAW_STATE_SCHEMA_VERSION, OPENCLAW_AGENT_SCHEMA_VERSION]).toEqual([
      PRIOR_STATE_SCHEMA_VERSION + 1,
      PRIOR_AGENT_SCHEMA_VERSION + 1,
    ]);
    const instance = await createOpenClawTestInstance({ name: "mini-me-persistence", signal });
    try {
      const { statePath, mainAgentPath } = writePriorSchemaStores(instance.stateDir);
      const child = <K extends MiniMePersistenceReply["kind"]>(
        command: MiniMePersistenceCommand,
        kind: K,
        env = instance.env,
      ) => runMiniMeChild(command, kind, env, signal);
      const cliLogs = (result: { stdout: string; stderr: string }) =>
        `${result.stdout}\n${result.stderr}`;

      // The existing Doctor preflight reports both prior stores as pending, not refused.
      expect(await child({ action: "preflight" }, "preflight")).toEqual({
        kind: "preflight",
        incompatible: [],
        indeterminate: [],
        pending: [
          {
            kind: "agent",
            agentId: "main",
            foundVersion: PRIOR_AGENT_SCHEMA_VERSION,
            supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
          {
            kind: "state",
            foundVersion: PRIOR_STATE_SCHEMA_VERSION,
            supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
          },
        ],
      });

      // The existing migration owner upgrades both; Mini Me tables wait for opt-in.
      const doctor = await instance.cli(DOCTOR_FIX, { timeoutMs: CLI_TIMEOUT_MS });
      expect(doctor.code, cliLogs(doctor)).toBe(0);
      expect(readSqlite(statePath, (db) => [userVersion(db), miniMeTables(db)])).toEqual([
        OPENCLAW_STATE_SCHEMA_VERSION,
        [],
      ]);
      expect(readSqlite(mainAgentPath, (db) => [userVersion(db), miniMeTables(db)])).toEqual([
        OPENCLAW_AGENT_SCHEMA_VERSION,
        [],
      ]);

      // First process: canonical people, opt-in, direct belief, correction and undo.
      const seeded = await child({ action: "seed" }, "seeded");
      expect(seeded.preflight).toEqual({ incompatible: [], indeterminate: [], pending: [] });
      expect(seeded.readBeforeOptIn).toBeNull();
      expect(seeded.nonCanonical).toMatchObject({
        ok: false,
        message: expect.stringContaining("Owner identity changed"),
      });
      expect(seeded.created).toMatchObject({ lifecycle: "preparing", generation: 0, revision: 0 });
      expect(seeded.active).toMatchObject({ lifecycle: "active", generation: 0, revision: 1 });
      const undoneBeliefs = [
        { id: "synthetic-belief-coffee", status: "undone" },
        { id: "synthetic-belief-oat-milk", status: "undone" },
        { id: "synthetic-belief-tea", status: "active" },
      ];
      expect(seeded.beliefs).toEqual(undoneBeliefs);
      expect(seeded.activeBeliefs).toEqual({ drink: ["synthetic-belief-tea"], milk: [] });
      expect(seeded.replayApplied).toEqual({ correction: 0, inferred: 0 });
      const facts: SeedFacts = {
        ownerId: seeded.ownerId,
        otherOwnerId: seeded.otherOwnerId,
        created: seeded.created,
        active: seeded.active,
      };
      const miniMeAgentPath = path.join(
        instance.stateDir,
        "agents",
        facts.active.agentId,
        "agent",
        "openclaw-agent.sqlite",
      );
      expect(readSqlite(statePath, miniMeTables)).toEqual([...MINI_ME_STATE_TABLES].toSorted());
      expect(readSqlite(miniMeAgentPath, miniMeTables)).toEqual(
        [...MINI_ME_AGENT_TABLES].toSorted(),
      );
      expect(readSqlite(mainAgentPath, miniMeTables)).toEqual([]);

      // Capture the committed opt-in through the existing archive owner before closing it.
      const created = await instance.cli(
        [
          "backup",
          "create",
          "--output",
          tempDirs.make("openclaw-mini-me-backup-"),
          "--no-include-workspace",
          "--verify",
          "--json",
        ],
        { timeoutMs: CLI_TIMEOUT_MS },
      );
      expect(created.code, cliLogs(created)).toBe(0);
      const archive = parseVerifiedArchive(created.stdout);
      expect(archive.verified).toBe(true);

      // Fresh process: the same committed facts, durable suppression, owner isolation; disable.
      const reopened = await child({ action: "reopen", facts }, "reopened");
      expect(reopened.read).toEqual({
        profile: facts.active,
        attachments: [],
        pendingDataChanges: [],
      });
      expect(reopened.metadataLifecycle).toBe("active");
      expect(reopened.beliefs).toEqual(undoneBeliefs);
      expect(reopened.replayApplied).toEqual({ correction: 0, inferred: 0 });
      expect(reopened.foreignRead).toBeNull();
      expect(reopened.foreignConfigure).toMatchObject({
        ok: false,
        message: expect.stringContaining("unavailable for this owner"),
      });
      expect(reopened.foreignSnapshot).toMatchObject({
        ok: false,
        message: expect.stringContaining("unavailable for this owner and agent"),
      });
      expect(reopened.disabled).toMatchObject({ lifecycle: "disabled", generation: 1 });

      // Fresh process: disabled consent stays closed against replay; then delete.
      const disabled = await child(
        { action: "after-disable", facts, disabled: reopened.disabled },
        "after-disable",
      );
      expect(disabled.read?.profile).toEqual(reopened.disabled);
      expect(disabled.metadataLifecycle).toBe("disabled");
      expect(disabled.runAssertion).toMatchObject({
        ok: false,
        message: expect.stringContaining("requires its active original owner"),
      });
      expect(disabled.staleLearn).toMatchObject({
        ok: false,
        message: expect.stringContaining("generation changed"),
      });
      expect(disabled.replayActivate).toEqual({ ok: true, value: facts.active });
      expect(disabled.lifecycleAfterReplay).toBe("disabled");
      expect(disabled.reactivate).toMatchObject({
        ok: false,
        message: expect.stringContaining("not preparing"),
      });
      expect(disabled.deleted).toMatchObject({ lifecycle: "deleted", generation: 2 });

      // Fresh process: deleted content and old replies cannot be read or replayed back.
      const deleted = await child(
        { action: "after-delete", facts, deleted: disabled.deleted },
        "after-delete",
      );
      expect(deleted.read?.profile).toEqual(disabled.deleted);
      expect(deleted.metadataLifecycle).toBe("deleted");
      for (const refused of [deleted.snapshot, deleted.replayLearn]) {
        expect(refused).toMatchObject({
          ok: false,
          message: expect.stringContaining("unavailable for this owner and agent"),
        });
      }
      expect(deleted.recreated).toMatchObject({ lifecycle: "preparing", generation: 0 });
      expect(deleted.recreated.id).not.toBe(facts.active.id);
      expect(deleted.recreatedBeliefs).toEqual([]);
      expect(
        readSqlite(miniMeAgentPath, (db) =>
          MINI_ME_AGENT_TABLES.filter((table) => table !== "mini_me_content_operations").map(
            (table) => [
              table,
              Number(
                db
                  .prepare(`SELECT count(*) AS count FROM ${table} WHERE mini_me_id = ?`)
                  .get(facts.active.id)?.count,
              ),
            ],
          ),
        ),
      ).toEqual(
        MINI_ME_AGENT_TABLES.filter((table) => table !== "mini_me_content_operations").map(
          (table) => [table, 0],
        ),
      );
      // The empty purge acknowledgement survives so a lost reply can be retried.
      // Every prior reply containing learned data is erased.
      expect(
        readSqlite(miniMeAgentPath, (db) =>
          db
            .prepare(
              "SELECT operation_id, result_json FROM mini_me_content_operations WHERE mini_me_id = ?",
            )
            .all(facts.active.id),
        ),
      ).toEqual([{ operation_id: "synthetic-purge", result_json: "null" }]);

      // Restore the pre-disable archive into an isolated root, activated through Doctor.
      const restoreTarget = tempDirs.make("openclaw-mini-me-restore-");
      const restore = await instance.cli(
        ["backup", "restore", archive.archivePath, "--target", restoreTarget, "--json"],
        { timeoutMs: CLI_TIMEOUT_MS },
      );
      expect(restore.code, cliLogs(restore)).toBe(0);
      const restoredStateDir = path.join(restoreTarget, archive.state.archivePath);
      const restoredEnv = restoredEnvironment(instance, restoredStateDir);
      const restoredDoctor = await runNodeScript(
        [...(await instance.entrypoint()), ...DOCTOR_FIX],
        restoredEnv,
        CLI_TIMEOUT_MS,
        { cwd: process.cwd(), signal },
      );
      expect(restoredDoctor.error ?? restoredDoctor.status, cliLogs(restoredDoctor)).toBe(0);
      const restored = await child({ action: "restored", facts }, "restored", restoredEnv);
      expect(restored.read).toEqual({
        profile: facts.active,
        attachments: [],
        pendingDataChanges: [],
      });
      expect(restored.metadataLifecycle).toBe("active");
      expect(restored.beliefs).toEqual(undoneBeliefs);
      expect(restored.replayApplied).toEqual({ correction: 0, inferred: 0 });
      expect(
        readSqlite(
          statePath,
          (db) =>
            db
              .prepare("SELECT lifecycle FROM mini_me_profiles WHERE mini_me_id = ?")
              .get(facts.active.id)?.lifecycle,
        ),
      ).toBe("deleted");

      // A newer writer's copy is refused by preflight and runtime without being rewritten.
      const restoredStatePath = path.join(restoredStateDir, "state", "openclaw.sqlite");
      const futureBytes = writeFutureStateVersion(restoredStatePath);
      const downgrade = await child({ action: "downgrade", facts }, "downgrade", restoredEnv);
      expect(downgrade.preflight).toMatchObject({
        ok: false,
        name: "OpenClawDatabaseSchemaPreflightError",
        message: expect.stringContaining(
          `uses schema ${FUTURE_STATE_SCHEMA_VERSION}; this build supports ${OPENCLAW_STATE_SCHEMA_VERSION}`,
        ),
      });
      expect(downgrade.read).toMatchObject({
        ok: false,
        name: "SqliteSchemaVersionError",
        message: expect.stringContaining(`newer schema version ${FUTURE_STATE_SCHEMA_VERSION}`),
      });
      expect(createHash("sha256").update(fs.readFileSync(restoredStatePath)).digest("hex")).toBe(
        futureBytes,
      );
    } finally {
      await instance.cleanup();
    }
  },
);
