import { createHash } from "node:crypto";
import type {
  MiniMeAttachment,
  MiniMeBelief,
  MiniMeDocument,
  MiniMeDocumentName,
  MiniMeGrant,
  MiniMeMode,
  MiniMeModels,
  MiniMeOutcome,
  MiniMePrediction,
  MiniMeProfile,
  MiniMeSource,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import type { OpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution-contract.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";

export type MiniMeOwnerScope = { ownerId: string; miniMeId: string };
export type MiniMeContentScope = MiniMeOwnerScope & { agentId: string; generation: number };
export type MiniMePersistenceOptions = {
  state?: OpenClawStateDatabaseOptions;
  assertCurrent(this: void): void;
};
export type MiniMeContentPersistenceOptions = {
  execution: OpenClawAgentDatabaseExecution;
  databaseOptions: OpenClawAgentDatabaseOptions;
  assertCurrent(this: void): void;
};
export type MiniMeMutation = { scope: MiniMeOwnerScope; operationId: string };
export type MiniMeContentMutation = { scope: MiniMeContentScope; operationId: string };
export type MiniMeDataChange = {
  id: string;
  generation: number;
  change: { kind: "remove-source"; sourceId: string };
};
export type MiniMeProfileState = {
  profile: MiniMeProfile;
  attachments: MiniMeAttachment[];
  pendingDataChanges: MiniMeDataChange[];
};
export type MiniMeContentSnapshot = {
  contentRevision: number;
  historyCursor: string | null;
  documents: MiniMeDocument[];
  sources: MiniMeSource[];
  beliefs: MiniMeBelief[];
  predictions: MiniMePrediction[];
  outcomes: MiniMeOutcome[];
};
export type MiniMeRootOperation = {
  kind: string;
  requestFingerprint: string;
  predictionId: string | null;
  state: "pending" | "complete";
  createdAt: number;
  profile: MiniMeProfile | null;
};
export type MiniMeOperationStatus = MiniMeRootOperation | null;
export type MiniMeActionScope = MiniMeOwnerScope & {
  targetAgentId: string;
  profileGeneration: number;
  attachmentRevision: number;
};
export type MiniMeReservationState =
  | "reserved"
  | "consumed"
  | "not-dispatched"
  | "succeeded"
  | "failed"
  | "unknown";
export type MiniMeReserveInput = {
  scope: MiniMeActionScope;
  actionId: string;
  predictionId: string;
  optionId: string;
  grant: MiniMeGrant;
  action: { effect: MiniMeGrant["effect"]; resource: string; fingerprint: string; bytes: number };
};
export type MiniMeReservationResult =
  | { kind: "reserved"; reservationId: string }
  | { kind: "existing"; state: MiniMeReservationState }
  | { kind: "denied"; reason: string };
export type MiniMeConsumeResult =
  | { kind: "consumed" }
  | { kind: "existing" }
  | { kind: "denied"; reason: string };

export type MiniMePrivateMetadata = {
  profiles: {
    ownerId: string;
    miniMeId: string;
    agentId: string;
    lifecycle: MiniMeProfile["lifecycle"];
    generation: number;
    revision: number;
  }[];
  attachments: {
    ownerId: string;
    miniMeId: string;
    targetAgentId: string;
    profileGeneration: number;
    attachmentRevision: number;
  }[];
};
export type MiniMeStateWorkerOperations = {
  "miniMe.privateMetadata": { input: Record<string, never>; output: MiniMePrivateMetadata };
  "miniMe.read": {
    input: { ownerId: string; miniMeId?: string };
    output: MiniMeProfileState | null;
  };
  "miniMe.beginCreate": {
    input: { ownerId: string; operationId: string; name: string; models: MiniMeModels };
    output: MiniMeProfile;
  };
  "miniMe.activate": {
    input: MiniMeMutation & { expectedRevision: number };
    output: MiniMeProfile;
  };
  "miniMe.configure": {
    input: MiniMeMutation & {
      expectedRevision: number;
      patch: { name?: string; models?: MiniMeModels; learningPaused?: boolean; enabled?: boolean };
    };
    output: MiniMeProfile;
  };
  "miniMe.setAttachment": {
    input: MiniMeMutation & {
      agentId: string;
      expectedRevision: number;
      mode: MiniMeMode;
      grants: MiniMeGrant[];
    };
    output: MiniMeAttachment;
  };
  "miniMe.detachAttachment": { input: MiniMeMutation & { agentId: string }; output: null };
  "miniMe.closeLifecycle": {
    input: MiniMeMutation & {
      expectedRevision: number;
      lifecycle: "disabling" | "deleting";
      advanceDataGeneration?: boolean;
    };
    output: MiniMeProfile;
  };
  "miniMe.finalizeLifecycle": {
    input: MiniMeMutation & { expectedRevision: number; lifecycle: "disabled" | "deleted" };
    output: MiniMeProfile;
  };
  "miniMe.advanceGeneration": {
    input: MiniMeMutation & {
      expectedRevision: number;
      change?: { kind: "remove-source"; sourceId: string };
    };
    output: MiniMeProfile;
  };
  "miniMe.readPendingDataChanges": {
    input: { scope: MiniMeOwnerScope };
    output: MiniMeDataChange[];
  };
  "miniMe.completeDataChange": { input: MiniMeMutation & { dataChangeId: string }; output: null };
  "miniMe.beginOperation": {
    input: MiniMeMutation & { kind: string; requestFingerprint: string };
    output: MiniMeRootOperation;
  };
  "miniMe.finishOperation": {
    input: MiniMeMutation & { kind: string; requestFingerprint: string; predictionId?: string };
    output: null;
  };
  "miniMe.operationLookup": {
    input: { ownerId: string; operationId: string };
    output: (MiniMeRootOperation & { miniMeId: string }) | null;
  };
  "miniMe.operationStatus": { input: MiniMeMutation; output: MiniMeOperationStatus };
  "miniMe.reserve": { input: MiniMeReserveInput; output: MiniMeReservationResult };
  "miniMe.consume": {
    input: { scope: MiniMeActionScope; actionId: string; reservationId: string };
    output: MiniMeConsumeResult;
  };
  "miniMe.settle": {
    input: {
      scope: MiniMeActionScope;
      actionId: string;
      reservationId: string;
      state: Exclude<MiniMeReservationState, "reserved" | "consumed">;
    };
    output: null;
  };
};
export type MiniMeActionRestore = {
  receiptId: string;
  actionId: string;
  targetAgentId: string;
  resource: string;
  before: { utf8: string; sha256: string };
  afterSha256: string;
  createdAt: number;
};
export type MiniMeContentWorkerOperations = {
  recordActionRestore: {
    input: MiniMeContentMutation & Omit<MiniMeActionRestore, "receiptId">;
    output: { receiptId: string };
  };
  /** Erases one action's preimage after its dispatch is known never admitted. */
  releaseActionRestore: {
    input: MiniMeContentMutation & { actionId: string };
    output: null;
  };
  readActionRestore: {
    input: { scope: MiniMeContentScope; receiptId: string };
    output: MiniMeActionRestore | null;
  };
  readActionRestores: {
    input: { scope: MiniMeContentScope; cursor?: string };
    output: { receipts: MiniMeActionRestore[]; cursor: string | null };
  };

  initialize: { input: MiniMeContentMutation; output: MiniMeContentSnapshot };
  readExactPrediction: {
    input: { scope: MiniMeContentScope; predictionId: string };
    output: MiniMePrediction | null;
  };
  readExport: { input: { scope: MiniMeContentScope }; output: MiniMeContentSnapshot };
  readBeliefs: { input: { scope: MiniMeContentScope; topic: string }; output: MiniMeBelief[] };
  history: {
    input: { scope: MiniMeContentScope; cursor?: string };
    output: Pick<MiniMeContentSnapshot, "beliefs" | "predictions" | "outcomes" | "historyCursor">;
  };
  readSnapshot: { input: { scope: MiniMeContentScope }; output: MiniMeContentSnapshot };
  addSource: { input: MiniMeContentMutation & { source: MiniMeSource }; output: MiniMeSource };
  updateSourceStatus: {
    input: MiniMeContentMutation & {
      sourceId: string;
      status: MiniMeSource["status"];
      detail: string | null;
    };
    output: MiniMeSource;
  };
  removeSource: { input: MiniMeContentMutation & { sourceId: string }; output: null };
  sourceCursor: { input: { scope: MiniMeContentScope; sourceId: string }; output: string | null };
  learnBatch: {
    input: MiniMeContentMutation & {
      beliefs: MiniMeBelief[];
      sourceId?: string;
      expectedCursor?: string | null;
      cursor?: string | null;
    };
    output: { contentRevision: number; applied: MiniMeBelief[] };
  };
  reviseDocument: {
    input: MiniMeContentMutation & {
      name: MiniMeDocumentName;
      expectedRevision: number;
      content: string;
      evidenceSourceIds?: string[];
    };
    output: MiniMeDocument;
  };
  undo: { input: MiniMeContentMutation & { beliefId: string }; output: MiniMeBelief };
  freezePrediction: {
    input: MiniMeContentMutation & { prediction: MiniMePrediction };
    output: null;
  };
  appendOutcome: {
    input: MiniMeContentMutation & { outcome: MiniMeOutcome };
    output: MiniMeOutcome;
  };
  purge: { input: MiniMeContentMutation; output: null };
};
export type MiniMePersistenceErrorCode =
  | "conflict"
  | "not-found"
  | "lifecycle"
  | "limit-reached"
  | "invalid"
  | "operation-conflict";
export class MiniMePersistenceError extends Error {
  readonly code: string;
  constructor(
    readonly reason: MiniMePersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MiniMePersistenceError";
    this.code = `MINI_ME_${reason.toUpperCase().replaceAll("-", "_")}`;
  }
}

export function miniMeOperationFingerprint(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, item]) => item !== undefined)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}
