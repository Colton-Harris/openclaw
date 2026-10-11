import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SessionMutationFactsUnavailableError } from "../gateway/session-sharing-incognito.js";
import { queueMiniMeLearning } from "./automatic-learning.js";
import {
  assertMiniMeProfileGeneration,
  miniMeHostState,
  withMiniMeContent,
} from "./host-storage.js";
import { readActiveMiniMeOwner } from "./private-agent-projection.js";
import { retainMiniMeConversation } from "./sources.js";

/** Reuses the settled-turn admission point; no scheduled scan or replacement owner authority. */
export async function queueMiniMeSettledSource(input: {
  operatorAuthority: AdmittedRunOperatorAuthority;
  sessionKey: string;
  config: OpenClawConfig;
}) {
  const operator = input.operatorAuthority;
  const ownerId = operator.profileId;
  const metadata = readActiveMiniMeOwner(ownerId);
  if (!metadata) {
    return;
  }
  operator.assertCurrent();
  // The owner's own selection decides first. Shared, incognito and unselected private
  // sessions are ordinary turns, so they never acquire or validate a conversation source.
  const current = await miniMeHostState(operator.assertCurrent).read(ownerId, metadata.miniMeId);
  if (!current || current.profile.lifecycle !== "active" || current.pendingDataChanges.length) {
    return;
  }
  const profile = current.profile;
  const content = await withMiniMeContent(profile, operator.assertCurrent, (store) =>
    store.readSnapshot({
      ownerId,
      miniMeId: profile.id,
      agentId: profile.agentId,
      generation: profile.generation,
    }),
  );
  operator.assertCurrent();
  if (
    !content.sources.some(
      (source) =>
        source.selection.kind === "conversation" &&
        source.selection.mode === "ongoing" &&
        source.selection.sessionKey === input.sessionKey,
    )
  ) {
    return;
  }
  // A selected source that is no longer the owner's private conversation still fails visibly.
  for (let refreshes = 0; ; refreshes++) {
    operator.assertCurrent();
    assertMiniMeProfileGeneration(ownerId, profile);
    try {
      const retained = await retainMiniMeConversation({
        ownerId,
        sessionKey: input.sessionKey,
        getConfig: () => input.config,
        assertCurrent: operator.assertCurrent,
      });
      try {
        retained.assertCurrent();
        assertMiniMeProfileGeneration(ownerId, profile);
        queueMiniMeLearning({
          ownerId,
          profile,
          config: input.config,
          operatorAuthority: operator,
          assertCurrent: operator.assertCurrent,
        });
      } finally {
        retained.release();
      }
      return;
    } catch (error) {
      if (!(error instanceof SessionMutationFactsUnavailableError) || refreshes >= 2) {
        throw error;
      }
    }
  }
}
