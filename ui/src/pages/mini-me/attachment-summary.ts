import "../../styles/settings.css";
import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { pathForRoute } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsRow, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerMiniMeEnglish } from "../../i18n/locales/en-mini-me.ts";
import { miniMeController, type MiniMeController } from "../../lib/mini-me/controller.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { modeLabel } from "./home-view.ts";
registerMiniMeEnglish();
export class MiniMeAttachmentSummary extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @property() agentId = "";
  private controller: MiniMeController | null = null;
  constructor() {
    super();
    new SubscriptionsController(this).effect(
      () => this.context,
      (context) => {
        this.controller = miniMeController(context);
        return this.controller.subscribe(() => this.requestUpdate());
      },
    );
  }
  override render() {
    const snapshot = this.controller?.state.snapshot,
      profile = snapshot?.profile;
    const attachment = snapshot?.attachments.find((item) => item.agentId === this.agentId);
    if (!profile || !attachment || !this.controller?.state.identified) {
      return nothing;
    }
    return renderSettingsSection(
      { title: t("miniMe.title") },
      renderSettingsRow({
        title: t("miniMe.attachedName", { name: profile.name }),
        description:
          profile.lifecycle === "active" ? modeLabel(attachment.mode) : t("miniMe.disabled"),
        control: html`<a
          class="btn"
          href=${pathForRoute("mini-me", this.context.basePath)}
          @click=${(event: MouseEvent) => {
            if (shouldHandleNavigationClick(event)) {
              event.preventDefault();
              this.context.navigate("mini-me");
            }
          }}
          >${t("miniMe.attachmentLink")}</a
        >`,
      }),
    );
  }
}
if (!customElements.get("openclaw-mini-me-attachment-summary")) {
  customElements.define("openclaw-mini-me-attachment-summary", MiniMeAttachmentSummary);
}
