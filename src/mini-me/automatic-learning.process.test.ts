import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { miniMeLearningProcessEntrypoint } from "./automatic-learning.process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workerUrl = resolveRuntimeWorkerUrl(miniMeLearningProcessEntrypoint);

async function runProcess(action: string, databasePath: string) {
  const result = await runNodeScript(
    (workerArgv) => [...workerArgv(workerUrl), action, databasePath],
    process.env,
    30_000,
    { cwd: process.cwd() },
  );
  expect(result.error ?? result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout.trim()) as {
    cursor: string | null;
    source?: { status: string; detail: string | null };
  };
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

it("reopens a committed pending conversation page in a fresh process and resumes from its cursor", async () => {
  const directory = tempDirs.make("mini-me-learning-process-");
  const databasePath = path.join(directory, "synthetic-agent.sqlite");

  const firstProcess = await runProcess("commit-first-page", databasePath);
  expect(firstProcess).toMatchObject({
    cursor: "page-1",
    source: {
      status: "pending",
      detail: expect.stringContaining("still learning"),
    },
  });

  const committedBytes = sha256(databasePath);
  const readProcess = await runProcess("read", databasePath);
  expect(readProcess).toEqual(firstProcess);
  expect(sha256(databasePath)).toBe(committedBytes);

  const resumedProcess = await runProcess("resume-next-page", databasePath);
  expect(resumedProcess).toMatchObject({
    cursor: "page-2",
    source: { status: "ready", detail: null },
  });
});
