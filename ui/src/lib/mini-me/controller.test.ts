// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MiniMeSnapshot } from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { createGatewayHarness } from "../../app/overlays-access.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { MiniMeController } from "./controller.ts";
import { writeMiniMeOperationReceipts } from "./operation-journal.ts";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function snapshot(name: string): MiniMeSnapshot {
  return {
    profile: {
      id: `mini-${name}`,
      agentId: `agent-${name}`,
      name,
      lifecycle: "active",
      learningPaused: false,
      generation: 1,
      revision: 1,
      models: { conversationModel: null, decisionModel: null, allowInference: false },
      createdAt: 1,
      updatedAt: 1,
    },
    contentRevision: 1,
    documents: [],
    sources: [],
    beliefs: [],
    predictions: [],
    outcomes: [],
    attachments: [],
    capabilities: { effects: [], maxSources: 16, maxDocumentBytes: 65536, maxOptions: 8 },
    historyCursor: null,
  };
}
const user = (id: string) => ({ id, identity: { type: "profile" as const, id } });

it("never publishes a late private snapshot into another person's view", async () => {
  const prior = createDeferred<MiniMeSnapshot>();
  const request = vi.fn().mockReturnValueOnce(prior.promise).mockResolvedValue(snapshot("Second"));
  const harness = createGatewayHarness(createTestGatewayClient(request));
  harness.update({ selfUser: user("first") });
  const controller = new MiniMeController(harness);
  const unsubscribe = controller.subscribe(() => {});
  try {
    harness.update({ selfUser: user("second") });
    await controller.refresh();
    expect(controller.state.snapshot?.profile?.name).toBe("Second");
    prior.resolve(snapshot("First private profile"));
    await prior.promise;
    expect(controller.state.ownerKey).toBe("second");
    expect(controller.state.snapshot?.profile?.name).toBe("Second");
  } finally {
    unsubscribe();
  }
});

it.each(["unknown", "pending"])(
  "reconciles a %s mutation and resumes only the original operation",
  async (status) => {
    let attempts = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "miniMe.configure" && attempts++ === 0) {
        throw new Error("Transport ended");
      }
      if (method === "miniMe.operation.get") {
        return { status };
      }
      return snapshot("First");
    });
    const harness = createGatewayHarness(createTestGatewayClient(request));
    harness.update({ selfUser: user("first") });
    const controller = new MiniMeController(harness);
    const unsubscribe = controller.subscribe(() => {});
    try {
      await controller.refresh();
      const operation = {
        operationId: "original-operation",
        expectedRevision: 1,
        learningPaused: true,
      };
      expect(await controller.mutate("miniMe.configure", operation)).toBe(false);
      expect(controller.state.operationStatus).toBe("unknown");
      expect(
        await controller.mutate("miniMe.configure", { ...operation, operationId: "new-operation" }),
      ).toBe(false);
      await controller.retryOperation();
      const mutations = request.mock.calls.filter(([method]) => method === "miniMe.configure");
      expect(mutations).toHaveLength(2);
      expect(request).toHaveBeenCalledWith("miniMe.operation.get", {
        operationId: "original-operation",
      });
      expect(mutations.map((call) => call[1])).toEqual([operation, operation]);
      expect(controller.state.operationStatus).toBeNull();
    } finally {
      unsubscribe();
    }
  },
);

it.each(["unknown", "pending"])(
  "restores a %s receipt after reload and requires reviewed original inputs",
  async (status) => {
    const operation = {
      operationId: "reload-operation",
      expectedRevision: 1,
      name: "Private input",
    };
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "miniMe.configure") {
        throw new Error("Transport ended");
      }
      if (method === "miniMe.operation.get") {
        return { status };
      }
      return snapshot("First");
    });
    const harness = createGatewayHarness(createTestGatewayClient(request));
    harness.update({ selfUser: user("reload-owner") });
    const first = new MiniMeController(harness);
    const stopFirst = first.subscribe(() => {});
    await first.refresh();
    await first.mutate("miniMe.configure", operation);
    stopFirst();
    const journal = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index)!,
    ).filter((key) => key.startsWith("openclaw.mini-me.operations.v1:"));
    expect(journal).toHaveLength(1);
    expect(sessionStorage.getItem(journal[0]!)).not.toContain("Private input");
    const reloaded = new MiniMeController(harness);
    const stop = reloaded.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(reloaded.state.busy).toBe(false));
      expect(reloaded.needsOriginalInputs).toBe(true);
      expect(await reloaded.mutate("miniMe.configure", operation)).toBe(false);
      reloaded.reviewOriginalInputs();
      expect(
        await reloaded.mutate("miniMe.learn", {
          operationId: "must-not-be-used",
          preference: {
            document: "PREFERENCES.md",
            scope: "preview",
            statement: "Preview only",
            preferred: ["a"],
            avoided: [],
          },
        }),
      ).toBe(false);
      await reloaded.mutate("miniMe.configure", { ...operation, operationId: "must-not-be-used" });
      expect(
        request.mock.calls
          .filter(([method]) => method === "miniMe.configure")
          .map((call) => call[1]),
      ).toEqual([operation, operation]);
    } finally {
      stop();
      for (const key of journal) {
        sessionStorage.removeItem(key);
      }
    }
  },
);

it("retains a partial commit after a finite Gateway error and resumes the same request", async () => {
  let attempts = 0;
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "miniMe.document.set" && attempts++ === 0) {
      throw new GatewayRequestError({ code: "UNAVAILABLE", message: "Projection interrupted" });
    }
    if (method === "miniMe.operation.get") {
      return { status: "pending" };
    }
    return snapshot("First");
  });
  const harness = createGatewayHarness(createTestGatewayClient(request));
  harness.update({ selfUser: user("partial-owner") });
  const controller = new MiniMeController(harness);
  const stop = controller.subscribe(() => {});
  try {
    await controller.refresh();
    const operation = {
      operationId: "partial-file",
      name: "SOUL.md" as const,
      expectedRevision: 1,
      content: "Reviewed text",
    };
    expect(await controller.mutate("miniMe.document.set", operation)).toBe(false);
    expect(controller.state.operationStatus).toBe("pending");
    expect(
      await controller.mutate("miniMe.document.set", { ...operation, operationId: "duplicate" }),
    ).toBe(false);
    await controller.retryOperation();
    expect(
      request.mock.calls
        .filter(([method]) => method === "miniMe.document.set")
        .map((call) => call[1]),
    ).toEqual([operation, operation]);
    expect(controller.state.operationStatus).toBeNull();
  } finally {
    stop();
  }
});

it.each(["miniMe.delete", "miniMe.configure"] as const)(
  "reuses a reviewed %s receipt before considering independent shutdown",
  async (method) => {
    const request = vi.fn(async (rpc: string, _params?: unknown) =>
      rpc === "miniMe.operation.get" ? { status: "unknown" } : snapshot("First"),
    );
    const harness = createGatewayHarness(createTestGatewayClient(request));
    harness.update({ selfUser: user("shutdown-owner") });
    writeMiniMeOperationReceipts(harness.gateway.connection.gatewayUrl, "shutdown-owner", [
      { method, operationId: "original-shutdown", startedAt: 1 },
    ]);
    const controller = new MiniMeController(harness);
    const stop = controller.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(controller.state.busy).toBe(false));
      controller.reviewOriginalInputs();
      await controller.mutate(method, {
        operationId: "unused-new-id",
        expectedRevision: 1,
        ...(method === "miniMe.configure" ? { enabled: false } : {}),
      });
      expect(request).toHaveBeenCalledWith(method, {
        operationId: "original-shutdown",
        expectedRevision: 1,
        ...(method === "miniMe.configure" ? { enabled: false } : {}),
      });
    } finally {
      stop();
    }
  },
);
