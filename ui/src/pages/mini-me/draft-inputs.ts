import type {
  MiniMeBelief,
  MiniMeChoice,
  MiniMeDocumentName,
  MiniMeGrant,
  MiniMePrediction,
  MiniMeSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import type { ChoiceDraft } from "./decision-view.ts";
import type { DocumentDraft } from "./documents-view.ts";
import { emptyPreferenceDraft, type PreferenceDraft } from "./learning-view.ts";
import { emptyPermissionDraft, type GrantDraft, type PermissionDraft } from "./permissions-view.ts";

// Pure conversions between page-owned form drafts and Gateway request inputs.
// The page keeps every draft and decides when to publish or submit them.

type DocumentDrafts = ReadonlyMap<MiniMeDocumentName, DocumentDraft>;
type DocumentFile = MiniMeSnapshot["documents"][number];

// A new draft pins the revision it was started from until the owner saves or rebases it.
export function documentDraftsWithContent(
  drafts: DocumentDrafts,
  file: DocumentFile,
  content: string,
): Map<MiniMeDocumentName, DocumentDraft> {
  return new Map(drafts).set(file.name, {
    ...(drafts.get(file.name) ?? { revision: file.revision, original: file.content }),
    content,
  });
}

export function documentDraftsWithout(
  drafts: DocumentDrafts,
  name: MiniMeDocumentName,
): Map<MiniMeDocumentName, DocumentDraft> {
  const next = new Map(drafts);
  next.delete(name);
  return next;
}

export function rebasedDocumentDrafts(
  drafts: DocumentDrafts,
  file: DocumentFile,
  discard: boolean,
): Map<MiniMeDocumentName, DocumentDraft> {
  if (discard) {
    return documentDraftsWithout(drafts, file.name);
  }
  const next = new Map(drafts),
    draft = next.get(file.name);
  if (draft) {
    next.set(file.name, { ...draft, revision: file.revision, original: file.content });
  }
  return next;
}

export function choiceFromDraft(draft: ChoiceDraft): MiniMeChoice | null {
  const options = [
    ...new Set(
      draft.options
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  if (
    !draft.scope.trim() ||
    draft.scope.length > 128 ||
    !draft.question.trim() ||
    options.length < 2 ||
    options.length > 8 ||
    options.some((option) => option.length > 512)
  ) {
    return null;
  }
  return {
    scope: draft.scope.trim(),
    question: draft.question.trim(),
    options: options.map((value, index) => ({
      id: `option-${index + 1}`,
      label: value,
      value,
    })),
  };
}

// The caller assigns the grant id only after validation succeeds.
export function grantFromDraft(
  draft: GrantDraft,
  effects: MiniMeSnapshot["capabilities"]["effects"] | undefined,
): Omit<MiniMeGrant, "id"> | null {
  const resources = [
    ...new Set(
      draft.resources
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  const maxActions = Number(draft.maxActions),
    maxBytes = draft.maxBytes ? Number(draft.maxBytes) : undefined,
    expiresAt = new Date(draft.expires).getTime();
  if (
    !effects?.some((item) => item.effect === draft.effect && item.available) ||
    !resources.length ||
    resources.length > 32 ||
    resources.some((item) => item.length > 512 || item.includes("*")) ||
    !Number.isInteger(maxActions) ||
    maxActions < 1 ||
    maxActions > 10000 ||
    (maxBytes !== undefined &&
      (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 10485760)) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    return null;
  }
  return {
    effect: draft.effect,
    resources,
    maxActions,
    ...(maxBytes ? { maxBytes } : {}),
    expiresAt,
  };
}

export function permissionDraftFor(
  snapshot: MiniMeSnapshot | null | undefined,
  agentId: string,
): PermissionDraft {
  const attachment = snapshot?.attachments.find((item) => item.agentId === agentId);
  const draft: PermissionDraft = {
    ...emptyPermissionDraft(),
    agentId,
    ...(attachment
      ? {
          mode: attachment.mode,
          grants: attachment.grants.map((grant) => ({
            ...grant,
            resources: [...grant.resources],
          })),
          revision: attachment.revision,
        }
      : {}),
  };
  const available = snapshot?.capabilities.effects.find((item) => item.available);
  return available ? { ...draft, grant: { ...draft.grant, effect: available.effect } } : draft;
}

export function beliefCorrectionDraft(belief: MiniMeBelief): PreferenceDraft {
  return {
    ...belief.preference,
    preferred: belief.preference.preferred.join("\n"),
    avoided: belief.preference.avoided.join("\n"),
    corrects: belief.id,
  };
}

export function outcomeCorrectionDraft(
  prediction: MiniMePrediction | undefined,
  optionId: string,
): PreferenceDraft {
  return {
    ...emptyPreferenceDraft(),
    scope: prediction?.choice.scope ?? "",
    preferred: prediction?.choice.options.find((item) => item.id === optionId)?.value ?? "",
  };
}
