import type {
  MiniMeAttachment,
  MiniMeEffect,
  MiniMeGrant,
  MiniMePrediction,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";

/** Captured by the host from the original requester and selected attachment. */
export type MiniMeDelegationScope = Readonly<{
  ownerId: string;
  miniMeId: string;
  targetAgentId: string;
  profileGeneration: number;
  attachmentRevision: number;
}>;

export type MiniMeDelegationAction =
  | Readonly<{
      effect: "workspace.edit";
      /** Exact canonical workspace/path resource prepared by the filesystem owner. */
      resource: string;
      expectedContentHash: string;
      content: string;
    }>
  | Readonly<{
      effect: "message.send";
      /** Exact canonical channel/account/destination/thread prepared by the channel owner. */
      resource: string;
      text: string;
    }>;

/** Host classification is independent of the predictor's confidence or prose. */
export type MiniMeDelegationQualification = Readonly<{
  supported: boolean;
  impact: "low" | "other";
  /** Counts only with restore custody the owner acknowledges before dispatch admission. */
  reversible: boolean;
  evidence: "explicit" | "qualified-inference" | "uncertain" | "conflicting";
}>;

export type MiniMeDelegationAuthority = Readonly<{
  scope: MiniMeDelegationScope;
  /** Includes live run, canonical person, private audience, source, and feature generations. */
  assertCurrent: () => void;
  /** Published current facts, not a database read or client-supplied attachment. */
  readAttachment: () => MiniMeAttachment | undefined;
}>;

export type MiniMeReservationState =
  | "reserved"
  | "consumed"
  | "not-dispatched"
  | "succeeded"
  | "failed"
  | "unknown";

export type MiniMeDelegationReservationRef = Readonly<{
  scope: MiniMeDelegationScope;
  actionId: string;
  reservationId: string;
}>;

/**
 * The worker owns atomic limits and idempotency. Every mutation independently
 * checks authoritative generations, grant/mode, expiry, and its commit admission.
 * Unknown/consumed effects never refund budget; only not-dispatched may release it.
 */
export type MiniMeDelegationStore = Readonly<{
  freezePrediction: (input: {
    scope: MiniMeDelegationScope;
    prediction: MiniMePrediction;
    assertCurrent: () => void;
  }) => Promise<void>;
  reserve: (input: {
    scope: MiniMeDelegationScope;
    actionId: string;
    predictionId: string;
    optionId: string;
    grant: MiniMeGrant;
    action: Readonly<{
      effect: MiniMeEffect;
      resource: string;
      fingerprint: string;
      bytes: number;
    }>;
    assertCurrent: () => void;
  }) => Promise<
    | { kind: "reserved"; reservationId: string }
    | { kind: "existing"; state: MiniMeReservationState }
    | { kind: "denied"; reason: string }
  >;
  consume: (
    input: MiniMeDelegationReservationRef & {
      assertCurrent: () => void;
    },
  ) => Promise<{ kind: "consumed" } | { kind: "existing" } | { kind: "denied"; reason: string }>;
  /** Settlement closes previously admitted work even when execution authority was revoked. */
  settle: (
    input: MiniMeDelegationReservationRef & {
      state: Exclude<MiniMeReservationState, "reserved" | "consumed">;
    },
  ) => Promise<void>;
}>;

/** The issuing owner's private registry, never this public shape, grants custody. */
export type MiniMePreparedDelegation = Readonly<{ kind: "mini-me-delegation" }>;

export type MiniMeDelegationPreparation =
  | { kind: "delegated"; capability: MiniMePreparedDelegation; prediction: MiniMePrediction }
  | { kind: "advice" | "pending-owner"; reason: string; prediction: MiniMePrediction }
  | { kind: "existing"; state: MiniMeReservationState; prediction: MiniMePrediction };

export type MiniMeDelegationFence = Readonly<{
  action: MiniMeDelegationAction;
  /** Host preparation may read/normalize while the action is still reserved. */
  assertPreparing: () => void;
  /** Await after all action preparation; pass the final canonical execution shape. */
  beforeDispatch: (action: MiniMeDelegationAction) => Promise<void>;
  /** Requires confirmed dispatch admission; compose into the owner's final effect guards. */
  assertCurrent: () => void;
}>;

export type MiniMeEffectResult<T> =
  | { state: "succeeded"; value: T }
  | { state: "failed" | "unknown"; reason: string };

/**
 * Preimage custody for the selected edit. The owner awaits `record` at the dispatch
 * fence, after host preparation and before reservation consumption, so refused,
 * duplicate, or abandoned work never publishes a restore receipt.
 */
export type MiniMeRestoreCustody = Readonly<{
  record: (assertCurrent: () => void) => Promise<{ receiptId: string }>;
  /**
   * Idempotently erases this action's preimage, including one whose record acknowledgment
   * was lost. Called only once dispatch is known never admitted, possibly after requester
   * revocation, so the host binds it to physical storage identity and the content
   * owner/generation fence rather than requester authority. It cannot create or widen custody.
   */
  release: () => Promise<void>;
}>;

export type MiniMeDelegationExecution<T> = Readonly<{
  outcome: MiniMeEffectResult<T> | { state: "not-dispatched"; reason: string };
  settlement: { state: "recorded" } | { state: "unconfirmed"; error: unknown };
  /**
   * An acknowledged preimage this attempt still retains: always for consumed or uncertain
   * dispatch, and for a not-dispatched attempt only while its release is unconfirmed.
   */
  restoreReceiptId?: string;
  /** Present when a not-dispatched attempt had begun preimage custody. */
  restoreRelease?: { state: "released" } | { state: "unconfirmed"; error: unknown };
}>;
