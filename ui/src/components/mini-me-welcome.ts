import { consume } from "@lit/context";
import { html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { saveUserPreferences } from "../app/user-prefs-cache.ts";
import { loadUserPreferences } from "../app/user-prefs-request.ts";
import { t } from "../i18n/index.ts";
import { registerMiniMeEnglish } from "../i18n/locales/en-mini-me.ts";
import { formatUiError } from "../lib/format-error.ts";
import { miniMeController } from "../lib/mini-me/controller.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { strokeIcon } from "./icons-tools.ts";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";
import "../styles/mini-me-welcome.css";
registerMiniMeEnglish();
export const MINI_ME_WELCOME_KEY = "miniMe.welcome.v1";
const symbol = strokeIcon(
  svg`<path d="M12 2c0 7-3 10-10 10 7 0 10 3 10 10 0-7 3-10 10-10-7 0-10-3-10-10Z"/><path d="m12 7 5 5-5 5-5-5Z"/>`,
);
export function renderMiniMeWelcome(params: {
  busy: boolean;
  error: string | null;
  dismiss: () => void;
  setup: () => void;
}) {
  return html`<openclaw-modal-dialog
    class="mini-me-welcome-dialog"
    label=${t("miniMe.welcome")}
    description=${t("miniMe.introduction")}
    @modal-cancel=${(event: Event) => {
      event.preventDefault();
      if (!params.busy) {
        params.dismiss();
      }
    }}
  >
    <section class="mini-me-welcome">
      <header class="mini-me-welcome__top">
        <span>${t("miniMe.newFeature")}</span
        ><button
          class="btn mini-me-welcome__close"
          aria-label=${t("miniMe.close")}
          ?disabled=${params.busy}
          @click=${params.dismiss}
        >
          ${icons.x}
        </button>
      </header>
      <div class="mini-me-welcome__art" aria-hidden="true">
        <span class="mini-me-welcome__line"></span>
        <span class="mini-me-welcome__tag mini-me-welcome__tag--taste">${t("miniMe.taste")}</span
        ><span class="mini-me-welcome__tag mini-me-welcome__tag--opinions"
          >${t("miniMe.opinions")}</span
        >
        <div class="mini-me-welcome__node">
          <span>${icons.circleUser}</span><small>${t("miniMe.you")}</small>
        </div>
        <div class="mini-me-welcome__node mini-me-welcome__node--self">
          <span>${symbol}</span><strong>${t("miniMe.yourMiniMe")}</strong>
        </div>
        <div class="mini-me-welcome__node">
          <span>${icons.bot}</span><small>${t("miniMe.yourAgents")}</small>
        </div>
        <span class="mini-me-welcome__tag mini-me-welcome__tag--values">${t("miniMe.values")}</span
        ><span class="mini-me-welcome__tag mini-me-welcome__tag--preferences"
          >${t("miniMe.preferences")}</span
        >
      </div>
      <div class="mini-me-welcome__copy">
        <h1>${t("miniMe.welcome")}</h1>
        <p>${t("miniMe.introduction")}</p>
        <p class="mini-me-welcome__control">${t("miniMe.control")}</p>
      </div>
      ${params.error ? html`<p class="callout danger" role="alert">${params.error}</p>` : nothing}
      <footer class="mini-me-welcome__actions">
        <button class="btn" ?disabled=${params.busy} @click=${params.dismiss}>
          ${t("miniMe.later")}</button
        ><button class="btn primary" ?disabled=${params.busy} @click=${params.setup}>
          ${t("miniMe.setup")} ${icons.arrowRight}
        </button>
      </footer>
      <p class="mini-me-welcome__optional">${t("miniMe.optional")}</p>
    </section>
  </openclaw-modal-dialog>`;
}
export class MiniMeWelcome extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @property({ type: Boolean }) active = true;
  @state() private eligible = false;
  @state() private dismissed = true;
  @state() private busy = false;
  @state() private error: string | null = null;
  private owner: string | null = null;
  private client: ApplicationContext["gateway"]["snapshot"]["client"] = null;
  private generation = 0;
  constructor() {
    super();
    new SubscriptionsController(this).effect(
      () => this.context,
      (context) => {
        const controller = miniMeController(context);
        return controller.subscribe(() => {
          const current = context.gateway.snapshot;
          const owner = controller.state.ownerKey;
          this.eligible = Boolean(
            controller.state.identified &&
            controller.state.snapshot &&
            !controller.state.snapshot.profile,
          );
          if (owner !== this.owner || current.client !== this.client) {
            this.owner = owner;
            this.client = current.client;
            this.generation += 1;
            this.dismissed = true;
            this.busy = false;
            this.error = null;
            if (owner && current.client) {
              void this.loadDismissal(owner, current.client, this.generation);
            }
          }
        });
      },
    );
  }
  private async loadDismissal(
    owner: string,
    client: NonNullable<typeof this.client>,
    generation: number,
  ) {
    try {
      const result = await loadUserPreferences(client, owner, { keys: [MINI_ME_WELCOME_KEY] });
      if (this.generation === generation && this.client === client && this.owner === owner) {
        this.dismissed =
          result.status !== "ok" || result.entries[MINI_ME_WELCOME_KEY] === "dismissed";
      }
    } catch {
      /* The persistent navigation remains available if notice state is unavailable. */
    }
  }
  private async dismiss(setup = false) {
    const client = this.client,
      owner = this.owner,
      generation = this.generation;
    if (!client || !owner || this.busy) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      const result = await saveUserPreferences(client, {
        entries: { [MINI_ME_WELCOME_KEY]: "dismissed" },
      });
      if (this.generation !== generation || this.client !== client || this.owner !== owner) {
        return;
      }
      if (result.status !== "ok") {
        this.error = t("miniMe.unidentified");
        return;
      }
      this.dismissed = true;
      if (setup) {
        this.context.navigate("mini-me", { search: "?setup=1" });
      }
    } catch (error) {
      if (this.generation === generation) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.generation === generation) {
        this.busy = false;
      }
    }
  }
  override render() {
    return this.active && this.eligible && !this.dismissed
      ? renderMiniMeWelcome({
          busy: this.busy,
          error: this.error,
          dismiss: () => void this.dismiss(),
          setup: () => void this.dismiss(true),
        })
      : nothing;
  }
}
if (!customElements.get("openclaw-mini-me-welcome")) {
  customElements.define("openclaw-mini-me-welcome", MiniMeWelcome);
}
