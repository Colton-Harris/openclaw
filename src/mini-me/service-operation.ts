import type * as M from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { miniMeOperationFingerprint, MiniMePersistenceError } from "./persistence.js";
import type {
  MiniMeServiceDependencies,
  MiniMeServiceContext,
  MiniMeMutationContext as MutationContext,
  MiniMePreflightContext as PreflightContext,
} from "./service.types.js";

/** Stable stage IDs separate a terminal request receipt from its recoverable commits. */
export function miniMeStage(operationId: string, stage: string): string {
  return miniMeOperationFingerprint([operationId, stage]);
}

/** One mutation owner controls replay, preflight, commits and completion across stores. */
export function createMiniMeMutation(
  deps: MiniMeServiceDependencies,
  context: MiniMeServiceContext,
) {
  const ownerId = deps.ownerId;
  const { scope, snapshot, requireProfile } = context;
  return async function mutate(
    kind: string,
    params: { operationId: string; [key: string]: unknown },
    apply: (context: MutationContext) => Promise<void>,
    preflight?: (context: PreflightContext) => Promise<void>,
  ): Promise<M.MiniMeSnapshot> {
    return deps.lifecycle.mutate(deps.assertCurrent, async () => {
      const assertCurrent = deps.assertCurrent;
      const state = deps.state(assertCurrent);
      const requestFingerprint = miniMeOperationFingerprint(params);
      const previous = await state.operationLookup({ ownerId, operationId: params.operationId });
      if (
        previous &&
        (previous.kind !== kind || previous.requestFingerprint !== requestFingerprint)
      ) {
        throw new MiniMePersistenceError(
          "operation-conflict",
          "Operation ID belongs to another request",
        );
      }
      if (previous?.state === "complete") {
        return snapshot(assertCurrent);
      }
      const found = previous?.profile
        ? await state.read(ownerId, previous.miniMeId)
        : await requireProfile(state);
      if (!found) {
        throw new MiniMePersistenceError(
          "not-found",
          "The original Mini Me profile is unavailable",
        );
      }
      const { profile } = found;
      if (profile.lifecycle === "deleted") {
        if (kind !== "delete") {
          throw new MiniMePersistenceError("lifecycle", "The original Mini Me was deleted");
        }
        await state.finishOperation({
          scope: scope(profile),
          operationId: params.operationId,
          kind,
          requestFingerprint,
        });
        return snapshot(assertCurrent);
      }
      if (!previous) {
        if (
          kind !== "delete" &&
          profile.lifecycle !== "active" &&
          profile.lifecycle !== "disabled"
        ) {
          throw new MiniMePersistenceError("lifecycle", "Mini Me lifecycle is closed");
        }
        if (
          (kind === "configure" || kind === "delete") &&
          "expectedRevision" in params &&
          params.expectedRevision !== profile.revision
        ) {
          throw new MiniMePersistenceError(
            "conflict",
            "Mini Me changed; inspect its current revision",
          );
        }
        await preflight?.({
          state,
          profile,
          attachments: found.attachments,
          operationId: params.operationId,
          assertCurrent,
        });
      }
      const root = await state.beginOperation({
        scope: scope(profile),
        operationId: params.operationId,
        kind,
        requestFingerprint,
      });
      if (root.state !== "complete") {
        await apply({
          state,
          profile: root.profile ?? profile,
          operationId: params.operationId,
          createdAt: root.createdAt,
          assertCurrent,
        });
        await state.finishOperation({
          scope: scope(profile),
          operationId: params.operationId,
          kind,
          requestFingerprint: miniMeOperationFingerprint(params),
        });
      }
      return snapshot(assertCurrent);
    });
  };
}
