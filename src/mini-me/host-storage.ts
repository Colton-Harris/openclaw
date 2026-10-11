import type { MiniMeProfile } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  captureOpenClawStateWorkerContext,
  prepareOpenClawStateReadSource,
} from "../state/openclaw-state-worker-context.js";
import { MiniMeLifecycleOwner } from "./lifecycle.js";
import {
  createMiniMeContentPersistence,
  createMiniMeStatePersistence,
  miniMeOperationFingerprint,
} from "./persistence.js";
import { readMiniMePrivateAgentMetadata } from "./private-agent-projection.js";
import type { MiniMeContentStore } from "./service.types.js";

const lifetimes = resolveGlobalSingleton(
  Symbol.for("openclaw.miniMeLifetimes"),
  () => new Map<string, MiniMeLifecycleOwner>(),
);
export function miniMeLifecycleForOwner(ownerId: string): MiniMeLifecycleOwner {
  const physical = captureOpenClawStateWorkerContext();
  const key = JSON.stringify([physical.admission.identity.key, ownerId]);
  let lifetime = lifetimes.get(key);
  if (!lifetime) {
    if (lifetimes.size >= 1024) {
      throw new Error("Mini Me runtime owner capacity reached");
    }
    const source = prepareOpenClawStateReadSource({ path: physical.admission.databasePath });
    lifetime = new MiniMeLifecycleOwner(() => source.current().admission.assertCurrent());
    lifetimes.set(key, lifetime);
  }
  return lifetime;
}

/** Synchronous resident facts fence the final effect; re-reading config is never owner proof. */
export function assertMiniMeProfileGeneration(ownerId: string, profile: MiniMeProfile): void {
  const metadata = readMiniMePrivateAgentMetadata(profile.agentId);
  if (
    !metadata ||
    metadata.ownerId !== ownerId ||
    metadata.miniMeId !== profile.id ||
    metadata.generation !== profile.generation ||
    metadata.lifecycle !== profile.lifecycle
  ) {
    throw new Error("Mini Me owner, lifecycle or generation changed");
  }
}
export function miniMeHostState(assertCurrent: () => void) {
  return createMiniMeStatePersistence({ assertCurrent });
}
type MiniMeContentCustody = {
  /** Release only a known never-dispatched preimage, even after requester revocation. */
  releaseActionRestore(ownerId: string, actionId: string): Promise<null>;
};
export async function withMiniMeContent<T>(
  profile: MiniMeProfile,
  assertCurrent: () => void,
  consume: (store: MiniMeContentStore, custody: MiniMeContentCustody) => Promise<T>,
): Promise<T> {
  assertCurrent();
  const databaseOptions = { agentId: profile.agentId };
  const custodyScope = {
    miniMeId: profile.id,
    agentId: profile.agentId,
    generation: profile.generation,
  };
  const execution = captureOpenClawAgentDatabaseExecution(databaseOptions);
  try {
    assertCurrent();
    const custody = createMiniMeContentPersistence({
      databaseOptions,
      execution,
      assertCurrent: () => execution.assertCurrent(),
    });
    return await consume(
      createMiniMeContentPersistence({ databaseOptions, execution, assertCurrent }),
      {
        // This view cannot read, create content, or change its owner. The original physical
        // execution and worker generation remain mandatory after requester authority ends.
        releaseActionRestore: (ownerId, actionId) =>
          custody.releaseActionRestore({
            scope: { ...custodyScope, ownerId },
            actionId,
            operationId: miniMeOperationFingerprint([actionId, "preimage-release"]),
          }),
      },
    );
  } finally {
    await execution.release();
  }
}
