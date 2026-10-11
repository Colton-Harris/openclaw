import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import {
  MiniMePredictionSchema,
  type MiniMeChoice,
  type MiniMePrediction,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import type { AnyAgentTool } from "../agents/agent-tools.types.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { isValidMiniMeChoice } from "./choice.js";
import type { createMiniMeDelegationOwner } from "./delegation.js";
import type {
  MiniMeDelegationAction,
  MiniMeDelegationAuthority,
  MiniMeDelegationExecution,
  MiniMeDelegationQualification,
  MiniMeRestoreCustody,
} from "./delegation.types.js";
import { executeMiniMeHostTool, prepareMiniMeWorkspaceAction } from "./effect-execution.js";
import { miniMeMessageResource } from "./effect-scope.js";

export type MiniMeChoiceCandidate = Readonly<
  { optionId: string } & (
    | { effect: "workspace.edit"; relativePath: string; content: string }
    | {
        effect: "message.send";
        channel: string;
        accountId: string;
        to: string;
        threadId?: string;
        text: string;
      }
  )
>;

/** Bound once by the host to the original owner's private admitted run. */
export type MiniMeConsultationBinding = Readonly<{
  authority: MiniMeDelegationAuthority;
  workspaceDir: string;
  predict: (choice: MiniMeChoice) => Promise<MiniMePrediction>;
  /** Uses current stored belief/source provenance, never provider-authored classifications. */
  qualifyEvidence: (prediction: MiniMePrediction) => MiniMeDelegationQualification["evidence"];
  /** The final policy-filtered, approval-wrapped surface of this admitted run. */
  getAdmittedTool: (name: "write" | "message") => AnyAgentTool | undefined;
  /** Preimage custody for admitted edits; see MiniMeRestoreCustody for each call's authority. */
  actionRestore?: Readonly<{
    /** Called only at an admitted edit's dispatch fence, before reservation consumption. */
    record: (input: {
      actionId: string;
      resource: string;
      before: { utf8: string; sha256: string };
      afterSha256: string;
      createdAt: number;
      assertCurrent: () => void;
    }) => Promise<{ receiptId: string }>;
    /** Called only once that dispatch is known never admitted, even after revocation. */
    release: (input: { actionId: string }) => Promise<void>;
  }>;
}>;

export type MiniMeConsultationResult =
  | { kind: "advice" | "pending-owner" | "existing"; prediction: MiniMePrediction; reason: string }
  | {
      kind: "executed";
      prediction: MiniMePrediction;
      restoreReceiptId?: string;
      execution: MiniMeDelegationExecution<Awaited<ReturnType<AnyAgentTool["execute"]>>>;
    };

export type MiniMeToolConsultation = (input: {
  toolCallId: string;
  choice: MiniMeChoice;
  candidates: MiniMeChoiceCandidate[];
  signal?: AbortSignal;
}) => Promise<MiniMeConsultationResult>;

/** Structured choice consultation; ordinary tool calls never enter this owner. */
export function createMiniMeConsultation(input: {
  owner: ReturnType<typeof createMiniMeDelegationOwner>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  return async (params: {
    binding: MiniMeConsultationBinding;
    actionId: string;
    choice: MiniMeChoice;
    candidates: readonly MiniMeChoiceCandidate[];
    signal?: AbortSignal;
  }): Promise<MiniMeConsultationResult> => {
    const binding = params.binding;
    const actionId = params.actionId;
    const signal = params.signal;
    const choice = freezeJsonSnapshot(structuredClone(params.choice));
    const candidates = freezeJsonSnapshot(structuredClone(params.candidates));
    const assertCurrent = () => {
      signal?.throwIfAborted();
      binding.authority.assertCurrent();
    };
    assertCurrent();
    if (!isValidMiniMeChoice(choice)) {
      throw new Error("Mini Me requires a bounded choice with distinct options");
    }
    const prediction = freezeJsonSnapshot(structuredClone(await binding.predict(choice)));
    assertCurrent();
    if (
      !Value.Check(MiniMePredictionSchema, prediction) ||
      !isDeepStrictEqual(prediction.choice, choice) ||
      prediction.agentId !== binding.authority.scope.targetAgentId ||
      prediction.profileGeneration !== binding.authority.scope.profileGeneration
    ) {
      throw new Error("Mini Me prediction does not match this admitted structured choice.");
    }
    const matches = candidates.filter((candidate) => candidate.optionId === prediction.optionId);
    const selected = matches.length === 1 ? matches[0] : undefined;
    const attachment = binding.authority.readAttachment();
    const actions: Array<{
      optionId: string;
      action: MiniMeDelegationAction;
      qualification: MiniMeDelegationQualification;
    }> = [];
    let tool: AnyAgentTool | undefined;
    let args: Record<string, unknown> | undefined;
    let restore: MiniMeRestoreCustody | undefined;
    if (selected && attachment?.mode !== "dont-decide") {
      const evidence = binding.qualifyEvidence(prediction);
      if (selected.effect === "workspace.edit") {
        tool = binding.getAdmittedTool("write");
        if (!tool) {
          const frozen = await input.owner.prepare({
            authority: binding.authority,
            actionId,
            prediction,
            actions: [],
          });
          return {
            kind: "pending-owner",
            prediction: frozen.prediction,
            reason: "The current agent has no admitted workspace-write tool.",
          };
        }
        const workspace = await prepareMiniMeWorkspaceAction({
          workspaceDir: binding.workspaceDir,
          relativePath: selected.relativePath,
          content: selected.content,
          assertCurrent,
        });
        assertCurrent();
        const actionRestore = binding.actionRestore;
        // The delegation owner records only at the dispatch fence of an admitted edit and
        // releases only after that dispatch is known never admitted.
        restore = actionRestore
          ? {
              record: (assertCustody) =>
                actionRestore.record({
                  actionId,
                  resource: workspace.action.resource,
                  before: workspace.preimage,
                  afterSha256: workspace.afterSha256,
                  createdAt: now(),
                  assertCurrent: () => {
                    assertCurrent();
                    assertCustody();
                  },
                }),
              // Deliberately not gated on this request's signal or authority.
              release: () => actionRestore.release({ actionId }),
            }
          : undefined;
        actions.push({
          optionId: selected.optionId,
          action: workspace.action,
          qualification: {
            supported: true,
            impact: workspace.impact,
            reversible: restore !== undefined,
            evidence,
          },
        });
        args = { path: workspace.absolutePath, content: selected.content };
      } else {
        actions.push({
          optionId: selected.optionId,
          action: {
            effect: "message.send",
            resource: miniMeMessageResource(selected),
            text: selected.text,
          },
          qualification: { supported: false, impact: "other", reversible: false, evidence },
        });
      }
    }
    assertCurrent();
    const prepared = await input.owner.prepare({
      authority: binding.authority,
      actionId,
      prediction,
      actions,
      restore,
    });
    if (prepared.kind !== "delegated") {
      return prepared.kind === "existing"
        ? {
            kind: "existing",
            prediction: prepared.prediction,
            reason: `This choice already has a ${prepared.state} reservation.`,
          }
        : prepared;
    }
    if (!tool || !args) {
      await input.owner.cancel(prepared.capability);
      throw new Error("Mini Me lost the admitted effect route.");
    }
    const execution = await input.owner.execute(prepared.capability, (fence) =>
      executeMiniMeHostTool({ fence, tool, args, toolCallId: actionId, signal }),
    );
    return {
      kind: "executed",
      prediction: prepared.prediction,
      restoreReceiptId: execution.restoreReceiptId,
      execution,
    };
  };
}
