import { html } from "lit";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import type { MiniMeControllerState } from "../../lib/mini-me/controller.ts";
import type { MiniMeOperationMethod } from "../../lib/mini-me/operation-journal.ts";

export type MiniMeConfirmation = {
  title: string;
  description: string;
  confirm: string;
  action: () => Promise<unknown>;
};

// Tab holding the inputs that a restored operation must be re-entered from.
export function miniMeOperationTab(method: MiniMeOperationMethod): string {
  return method === "miniMe.document.set"
    ? "files"
    : method.startsWith("miniMe.source.")
      ? "sources"
      : ["miniMe.learn", "miniMe.undo"].includes(method)
        ? "learning"
        : ["miniMe.attach", "miniMe.detach"].includes(method)
          ? "permissions"
          : ["miniMe.predict", "miniMe.outcome"].includes(method)
            ? "choices"
            : "settings";
}

export function renderMiniMeOperationStatus(params: {
  status: NonNullable<MiniMeControllerState["operationStatus"]>;
  busy: boolean;
  reviewOperation: boolean;
  needsOriginalInputs: boolean;
  check: () => void;
  review: () => void;
  retry: () => void;
}) {
  return html`<div class="callout warn" role="status">
    <p>${t(params.status === "pending" ? "miniMe.operationPending" : "miniMe.unknownOutcome")}</p>
    <button class="btn" ?disabled=${params.busy} @click=${params.check}>
      ${t("miniMe.checkOperation")}</button
    >${
      params.needsOriginalInputs
        ? html`<p>
              ${t(params.reviewOperation ? "miniMe.reenterOperation" : "miniMe.restoredOperation")}
            </p>
            <button
              class="btn"
              ?disabled=${params.busy || params.reviewOperation}
              @click=${params.review}
            >
              ${t("miniMe.reviewOperation")}
            </button>`
        : html`<button class="btn" ?disabled=${params.busy} @click=${params.retry}>
            ${t("miniMe.retryOperation")}
          </button>`
    }
  </div>`;
}

export function renderMiniMeConfirmation(params: {
  confirmation: MiniMeConfirmation;
  cancel: () => void;
  confirm: () => void;
}) {
  const { confirmation } = params;
  return html`<openclaw-modal-dialog
    .label=${confirmation.title}
    .description=${confirmation.description}
    @modal-cancel=${params.cancel}
    ><section class="settings-page">
      <h2>${confirmation.title}</h2>
      <p>${confirmation.description}</p>
      <div class="settings-actions">
        <button class="btn" @click=${params.cancel}>${t("miniMe.cancel")}</button
        ><button class="btn danger" @click=${params.confirm}>${confirmation.confirm}</button>
      </div>
    </section></openclaw-modal-dialog
  >`;
}
