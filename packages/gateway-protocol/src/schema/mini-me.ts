import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

// Owner and database identities are derived by the host, never supplied by clients.
const Id = Type.String({ minLength: 1, maxLength: 128 });
const Revision = Type.Integer({ minimum: 0 });
const Timestamp = Type.Integer({ minimum: 0 });
const ShortText = Type.String({ minLength: 1, maxLength: 512 });
const Scope = Type.String({ minLength: 1, maxLength: 128 });
const Operation = { operationId: Id };

export const MINI_ME_DOCUMENT_NAMES = [
  "SOUL.md",
  "OPINIONS.md",
  "PREFERENCES.md",
  "MORALS.md",
  "TASTE.md",
  "DECISIONS.md",
] as const;
export const MiniMeDocumentNameSchema = Type.Union([
  Type.Literal("SOUL.md"),
  Type.Literal("OPINIONS.md"),
  Type.Literal("PREFERENCES.md"),
  Type.Literal("MORALS.md"),
  Type.Literal("TASTE.md"),
  Type.Literal("DECISIONS.md"),
]);
export const MiniMeModeSchema = Type.Union([
  Type.Literal("dont-decide"),
  Type.Literal("safe"),
  Type.Literal("auto"),
  Type.Literal("all"),
]);
export const MiniMeLifecycleSchema = Type.Union([
  Type.Literal("preparing"),
  Type.Literal("active"),
  Type.Literal("disabling"),
  Type.Literal("disabled"),
  Type.Literal("deleting"),
  Type.Literal("deleted"),
]);
export const MiniMeEffectSchema = Type.Union([
  Type.Literal("workspace.edit"),
  Type.Literal("message.send"),
]);
export const MiniMeGrantSchema = closedObject({
  id: Id,
  effect: MiniMeEffectSchema,
  // Exact host-normalized resources. Wildcards and shell-derived classifications are forbidden.
  resources: Type.Array(ShortText, { minItems: 1, maxItems: 32, uniqueItems: true }),
  maxActions: Type.Integer({ minimum: 1, maximum: 10_000 }),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_485_760 })),
  expiresAt: Timestamp,
});
export const MiniMeAttachmentSchema = closedObject({
  agentId: Id,
  mode: MiniMeModeSchema,
  revision: Revision,
  grants: Type.Array(MiniMeGrantSchema, { maxItems: 32 }),
  usage: Type.Array(closedObject({ grantId: Id, reserved: Revision, consumed: Revision })),
});
export const MiniMeModelsSchema = closedObject({
  conversationModel: Type.Union([ShortText, Type.Null()]),
  decisionModel: Type.Union([ShortText, Type.Null()]),
  // Explicit consent to the selected conversational model extracting selected source text.
  allowInference: Type.Boolean(),
});
export const MiniMeProfileSchema = closedObject({
  id: Id,
  agentId: Id,
  name: Type.String({ minLength: 1, maxLength: 80 }),
  lifecycle: MiniMeLifecycleSchema,
  learningPaused: Type.Boolean(),
  generation: Revision,
  revision: Revision,
  models: MiniMeModelsSchema,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const MiniMeSourceInputSchema = Type.Union([
  closedObject({ kind: Type.Literal("manual"), label: ShortText }),
  closedObject({ kind: Type.Literal("document"), name: MiniMeDocumentNameSchema }),
  closedObject({
    kind: Type.Literal("conversation"),
    sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    mode: Type.Union([Type.Literal("past-only"), Type.Literal("ongoing")]),
  }),
]);
export const MiniMeSourceSchema = closedObject({
  id: Id,
  selection: MiniMeSourceInputSchema,
  revision: Revision,
  status: Type.Union([
    Type.Literal("ready"),
    Type.Literal("pending"),
    Type.Literal("paused"),
    Type.Literal("unavailable"),
    Type.Literal("limit-reached"),
  ]),
  lastIngestedAt: Type.Union([Timestamp, Type.Null()]),
  detail: Type.Union([ShortText, Type.Null()]),
});
export const MiniMeEvidenceSchema = closedObject({
  sourceId: Id,
  sourceRevision: Id,
  excerpt: Type.String({ minLength: 1, maxLength: 4096 }),
});
export const MiniMePreferenceSchema = closedObject({
  document: MiniMeDocumentNameSchema,
  scope: Scope,
  statement: Type.String({ minLength: 1, maxLength: 4096 }),
  preferred: Type.Array(ShortText, { maxItems: 8, uniqueItems: true }),
  avoided: Type.Array(ShortText, { maxItems: 8, uniqueItems: true }),
});
export const MiniMeBeliefSchema = closedObject({
  id: Id,
  preference: MiniMePreferenceSchema,
  origin: Type.Union([
    Type.Literal("direct"),
    Type.Literal("correction"),
    Type.Literal("inferred"),
    Type.Literal("reference"),
    Type.Literal("observed-decision"),
  ]),
  evidence: Type.Array(MiniMeEvidenceSchema, { minItems: 1, maxItems: 16 }),
  status: Type.Union([Type.Literal("active"), Type.Literal("superseded"), Type.Literal("undone")]),
  supersedes: Type.Union([Id, Type.Null()]),
  createdAt: Timestamp,
});
export const MiniMeDocumentSchema = closedObject({
  name: MiniMeDocumentNameSchema,
  content: Type.String({ maxLength: 65_536 }),
  revision: Revision,
  updatedAt: Timestamp,
  external: Type.Optional(
    closedObject({
      content: Type.String({ maxLength: 65_536 }),
      baseRevision: Type.Union([Revision, Type.Null()]),
    }),
  ),
});
export const MiniMeChoiceSchema = closedObject({
  scope: Scope,
  question: Type.String({ minLength: 1, maxLength: 4096 }),
  options: Type.Array(closedObject({ id: Id, label: ShortText, value: ShortText }), {
    minItems: 2,
    maxItems: 8,
  }),
});
export const MiniMePredictionSchema = closedObject({
  id: Id,
  agentId: Type.Union([Id, Type.Null()]),
  choice: MiniMeChoiceSchema,
  optionId: Type.Union([Id, Type.Null()]),
  explanation: Type.String({ maxLength: 8192 }),
  uncertainty: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  evidence: Type.Array(MiniMeEvidenceSchema, { maxItems: 16 }),
  beliefIds: Type.Array(Id, { maxItems: 32 }),
  correctionApplied: Type.Boolean(),
  provider: ShortText,
  rubricVersion: ShortText,
  providerRuntimeGeneration: Type.Union([Id, Type.Null()]),
  createdAt: Timestamp,
  profileGeneration: Revision,
  contentRevision: Revision,
  // A frozen prediction is evidence, never approval or an execution capability.
  authority: Type.Literal("advisory"),
});
export const MiniMeOutcomeSchema = closedObject({
  id: Id,
  predictionId: Id,
  optionId: Id,
  origin: Type.Union([Type.Literal("owner"), Type.Literal("delegated")]),
  matched: Type.Boolean(),
  correctionId: Type.Union([Id, Type.Null()]),
  createdAt: Timestamp,
});
export const MiniMeCapabilitiesSchema = closedObject({
  effects: Type.Array(
    closedObject({
      effect: MiniMeEffectSchema,
      available: Type.Boolean(),
      reason: Type.String({ maxLength: 1024 }),
    }),
  ),
  maxSources: Revision,
  maxDocumentBytes: Revision,
  maxOptions: Revision,
});
export const MiniMeSnapshotSchema = closedObject({
  profile: Type.Union([MiniMeProfileSchema, Type.Null()]),
  contentRevision: Revision,
  documents: Type.Array(MiniMeDocumentSchema, { maxItems: 6 }),
  sources: Type.Array(MiniMeSourceSchema, { maxItems: 16 }),
  beliefs: Type.Array(MiniMeBeliefSchema),
  predictions: Type.Array(MiniMePredictionSchema),
  outcomes: Type.Array(MiniMeOutcomeSchema),
  attachments: Type.Array(MiniMeAttachmentSchema),
  capabilities: MiniMeCapabilitiesSchema,
  historyCursor: Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]),
});
export const MiniMeGetParamsSchema = closedObject({});
export const MiniMeCreateParamsSchema = closedObject({
  ...Operation,
  name: Type.String({ minLength: 1, maxLength: 80 }),
  models: MiniMeModelsSchema,
  sources: Type.Array(MiniMeSourceInputSchema, { maxItems: 16 }),
  attachments: Type.Array(
    closedObject({
      agentId: Id,
      mode: MiniMeModeSchema,
      grants: Type.Array(MiniMeGrantSchema, { maxItems: 32 }),
    }),
    { maxItems: 64 },
  ),
});
export const MiniMeConfigureParamsSchema = closedObject({
  ...Operation,
  expectedRevision: Revision,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  enabled: Type.Optional(Type.Boolean()),
  learningPaused: Type.Optional(Type.Boolean()),
  models: Type.Optional(MiniMeModelsSchema),
});
export const MiniMeDocumentSetParamsSchema = closedObject({
  ...Operation,
  name: MiniMeDocumentNameSchema,
  expectedRevision: Revision,
  content: Type.String({ maxLength: 65_536 }),
});
export const MiniMeSourceAddParamsSchema = closedObject({
  ...Operation,
  source: MiniMeSourceInputSchema,
});
export const MiniMeSourceRemoveParamsSchema = closedObject({ ...Operation, sourceId: Id });
export const MiniMeLearnParamsSchema = closedObject({
  ...Operation,
  preference: MiniMePreferenceSchema,
  corrects: Type.Optional(Id),
});
export const MiniMeUndoParamsSchema = closedObject({ ...Operation, beliefId: Id });
export const MiniMePredictParamsSchema = closedObject({
  ...Operation,
  choice: MiniMeChoiceSchema,
  agentId: Type.Optional(Id),
});
export const MiniMeOutcomeParamsSchema = closedObject({
  ...Operation,
  predictionId: Id,
  optionId: Id,
  correction: Type.Optional(MiniMePreferenceSchema),
});
export const MiniMeAttachParamsSchema = closedObject({
  ...Operation,
  agentId: Id,
  expectedRevision: Revision,
  mode: MiniMeModeSchema,
  grants: Type.Array(MiniMeGrantSchema, { maxItems: 32 }),
});
export const MiniMeDetachParamsSchema = closedObject({ ...Operation, agentId: Id });
export const MiniMeDeleteParamsSchema = closedObject({ ...Operation, expectedRevision: Revision });
export const MiniMeExportParamsSchema = closedObject({});
export const MiniMeExportResultSchema = closedObject({
  format: Type.Literal("openclaw-mini-me-v1"),
  exportedAt: Timestamp,
  snapshot: MiniMeSnapshotSchema,
});
const HistoryCursor = Type.String({ minLength: 1, maxLength: 2048 });
export const MiniMeHistoryParamsSchema = closedObject({ cursor: Type.Optional(HistoryCursor) });
export const MiniMeHistoryResultSchema = closedObject({
  beliefs: Type.Array(MiniMeBeliefSchema, { maxItems: 50 }),
  predictions: Type.Array(MiniMePredictionSchema, { maxItems: 50 }),
  outcomes: Type.Array(MiniMeOutcomeSchema, { maxItems: 50 }),
  cursor: Type.Union([HistoryCursor, Type.Null()]),
});
export const MiniMeSourcesAvailableParamsSchema = closedObject({});
export const MiniMeActionReceiptSchema = closedObject({
  receiptId: Id,
  actionId: Id,
  targetAgentId: Id,
  resource: Type.String({ minLength: 1, maxLength: 4096 }),
  afterSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  createdAt: Timestamp,
});
export const MiniMeActionsParamsSchema = closedObject({ cursor: Type.Optional(HistoryCursor) });
export const MiniMeActionsResultSchema = closedObject({
  receipts: Type.Array(MiniMeActionReceiptSchema, { maxItems: 50 }),
  cursor: Type.Union([HistoryCursor, Type.Null()]),
});
export const MiniMeActionGetParamsSchema = closedObject({ receiptId: Id });
export const MiniMeActionGetResultSchema = closedObject({
  receipt: MiniMeActionReceiptSchema,
  before: closedObject({
    utf8: Type.String({ maxLength: 65_536 }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  }),
});
export const MiniMeSourcesAvailableResultSchema = closedObject({
  conversations: Type.Array(
    closedObject({
      sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
      title: Type.String({ maxLength: 512 }),
      agentId: Id,
      updatedAt: Timestamp,
    }),
    { maxItems: 50 },
  ),
});
export const MiniMeOperationGetParamsSchema = closedObject({ operationId: Id });
export const MiniMeOperationGetResultSchema = closedObject({
  status: Type.Union([
    Type.Literal("unknown"),
    Type.Literal("pending"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
  prediction: Type.Optional(MiniMePredictionSchema),
  error: Type.Optional(Type.String({ maxLength: 1024 })),
});

export type MiniMeDocumentName = Static<typeof MiniMeDocumentNameSchema>;
export type MiniMeMode = Static<typeof MiniMeModeSchema>;
export type MiniMeLifecycle = Static<typeof MiniMeLifecycleSchema>;
export type MiniMeEffect = Static<typeof MiniMeEffectSchema>;
export type MiniMeGrant = Static<typeof MiniMeGrantSchema>;
export type MiniMeAttachment = Static<typeof MiniMeAttachmentSchema>;
export type MiniMeModels = Static<typeof MiniMeModelsSchema>;
export type MiniMeProfile = Static<typeof MiniMeProfileSchema>;
export type MiniMeSourceInput = Static<typeof MiniMeSourceInputSchema>;
export type MiniMeSource = Static<typeof MiniMeSourceSchema>;
export type MiniMeEvidence = Static<typeof MiniMeEvidenceSchema>;
export type MiniMePreference = Static<typeof MiniMePreferenceSchema>;
export type MiniMeBelief = Static<typeof MiniMeBeliefSchema>;
export type MiniMeDocument = Static<typeof MiniMeDocumentSchema>;
export type MiniMeChoice = Static<typeof MiniMeChoiceSchema>;
export type MiniMePrediction = Static<typeof MiniMePredictionSchema>;
export type MiniMeOutcome = Static<typeof MiniMeOutcomeSchema>;
export type MiniMeSnapshot = Static<typeof MiniMeSnapshotSchema>;
export type MiniMeCreateParams = Static<typeof MiniMeCreateParamsSchema>;
export type MiniMeConfigureParams = Static<typeof MiniMeConfigureParamsSchema>;
export type MiniMeDocumentSetParams = Static<typeof MiniMeDocumentSetParamsSchema>;
export type MiniMeSourceAddParams = Static<typeof MiniMeSourceAddParamsSchema>;
export type MiniMeSourceRemoveParams = Static<typeof MiniMeSourceRemoveParamsSchema>;
export type MiniMeLearnParams = Static<typeof MiniMeLearnParamsSchema>;
export type MiniMeUndoParams = Static<typeof MiniMeUndoParamsSchema>;
export type MiniMePredictParams = Static<typeof MiniMePredictParamsSchema>;
export type MiniMeOutcomeParams = Static<typeof MiniMeOutcomeParamsSchema>;
export type MiniMeAttachParams = Static<typeof MiniMeAttachParamsSchema>;
export type MiniMeDetachParams = Static<typeof MiniMeDetachParamsSchema>;
export type MiniMeDeleteParams = Static<typeof MiniMeDeleteParamsSchema>;
export type MiniMeExportResult = Static<typeof MiniMeExportResultSchema>;
export type MiniMeHistoryResult = Static<typeof MiniMeHistoryResultSchema>;
export type MiniMeSourcesAvailableResult = Static<typeof MiniMeSourcesAvailableResultSchema>;
export type MiniMeOperationGetResult = Static<typeof MiniMeOperationGetResultSchema>;
export type MiniMeActionsResult = Static<typeof MiniMeActionsResultSchema>;
export type MiniMeActionGetResult = Static<typeof MiniMeActionGetResultSchema>;
