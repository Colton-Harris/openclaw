import { assert, describe, expect, it, vi } from "vitest";
import type {
  MiniMeAttachment,
  MiniMeMode,
  MiniMePrediction,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createMiniMeDelegationOwner } from "./delegation.js";
import type {
  MiniMeDelegationAction,
  MiniMeDelegationFence,
  MiniMeDelegationQualification,
  MiniMeDelegationStore,
  MiniMeEffectResult,
  MiniMeRestoreCustody,
} from "./delegation.types.js";

function fixture() {
  const events: string[] = [];
  const clock = { now: 100 };
  const lifetime = { active: true };
  const attachment: MiniMeAttachment = {
    agentId: "host-agent",
    mode: "safe",
    revision: 4,
    grants: [
      {
        id: "grant-1",
        effect: "workspace.edit",
        resources: ["workspace:host-agent/notes.txt"],
        maxActions: 2,
        maxBytes: 100,
        expiresAt: 1_000,
      },
    ],
    usage: [],
  };
  const prediction: MiniMePrediction = {
    id: "prediction-1",
    agentId: "host-agent",
    choice: {
      scope: "synthetic-layout",
      question: "Which fixture layout?",
      options: [
        { id: "compact", label: "Compact", value: "compact" },
        { id: "expanded", label: "Expanded", value: "expanded" },
      ],
    },
    optionId: "compact",
    explanation: "The synthetic preference selects compact.",
    uncertainty: "low",
    evidence: [{ sourceId: "source-1", sourceRevision: "1", excerpt: "Prefer compact." }],
    beliefIds: ["belief-1"],
    correctionApplied: false,
    provider: "explicit-preference",
    rubricVersion: "synthetic-rubric-1",
    providerRuntimeGeneration: null,
    createdAt: 99,
    profileGeneration: 3,
    contentRevision: 5,
    authority: "advisory",
  };
  const action: MiniMeDelegationAction = {
    effect: "workspace.edit",
    resource: "workspace:host-agent/notes.txt",
    expectedContentHash: "synthetic-preimage",
    content: "compact",
  };
  const qualification: MiniMeDelegationQualification = {
    supported: true,
    impact: "low",
    reversible: true,
    evidence: "explicit",
  };
  const freezePrediction = vi.fn<MiniMeDelegationStore["freezePrediction"]>(async (input) => {
    input.assertCurrent();
    events.push("frozen");
  });
  // This port records the owner's behavior; SQLite atomicity is a separate integration proof.
  const reserve = vi.fn<MiniMeDelegationStore["reserve"]>(async (input) => {
    input.assertCurrent();
    events.push("reserved");
    return { kind: "reserved", reservationId: "reservation-1" };
  });
  const consume = vi.fn<MiniMeDelegationStore["consume"]>(async (input) => {
    input.assertCurrent();
    events.push("consumed");
    return { kind: "consumed" };
  });
  const settle = vi.fn<MiniMeDelegationStore["settle"]>(async (input) => {
    events.push(input.state);
  });
  const store = { freezePrediction, reserve, consume, settle };
  const restore = vi.fn<MiniMeRestoreCustody["record"]>(async (assertCurrent) => {
    assertCurrent();
    events.push("restored");
    return { receiptId: "restore-1" };
  });
  // Deliberately ignores requester lifetime: release must work after revocation.
  const release = vi.fn<MiniMeRestoreCustody["release"]>(async () => {
    events.push("released");
  });
  const owner = createMiniMeDelegationOwner({ store, now: () => clock.now });
  const params: Parameters<typeof owner.prepare>[0] = {
    authority: {
      scope: {
        ownerId: "person-a",
        miniMeId: "mini-a",
        targetAgentId: "host-agent",
        profileGeneration: 3,
        attachmentRevision: 4,
      },
      assertCurrent() {
        if (!lifetime.active) {
          throw new Error("Source was revoked.");
        }
      },
      readAttachment: () => attachment,
    },
    actionId: "action-1",
    prediction,
    actions: [{ optionId: "compact", action, qualification }],
    restore: { record: restore, release },
  };
  const effect = vi.fn(
    async (fence: MiniMeDelegationFence): Promise<MiniMeEffectResult<string>> => {
      await fence.beforeDispatch(fence.action);
      fence.assertCurrent();
      events.push("effect");
      return { state: "succeeded", value: "done" };
    },
  );
  const prepare = async () => {
    const result = await owner.prepare(params);
    if (result.kind !== "delegated") {
      throw new Error(`Expected a test delegation, received ${result.kind}.`);
    }
    return result.capability;
  };
  return {
    owner,
    params,
    prepare,
    effect,
    store,
    restore,
    release,
    events,
    clock,
    lifetime,
    attachment,
  };
}

describe("Mini Me delegated action authority", () => {
  it("freezes advice before reserving and consumes at the host effect boundary", async () => {
    const f = fixture();
    const capability = await f.prepare();
    expect(f.events).toEqual(["frozen", "reserved"]);
    expect(await f.owner.execute(capability, f.effect)).toEqual({
      outcome: { state: "succeeded", value: "done" },
      settlement: { state: "recorded" },
      restoreReceiptId: "restore-1",
    });
    expect(f.events).toEqual(["frozen", "reserved", "restored", "consumed", "effect", "succeeded"]);
    await expect(f.owner.execute(capability, f.effect)).rejects.toThrow("already used");
    expect(f.effect).toHaveBeenCalledOnce();
  });

  it("rejects a prediction, forged handle, copied handle, and another owner's handle", async () => {
    const f = fixture();
    const capability = await f.prepare();
    const foreign = fixture();
    for (const candidate of [
      f.params.prediction,
      { kind: "mini-me-delegation", approved: true },
      { ...capability },
      await foreign.prepare(),
    ]) {
      await expect(f.owner.execute(candidate, f.effect)).rejects.toThrow("invalid or already used");
    }
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.store.consume).not.toHaveBeenCalled();
    await f.owner.cancel(capability);
  });

  it("rejects approval-shaped provider extras before any reservation", async () => {
    const f = fixture();
    f.params.prediction = Object.assign({}, f.params.prediction, { approved: true });
    await expect(f.owner.prepare(f.params)).rejects.toThrow("advisory prediction contract");
    expect(f.store.freezePrediction).not.toHaveBeenCalled();
    expect(f.store.reserve).not.toHaveBeenCalled();
  });

  it("does not expose an effect assertion before durable dispatch admission", async () => {
    const f = fixture();
    const capability = await f.prepare();
    const result = await f.owner.execute(capability, async (fence) => {
      expect(() => fence.assertCurrent()).toThrow("dispatch has not been admitted");
      return f.effect(fence);
    });
    expect(result.outcome.state).toBe("succeeded");
    expect(f.store.consume).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: "dont-decide", result: "advice" },
    { mode: "safe", evidence: "qualified-inference", result: "pending-owner" },
    { mode: "safe", reversible: false, result: "pending-owner" },
    { mode: "safe", withoutRestore: true, result: "pending-owner" },
    { mode: "safe", message: true, result: "pending-owner" },
    { mode: "auto", evidence: "qualified-inference", result: "delegated" },
    { mode: "auto", uncertainty: "high", result: "pending-owner" },
    { mode: "all", uncertainty: "high", evidence: "uncertain", result: "delegated" },
    { mode: "all", evidence: "conflicting", result: "pending-owner" },
    { mode: "all", supported: false, result: "pending-owner" },
  ] satisfies Array<{
    mode: MiniMeMode;
    result: string;
    evidence?: MiniMeDelegationQualification["evidence"];
    reversible?: boolean;
    supported?: boolean;
    uncertainty?: MiniMePrediction["uncertainty"];
    message?: boolean;
    withoutRestore?: boolean;
  }>)("applies $mode policy with $evidence evidence ($result)", async (test) => {
    const f = fixture();
    f.attachment.mode = test.mode;
    if (test.withoutRestore) {
      f.params.restore = undefined;
    }
    if (test.uncertainty) {
      f.params.prediction.uncertainty = test.uncertainty;
    }
    const original = f.params.actions[0];
    assert(original);
    f.params.actions = [
      {
        ...original,
        qualification: {
          ...original.qualification,
          ...(test.evidence !== undefined ? { evidence: test.evidence } : {}),
          ...(test.reversible !== undefined ? { reversible: test.reversible } : {}),
          ...(test.supported !== undefined ? { supported: test.supported } : {}),
        },
        ...(test.message
          ? {
              action: { effect: "message.send", resource: "channel:account:target", text: "hello" },
            }
          : {}),
      },
    ];
    if (test.message) {
      assert(f.attachment.grants[0]);
      f.attachment.grants[0].effect = "message.send";
      f.attachment.grants[0].resources = ["channel:account:target"];
    }
    const result = await f.owner.prepare(f.params);
    expect(result.kind).toBe(test.result);
    if (result.kind === "delegated") {
      await f.owner.cancel(result.capability);
    } else {
      expect(f.store.reserve).not.toHaveBeenCalled();
    }
    expect(f.store.consume).not.toHaveBeenCalled();
    expect(f.restore).not.toHaveBeenCalled();
  });

  it("requires exact resources, current expiry, and the actual UTF-8 byte budget", async () => {
    const f = fixture();
    assert(f.params.actions[0]);
    f.params.actions = [
      {
        ...f.params.actions[0],
        action: { effect: "message.send", resource: "channel:account:target", text: "🦞" },
      },
    ];
    f.attachment.mode = "all";
    f.attachment.grants[0] = {
      id: "message-grant",
      effect: "message.send",
      resources: ["channel:account:other"],
      maxActions: 2,
      maxBytes: 4,
      expiresAt: f.clock.now + 1,
    };
    expect((await f.owner.prepare(f.params)).kind).toBe("pending-owner");
    f.attachment.grants[0].resources = ["channel:account:target"];
    f.attachment.grants[0].expiresAt = f.clock.now;
    expect((await f.owner.prepare(f.params)).kind).toBe("pending-owner");
    f.attachment.grants[0].expiresAt = f.clock.now + 1;
    f.attachment.grants[0].maxBytes = 3;
    expect((await f.owner.prepare(f.params)).kind).toBe("pending-owner");
    expect(f.store.reserve).not.toHaveBeenCalled();
    f.attachment.grants[0].maxBytes = 4;
    const capability = await f.prepare();
    expect(f.store.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.objectContaining({ bytes: 4 }) }),
    );
    f.clock.now += 1;
    expect((await f.owner.execute(capability, f.effect)).outcome.state).toBe("not-dispatched");
    expect(f.effect).not.toHaveBeenCalled();
  });

  it("does not turn a denied or already used durable reservation into a capability", async () => {
    const f = fixture();
    f.store.reserve.mockResolvedValueOnce({ kind: "denied", reason: "Action limit reached." });
    expect(await f.owner.prepare(f.params)).toMatchObject({
      kind: "pending-owner",
      reason: "Action limit reached.",
    });
    f.store.reserve.mockResolvedValueOnce({ kind: "existing", state: "unknown" });
    expect(await f.owner.prepare(f.params)).toMatchObject({ kind: "existing", state: "unknown" });
    expect(f.store.consume).not.toHaveBeenCalled();
    expect(f.restore).not.toHaveBeenCalled();
  });

  it("takes restore custody only when prepared work reaches its dispatch fence", async () => {
    const f = fixture();
    const abandoned = await f.prepare();
    const result = await f.owner.execute(abandoned, async () => {
      throw new Error("Host approval denied before dispatch.");
    });
    expect(result).toEqual({
      outcome: { state: "not-dispatched", reason: "Execution ended before effect dispatch." },
      settlement: { state: "recorded" },
    });
    await f.owner.cancel(await f.prepare());
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.store.consume).not.toHaveBeenCalled();
  });

  it.each([
    "unacknowledged",
    "record-ack-lost",
    "revoked-after-custody",
    "consume-denied",
  ] as const)(
    "erases preimage custody once dispatch is known never admitted (%s)",
    async (scenario) => {
      const f = fixture();
      const capability = await f.prepare();
      if (scenario === "unacknowledged") {
        f.restore.mockImplementationOnce(async () => {
          f.events.push("restored");
          return { receiptId: "" };
        });
      } else if (scenario === "record-ack-lost") {
        // The row may have committed; only the acknowledgment is missing.
        f.restore.mockImplementationOnce(async () => {
          f.events.push("restored");
          throw new Error("Lost record acknowledgement.");
        });
      } else if (scenario === "revoked-after-custody") {
        f.restore.mockImplementationOnce(async () => {
          f.events.push("restored");
          f.lifetime.active = false;
          return { receiptId: "restore-1" };
        });
      } else {
        f.store.consume.mockImplementationOnce(async () => {
          f.events.push("denied");
          return { kind: "denied", reason: "Reservation authority was revoked" };
        });
      }
      expect(await f.owner.execute(capability, f.effect)).toEqual({
        outcome: { state: "not-dispatched", reason: "Execution ended before effect dispatch." },
        settlement: { state: "recorded" },
        restoreRelease: { state: "released" },
      });
      expect(f.events.slice(2)).toEqual([
        "restored",
        ...(scenario === "consume-denied" ? ["denied"] : []),
        "not-dispatched",
        "released",
      ]);
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.effect).toHaveBeenCalledOnce();
      expect(f.events).not.toContain("effect");
    },
  );

  it("reports retained preimage bytes when their release is unconfirmed", async () => {
    const f = fixture();
    const capability = await f.prepare();
    const error = new Error("Release unavailable.");
    f.store.consume.mockResolvedValueOnce({ kind: "denied", reason: "Revoked." });
    f.release.mockRejectedValueOnce(error);
    expect(await f.owner.execute(capability, f.effect)).toEqual({
      outcome: { state: "not-dispatched", reason: "Execution ended before effect dispatch." },
      settlement: { state: "recorded" },
      restoreReceiptId: "restore-1",
      restoreRelease: { state: "unconfirmed", error },
    });
  });

  it("captures selected action bytes before prediction persistence can yield", async () => {
    const f = fixture();
    const started = createDeferred();
    const release = createDeferred();
    f.store.freezePrediction.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
    });
    const preparation = f.owner.prepare(f.params);
    await awaitGateBeforeSettlement(started.promise, preparation, "Prediction freeze was skipped.");
    f.params.actionId = "changed-action";
    assert(f.params.actions[0]);
    f.params.actions = [
      {
        ...f.params.actions[0],
        action: {
          effect: "workspace.edit",
          resource: "workspace:host-agent/other.txt",
          expectedContentHash: "other",
          content: "changed",
        },
      },
    ];
    release.resolve();
    const prepared = await preparation;
    expect(prepared.kind).toBe("delegated");
    expect(f.store.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "action-1",
        action: expect.objectContaining({ resource: "workspace:host-agent/notes.txt", bytes: 7 }),
      }),
    );
    if (prepared.kind === "delegated") {
      await f.owner.cancel(prepared.capability);
    }
  });

  it("fences revocation during preparation and refuses a concurrent second executor", async () => {
    const f = fixture();
    const capability = await f.prepare();
    const started = createDeferred();
    const release = createDeferred();
    let retainedFence: MiniMeDelegationFence | undefined;
    const execution = f.owner.execute(capability, async (fence) => {
      retainedFence = fence;
      started.resolve();
      await release.promise;
      return f.effect(fence);
    });
    await awaitGateBeforeSettlement(started.promise, execution, "Effect preparation was skipped.");
    await expect(f.owner.execute(capability, f.effect)).rejects.toThrow("already used");
    f.lifetime.active = false;
    release.resolve();
    expect((await execution).outcome.state).toBe("not-dispatched");
    expect(f.store.consume).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(() => retainedFence?.assertCurrent()).toThrow("closed");
    expect(f.events).not.toContain("effect");
  });

  it("checks changed mode and exact final action after a capability has been issued", async () => {
    const f = fixture();
    const capability = await f.prepare();
    f.attachment.mode = "dont-decide";
    expect((await f.owner.execute(capability, f.effect)).outcome.state).toBe("not-dispatched");
    expect(f.effect).not.toHaveBeenCalled();
    f.attachment.mode = "safe";
    f.params.actionId = "action-2";
    const rewritten = await f.prepare();
    const result = await f.owner.execute(rewritten, async (fence) => {
      await fence.beforeDispatch({ ...fence.action, resource: "workspace:host-agent/other.txt" });
      return { state: "succeeded", value: "must not execute" };
    });
    expect(result.outcome.state).toBe("not-dispatched");
    expect(f.store.consume).not.toHaveBeenCalled();
  });

  it.each(["consume-response-lost", "effect-threw", "effect-failed", "consume-existing"] as const)(
    "retains the reservation after %s without permitting another execution",
    async (scenario) => {
      const f = fixture();
      const capability = await f.prepare();
      if (scenario === "consume-response-lost") {
        f.store.consume.mockRejectedValueOnce(new Error("Lost commit acknowledgement."));
      } else if (scenario === "consume-existing") {
        f.store.consume.mockResolvedValueOnce({ kind: "existing" });
      }
      const result = await f.owner.execute(capability, async (fence) => {
        await fence.beforeDispatch(fence.action);
        if (scenario === "effect-failed") {
          return { state: "failed", reason: "The effect owner confirmed failure." };
        }
        throw new Error("The effect owner lost the outcome.");
      });
      const state = scenario === "effect-failed" ? "failed" : "unknown";
      expect(result.outcome.state).toBe(state);
      expect(result.restoreReceiptId).toBe("restore-1");
      expect(result.restoreRelease).toBeUndefined();
      expect(f.release).not.toHaveBeenCalled();
      expect(f.store.settle).toHaveBeenCalledWith(expect.objectContaining({ state }));
      await expect(f.owner.execute(capability, f.effect)).rejects.toThrow("already used");
      expect(f.effect).not.toHaveBeenCalled();
    },
  );

  it("reports an unconfirmed settlement without repeating a completed effect", async () => {
    const f = fixture();
    const capability = await f.prepare();
    const error = new Error("Settlement unavailable.");
    f.store.settle.mockRejectedValueOnce(error);
    expect(await f.owner.execute(capability, f.effect)).toEqual({
      outcome: { state: "succeeded", value: "done" },
      settlement: { state: "unconfirmed", error },
      restoreReceiptId: "restore-1",
    });
    await expect(f.owner.execute(capability, f.effect)).rejects.toThrow("already used");
    expect(f.effect).toHaveBeenCalledOnce();
  });

  it("releases a canceled prepared reservation without creating effect authority", async () => {
    const f = fixture();
    const capability = await f.prepare();
    await f.owner.cancel(capability);
    expect(f.store.settle).toHaveBeenCalledWith(
      expect.objectContaining({ state: "not-dispatched" }),
    );
    await expect(f.owner.execute(capability, f.effect)).rejects.toThrow("already used");
    expect(f.store.consume).not.toHaveBeenCalled();
  });
});
