import type * as M from "../../packages/gateway-protocol/src/schema/mini-me.js";
import type { MiniMeLifecycleOwner } from "./lifecycle.js";
import type {
  createMiniMeContentPersistence,
  createMiniMeStatePersistence,
} from "./persistence.js";
import type { MiniMeContentScope } from "./persistence.types.js";
import type { MiniMePredictionInput } from "./prediction.js";

export type MiniMeStateStore = ReturnType<typeof createMiniMeStatePersistence>;
export type MiniMeContentStore = ReturnType<typeof createMiniMeContentPersistence>;
export type MiniMeServiceDependencies = {
  ownerId: string;
  /** This fact comes from the original authenticated ingress, never RPC params. */
  humanRequest: boolean;
  lifecycle: MiniMeLifecycleOwner;
  assertCurrent(this: void): void;
  state(assertCurrent: () => void): MiniMeStateStore;
  withContent<T>(
    this: void,
    profile: M.MiniMeProfile,
    assertCurrent: () => void,
    consume: (store: MiniMeContentStore) => Promise<T>,
  ): Promise<T>;
  provision(this: void, profile: M.MiniMeProfile, assertCurrent: () => void): Promise<void>;
  configureAgent(profile: M.MiniMeProfile, assertCurrent: () => void): Promise<void>;
  /**
   * Removes the six projected files and retires the private agent. Retry-safe: it completes when
   * the canonical agent owner already finished cleanup. Never evidence of Mini Me content erasure.
   */
  deleteAgent(profile: M.MiniMeProfile, assertCurrent: () => void): Promise<void>;
  project(
    profile: M.MiniMeProfile,
    store: MiniMeContentStore,
    assertCurrent: () => void,
  ): Promise<void>;
  inspectDocuments(
    profile: M.MiniMeProfile,
    documents: M.MiniMeDocument[],
    assertCurrent: () => void,
  ): Promise<M.MiniMeDocument[]>;
  assertAgentAllowed(agentId: string): void;
  prepareGrants(
    agentId: string,
    grants: M.MiniMeGrant[],
    assertCurrent: () => void,
  ): Promise<M.MiniMeGrant[]>;
  validateSource(source: M.MiniMeSourceInput, assertCurrent: () => void): Promise<void>;
  availableSources(assertCurrent: () => void): Promise<M.MiniMeSourcesAvailableResult>;
  predict(
    this: void,
    profile: M.MiniMeProfile,
    input: MiniMePredictionInput,
    lifetime: { assertCurrent(this: void): void; signal: AbortSignal },
  ): Promise<M.MiniMePrediction>;
  /** Queue only selected work, with a visible bounded failure; never broad transcript scanning. */
  queueLearning(profile: M.MiniMeProfile): void;
  capabilities: M.MiniMeSnapshot["capabilities"];
};

export type MiniMeMutationContext = {
  state: MiniMeStateStore;
  profile: M.MiniMeProfile;
  operationId: string;
  createdAt: number;
  assertCurrent(this: void): void;
};
export type MiniMePreflightContext = Omit<MiniMeMutationContext, "createdAt"> & {
  attachments: M.MiniMeAttachment[];
};
export type MiniMeServiceContext = {
  scope(this: void, profile: M.MiniMeProfile): MiniMeContentScope;
  snapshot(this: void, assertCurrent: () => void, full?: boolean): Promise<M.MiniMeSnapshot>;
  requireProfile(
    this: void,
    state: MiniMeStateStore,
  ): Promise<NonNullable<Awaited<ReturnType<MiniMeStateStore["read"]>>>>;
};
