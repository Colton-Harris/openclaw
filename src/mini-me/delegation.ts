import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import {
  MiniMePredictionSchema,
  type MiniMeAttachment,
  type MiniMeGrant,
  type MiniMePrediction,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type {
  MiniMeDelegationAction,
  MiniMeDelegationAuthority,
  MiniMeDelegationExecution,
  MiniMeDelegationFence,
  MiniMeDelegationPreparation,
  MiniMeDelegationQualification,
  MiniMeDelegationReservationRef,
  MiniMeDelegationStore,
  MiniMeEffectResult,
  MiniMePreparedDelegation,
  MiniMeRestoreCustody,
} from "./delegation.types.js";

type PreparedRecord = {
  ref: MiniMeDelegationReservationRef;
  action: MiniMeDelegationAction;
  fingerprint: string;
  assertCurrent: () => void;
  restore?: MiniMeRestoreCustody;
  phase: "prepared" | "executing" | "closed";
};

function fingerprint(action: MiniMeDelegationAction): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        action.effect === "workspace.edit"
          ? [action.effect, action.resource, action.expectedContentHash, action.content]
          : [action.effect, action.resource, action.text],
      ),
    )
    .digest("hex");
}

function actionBytes(action: MiniMeDelegationAction): number {
  return Buffer.byteLength(action.effect === "workspace.edit" ? action.content : action.text);
}

function modeRefusal(
  attachment: MiniMeAttachment,
  action: MiniMeDelegationAction,
  qualification: MiniMeDelegationQualification,
  prediction: MiniMePrediction,
): string | undefined {
  if (attachment.mode === "dont-decide") {
    return "Mini Me is advisory in Don't decide mode.";
  }
  if (!qualification.supported) {
    return "This action has no qualified host execution route.";
  }
  if (!prediction.evidence.length || qualification.evidence === "conflicting") {
    return "The choice lacks nonconflicting grounding.";
  }
  if (
    attachment.mode === "safe" &&
    (action.effect !== "workspace.edit" ||
      qualification.impact !== "low" ||
      !qualification.reversible ||
      qualification.evidence !== "explicit" ||
      prediction.uncertainty !== "low")
  ) {
    return "Decide safe requires a reversible, low-impact edit and clear explicit evidence.";
  }
  if (
    attachment.mode === "auto" &&
    (qualification.evidence === "uncertain" || prediction.uncertainty === "high")
  ) {
    return "Decide auto requires qualified evidence for this choice.";
  }
  return undefined;
}

/**
 * Owns only Mini Me delegation. Direct tool calls retain their ordinary authority.
 * Callers are host services: neither a provider result nor an RPC body supplies
 * authority, classifications, an executor, or a capability to this owner.
 */
export function createMiniMeDelegationOwner(input: {
  store: MiniMeDelegationStore;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const store = input.store;
  const issued = new WeakMap<object, PreparedRecord>();

  const requireRecord = (capability: unknown): PreparedRecord => {
    const record =
      capability && typeof capability === "object" ? issued.get(capability) : undefined;
    if (!record || record.phase !== "prepared") {
      throw new Error("Mini Me delegation capability is invalid or already used.");
    }
    return record;
  };

  async function prepare(params: {
    authority: MiniMeDelegationAuthority;
    actionId: string;
    prediction: MiniMePrediction;
    actions: readonly Readonly<{
      optionId: string;
      action: MiniMeDelegationAction;
      qualification: MiniMeDelegationQualification;
    }>[];
    /** Custody for the selected edit; recorded only when that edit reaches dispatch. */
    restore?: MiniMeRestoreCustody;
  }): Promise<MiniMeDelegationPreparation> {
    const scope = freezeJsonSnapshot(structuredClone(params.authority.scope));
    const actionId = params.actionId;
    const actions = freezeJsonSnapshot(structuredClone(params.actions));
    const restore = params.restore;
    const assertAuthority = params.authority.assertCurrent;
    const readAttachment = params.authority.readAttachment;
    const assertAttachment = () => {
      assertAuthority();
      const attachment = readAttachment();
      if (
        !attachment ||
        attachment.agentId !== scope.targetAgentId ||
        attachment.revision !== scope.attachmentRevision
      ) {
        throw new Error("Mini Me attachment authority changed.");
      }
      return attachment;
    };
    assertAttachment();
    if (!Value.Check(MiniMePredictionSchema, params.prediction)) {
      throw new Error("Mini Me predictions must satisfy the advisory prediction contract.");
    }
    const prediction = freezeJsonSnapshot(structuredClone(params.prediction));
    if (
      !actionId ||
      prediction.agentId !== scope.targetAgentId ||
      prediction.profileGeneration !== scope.profileGeneration
    ) {
      throw new Error("Mini Me prediction does not belong to the admitted attachment.");
    }
    await store.freezePrediction({ scope, prediction, assertCurrent: assertAttachment });
    const attachment = assertAttachment();
    const optionId = prediction.optionId;
    const selected = actions.filter((option) => option.optionId === optionId);
    const selectedAction = selected[0];
    if (
      optionId === null ||
      prediction.choice.options.filter((option) => option.id === optionId).length !== 1 ||
      selected.length !== 1 ||
      !selectedAction
    ) {
      return {
        kind: "advice",
        prediction,
        reason: "No unambiguous executable choice was selected.",
      };
    }
    const action = freezeJsonSnapshot(structuredClone(selectedAction.action));
    // Reversibility is a promise this owner keeps at dispatch, never a caller claim alone.
    const qualification = freezeJsonSnapshot({
      ...structuredClone(selectedAction.qualification),
      reversible: selectedAction.qualification.reversible && restore !== undefined,
    });
    const refusal = modeRefusal(attachment, action, qualification, prediction);
    if (refusal) {
      return {
        kind: attachment.mode === "dont-decide" ? "advice" : "pending-owner",
        prediction,
        reason: refusal,
      };
    }
    const bytes = actionBytes(action);
    const grant = attachment.grants.find(
      (candidate) =>
        candidate.effect === action.effect &&
        candidate.resources.includes(action.resource) &&
        candidate.expiresAt > now() &&
        (candidate.maxBytes === undefined || candidate.maxBytes >= bytes),
    );
    if (!grant) {
      return {
        kind: "pending-owner",
        prediction,
        reason: "No current grant covers this exact action.",
      };
    }
    const capturedGrant: MiniMeGrant = freezeJsonSnapshot(structuredClone(grant));
    const assertCurrent = () => {
      const current = assertAttachment();
      const currentGrant = current.grants.find((candidate) => candidate.id === capturedGrant.id);
      if (
        now() >= capturedGrant.expiresAt ||
        !isDeepStrictEqual(currentGrant, capturedGrant) ||
        modeRefusal(current, action, qualification, prediction)
      ) {
        throw new Error("Mini Me action authority was revoked or expired.");
      }
    };
    assertCurrent();
    const actionFingerprint = fingerprint(action);
    const reservation = await store.reserve({
      scope,
      actionId,
      predictionId: prediction.id,
      optionId,
      grant: capturedGrant,
      action: {
        effect: action.effect,
        resource: action.resource,
        fingerprint: actionFingerprint,
        bytes,
      },
      assertCurrent,
    });
    if (reservation.kind === "existing") {
      assertCurrent();
      return { kind: "existing", prediction, state: reservation.state };
    }
    if (reservation.kind === "denied") {
      assertCurrent();
      return { kind: "pending-owner", prediction, reason: reservation.reason };
    }
    const ref = { scope, actionId, reservationId: reservation.reservationId };
    try {
      assertCurrent();
    } catch (error) {
      await store.settle({ ...ref, state: "not-dispatched" });
      throw error;
    }
    const capability: MiniMePreparedDelegation = Object.freeze({ kind: "mini-me-delegation" });
    issued.set(capability, {
      ref,
      action,
      fingerprint: actionFingerprint,
      assertCurrent,
      restore: qualification.reversible ? restore : undefined,
      phase: "prepared",
    });
    return { kind: "delegated", capability, prediction };
  }

  async function execute<T>(
    capability: unknown,
    executeEffect: (fence: MiniMeDelegationFence) => Promise<MiniMeEffectResult<T>>,
  ): Promise<MiniMeDelegationExecution<T>> {
    const record = requireRecord(capability);
    // Take custody synchronously: concurrent callers cannot both enter the executor.
    record.phase = "executing";
    const dispatch: { state: "not-started" | "pending" | "consumed" | "denied" } = {
      state: "not-started",
    };
    let consumption: Promise<void> | undefined;
    let custodyBegun = false;
    let restoreReceiptId: string | undefined;
    const assertExecutionCurrent = () => {
      if (record.phase !== "executing") {
        throw new Error("Mini Me effect execution is closed.");
      }
      record.assertCurrent();
    };
    const assertCurrent = () => {
      assertExecutionCurrent();
      if (dispatch.state !== "consumed") {
        throw new Error("Mini Me effect dispatch has not been admitted.");
      }
    };
    const fence: MiniMeDelegationFence = Object.freeze({
      action: record.action,
      assertPreparing: assertExecutionCurrent,
      assertCurrent,
      beforeDispatch: async (action) => {
        assertExecutionCurrent();
        if (fingerprint(action) !== record.fingerprint) {
          throw new Error("Mini Me action changed after delegation.");
        }
        consumption ??= (async () => {
          // Custody follows host preparation (approval, hooks, final shape) so abandoned
          // work leaves no receipt, and precedes admission so no edit runs without it.
          if (record.restore) {
            // Set before the write: a lost acknowledgment may still leave committed bytes.
            custodyBegun = true;
            const receipt = await record.restore.record(assertExecutionCurrent);
            assertExecutionCurrent();
            if (!receipt.receiptId) {
              throw new Error("Mini Me could not confirm restorable preimage custody.");
            }
            restoreReceiptId = receipt.receiptId;
          }
          dispatch.state = "pending";
          const result = await store.consume({
            ...record.ref,
            assertCurrent: assertExecutionCurrent,
          });
          if (result.kind !== "consumed") {
            dispatch.state = result.kind === "denied" ? "denied" : "pending";
            throw new Error("Mini Me reservation cannot dispatch this action.");
          }
          dispatch.state = "consumed";
        })();
        await consumption;
        assertCurrent();
      },
    });
    let outcome: MiniMeDelegationExecution<T>["outcome"];
    try {
      assertExecutionCurrent();
      const result = await executeEffect(fence);
      // Join consumption even if a host adapter incorrectly returned before its fence.
      await consumption;
      if (dispatch.state === "not-started" || dispatch.state === "denied") {
        outcome = { state: "not-dispatched", reason: "No effect dispatch was admitted." };
      } else if (dispatch.state === "pending") {
        outcome = { state: "unknown", reason: "Effect dispatch admission was not confirmed." };
      } else {
        outcome = result;
      }
    } catch {
      // A callback failure must not leave its write-capable consumption running at settlement.
      await consumption?.catch(() => undefined);
      outcome =
        dispatch.state === "not-started" || dispatch.state === "denied"
          ? { state: "not-dispatched", reason: "Execution ended before effect dispatch." }
          : { state: "unknown", reason: "Execution ended without a confirmed effect outcome." };
    } finally {
      record.phase = "closed";
    }
    let settlement: MiniMeDelegationExecution<T>["settlement"];
    try {
      await store.settle({ ...record.ref, state: outcome.state });
      settlement = { state: "recorded" };
    } catch (error) {
      settlement = { state: "unconfirmed", error };
    }
    // Only "not-dispatched" (consume never called or explicitly denied) proves the edit
    // never ran; consumed, failed, and unknown attempts keep their preimage. Settlement
    // failure does not weaken that local proof, and the capability is already closed.
    let restoreRelease: MiniMeDelegationExecution<T>["restoreRelease"];
    if (custodyBegun && outcome.state === "not-dispatched" && record.restore) {
      try {
        await record.restore.release();
        restoreRelease = { state: "released" };
        restoreReceiptId = undefined;
      } catch (error) {
        restoreRelease = { state: "unconfirmed", error };
      }
    }
    return {
      outcome,
      settlement,
      ...(restoreReceiptId === undefined ? {} : { restoreReceiptId }),
      ...(restoreRelease === undefined ? {} : { restoreRelease }),
    };
  }

  async function cancel(capability: unknown): Promise<void> {
    const record = requireRecord(capability);
    record.phase = "closed";
    await store.settle({ ...record.ref, state: "not-dispatched" });
  }

  return { prepare, execute, cancel };
}
