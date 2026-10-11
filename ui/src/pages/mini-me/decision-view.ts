import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type {
  MiniMeSnapshot,
  MiniMeActionsResult,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { inputField, textField } from "./home-view.ts";
import { miniMeInputChecked, miniMeInputValue } from "./input-events.ts";
import {
  renderMiniMeEvidence,
  renderPreferenceForm,
  type PreferenceDraft,
} from "./learning-view.ts";
import { miniMeResourceLabel } from "./permissions-view.ts";
export type ChoiceDraft = { scope: string; question: string; options: string };
export function renderMiniMeDecisions(params: {
  snapshot: MiniMeSnapshot;
  draft: ChoiceDraft;
  busy: boolean;
  change: (draft: ChoiceDraft) => void;
  predict: () => void;
  predictionId: string;
  optionId: string;
  correcting: boolean;
  correction: PreferenceDraft;
  selectOutcome: (predictionId: string, optionId: string) => void;
  setCorrecting: (value: boolean) => void;
  changeCorrection: (draft: PreferenceDraft) => void;
  record: () => void;
  more: () => void;
  actions: MiniMeActionsResult | null;
  loadActions: (more: boolean) => void;
  downloadBefore: (receiptId: string) => void;
}) {
  const { draft } = params;
  return html`<fieldset class="settings-fieldset settings-stack" ?disabled=${params.busy}>
    ${renderSettingsSection(
      { title: t("miniMe.ask"), description: t("miniMe.authority") },
      html`
        ${renderSettingsRow({ title: t("miniMe.scope"), description: t("miniMe.scopeHelp"), stacked: true, control: inputField(t("miniMe.scope"), draft.scope, (scope) => params.change({ ...draft, scope }), { maxLength: 128 }) })}
        ${renderSettingsRow({ title: t("miniMe.question"), stacked: true, control: inputField(t("miniMe.question"), draft.question, (question) => params.change({ ...draft, question }), { maxLength: 4096, placeholder: t("miniMe.questionPlaceholder") }) })}
        ${renderSettingsRow({ title: t("miniMe.options"), description: t("miniMe.optionsHelp"), stacked: true, control: textField(t("miniMe.options"), draft.options, (options) => params.change({ ...draft, options })) })}
        ${renderSettingsRow({ title: nothing, control: html`<button class="btn primary" @click=${params.predict}>${t("miniMe.ask")}</button>` })}
      `,
    )}
    ${
      !params.snapshot.predictions.length
        ? renderSettingsEmpty(t("miniMe.noPredictions"))
        : repeat(
            params.snapshot.predictions,
            (prediction) => prediction.id,
            (prediction) => {
              const choice = prediction.choice.options.find(
                (option) => option.id === prediction.optionId,
              );
              const outcomes = params.snapshot.outcomes.filter(
                (outcome) => outcome.predictionId === prediction.id,
              );
              const ownerOutcome = outcomes.find((outcome) => outcome.origin === "owner");
              return renderSettingsSection(
                {
                  title: prediction.choice.question,
                  description: t("miniMe.predictedAt", {
                    date: new Date(prediction.createdAt).toLocaleString(),
                  }),
                },
                html`
                  ${renderSettingsRow({
                    title: choice?.label ?? t("miniMe.abstained"),
                    description: prediction.explanation,
                    stacked: true,
                    control: html`<div>
                      <p>
                        ${t("miniMe.uncertainty", { level: t(`miniMe.uncertainty${prediction.uncertainty[0]!.toUpperCase()}${prediction.uncertainty.slice(1)}`) })}
                      </p>
                      ${prediction.correctionApplied ? html`<p>${t("miniMe.correctionApplied")}</p>` : nothing}${renderMiniMeEvidence(prediction.evidence, params.snapshot.sources)}<small
                        >${t("miniMe.provider", { provider: prediction.provider })}</small
                      >
                    </div>`,
                  })}
                  ${outcomes.map((outcome) => renderSettingsRow({ title: t(outcome.origin === "delegated" ? "miniMe.delegatedOutcome" : "miniMe.ownerOutcome"), description: t(outcome.matched ? "miniMe.outcomeMatch" : "miniMe.outcomeMismatch"), control: html`<span>${prediction.choice.options.find((option) => option.id === outcome.optionId)?.label ?? outcome.optionId}</span>` }))}
                  ${
                    !ownerOutcome
                      ? html`
                          ${renderSettingsRow({
                            title: t("miniMe.ownerChoice"),
                            description: t("miniMe.ownerOnly"),
                            stackedOnNarrow: true,
                            control: html`<select
                              class="settings-select"
                              aria-label=${`${t("miniMe.ownerChoice")} — ${prediction.choice.question}`}
                              .value=${params.predictionId === prediction.id ? params.optionId : ""}
                              @change=${(event: Event) => params.selectOutcome(prediction.id, miniMeInputValue(event))}
                            >
                              <option
                                value=""
                                ?selected=${params.predictionId !== prediction.id || !params.optionId}
                              >
                                ${t("miniMe.ownerChoice")}
                              </option>
                              ${prediction.choice.options.map((option) => html`<option value=${option.id} ?selected=${params.predictionId === prediction.id && params.optionId === option.id}>${option.label}</option>`)}
                            </select>`,
                          })}
                          ${
                            params.predictionId === prediction.id && params.optionId
                              ? html`
                                  ${renderSettingsRow({ title: t("miniMe.correctNext"), control: html`<input type="checkbox" aria-label=${t("miniMe.correctNext")} .checked=${params.correcting} @change=${(event: Event) => params.setCorrecting(miniMeInputChecked(event))} />` })}
                                  ${params.correcting ? renderPreferenceForm(params.correction, params.changeCorrection) : nothing}
                                  ${renderSettingsRow({ title: nothing, control: html`<button class="btn" @click=${params.record}>${t("miniMe.recordChoice")}</button>` })}
                                `
                              : nothing
                          }
                        `
                      : nothing
                  }
                `,
              );
            },
          )
    }
    ${params.snapshot.historyCursor ? html`<button class="btn" @click=${params.more}>${t("miniMe.loadMore")}</button>` : nothing}
    ${renderSettingsSection(
      { title: t("miniMe.savedFiles"), description: t("miniMe.savedFilesHelp") },
      html`
        <button class="btn" @click=${() => params.loadActions(false)}>
          ${t("miniMe.loadSavedFiles")}
        </button>
        ${
          params.actions
            ? params.actions.receipts.length
              ? params.actions.receipts.map((receipt) =>
                  renderSettingsRow({
                    title: miniMeResourceLabel(receipt.resource),
                    description: `${receipt.targetAgentId} · ${new Date(receipt.createdAt).toLocaleString()}`,
                    control: html`<button
                      class="btn"
                      @click=${() => params.downloadBefore(receipt.receiptId)}
                    >
                      ${t("miniMe.downloadBefore")}
                    </button>`,
                  }),
                )
              : renderSettingsEmpty(t("miniMe.noSavedFiles"))
            : nothing
        }
        ${params.actions?.cursor ? html`<button class="btn" @click=${() => params.loadActions(true)}>${t("miniMe.loadMore")}</button>` : nothing}
      `,
    )}
  </fieldset>`;
}
