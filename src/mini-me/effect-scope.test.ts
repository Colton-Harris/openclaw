import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { captureAgentToolSourceExecutionGuard } from "../agents/agent-tool-source-execution-guard.js";
import type { MiniMeDelegationFence } from "./delegation.types.js";
import {
  captureMiniMeEffectAssertion,
  captureMiniMeEffectPreparation,
  withMiniMeEffectScope,
} from "./effect-scope.js";

function scopeFixture() {
  const state = { active: true, admitted: false };
  const assertPreparing = () => {
    if (!state.active) {
      throw new Error("Synthetic run was revoked.");
    }
  };
  const fence: MiniMeDelegationFence = {
    action: { effect: "message.send", resource: "synthetic-route", text: "hello" },
    assertPreparing,
    assertCurrent() {
      assertPreparing();
      if (!state.admitted) {
        throw new Error("Synthetic dispatch is not admitted.");
      }
    },
    beforeDispatch: vi.fn(async () => {
      assertPreparing();
      state.admitted = true;
    }),
  };
  return { state, fence };
}

describe("Mini Me effect scope", () => {
  it("leaves ordinary tool guards unchanged and captures the original delegated scope", async () => {
    expect(captureMiniMeEffectAssertion()).toBeUndefined();
    const ordinary = captureAgentToolSourceExecutionGuard();
    const first = scopeFixture();
    let retained: (() => void) | undefined;
    await withMiniMeEffectScope(first.fence, async () => {
      retained = captureAgentToolSourceExecutionGuard();
      retained();
      const prepared = captureMiniMeEffectPreparation("message.send")!;
      await prepared.beforeDispatch(first.fence.action);
      retained();
      first.state.active = false;
      expect(retained).toThrow("revoked");
      expect(ordinary).not.toThrow();
    });
    await withMiniMeEffectScope(scopeFixture().fence, async () => {
      expect(retained).toThrow("scope is closed");
      expect(captureAgentToolSourceExecutionGuard()).not.toThrow();
    });
    expect(captureMiniMeEffectAssertion()).toBeUndefined();
  });

  it("cannot replace inherited authority with a nested active scope", async () => {
    const outer = scopeFixture();
    await withMiniMeEffectScope(outer.fence, async () => {
      outer.state.active = false;
      await expect(withMiniMeEffectScope(scopeFixture().fence, async () => {})).rejects.toThrow(
        "revoked",
      );
    });
  });

  it("allows one final effect shape and rejects the wrong effect owner", async () => {
    const fixture = scopeFixture();
    await withMiniMeEffectScope(fixture.fence, async () => {
      expect(() => captureMiniMeEffectPreparation("workspace.edit")).toThrow("does not own");
      const preparation = captureMiniMeEffectPreparation("message.send")!;
      await preparation.beforeDispatch(fixture.fence.action);
      await expect(preparation.beforeDispatch(fixture.fence.action)).rejects.toThrow("one effect");
      expect(fixture.fence.beforeDispatch).toHaveBeenCalledOnce();
    });
  });

  it("keeps concurrent runs isolated across an awaited preparation", async () => {
    const first = scopeFixture();
    const second = scopeFixture();
    const entered = createDeferred();
    const release = createDeferred();
    const pending = withMiniMeEffectScope(first.fence, async () => {
      const guard = captureAgentToolSourceExecutionGuard();
      entered.resolve();
      await release.promise;
      expect(guard).toThrow("revoked");
    });
    await awaitGateBeforeSettlement(entered.promise, pending, "First run did not enter.");
    await withMiniMeEffectScope(second.fence, async () => {
      first.state.active = false;
      expect(captureAgentToolSourceExecutionGuard()).not.toThrow();
      release.resolve();
      await pending;
      expect(captureAgentToolSourceExecutionGuard()).not.toThrow();
    });
  });
});
