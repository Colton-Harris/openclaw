import { html, nothing } from "lit";
import type {
  MiniMeSnapshot,
  MiniMeSourceInput,
  MiniMeSourcesAvailableResult,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { sourceLabel } from "./home-view.ts";
import { miniMeInputValue } from "./input-events.ts";
import { DOCUMENT_NAMES } from "./learning-view.ts";
export function renderMiniMeSources(params: {
  snapshot: MiniMeSnapshot;
  available: MiniMeSourcesAvailableResult["conversations"];
  busy: boolean;
  conversation: string;
  ongoing: boolean;
  select: (session: string) => void;
  setOngoing: (ongoing: boolean) => void;
  add: (source: MiniMeSourceInput) => void;
  remove: (id: string) => void;
}) {
  const statusKeys = {
    ready: "sourceReady",
    pending: "sourcePending",
    paused: "sourcePaused",
    unavailable: "sourceUnavailable",
    "limit-reached": "sourceLimit",
  } as const;
  const atLimit = params.snapshot.sources.length >= params.snapshot.capabilities.maxSources;
  return html`<fieldset class="settings-fieldset settings-stack" ?disabled=${params.busy}>
    ${renderSettingsSection({ title: t("miniMe.sources"), description: t("miniMe.sourcesDescription") }, params.snapshot.sources.length ? params.snapshot.sources.map((source) => renderSettingsRow({ title: sourceLabel(source.selection), description: html`${t(`miniMe.${statusKeys[source.status]}`)}${source.selection.kind === "conversation" ? html` · ${t(source.selection.mode === "ongoing" ? "miniMe.ongoing" : "miniMe.pastOnly")}` : nothing}${source.detail ? html` · ${source.detail}` : nothing}`, control: html`<button class="btn" @click=${() => params.remove(source.id)}>${t("miniMe.removeSource")}</button>` })) : renderSettingsEmpty(t("miniMe.noSources")))}
    ${renderSettingsSection(
      {
        title: t("miniMe.addSource"),
        description: atLimit ? t("miniMe.sourceLimitDetail") : undefined,
      },
      html`
        ${DOCUMENT_NAMES.filter((name) => !params.snapshot.sources.some((source) => source.selection.kind === "document" && source.selection.name === name)).map((name) => renderSettingsRow({ title: name, control: html`<button class="btn" ?disabled=${atLimit} @click=${() => params.add({ kind: "document", name })}>${t("miniMe.addSource")}</button>` }))}
        ${renderSettingsRow({
          title: t("miniMe.conversation"),
          description: !params.available.length ? t("miniMe.noConversations") : undefined,
          control: html`<select
            class="settings-select"
            aria-label=${t("miniMe.conversation")}
            .value=${params.conversation}
            ?disabled=${atLimit}
            @change=${(event: Event) => params.select(miniMeInputValue(event))}
          >
            <option value="" ?selected=${!params.conversation}>
              ${t("miniMe.availableConversations")}
            </option>
            ${params.available.map((item) => html`<option value=${item.sessionKey} ?selected=${params.conversation === item.sessionKey}>${item.title || item.sessionKey}</option>`)}
          </select>`,
        })}
        ${renderSettingsRow({
          title: t("miniMe.sourceMode"),
          control: html`<select
            class="settings-select"
            aria-label=${t("miniMe.sourceMode")}
            .value=${params.ongoing ? "ongoing" : "past-only"}
            @change=${(event: Event) => params.setOngoing(miniMeInputValue(event) === "ongoing")}
          >
            <option value="past-only" ?selected=${!params.ongoing}>${t("miniMe.pastOnly")}</option>
            <option value="ongoing" ?selected=${params.ongoing}>${t("miniMe.ongoing")}</option>
          </select>`,
        })}
        ${renderSettingsRow({ title: nothing, control: html`<button class="btn primary" ?disabled=${!params.conversation || atLimit} @click=${() => params.add({ kind: "conversation", sessionKey: params.conversation, mode: params.ongoing ? "ongoing" : "past-only" })}>${t("miniMe.addSource")}</button>` })}
      `,
    )}
  </fieldset>`;
}
