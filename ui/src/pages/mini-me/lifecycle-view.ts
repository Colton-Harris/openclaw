import { html } from "lit";
import type {
  MiniMeModels,
  MiniMeSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import type { ModelCatalogResult } from "../../api/types.ts";
import { renderSettingsRow, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { inputField } from "./home-view.ts";
import { renderMiniMeModels } from "./setup-view.ts";
export function renderMiniMeLifecycle(params: {
  snapshot: MiniMeSnapshot;
  name: string;
  models: MiniMeModels;
  catalog: ModelCatalogResult | null;
  busy: boolean;
  shutdownBusy: boolean;
  changeName: (name: string) => void;
  changeModels: (models: MiniMeModels) => void;
  save: () => void;
  pause: () => void;
  toggle: () => void;
  remove: () => void;
  export: () => void;
}) {
  const profile = params.snapshot.profile!;
  return html`<div class="settings-stack">
    <fieldset class="settings-fieldset settings-stack" ?disabled=${params.busy}>
      ${renderSettingsSection(
        { title: t("miniMe.settings") },
        html`
          ${renderSettingsRow({ title: t("miniMe.name"), control: inputField(t("miniMe.name"), params.name, params.changeName, { maxLength: 80 }) })}
          ${renderMiniMeModels({ models: params.models, catalog: params.catalog, disabled: params.busy, change: params.changeModels })}
          ${renderSettingsRow({ title: t("miniMe.destinationDescription"), control: html`<button class="btn primary" @click=${params.save}>${t("miniMe.save")}</button>` })}
        `,
      )}
      ${renderSettingsSection(
        { title: t("miniMe.control") },
        html`
          ${renderSettingsRow({ title: t(profile.learningPaused ? "miniMe.paused" : "miniMe.pause"), description: t("miniMe.pauseDescription"), control: html`<button class="btn" @click=${params.pause}>${t(profile.learningPaused ? "miniMe.resume" : "miniMe.pause")}</button>` })}
          ${renderSettingsRow({ title: t("miniMe.export"), control: html`<button class="btn" @click=${params.export}>${t("miniMe.export")}</button>` })}
        `,
      )}
    </fieldset>
    <fieldset class="settings-fieldset settings-stack" ?disabled=${params.shutdownBusy}>
      ${renderSettingsSection(
        { title: t("miniMe.disable") },
        html`
          ${renderSettingsRow({ title: t(profile.lifecycle === "disabled" ? "miniMe.disabled" : "miniMe.disable"), description: t("miniMe.disableDescription"), control: html`<button class="btn" ?disabled=${params.busy && profile.lifecycle === "disabled"} @click=${params.toggle}>${t(profile.lifecycle === "disabled" ? "miniMe.enable" : "miniMe.disable")}</button>` })}
        `,
      )}
      ${renderSettingsSection({ title: t("miniMe.delete"), danger: true }, renderSettingsRow({ title: t("miniMe.delete"), description: t("miniMe.deleteDescription"), control: html`<button class="btn danger" @click=${params.remove}>${t("miniMe.delete")}</button>` }))}
    </fieldset>
  </div>`;
}
