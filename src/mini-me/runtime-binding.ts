import { isDeepStrictEqual } from "node:util";
import type {
  MiniMeBelief,
  MiniMePrediction,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { AnyAgentTool } from "../agents/agent-tools.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { isValidMiniMeChoice } from "./choice.js";
import { createMiniMeConsultation, type MiniMeToolConsultation } from "./consultation.js";
import { createMiniMeDelegationOwner } from "./delegation.js";
import { projectMiniMeDocuments } from "./documents.js";
import {
  assertMiniMeProfileGeneration,
  miniMeHostState,
  miniMeLifecycleForOwner,
  withMiniMeContent,
} from "./host-storage.js";
import { miniMeOperationFingerprint } from "./persistence.js";
import { readActiveMiniMeAttachment } from "./private-agent-projection.js";
import { predictMiniMeWithProvider } from "./providers.js";
import { retainMiniMeConversation } from "./sources.js";

/** Only the original admitted owner's private run can obtain this host callback. */
export async function bindMiniMeForRun(input: {
  admittedRunContext: AdmittedRunContext;
  config: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir: string;
  signal?: AbortSignal;
  assertCurrent(this: void): void;
  getAdmittedTool(name: "write" | "message"): AnyAgentTool | undefined;
}): Promise<MiniMeToolConsultation | undefined> {
  input.assertCurrent();
  const operator = readAdmittedRunOperatorAuthority(input.admittedRunContext);
  if (!operator || !input.sessionKey) {
    return undefined;
  }
  const ownerId = operator.profileId;
  const assertRun = () => {
    input.assertCurrent();
    input.signal?.throwIfAborted();
    operator.assertCurrent();
    if (readAdmittedRunOperatorAuthority(input.admittedRunContext) !== operator) {
      throw new Error("Mini Me original run authority changed");
    }
  };
  const sourceInput = {
    ownerId,
    sessionKey: input.sessionKey,
    getConfig: () => input.config,
    assertCurrent: assertRun,
  };
  const readBindableAttachment = async () => {
    const found = readActiveMiniMeAttachment(ownerId, input.agentId);
    if (!found) {
      return undefined;
    }
    // A shared or system run keeps its ordinary tools, without exposing private Mini Me context.
    const initialSource = await retainMiniMeConversation(sourceInput).catch(() => undefined);
    assertRun();
    if (!initialSource) {
      return undefined;
    }
    initialSource.release();
    const initial = await miniMeHostState(assertRun).read(ownerId, found.miniMeId);
    assertRun();
    if (!initial || initial.profile.lifecycle !== "active" || initial.pendingDataChanges.length) {
      return undefined;
    }
    assertMiniMeProfileGeneration(ownerId, initial.profile);
    return found;
  };
  // Configure, attach and learn retire the projection while attached assistants build tools.
  // Unavailable Mini Me state removes only this tool; original run or owner revocation still fails.
  const metadata = await readBindableAttachment().catch(() => {
    assertRun();
    return undefined;
  });
  if (!metadata) {
    return undefined;
  }

  return async (request) => {
    assertRun();
    if (!isValidMiniMeChoice(request.choice)) {
      throw new Error("Mini Me requires a bounded choice with distinct options");
    }
    const retained = await retainMiniMeConversation(sourceInput);
    try {
      return await miniMeLifecycleForOwner(ownerId).read(assertRun, async (lifetime) => {
        const signal = AbortSignal.any([
          lifetime.signal,
          ...[input.signal, request.signal].filter(
            (item): item is AbortSignal => item !== undefined,
          ),
        ]);
        const assertSource = () => {
          lifetime.assertCurrent();
          signal.throwIfAborted();
          retained.assertCurrent();
        };
        const state = miniMeHostState(assertSource);
        const found = await state.read(ownerId, metadata.miniMeId);
        if (!found || found.profile.lifecycle !== "active" || found.pendingDataChanges.length) {
          throw new Error("Mini Me is unavailable for this run");
        }
        const profile = found.profile;
        const attachment = found.attachments.find((item) => item.agentId === input.agentId);
        if (!attachment) {
          throw new Error("This agent is no longer attached to Mini Me");
        }
        const assertCurrent = () => {
          assertSource();
          assertMiniMeProfileGeneration(ownerId, profile);
          const current = readActiveMiniMeAttachment(ownerId, input.agentId);
          if (
            !current ||
            current.miniMeId !== profile.id ||
            current.profileGeneration !== profile.generation ||
            current.attachmentRevision !== attachment.revision
          ) {
            throw new Error("Mini Me attachment permissions changed");
          }
        };
        assertCurrent();
        const scope = {
          ownerId,
          miniMeId: profile.id,
          targetAgentId: input.agentId,
          profileGeneration: profile.generation,
          attachmentRevision: attachment.revision,
        };
        const contentScope = {
          ownerId,
          miniMeId: profile.id,
          agentId: profile.agentId,
          generation: profile.generation,
        };
        const actionId = miniMeOperationFingerprint([
          input.admittedRunContext.operationalRunInstance.instanceId,
          request.toolCallId,
        ]);
        const predictionId = miniMeOperationFingerprint([actionId, "prediction"]);
        const requestFingerprint = miniMeOperationFingerprint({
          choice: request.choice,
          candidates: request.candidates,
          agentId: input.agentId,
        });
        const operation = await state.beginOperation({
          scope,
          operationId: actionId,
          kind: "runtime.consult",
          requestFingerprint,
        });
        assertCurrent();
        // Settlement can close an already admitted reservation after requester revocation.
        // It cannot create an action, change its scope, or refund an unknown dispatch.
        const physical = captureOpenClawStateWorkerContext();
        const settlementState = miniMeHostState(physical.admission.assertCurrent);
        return withMiniMeContent(profile, assertCurrent, async (content, custody) => {
          let beliefs: MiniMeBelief[] = [];
          let frozen: MiniMePrediction | undefined;
          const delegation = createMiniMeDelegationOwner({
            store: {
              async freezePrediction(params) {
                assertCurrent();
                params.assertCurrent();
                if (!frozen || !isDeepStrictEqual(frozen, params.prediction)) {
                  throw new Error("Mini Me delegation requires this exact frozen prediction");
                }
              },
              reserve: ({ assertCurrent: assertion, ...params }) => {
                assertCurrent();
                assertion();
                return miniMeHostState(() => {
                  assertCurrent();
                  assertion();
                }).reserve(params);
              },
              consume: ({ assertCurrent: assertion, ...params }) => {
                assertCurrent();
                assertion();
                return miniMeHostState(() => {
                  assertCurrent();
                  assertion();
                }).consume(params);
              },
              async settle(params) {
                await settlementState.settle(params);
              },
            },
          });
          const consult = createMiniMeConsultation({ owner: delegation });
          const result = await consult({
            actionId,
            choice: request.choice,
            candidates: request.candidates,
            signal,
            binding: {
              authority: {
                scope,
                assertCurrent,
                readAttachment: () => {
                  assertCurrent();
                  return attachment;
                },
              },
              workspaceDir: input.workspaceDir,
              getAdmittedTool: (name) => input.getAdmittedTool(name),
              async predict(choice) {
                assertCurrent();
                const prior = await content.readExactPrediction({
                  scope: contentScope,
                  predictionId,
                });
                if (prior) {
                  if (
                    !isDeepStrictEqual(prior.choice, choice) ||
                    prior.profileGeneration !== profile.generation ||
                    prior.agentId !== input.agentId
                  ) {
                    throw new Error(
                      "Mini Me consultation cannot replay against changed consent or choice",
                    );
                  }
                  frozen = prior;
                  beliefs = await content.readBeliefs({ scope: contentScope, topic: choice.scope });
                  return prior;
                }
                const snapshot = await content.readSnapshot(contentScope);
                beliefs = await content.readBeliefs({ scope: contentScope, topic: choice.scope });
                const prediction = await predictMiniMeWithProvider(
                  {
                    ownerId,
                    profile,
                    config: input.config,
                    operatorAuthority: operator,
                    signal,
                    assertCurrent,
                  },
                  {
                    id: predictionId,
                    agentId: input.agentId,
                    choice,
                    beliefs,
                    profileGeneration: profile.generation,
                    contentRevision: snapshot.contentRevision,
                    now: operation.createdAt,
                  },
                );
                assertCurrent();
                await content.freezePrediction({
                  scope: contentScope,
                  operationId: miniMeOperationFingerprint([actionId, "freeze"]),
                  prediction,
                });
                frozen = prediction;
                return prediction;
              },
              qualifyEvidence(prediction) {
                if (!prediction.optionId || prediction.uncertainty === "high") {
                  return "uncertain";
                }
                const used = beliefs.filter((belief) => prediction.beliefIds.includes(belief.id));
                if (
                  !used.length ||
                  used.length !== prediction.beliefIds.length ||
                  used.some((belief) => belief.status !== "active")
                ) {
                  return "uncertain";
                }
                return prediction.provider === "explicit-preference-baseline" &&
                  prediction.uncertainty === "low" &&
                  used.every(
                    (belief) => belief.origin === "direct" || belief.origin === "correction",
                  )
                  ? "explicit"
                  : "qualified-inference";
              },
              actionRestore: {
                record: async ({ assertCurrent: assertion, ...params }) => {
                  assertCurrent();
                  assertion();
                  return content.recordActionRestore({
                    ...params,
                    scope: contentScope,
                    targetAgentId: input.agentId,
                    operationId: miniMeOperationFingerprint([actionId, "preimage"]),
                  });
                },
                // The delegation owner calls this only for its own known never-dispatched
                // action; scope and action ID are fixed here, never caller-supplied.
                release: async (params) => {
                  if (params.actionId !== actionId) {
                    throw new Error("Mini Me preimage release targets another action");
                  }
                  await custody.releaseActionRestore(ownerId, actionId);
                },
              },
            },
          });
          assertCurrent();
          if (
            result.kind === "executed" &&
            result.execution.outcome.state === "succeeded" &&
            result.prediction.optionId
          ) {
            await content.appendOutcome({
              scope: contentScope,
              operationId: miniMeOperationFingerprint([actionId, "delegated-outcome"]),
              outcome: {
                id: miniMeOperationFingerprint([actionId, "outcome"]),
                predictionId,
                optionId: result.prediction.optionId,
                origin: "delegated",
                matched: true,
                correctionId: null,
                createdAt: Date.now(),
              },
            });
          }
          await projectMiniMeDocuments({
            ownerId,
            profile,
            store: content,
            workspaceDir: resolveAgentWorkspaceDir(input.config, profile.agentId),
            assertCurrent,
          });
          await state.finishOperation({
            scope,
            operationId: actionId,
            kind: "runtime.consult",
            requestFingerprint,
            predictionId,
          });
          return result;
        });
      });
    } finally {
      retained.release();
    }
  };
}
