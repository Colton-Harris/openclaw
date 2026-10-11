import { html, nothing } from "lit";
import type {
  MiniMeCreateParams,
  MiniMeSourceInput,
  MiniMeSourcesAvailableResult,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import type { AgentsListResult, ModelCatalogResult } from "../../api/types.ts";
import { renderModelPicker } from "../../components/model-picker.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { inputField, sourceLabel } from "./home-view.ts";
import { miniMeInputValue } from "./input-events.ts";
import { DOCUMENT_NAMES } from "./learning-view.ts";

export type MiniMeSetupDraft = Omit<MiniMeCreateParams, "operationId">;
export function createMiniMeSetupDraft(): MiniMeSetupDraft {
  return {
    name: "",
    models: { conversationModel: null, decisionModel: null, allowInference: false },
    sources: [{ kind: "manual", label: t("miniMe.manual") }],
    attachments: [],
  };
}
export function renderMiniMeModels(params: {
  models: MiniMeSetupDraft["models"];
  catalog: ModelCatalogResult | null;
  disabled: boolean;
  change: (models: MiniMeSetupDraft["models"]) => void;
}) {
  const { models, catalog, disabled, change } = params;
  return html`
    ${renderSettingsRow({ title: t("miniMe.model"), stackedOnNarrow: true, control: renderModelPicker({ label: t("miniMe.model"), value: models.conversationModel ?? "", options: [{ value: "", label: t("miniMe.modelDefault") }, ...(catalog?.models ?? []).map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name ?? model.id, provider: model.provider }))], disabled, groupByProvider: true, onChange: (value) => change({ ...models, conversationModel: value || null, allowInference: Boolean(value) && models.allowInference }) }) })}
    ${renderSettingsRow({ title: t("miniMe.decisionRoute"), description: models.decisionModel ? undefined : t("miniMe.decisionBaseline"), stackedOnNarrow: true, control: renderModelPicker({ id: "mini-me-decision-model", label: t("miniMe.decisionRoute"), value: models.decisionModel ?? "", options: [{ value: "", label: t("miniMe.decisionBaseline") }, ...(catalog?.decisionModels ?? []).map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name, provider: model.provider })), ...(models.decisionModel && !(catalog?.decisionModels ?? []).some((model) => `${model.provider}/${model.id}` === models.decisionModel) ? [{ value: models.decisionModel, label: models.decisionModel, detail: t("miniMe.modelMissing"), disabled: true }] : [])], disabled, groupByProvider: true, onChange: (value) => change({ ...models, decisionModel: value || null }) }) })}
    ${renderSettingsToggleRow({ title: t("miniMe.inference"), description: t(models.conversationModel ? "miniMe.inferenceDescription" : "miniMe.inferenceModelRequired"), checked: models.allowInference, disabled: disabled || !models.conversationModel, onChange: (value) => change({ ...models, allowInference: value }) })}
    ${renderSettingsRow({ title: t("miniMe.destination"), description: t("miniMe.destinationDescription"), stacked: true, control: html`<div>${models.conversationModel ?? t("miniMe.modelDefaultDestination")}${models.decisionModel ? html`<br />${models.decisionModel}` : nothing}</div>` })}
  `;
}
export function renderMiniMeSetup(params: {
  draft: MiniMeSetupDraft;
  step: number;
  busy: boolean;
  catalog: ModelCatalogResult | null;
  agents: AgentsListResult["agents"];
  conversations: MiniMeSourcesAvailableResult["conversations"];
  change: (draft: MiniMeSetupDraft) => void;
  stepChange: (step: number) => void;
  create: () => void;
  cancel: () => void;
}) {
  const { draft, step, busy, change } = params;
  const selected = (source: MiniMeSourceInput) =>
    draft.sources.some((item) => JSON.stringify(item) === JSON.stringify(source));
  const toggleSource = (source: MiniMeSourceInput, checked: boolean) =>
    change({
      ...draft,
      sources: checked
        ? [...draft.sources, source]
        : draft.sources.filter((item) => JSON.stringify(item) !== JSON.stringify(source)),
    });
  return html`<fieldset class="settings-fieldset settings-stack" ?disabled=${busy}>
    ${renderSettingsSection(
      {
        title: t(
          step === 0
            ? "miniMe.setupIdentity"
            : step === 1
              ? "miniMe.setupSources"
              : "miniMe.setupReview",
        ),
        description: t("miniMe.reviewDescription"),
      },
      step === 0
        ? html`
            ${renderSettingsRow({ title: t("miniMe.name"), control: inputField(t("miniMe.name"), draft.name, (name) => change({ ...draft, name }), { maxLength: 80, placeholder: t("miniMe.namePlaceholder") }), stackedOnNarrow: true })}
            ${renderMiniMeModels({ models: draft.models, catalog: params.catalog, disabled: busy, change: (models) => change({ ...draft, models }) })}
          `
        : step === 1
          ? html`
              ${DOCUMENT_NAMES.map((name) => {
                const source: MiniMeSourceInput = { kind: "document", name };
                return renderSettingsToggleRow({
                  title: name,
                  checked: selected(source),
                  disabled: busy,
                  onChange: (checked) => toggleSource(source, checked),
                });
              })}
              ${params.conversations.map((conversation) => {
                const source = draft.sources.find(
                  (item) =>
                    item.kind === "conversation" && item.sessionKey === conversation.sessionKey,
                );
                return renderSettingsRow({
                  title: conversation.title || conversation.sessionKey,
                  description: conversation.agentId,
                  control: html`<select
                    class="settings-select"
                    aria-label=${conversation.title || conversation.sessionKey}
                    .value=${source?.kind === "conversation" ? source.mode : ""}
                    @change=${(event: Event) => {
                      const value = miniMeInputValue(event);
                      change({
                        ...draft,
                        sources: [
                          ...draft.sources.filter(
                            (item) =>
                              item.kind !== "conversation" ||
                              item.sessionKey !== conversation.sessionKey,
                          ),
                          ...(value
                            ? [
                                {
                                  kind: "conversation" as const,
                                  sessionKey: conversation.sessionKey,
                                  mode:
                                    value === "ongoing"
                                      ? ("ongoing" as const)
                                      : ("past-only" as const),
                                },
                              ]
                            : []),
                        ],
                      });
                    }}
                  >
                    <option value="" ?selected=${!source}>
                      ${t("miniMe.availableConversations")}
                    </option>
                    <option
                      value="past-only"
                      ?selected=${source?.kind === "conversation" && source.mode === "past-only"}
                    >
                      ${t("miniMe.pastOnly")}
                    </option>
                    <option
                      value="ongoing"
                      ?selected=${source?.kind === "conversation" && source.mode === "ongoing"}
                    >
                      ${t("miniMe.ongoing")}
                    </option>
                  </select>`,
                });
              })}
              ${renderSettingsRow({ title: t("miniMe.permissions"), description: t("miniMe.noPermissionDefault") })}
              ${params.agents.map((agent) => renderSettingsToggleRow({ title: agent.name ?? agent.identity?.name ?? agent.id, checked: draft.attachments.some((item) => item.agentId === agent.id), disabled: busy, onChange: (checked) => change({ ...draft, attachments: checked ? [...draft.attachments, { agentId: agent.id, mode: "dont-decide", grants: [] }] : draft.attachments.filter((item) => item.agentId !== agent.id) }) }))}
            `
          : html`
              ${renderSettingsRow({ title: t("miniMe.name"), control: html`<span>${draft.name}</span>` })}
              ${renderSettingsRow({ title: t("miniMe.destination"), control: html`<span>${draft.models.conversationModel ?? t("miniMe.modelDefaultDestination")}<br />${draft.models.decisionModel ?? t("miniMe.decisionBaseline")}</span>` })}
              ${renderSettingsRow({ title: t("miniMe.inference"), description: draft.models.allowInference ? t("miniMe.inferenceDescription") : t("miniMe.inferenceOff") })}
              ${renderSettingsRow({
                title: t("miniMe.sources"),
                stacked: true,
                control: html`<ul>
                  ${draft.sources.map((source) => html`<li>${sourceLabel(source)}${source.kind === "conversation" ? html` — ${t(source.mode === "ongoing" ? "miniMe.ongoing" : "miniMe.pastOnly")}` : nothing}</li>`)}
                </ul>`,
              })}
              ${renderSettingsRow({
                title: t("miniMe.permissions"),
                description: t("miniMe.noPermissionDefault"),
                stacked: true,
                control: html`<ul>
                  ${draft.attachments.map((attachment) => html`<li>${params.agents.find((agent) => agent.id === attachment.agentId)?.name ?? attachment.agentId} — ${t("miniMe.modeDontDecide")}</li>`)}
                </ul>`,
              })}
            `,
    )}
    <div class="settings-actions">
      <button class="btn" @click=${params.cancel}>${t("miniMe.cancel")}</button
      >${step > 0 ? html`<button class="btn" @click=${() => params.stepChange(step - 1)}>${t("miniMe.back")}</button>` : nothing}<button
        class="btn primary"
        ?disabled=${!draft.name.trim() || draft.sources.length > 16}
        @click=${step === 2 ? params.create : () => params.stepChange(step + 1)}
      >
        ${t(busy ? "miniMe.saving" : step === 2 ? "miniMe.create" : "miniMe.continue")}
      </button>
    </div>
  </fieldset>`;
}
