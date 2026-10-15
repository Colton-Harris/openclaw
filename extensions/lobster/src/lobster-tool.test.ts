import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { createLobsterTool } from "./lobster-tool.js";

afterEach(() => vi.unstubAllEnvs());

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "lobster",
    name: "lobster",
    source: "test",
    runtime: { version: "test" } as OpenClawPluginApi["runtime"],
    resolvePath: (p) => p,
    ...overrides,
  });
}

function fakeCtx(overrides: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext {
  return {
    config: {},
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    agentId: "main",
    sessionKey: "main",
    messageChannel: undefined,
    agentAccountId: undefined,
    sandboxed: false,
    ...overrides,
  };
}

const requireRecord = createRequireRecord("record", "expected-label-record");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resumeToken(details: unknown, field = "requiresInput") {
  const envelope = requireRecord(details, "Lobster envelope");
  const request = requireRecord(envelope[field], field);
  if (typeof request.resumeToken !== "string") {
    throw new Error("expected a resume token");
  }
  return request.resumeToken;
}

describe("lobster plugin tool", () => {
  it("forwards caller cancellation and waits for embedded process cleanup", async () => {
    const dir = tempDirs.make("openclaw-lobster-caller-abort-");
    vi.stubEnv("LOBSTER_STATE_DIR", dir);
    const script = path.join(dir, "slow-effect.mjs");
    const workflow = path.join(dir, "slow-effect.lobster");
    const started = path.join(dir, "started");
    const effect = path.join(dir, "effect");
    await fs.writeFile(
      script,
      [
        "import fs from 'node:fs';",
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync(process.argv[2], 'started');",
        "setTimeout(() => fs.writeFileSync(process.argv[3], 'synthetic effect'), 900);",
        "setTimeout(() => process.exit(0), 1500);",
      ].join("\n"),
    );
    await fs.writeFile(
      workflow,
      JSON.stringify({
        steps: [
          {
            id: "synthetic-effect",
            run: [process.execPath, script, started, effect]
              .map((part) => JSON.stringify(part))
              .join(" "),
          },
        ],
      }),
    );

    const tool = createLobsterTool(fakeApi());
    const controller = new AbortController();
    const pending = tool.execute(
      "abort-running-workflow",
      { action: "run", pipeline: workflow, timeoutMs: 5_000 },
      controller.signal,
    );
    const startedDeadline = Date.now() + 5_000;
    while (Date.now() < startedDeadline) {
      try {
        await fs.access(started);
        break;
      } catch {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    }
    await fs.access(started);
    const abortAt = performance.now();
    const reason = new Error("private synthetic caller detail");
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message:
        "lobster execution cancelled after dispatch; effects may already exist. Inspect the original target before retrying.",
      cause: reason,
    });
    const cleanupMs = performance.now() - abortAt;
    expect(cleanupMs).toBeGreaterThanOrEqual(200);
    expect(cleanupMs).toBeLessThan(2_000);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_000);
    });
    await expect(fs.access(effect)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves durable approval preview and identity through resume", async () => {
    const dir = tempDirs.make("openclaw-lobster-approval-preview-");
    vi.stubEnv("LOBSTER_STATE_DIR", dir);
    const workflow = path.join(dir, "approval.lobster");
    const prepareScript = path.join(dir, "prepare.mjs");
    const publishScript = path.join(dir, "publish.mjs");
    const prepared = path.join(dir, "prepared");
    const published = path.join(dir, "published");
    await fs.writeFile(
      prepareScript,
      "import fs from 'node:fs'; fs.appendFileSync(process.argv[2], 'prepared');",
    );
    await fs.writeFile(
      publishScript,
      "import fs from 'node:fs'; fs.appendFileSync(process.argv[2], 'published');",
    );
    await fs.writeFile(
      workflow,
      JSON.stringify({
        steps: [
          {
            id: "prepare",
            run: [process.execPath, prepareScript, prepared]
              .map((part) => JSON.stringify(part))
              .join(" "),
          },
          {
            id: "approval",
            approval: {
              prompt: "Approve synthetic publication?",
              items: [{ target: "local-fixture" }],
              preview: "publish local-fixture",
              initiatedBy: "synthetic-requester",
              requiredApprover: "synthetic-reviewer",
              requireDifferentApprover: true,
            },
          },
          {
            id: "publish",
            run: [process.execPath, publishScript, published]
              .map((part) => JSON.stringify(part))
              .join(" "),
          },
        ],
      }),
    );

    const tool = createLobsterTool(fakeApi());
    const pending = await tool.execute("request-approval", { action: "run", pipeline: workflow });
    expect(await fs.readFile(prepared, "utf8")).toBe("prepared");
    await expect(fs.access(published)).rejects.toMatchObject({ code: "ENOENT" });
    expect(pending.details).toMatchObject({
      status: "needs_approval",
      requiresApproval: {
        type: "approval_request",
        prompt: "Approve synthetic publication?",
        items: [{ target: "local-fixture" }],
        preview: "publish local-fixture",
        initiatedBy: "synthetic-requester",
        requiredApprover: "synthetic-reviewer",
        requireDifferentApprover: true,
      },
    });

    vi.stubEnv("LOBSTER_APPROVAL_APPROVED_BY", "synthetic-reviewer");
    const approvalToken = resumeToken(pending.details, "requiresApproval");
    const approved = await createLobsterTool(fakeApi()).execute("resume-approval", {
      action: "resume",
      token: approvalToken,
      approve: true,
    });
    expect(approved.details).toMatchObject({ status: "ok" });
    expect(await fs.readFile(prepared, "utf8")).toBe("prepared");
    expect(await fs.readFile(published, "utf8")).toBe("published");
    await expect(
      createLobsterTool(fakeApi()).execute("replay-approval", {
        action: "resume",
        token: approvalToken,
        approve: true,
      }),
    ).rejects.toThrow(/not found/i);
    expect(await fs.readFile(published, "utf8")).toBe("published");
  });

  it("resumes real pipeline input, preserves invalid answers, and still handles approvals", async () => {
    vi.stubEnv("LOBSTER_STATE_DIR", tempDirs.make("openclaw-lobster-input-"));
    const tool = createLobsterTool(fakeApi());
    const first = await tool.execute("run", {
      action: "run",
      pipeline: 'ask --prompt "Review draft?" | approve --prompt "Publish?"',
    });
    expect(first.details).toMatchObject({
      status: "needs_input",
      requiresInput: { type: "input_request", prompt: "Review draft?" },
    });
    const token = resumeToken(first.details);
    await expect(
      tool.execute("invalid", { action: "resume", token, responseJson: '{"decision":123}' }),
    ).rejects.toThrow(/schema validation/);
    const second = await tool.execute("answer", {
      action: "resume",
      token,
      responseJson: '{"decision":"approve","feedback":"Looks good"}',
    });
    expect(second.details).toMatchObject({ status: "needs_approval" });
    const approvalToken = resumeToken(second.details, "requiresApproval");
    const approved = await tool.execute("approve", {
      action: "resume",
      token: approvalToken,
      approve: true,
    });
    expect(approved.details).toMatchObject({
      status: "ok",
      output: [{ decision: "approve", feedback: "Looks good" }],
    });
    await expect(
      tool.execute("replay", { action: "resume", token, responseJson: '{"decision":"reject"}' }),
    ).rejects.toThrow(/not found/i);
  });

  it("resumes real workflow files through successive questions without repeating preparation", async () => {
    const dir = tempDirs.make("openclaw-lobster-workflow-input-");
    vi.stubEnv("LOBSTER_STATE_DIR", dir);
    const seed = path.join(dir, "seed.json");
    await fs.writeFile(seed, JSON.stringify({ draft: "original" }));
    const file = path.join(dir, "review.lobster");
    await fs.writeFile(
      file,
      JSON.stringify({
        steps: [
          { id: "prepare", pipeline: "state.get seed | state.set prepared" },
          {
            id: "review",
            input: {
              prompt: "Review draft?",
              responseSchema: {
                type: "object",
                properties: { feedback: { type: "string" } },
                required: ["feedback"],
              },
              defaults: { feedback: "" },
            },
          },
          {
            id: "confirm",
            input: {
              prompt: "Which label?",
              responseSchema: { type: "string" },
            },
          },
          { id: "finish", pipeline: "state.get prepared" },
        ],
      }),
    );
    const tool = createLobsterTool(fakeApi());
    const first = await tool.execute("run", { action: "run", pipeline: file });
    expect(first.details).toMatchObject({
      status: "needs_input",
      requiresInput: { defaults: { feedback: "" }, subject: { draft: "original" } },
    });
    await fs.writeFile(seed, JSON.stringify({ draft: "changed" }));
    const second = await tool.execute("answer", {
      action: "resume",
      token: resumeToken(first.details),
      responseJson: '{"feedback":"Keep it"}',
    });
    expect(second.details).toMatchObject({
      status: "needs_input",
      requiresInput: { prompt: "Which label?" },
    });
    // A new tool instance proves continuation comes from saved state, not the runner's memory.
    const finished = await createLobsterTool(fakeApi()).execute("finish", {
      action: "resume",
      token: resumeToken(second.details),
      responseJson: '"reviewed"',
    });
    expect(finished.details).toMatchObject({ status: "ok", output: [{ draft: "original" }] });
  });

  it("cancels a real input checkpoint without executing its remaining steps", async () => {
    const dir = tempDirs.make("openclaw-lobster-input-cancel-");
    vi.stubEnv("LOBSTER_STATE_DIR", dir);
    const tool = createLobsterTool(fakeApi());
    const first = await tool.execute("run", {
      action: "run",
      pipeline: "ask | state.set should-not-exist",
    });
    const token = resumeToken(first.details);
    const cancelled = await tool.execute("cancel", { action: "resume", token, cancel: true });
    expect(cancelled.details).toMatchObject({ status: "cancelled" });
    await expect(fs.stat(path.join(dir, "should-not-exist.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      tool.execute("resume", {
        action: "resume",
        token,
        responseJson: '{"decision":"approve"}',
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("registers ordinary execution without a task runtime and keeps sandbox gating", () => {
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    plugin.register(fakeApi({ registerTool }));
    const factory = registerTool.mock.calls[0]?.[0];
    if (typeof factory !== "function") {
      throw new Error("expected a registered Lobster tool factory");
    }
    expect(factory(fakeCtx())).toMatchObject({ name: "lobster" });
    expect(factory(fakeCtx({ sandboxed: true }))).toBeNull();
  });

  it("returns approval envelopes for ordinary runs", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Continue?",
          items: [],
          resumeToken: "resume-token-1",
        },
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call-ordinary-run", {
      action: "run",
      pipeline: "noop",
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "ordinary run details");
    expect(details).toEqual({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "Continue?",
        items: [],
        resumeToken: "resume-token-1",
      },
    });
  });

  it("resumes ordinary workflows with approval credentials", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [{ approved: true }],
        requiresApproval: null,
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call-ordinary-resume", {
      action: "resume",
      token: "resume-token-1",
      approve: true,
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "resume",
      token: "resume-token-1",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "ordinary resume details");
    expect(details.ok).toBe(true);
    expect(details).toEqual({
      ok: true,
      status: "ok",
      output: [{ approved: true }],
      requiresApproval: null,
    });
  });

  it("normalizes numeric string run limits before invoking the runner", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    await tool.execute("call-string-limits", {
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      timeoutMs: "1500",
      maxStdoutBytes: "4096",
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      cwd: process.cwd(),
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });
  });

  it("rejects malformed numeric run limits before invoking the runner", async () => {
    const runner = { run: vi.fn() };
    const tool = createLobsterTool(fakeApi(), { runner });

    await expect(
      tool.execute("call-bad-timeout", {
        action: "run",
        pipeline: "noop",
        timeoutMs: "1500.5",
      }),
    ).rejects.toThrow("timeoutMs must be a positive integer");
    await expect(
      tool.execute("call-bad-stdout", {
        action: "run",
        pipeline: "noop",
        maxStdoutBytes: 0,
      }),
    ).rejects.toThrow("maxStdoutBytes must be a positive integer");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("throws when the runner returns an error envelope", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: {
        run: vi.fn().mockResolvedValue({
          ok: false,
          error: {
            type: "runtime_error",
            message: "boom",
          },
        }),
      },
    });

    await expect(
      tool.execute("call-runner-error", {
        action: "run",
        pipeline: "noop",
      }),
    ).rejects.toThrow("boom");
  });

  it("requires action", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(tool.execute("call-action-missing", {})).rejects.toThrow(/action required/);
  });

  it("rejects unknown action", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-action-unknown", {
        action: "explode",
      }),
    ).rejects.toThrow(/Unknown action/);
  });

  it("rejects absolute cwd", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-absolute-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/cwd must be a relative path/);
  });

  it("rejects cwd that escapes the gateway working directory", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-escape-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "../../etc",
      }),
    ).rejects.toThrow(/must stay within/);
  });
});
