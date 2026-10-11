import { html, nothing, type TemplateResult } from "lit";
import type {
  MiniMeMode,
  MiniMeSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { miniMeInputValue } from "./input-events.ts";

export const MINI_ME_MODES: MiniMeMode[] = ["dont-decide", "safe", "auto", "all"];
const MODE_KEYS = { "dont-decide": "DontDecide", safe: "Safe", auto: "Auto", all: "All" } as const;
export function modeLabel(mode: MiniMeMode) {
  return t(`miniMe.mode${MODE_KEYS[mode]}`);
}
export function modeDescription(mode: MiniMeMode) {
  return t(`miniMe.mode${MODE_KEYS[mode]}Detail`);
}
export function inputField(
  label: string,
  value: string,
  change: (value: string) => void,
  options: { type?: string; placeholder?: string; maxLength?: number; disabled?: boolean } = {},
): TemplateResult {
  return html`<input
    class="settings-input"
    aria-label=${label}
    type=${options.type ?? "text"}
    .value=${value}
    placeholder=${options.placeholder ?? ""}
    maxlength=${options.maxLength ?? nothing}
    ?disabled=${options.disabled ?? false}
    @input=${(event: Event) => change(miniMeInputValue(event))}
  />`;
}
export function textField(
  label: string,
  value: string,
  change: (value: string) => void,
  rows = 4,
  disabled = false,
): TemplateResult {
  return html`<textarea
    class="settings-input"
    aria-label=${label}
    rows=${rows}
    .value=${value}
    ?disabled=${disabled}
    @input=${(event: Event) => change(miniMeInputValue(event))}
  ></textarea>`;
}
export function sourceLabel(source: MiniMeSnapshot["sources"][number]["selection"]): string {
  return source.kind === "manual"
    ? source.label
    : source.kind === "document"
      ? source.name
      : source.sessionKey;
}
export function renderMiniMeHome(
  snapshot: MiniMeSnapshot,
  actions: { open: (tab: string) => void; chat: () => void; agentName: (id: string) => string },
) {
  const profile = snapshot.profile;
  if (!profile) {
    return nothing;
  }
  const activeBeliefs = snapshot.beliefs.filter((item) => item.status === "active");
  return html`
    ${renderSettingsSection({ title: profile.name }, [renderSettingsRow({ title: t(`miniMe.${profile.lifecycle === "active" ? "active" : profile.lifecycle === "disabled" ? "disabled" : `lifecycle${profile.lifecycle[0]!.toUpperCase()}${profile.lifecycle.slice(1)}`}`), description: !profile.models.conversationModel ? t("miniMe.chatModelRequired") : profile.learningPaused ? t("miniMe.paused") : t("miniMe.control"), control: html`<button class="btn primary" ?disabled=${profile.lifecycle !== "active" || !profile.models.conversationModel} @click=${actions.chat}>${t("miniMe.openChat", { name: profile.name })}</button>` })])}
    ${renderSettingsSection({ title: t("miniMe.learning"), actions: html`<button class="btn" @click=${() => actions.open("learning")}>${t("miniMe.learn")}</button>` }, activeBeliefs.length ? activeBeliefs.slice(0, 3).map((belief) => renderSettingsRow({ title: belief.preference.statement, description: belief.preference.scope, control: html`<span>${t(`miniMe.${belief.origin === "inferred" ? "originInferred" : belief.origin === "correction" ? "originCorrection" : "originDirect"}`)}</span>` })) : renderSettingsEmpty(t("miniMe.noLearning")))}
    ${renderSettingsSection({ title: t("miniMe.permissions"), actions: html`<button class="btn" @click=${() => actions.open("permissions")}>${t("miniMe.reviewPermissions")}</button>` }, snapshot.attachments.length ? snapshot.attachments.map((attachment) => renderSettingsRow({ title: actions.agentName(attachment.agentId), description: modeDescription(attachment.mode), control: html`<span>${modeLabel(attachment.mode)}</span>` })) : renderSettingsEmpty(t("miniMe.noAttachments")))}
    ${renderSettingsGroup([renderSettingsRow({ title: t("miniMe.authority"), control: html`<button class="btn" @click=${() => actions.open("choices")}>${t("miniMe.ask")}</button>` })])}
  `;
}
