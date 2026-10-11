import { html, nothing } from "lit";
import type {
  MiniMeBelief,
  MiniMeDocumentName,
  MiniMeEvidence,
  MiniMePreference,
  MiniMeSnapshot,
  MiniMeSource,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { inputField, sourceLabel, textField } from "./home-view.ts";
import { miniMeInputValue } from "./input-events.ts";

export const DOCUMENT_NAMES: MiniMeDocumentName[] = [
  "SOUL.md",
  "OPINIONS.md",
  "PREFERENCES.md",
  "MORALS.md",
  "TASTE.md",
  "DECISIONS.md",
];
export type PreferenceDraft = {
  document: MiniMeDocumentName;
  scope: string;
  statement: string;
  preferred: string;
  avoided: string;
  corrects?: string;
};
export function emptyPreferenceDraft(): PreferenceDraft {
  return { document: "PREFERENCES.md", scope: "", statement: "", preferred: "", avoided: "" };
}
export function preferenceFromDraft(draft: PreferenceDraft): MiniMePreference | null {
  const lines = (value: string) => [
    ...new Set(
      value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  const preferred = lines(draft.preferred),
    avoided = lines(draft.avoided);
  if (
    !draft.scope.trim() ||
    draft.scope.trim().length > 128 ||
    !draft.statement.trim() ||
    draft.statement.length > 4096 ||
    preferred.length > 8 ||
    avoided.length > 8 ||
    preferred.concat(avoided).some((value) => value.length > 512)
  ) {
    return null;
  }
  return {
    document: draft.document,
    scope: draft.scope.trim(),
    statement: draft.statement.trim(),
    preferred,
    avoided,
  };
}
export function renderMiniMeEvidence(evidence: MiniMeEvidence[], sources: MiniMeSource[]) {
  return html`<details>
    <summary>${t("miniMe.evidence")}</summary>
    ${
      evidence.length
        ? evidence.map((item) => {
            const foundSource = sources.find((source) => source.id === item.sourceId);
            return html`<blockquote>
              <p>${item.excerpt}</p>
              <small
                title=${t("miniMe.sourceRevision", { source: item.sourceId, revision: item.sourceRevision })}
                >${t("miniMe.sourceRevision", { source: foundSource ? sourceLabel(foundSource.selection) : item.sourceId, revision: item.sourceRevision.slice(0, 12) })}</small
              >
            </blockquote>`;
          })
        : html`<p>${t("miniMe.noEvidence")}</p>`
    }
  </details>`;
}
export function renderPreferenceForm(
  draft: PreferenceDraft,
  change: (draft: PreferenceDraft) => void,
) {
  return html`
    ${renderSettingsRow({
      title: t("miniMe.document"),
      control: html`<select
        class="settings-select"
        aria-label=${t("miniMe.document")}
        .value=${draft.document}
        @change=${(event: Event) => {
          const name = DOCUMENT_NAMES.find((item) => item === miniMeInputValue(event));
          if (name) {
            change({ ...draft, document: name });
          }
        }}
      >
        ${DOCUMENT_NAMES.map((name) => html`<option value=${name} ?selected=${draft.document === name}>${name}</option>`)}
      </select>`,
    })}
    ${renderSettingsRow({ title: t("miniMe.scope"), description: t("miniMe.scopeHelp"), stacked: true, control: inputField(t("miniMe.scope"), draft.scope, (scope) => change({ ...draft, scope }), { maxLength: 128 }) })}
    ${renderSettingsRow({ title: t("miniMe.statement"), stacked: true, control: textField(t("miniMe.statement"), draft.statement, (statement) => change({ ...draft, statement })) })}
    ${renderSettingsRow({ title: t("miniMe.preferred"), description: t("miniMe.valuesHelp"), stacked: true, control: textField(t("miniMe.preferred"), draft.preferred, (preferred) => change({ ...draft, preferred }), 3) })}
    ${renderSettingsRow({ title: t("miniMe.avoided"), description: t("miniMe.valuesHelp"), stacked: true, control: textField(t("miniMe.avoided"), draft.avoided, (avoided) => change({ ...draft, avoided }), 3) })}
  `;
}
export function renderMiniMeLearning(params: {
  snapshot: MiniMeSnapshot;
  draft: PreferenceDraft;
  busy: boolean;
  change: (draft: PreferenceDraft) => void;
  save: () => void;
  cancel: () => void;
  correct: (belief: MiniMeBelief) => void;
  undo: (id: string) => void;
  more: () => void;
}) {
  const origins = {
    direct: "originDirect",
    correction: "originCorrection",
    inferred: "originInferred",
    reference: "originReference",
    "observed-decision": "originObserved",
  } as const;
  return html`<fieldset class="settings-fieldset settings-stack" ?disabled=${params.busy}>
    ${renderSettingsSection({ title: t(params.draft.corrects ? "miniMe.correctPreference" : "miniMe.learn") }, html`${renderPreferenceForm(params.draft, params.change)}${renderSettingsRow({ title: nothing, control: html`${params.draft.corrects ? html`<button class="btn" @click=${params.cancel}>${t("miniMe.cancel")}</button>` : nothing}<button class="btn primary" @click=${params.save}>${t(params.draft.corrects ? "miniMe.correct" : "miniMe.learn")}</button>` })}`)}
    ${renderSettingsSection({ title: t("miniMe.learning") }, params.snapshot.beliefs.length ? params.snapshot.beliefs.map((belief) => renderSettingsRow({ title: belief.preference.statement, description: html`${belief.preference.scope} · ${t(`miniMe.${origins[belief.origin]}`)} · ${t(`miniMe.${belief.status}`)}`, stacked: true, control: html`<div>${renderMiniMeEvidence(belief.evidence, params.snapshot.sources)}${belief.origin === "inferred" ? html`<p>${t("miniMe.inferredDescription")}</p>` : nothing}${belief.status === "active" ? html`<div class="settings-actions"><button class="btn" @click=${() => params.correct(belief)}>${t("miniMe.correct")}</button><button class="btn" @click=${() => params.undo(belief.id)}>${t("miniMe.undo")}</button></div>` : nothing}</div>` })) : renderSettingsEmpty(t("miniMe.noLearning")))}
    ${params.snapshot.historyCursor ? html`<button class="btn" @click=${params.more}>${t("miniMe.loadMore")}</button>` : nothing}
  </fieldset>`;
}
