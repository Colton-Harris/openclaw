import fs from "node:fs/promises";
import path from "node:path";
import { assert, afterEach, describe, expect, it, vi } from "vitest";
import type {
  MiniMeAttachment,
  MiniMePrediction,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createHostWorkspaceWriteTool } from "../agents/agent-tools.read.js";
import { createMiniMeConsultation, type MiniMeConsultationBinding } from "./consultation.js";
import { createMiniMeDelegationOwner } from "./delegation.js";
import type { MiniMeDelegationStore } from "./delegation.types.js";
import { prepareMiniMeWorkspaceAction } from "./effect-execution.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const workspaceDir = dirs.make("mini-me-host-effect-");
  const file = path.join(workspaceDir, "notes.txt");
  await fs.writeFile(file, "original");
  const prepared = await prepareMiniMeWorkspaceAction({
    workspaceDir,
    relativePath: "notes.txt",
    content: "compact",
    assertCurrent() {},
  });
  const live = { active: true };
  const attachment: MiniMeAttachment = {
    agentId: "fixture-agent",
    mode: "safe",
    revision: 1,
    grants: [
      {
        id: "fixture-grant",
        effect: "workspace.edit",
        resources: [prepared.action.resource],
        maxActions: 1,
        maxBytes: 32,
        expiresAt: 1000,
      },
    ],
    usage: [],
  };
  const prediction: MiniMePrediction = {
    id: "fixture-prediction",
    agentId: "fixture-agent",
    choice: {
      scope: "synthetic-layout",
      question: "Which fixture layout?",
      options: [
        { id: "compact", label: "Compact", value: "compact" },
        { id: "expanded", label: "Expanded", value: "expanded" },
      ],
    },
    optionId: "compact",
    explanation: "Synthetic explicit preference.",
    uncertainty: "low",
    evidence: [{ sourceId: "fixture-source", sourceRevision: "1", excerpt: "Prefer compact." }],
    beliefIds: ["fixture-belief"],
    correctionApplied: false,
    provider: "explicit-preference",
    rubricVersion: "fixture-1",
    providerRuntimeGeneration: null,
    createdAt: 50,
    profileGeneration: 1,
    contentRevision: 1,
    authority: "advisory",
  };
  const assertCurrent = () => {
    if (!live.active) {
      throw new Error("Fixture authority revoked.");
    }
  };
  // Recording ports prove composition only; protected durable custody/limits have separate tests.
  const store = {
    freezePrediction: vi.fn<MiniMeDelegationStore["freezePrediction"]>(
      async ({ assertCurrent: paramAssertCurrent }) => {
        paramAssertCurrent();
      },
    ),
    reserve: vi.fn<MiniMeDelegationStore["reserve"]>(
      async ({ assertCurrent: paramAssertCurrent }) => {
        paramAssertCurrent();
        return { kind: "reserved", reservationId: "fixture-reservation" };
      },
    ),
    consume: vi.fn<MiniMeDelegationStore["consume"]>(
      async ({ assertCurrent: paramAssertCurrent }) => {
        paramAssertCurrent();
        return { kind: "consumed" };
      },
    ),
    settle: vi.fn<MiniMeDelegationStore["settle"]>(async () => {}),
  };
  const tool = createHostWorkspaceWriteTool(workspaceDir, { workspaceOnly: true });
  type ActionRestore = NonNullable<MiniMeConsultationBinding["actionRestore"]>;
  const recordActionRestore = vi.fn<ActionRestore["record"]>(
    async ({ assertCurrent: paramAssertCurrent }) => {
      paramAssertCurrent();
      return { receiptId: "fixture-restore" };
    },
  );
  // Unlike recording, release carries no requester assertion: it must work after revocation.
  const releaseActionRestore = vi.fn<ActionRestore["release"]>(async () => {});
  const binding: MiniMeConsultationBinding = {
    authority: {
      scope: {
        ownerId: "fixture-owner",
        miniMeId: "fixture-mini",
        targetAgentId: "fixture-agent",
        profileGeneration: 1,
        attachmentRevision: 1,
      },
      assertCurrent,
      readAttachment: () => attachment,
    },
    workspaceDir,
    predict: vi.fn(async () => prediction),
    qualifyEvidence: () => "explicit",
    getAdmittedTool: vi.fn((name) => (name === "write" ? tool : undefined)),
    actionRestore: { record: recordActionRestore, release: releaseActionRestore },
  };
  const owner = createMiniMeDelegationOwner({ store, now: () => 100 });
  const consult = createMiniMeConsultation({ owner, now: () => 100 });
  const params: Parameters<typeof consult>[0] = {
    binding,
    actionId: "fixture-action",
    choice: prediction.choice,
    candidates: [
      {
        optionId: "compact",
        effect: "workspace.edit",
        relativePath: "notes.txt",
        content: "compact",
      },
    ],
  };
  return {
    file,
    live,
    attachment,
    prediction,
    store,
    tool,
    binding,
    recordActionRestore,
    releaseActionRestore,
    params,
    consult,
  };
}

describe("Mini Me consultation through the real core text-file owner", () => {
  it("applies a grounded fixture choice after restorable custody and durable dispatch admission", async () => {
    const f = await fixture();
    const result = await f.consult(f.params);
    expect(result).toMatchObject({
      kind: "executed",
      restoreReceiptId: "fixture-restore",
      prediction: { authority: "advisory" },
      execution: { outcome: { state: "succeeded" } },
    });
    expect(await fs.readFile(f.file, "utf8")).toBe("compact");
    assert(f.attachment.grants[0]);
    expect(f.recordActionRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        before: { utf8: "original", sha256: expect.any(String) },
        resource: f.attachment.grants[0].resources[0],
      }),
    );
    expect(f.store.consume).toHaveBeenCalledOnce();
    assert(f.store.reserve.mock.invocationCallOrder[0] !== undefined);
    assert(f.recordActionRestore.mock.invocationCallOrder[0] !== undefined);
    assert(f.store.consume.mock.invocationCallOrder[0] !== undefined);
    expect(f.store.freezePrediction.mock.invocationCallOrder[0]).toBeLessThan(
      f.store.reserve.mock.invocationCallOrder[0],
    );
    // Custody is durable before the reservation admits the dispatch.
    expect(f.store.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      f.recordActionRestore.mock.invocationCallOrder[0],
    );
    expect(f.recordActionRestore.mock.invocationCallOrder[0]).toBeLessThan(
      f.store.consume.mock.invocationCallOrder[0],
    );
  });

  it("keeps a restore receipt for an actual Decide all edit", async () => {
    const f = await fixture();
    f.attachment.mode = "all";
    expect(await f.consult(f.params)).toMatchObject({
      kind: "executed",
      restoreReceiptId: "fixture-restore",
      execution: { outcome: { state: "succeeded" } },
    });
    expect(await fs.readFile(f.file, "utf8")).toBe("compact");
  });

  it.each([
    {
      name: "safe mode refuses inferred evidence",
      arrange: (f: Fixture) => {
        f.params.binding = { ...f.binding, qualifyEvidence: () => "qualified-inference" };
      },
      kind: "pending-owner",
    },
    {
      name: "safe mode refuses explicit evidence with medium uncertainty",
      arrange: (f: Fixture) => {
        f.prediction.uncertainty = "medium";
        f.params.binding = { ...f.binding, qualifyEvidence: () => "explicit" };
      },
      kind: "pending-owner",
    },
    {
      name: "no grant covers the edit",
      arrange: (f: Fixture) => {
        f.attachment.grants = [];
      },
      kind: "pending-owner",
    },
    {
      name: "the grant expired",
      arrange: (f: Fixture) => {
        assert(f.attachment.grants[0]);
        f.attachment.grants[0].expiresAt = 100;
      },
      kind: "pending-owner",
    },
    {
      name: "the grant budget is spent",
      arrange: (f: Fixture) => {
        f.store.reserve.mockResolvedValueOnce({ kind: "denied", reason: "Action limit reached." });
      },
      kind: "pending-owner",
    },
    {
      name: "the action already has a reservation",
      arrange: (f: Fixture) => {
        f.store.reserve.mockResolvedValueOnce({ kind: "existing", state: "succeeded" });
      },
      kind: "existing",
    },
  ])("saves no file version when $name", async (test) => {
    const f = await fixture();
    test.arrange(f);
    expect(await f.consult(f.params)).toMatchObject({ kind: test.kind });
    expect(f.recordActionRestore).not.toHaveBeenCalled();
    expect(f.store.consume).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file, "utf8")).toBe("original");
  });

  it("saves no file version when the admitted tool refuses before dispatch", async () => {
    const f = await fixture();
    f.params.binding = {
      ...f.binding,
      getAdmittedTool: () => ({
        ...f.tool,
        execute: async () => {
          throw new Error("Fixture approval denied.");
        },
      }),
    };
    const result = await f.consult(f.params);
    expect(result).toMatchObject({
      kind: "executed",
      execution: { outcome: { state: "not-dispatched" } },
    });
    expect(result.kind === "executed" && result.restoreReceiptId).toBeUndefined();
    expect(f.recordActionRestore).not.toHaveBeenCalled();
    expect(f.store.settle).toHaveBeenCalledWith(
      expect.objectContaining({ state: "not-dispatched" }),
    );
  });

  it("does not dispatch an edit whose preimage custody fails", async () => {
    const f = await fixture();
    f.recordActionRestore.mockRejectedValueOnce(new Error("Fixture custody unavailable."));
    expect(await f.consult(f.params)).toMatchObject({
      kind: "executed",
      execution: { outcome: { state: "not-dispatched" } },
    });
    expect(f.store.consume).not.toHaveBeenCalled();
    // The failure may be a lost acknowledgment of committed bytes, so release by action.
    expect(f.releaseActionRestore).toHaveBeenCalledWith({ actionId: "fixture-action" });
    expect(await fs.readFile(f.file, "utf8")).toBe("original");
  });

  it.each(["revoked-after-custody", "consume-denied"] as const)(
    "erases the preimage of an edit never dispatched (%s)",
    async (scenario) => {
      const f = await fixture();
      if (scenario === "revoked-after-custody") {
        f.recordActionRestore.mockImplementationOnce(async ({ assertCurrent }) => {
          assertCurrent();
          f.live.active = false;
          return { receiptId: "fixture-restore" };
        });
      } else {
        f.store.consume.mockResolvedValueOnce({ kind: "denied", reason: "Revoked." });
      }
      const result = await f.consult(f.params);
      expect(result).toMatchObject({
        kind: "executed",
        execution: {
          outcome: { state: "not-dispatched" },
          restoreRelease: { state: "released" },
        },
      });
      expect(result.kind === "executed" && result.restoreReceiptId).toBeUndefined();
      expect(f.releaseActionRestore).toHaveBeenCalledWith({ actionId: "fixture-action" });
      assert(f.releaseActionRestore.mock.invocationCallOrder[0] !== undefined);
      expect(f.store.settle.mock.invocationCallOrder[0]).toBeLessThan(
        f.releaseActionRestore.mock.invocationCallOrder[0],
      );
      expect(await fs.readFile(f.file, "utf8")).toBe("original");
    },
  );

  it("does not infer successful-edit reversibility without acknowledged restore custody", async () => {
    const f = await fixture();
    f.params.binding = { ...f.binding, actionRestore: undefined };
    expect(await f.consult(f.params)).toMatchObject({ kind: "pending-owner" });
    expect(await fs.readFile(f.file, "utf8")).toBe("original");
    expect(f.store.reserve).not.toHaveBeenCalled();
  });

  it("keeps Don't decide advisory while ordinary core writes remain available", async () => {
    const f = await fixture();
    f.attachment.mode = "dont-decide";
    expect(await f.consult(f.params)).toMatchObject({ kind: "advice" });
    expect(f.recordActionRestore).not.toHaveBeenCalled();
    expect(f.binding.getAdmittedTool).not.toHaveBeenCalled();
    await f.tool.execute("ordinary-action", {
      path: f.file,
      content: "ordinary owner instruction",
    });
    expect(await fs.readFile(f.file, "utf8")).toBe("ordinary owner instruction");
    expect(f.store.consume).not.toHaveBeenCalled();
  });

  it("never treats a transport without final-shape qualification as delegated approval", async () => {
    const f = await fixture();
    f.attachment.mode = "all";
    f.params.candidates = [
      {
        optionId: "compact",
        effect: "message.send",
        channel: "slack",
        accountId: "fixture",
        to: "C123",
        text: "hello",
      },
    ];
    expect(await f.consult(f.params)).toMatchObject({
      kind: "pending-owner",
      reason: "This action has no qualified host execution route.",
    });
    expect(f.binding.getAdmittedTool).not.toHaveBeenCalled();
    expect(f.store.reserve).not.toHaveBeenCalled();
  });

  it("rejects final tool-parameter rewrites before a filesystem effect", async () => {
    const f = await fixture();
    f.params.binding = {
      ...f.binding,
      getAdmittedTool: () => ({
        ...f.tool,
        execute: (id, args, signal) =>
          f.tool.execute(id, { ...(args as object), content: "changed after selection" }, signal),
      }),
    };
    expect(await f.consult(f.params)).toMatchObject({
      kind: "executed",
      execution: { outcome: { state: "not-dispatched" } },
    });
    expect(await fs.readFile(f.file, "utf8")).toBe("original");
    expect(f.store.consume).not.toHaveBeenCalled();
    expect(f.recordActionRestore).not.toHaveBeenCalled();
  });

  it.each(["revoked", "preimage-changed"] as const)(
    "fences %s after awaited dispatch admission",
    async (scenario) => {
      const f = await fixture();
      f.store.consume.mockImplementationOnce(async ({ assertCurrent }) => {
        assertCurrent();
        if (scenario === "revoked") {
          f.live.active = false;
        } else {
          await fs.writeFile(f.file, "external edit");
        }
        return { kind: "consumed" };
      });
      // Admitted work with an unknown outcome keeps its recovery receipt.
      expect(await f.consult(f.params)).toMatchObject({
        kind: "executed",
        restoreReceiptId: "fixture-restore",
        execution: { outcome: { state: "unknown" } },
      });
      expect(await fs.readFile(f.file, "utf8")).toBe(
        scenario === "revoked" ? "original" : "external edit",
      );
      expect(f.store.settle).toHaveBeenCalledWith(expect.objectContaining({ state: "unknown" }));
      expect(f.releaseActionRestore).not.toHaveBeenCalled();
    },
  );

  it("rejects provider approval extras before obtaining a file or restore receipt", async () => {
    const f = await fixture();
    Object.assign(f.prediction, { approved: true });
    await expect(f.consult(f.params)).rejects.toThrow("admitted structured choice");
    expect(f.binding.getAdmittedTool).not.toHaveBeenCalled();
    expect(f.recordActionRestore).not.toHaveBeenCalled();
  });
});
