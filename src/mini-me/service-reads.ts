import type * as M from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { isValidMiniMeChoice } from "./choice.js";
import { normalizeMiniMeValue } from "./learning.js";
import { miniMeOperationFingerprint, MiniMePersistenceError } from "./persistence.js";
import { miniMeStage } from "./service-operation.js";
import type { MiniMeServiceDependencies, MiniMeServiceContext } from "./service.types.js";

/** Read lifetimes hold owner consent while serving content or freezing advisory predictions. */
export function createMiniMeReadOperations(
  deps: MiniMeServiceDependencies,
  context: MiniMeServiceContext,
) {
  const ownerId = deps.ownerId;
  const { scope, snapshot, requireProfile } = context;
  return {
    get: () =>
      deps.lifecycle.read(deps.assertCurrent, ({ assertCurrent }) => snapshot(assertCurrent)),
    availableSources: () =>
      deps.lifecycle.read(deps.assertCurrent, ({ assertCurrent }) =>
        deps.availableSources(assertCurrent),
      ),
    export: () =>
      deps.lifecycle.read(
        deps.assertCurrent,
        async ({ assertCurrent }): Promise<M.MiniMeExportResult> => ({
          format: "openclaw-mini-me-v1",
          exportedAt: Date.now(),
          snapshot: await snapshot(assertCurrent, true),
        }),
      ),
    history: (cursor?: string) =>
      deps.lifecycle.read(
        deps.assertCurrent,
        async ({ assertCurrent }): Promise<M.MiniMeHistoryResult> => {
          const { profile, pendingDataChanges } = await requireProfile(deps.state(assertCurrent));
          if (pendingDataChanges.length) {
            throw new Error("Mini Me source removal is pending");
          }
          const result = await deps.withContent(profile, assertCurrent, (store) =>
            store.history({ scope: scope(profile), cursor }),
          );
          return {
            beliefs: result.beliefs,
            predictions: result.predictions,
            outcomes: result.outcomes,
            cursor: result.historyCursor,
          };
        },
      ),
    actions: (cursor?: string) =>
      deps.lifecycle.read(
        deps.assertCurrent,
        async ({ assertCurrent }): Promise<M.MiniMeActionsResult> => {
          const { profile, pendingDataChanges } = await requireProfile(deps.state(assertCurrent));
          if (pendingDataChanges.length || profile.lifecycle === "deleting") {
            throw new Error("Mini Me removal is pending");
          }
          const result = await deps.withContent(profile, assertCurrent, (store) =>
            store.readActionRestores({ scope: scope(profile), cursor }),
          );
          return {
            receipts: result.receipts.map(({ before: _before, ...receipt }) => receipt),
            cursor: result.cursor,
          };
        },
      ),
    action: (receiptId: string) =>
      deps.lifecycle.read(
        deps.assertCurrent,
        async ({ assertCurrent }): Promise<M.MiniMeActionGetResult> => {
          const { profile, pendingDataChanges } = await requireProfile(deps.state(assertCurrent));
          if (pendingDataChanges.length || profile.lifecycle === "deleting") {
            throw new Error("Mini Me removal is pending");
          }
          const result = await deps.withContent(profile, assertCurrent, (store) =>
            store.readActionRestore({ scope: scope(profile), receiptId }),
          );
          if (!result) {
            throw new MiniMePersistenceError("not-found", "Saved file version is unavailable");
          }
          const { before, ...receipt } = result;
          return { receipt, before };
        },
      ),
    predict: (params: M.MiniMePredictParams) =>
      deps.lifecycle.read(deps.assertCurrent, async (lifetime) => {
        const state = deps.state(lifetime.assertCurrent);
        const { profile, attachments, pendingDataChanges } = await requireProfile(state);
        if (profile.lifecycle !== "active" || pendingDataChanges.length) {
          throw new Error("Mini Me is not active");
        }
        if (params.agentId && !attachments.some((item) => item.agentId === params.agentId)) {
          throw new Error("Agent is not attached to your Mini Me");
        }
        if (!isValidMiniMeChoice(params.choice)) {
          throw new MiniMePersistenceError("invalid", "Mini Me requires distinct choice options");
        }
        const root = await state.beginOperation({
          scope: scope(profile),
          operationId: params.operationId,
          kind: "predict",
          requestFingerprint: miniMeOperationFingerprint(params),
        });
        return deps.withContent(profile, lifetime.assertCurrent, async (store) => {
          const predictionId = miniMeStage(params.operationId, "prediction");
          const prior = await store.readExactPrediction({ scope: scope(profile), predictionId });
          if (prior) {
            await deps.project(profile, store, lifetime.assertCurrent);
            await state.finishOperation({
              scope: scope(profile),
              operationId: params.operationId,
              kind: "predict",
              requestFingerprint: miniMeOperationFingerprint(params),
              predictionId,
            });
            return prior;
          }
          const content = await store.readSnapshot(scope(profile));
          const beliefs = await store.readBeliefs({
            scope: scope(profile),
            topic: normalizeMiniMeValue(params.choice.scope),
          });
          const prediction = await deps.predict(
            profile,
            {
              id: predictionId,
              agentId: params.agentId ?? null,
              choice: params.choice,
              beliefs,
              profileGeneration: profile.generation,
              contentRevision: content.contentRevision,
              now: root.createdAt,
            },
            lifetime,
          );
          await store.freezePrediction({
            scope: scope(profile),
            operationId: miniMeStage(params.operationId, "freeze"),
            prediction,
          });
          await deps.project(profile, store, lifetime.assertCurrent);
          await state.finishOperation({
            scope: scope(profile),
            operationId: params.operationId,
            kind: "predict",
            requestFingerprint: miniMeOperationFingerprint(params),
            predictionId,
          });
          return prediction;
        });
      }),
    operation: (operationId: string) =>
      deps.lifecycle.read(
        deps.assertCurrent,
        async ({ assertCurrent }): Promise<M.MiniMeOperationGetResult> => {
          const state = deps.state(assertCurrent);
          const current = await state.read(ownerId);
          const receipt = await state.operationLookup({ ownerId, operationId });
          if (!receipt) {
            return { status: "unknown" };
          }
          if (receipt.state !== "complete") {
            return { status: "pending" };
          }
          if (
            receipt.predictionId &&
            current &&
            current.profile.id === receipt.miniMeId &&
            !current.pendingDataChanges.length
          ) {
            const prediction = await deps.withContent(current.profile, assertCurrent, (store) =>
              store.readExactPrediction({
                scope: scope(current.profile),
                predictionId: receipt.predictionId!,
              }),
            );
            if (prediction) {
              return { status: "completed", prediction };
            }
          }
          return { status: "completed" };
        },
      ),
  };
}
