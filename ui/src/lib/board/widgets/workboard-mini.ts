import { initialState, Task } from "@lit/task";
import { html, type PropertyValues, type TemplateResult } from "lit";
import { pathForRoute } from "../../../app-route-paths.ts";
import { t } from "../../../i18n/index.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import { formatUiError } from "../../format-error.ts";
import { workboardCardBoardId } from "../../workboard/board-filter.ts";
import { WORKBOARD_STATUSES } from "../../workboard/types.ts";
import type { BoardWidget } from "../types.ts";
import type { PluginBoardWidgetRenderer } from "./index.ts";
import {
  loadCronReceiptHistory,
  renderCronReceiptHistory,
  subscribeCronReceiptHistory,
} from "./workboard-cron-receipts.ts";
import { renderWorkboardReceipts } from "./workboard-receipts.ts";
import { WorkboardWidgetElement } from "./workboard-widget.ts";

class OpenClawWorkboardMiniWidget extends WorkboardWidgetElement {
  private readonly cronHistory = new Task(this, {
    args: () =>
      [this.workboardClient, this.active && this.readStringProp("view") === "receipts"] as const,
    task: async ([client, active]) => {
      if (!client || !active) {
        return initialState;
      }
      return loadCronReceiptHistory(client);
    },
  });

  private readonly cronSubscriptions = new SubscriptionsController(this).effect(
    () =>
      this.active && this.readStringProp("view") === "receipts" ? this.context?.gateway : undefined,
    (gateway) =>
      subscribeCronReceiptHistory(gateway, () => {
        if (
          this.isConnected &&
          this.active &&
          this.readStringProp("view") === "receipts" &&
          this.context?.gateway === gateway &&
          gateway.snapshot.phase === "connected" &&
          this.workboardClient === gateway.snapshot.client
        ) {
          void this.cronHistory.run();
        }
      }),
  );

  override shouldUpdate(): boolean {
    if (!this.active) {
      this.cronSubscriptions.clear();
    }
    return super.shouldUpdate();
  }

  override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (changed.get("active") === false && this.active) {
      void this.cronHistory.run();
    }
  }

  override disconnectedCallback(): void {
    this.cronSubscriptions.clear();
    void this.cronHistory.run([null, false]);
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    const board = this.renderBoard();
    if (this.readStringProp("view") !== "receipts") {
      return board;
    }
    const limit = Math.min(10, this.readPositiveIntegerProp("limit", 5));
    // Independent sources keep their own pending/error states. A card-list
    // outage must not hide recorded scheduler failures or their retry control.
    return html`${board}
      <section data-cron-receipts>
        <h3>${t("workboard.widget.receiptsCronTitle")}</h3>
        <p>${t("workboard.widget.receiptsCronScope")}</p>
        ${this.cronHistory.render({
          initial: () => html`<p>${t("workboard.widget.receiptsCronUnknown")}</p>`,
          pending: () => html`<p role="status">${t("common.loading")}</p>`,
          error: (error) => html`<p role="alert">${formatUiError(error)}</p>`,
          complete: (result) => renderCronReceiptHistory(result, limit),
        })}
        <button class="btn btn--sm" type="button" @click=${() => this.cronHistory.run()}>
          ${t("common.refresh")}
        </button>
      </section>`;
  }

  private renderBoard(): TemplateResult {
    if (this.loading && !this.loaded) {
      return html`<p class="workboard-widget__state">${t("workboard.widget.loading")}</p>`;
    }
    if (this.error) {
      return html`<div class="workboard-widget__state" role="alert">
        <span>${this.error}</span>
        <button class="btn btn--sm" type="button" @click=${() => this.retryLoad()}>
          ${t("common.retry")}
        </button>
      </div>`;
    }
    // No boardId prop means every board: silently scoping to "default" hides
    // cards created with an explicit board id and renders an all-zero widget.
    const boardId = this.readStringProp("boardId");
    const limit = Math.min(10, this.readPositiveIntegerProp("limit", 5));
    const cards = boardId
      ? this.cards.filter((card) => workboardCardBoardId(card) === boardId)
      : this.cards;
    if (this.readStringProp("view") === "receipts") {
      if (!this.loaded) {
        return html`<p class="workboard-widget__state">${t("workboard.widget.loading")}</p>`;
      }
      return renderWorkboardReceipts(cards, limit);
    }
    const topCards = cards
      .filter((card) => card.status === "ready" || card.status === "running")
      .toSorted(
        (left, right) =>
          Number(right.status === "running") - Number(left.status === "running") ||
          left.position - right.position ||
          left.title.localeCompare(right.title),
      )
      .slice(0, limit);
    const workboardBase = pathForRoute("workboard", this.context?.basePath ?? "");
    const workboardPath = boardId
      ? `${workboardBase}?board=${encodeURIComponent(boardId)}`
      : workboardBase;
    return html`
      <section class="workboard-widget-mini" data-test-id="workboard-mini-widget">
        <header>
          <strong>${boardId ?? t("workboard.allBoards")}</strong>
          <a href=${workboardPath}>${t("workboard.widget.openBoard")}</a>
        </header>
        <div class="workboard-widget-mini__counts" aria-label=${t("workboard.widget.statusCounts")}>
          ${WORKBOARD_STATUSES.map(
            (status) => html`
              <span title=${t(`workboard.status.${status}`)}>
                <b>${cards.filter((card) => card.status === status).length}</b>
                ${t(`workboard.status.${status}`)}
              </span>
            `,
          )}
        </div>
        <div class="workboard-widget-mini__cards">
          ${
            topCards.length > 0
              ? topCards.map(
                  (card) => html`
                    <div class="workboard-widget-mini__card">
                      <span
                        class=${`workboard-widget__status workboard-widget__status--${card.status}`}
                      >
                        ${t(`workboard.status.${card.status}`)}
                      </span>
                      <strong>${card.title}</strong>
                    </div>
                  `,
                )
              : html`<p class="workboard-widget__state">${t("workboard.widget.noActiveCards")}</p>`
          }
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-workboard-mini-widget")) {
  customElements.define("openclaw-workboard-mini-widget", OpenClawWorkboardMiniWidget);
}

export const renderWorkboardMiniWidget: PluginBoardWidgetRenderer = ({
  widget,
  sessionKey,
  active,
  requestUpdate,
}: {
  widget: BoardWidget;
  sessionKey: string;
  active: boolean;
  requestUpdate: () => void;
}) => html`
  <openclaw-workboard-mini-widget
    .widget=${widget}
    .sessionKey=${sessionKey}
    .active=${active}
    .hostRequestUpdate=${requestUpdate}
  ></openclaw-workboard-mini-widget>
`;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-workboard-mini-widget": OpenClawWorkboardMiniWidget;
  }
}
