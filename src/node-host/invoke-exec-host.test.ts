import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import type { ExecHostRequest } from "../infra/exec-host.js";

const requestExecHostViaSocket = vi.hoisted(() => vi.fn());

vi.mock("../infra/exec-host.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../infra/exec-host.js")>();
  return { ...original, requestExecHostViaSocket };
});

import { runViaMacAppExecHost } from "./invoke.js";

describe("runViaMacAppExecHost", () => {
  it("forwards the command timeout to the companion socket deadline", async () => {
    const response = {
      ok: true,
      payload: { exitCode: 0, timedOut: false, success: true, stdout: "", stderr: "" },
    };
    requestExecHostViaSocket.mockResolvedValueOnce(response);
    const request: ExecHostRequest = {
      command: ["/bin/sh", "-c", "sleep 180"],
      timeoutMs: 180_000,
    };
    const signal = new AbortController().signal;
    const approvals = {
      socketPath: "/tmp/openclaw-exec-host.sock",
      token: "test-token",
    } as ExecApprovalsResolved;

    await expect(runViaMacAppExecHost({ approvals, request, signal })).resolves.toBe(response);
    expect(requestExecHostViaSocket).toHaveBeenCalledExactlyOnceWith({
      socketPath: approvals.socketPath,
      token: approvals.token,
      request,
      timeoutMs: 180_000,
      signal,
    });
  });
});
