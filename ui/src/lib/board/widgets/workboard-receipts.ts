import { html, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { resolveSafeExternalUrl } from "../../open-external-url.ts";
import type { WorkboardCard, WorkboardProof } from "../../workboard/types.ts";

// This is a projection of recorded proof, never a new acceptance verdict.
// File paths remain server-owned; the browser must not resolve or fetch them.
export function renderWorkboardReceipts(
  cards: readonly WorkboardCard[],
  limit: number,
): TemplateResult {
  const rows: { card: WorkboardCard; proof: WorkboardProof; url: string }[] = [];
  for (const card of cards) {
    const proofs = card.metadata?.proof ?? [];
    // Unorderable history cannot establish the latest proof: report coverage unknown,
    // rather than resurrecting a possibly superseded pass.
    if (
      !proofs.length ||
      proofs.some(
        (proof) =>
          !Number.isFinite(proof.createdAt) || proof.createdAt <= 0 || proof.createdAt > Date.now(),
      )
    ) {
      continue;
    }
    const latestAt = Math.max(...proofs.map((proof) => proof.createdAt));
    const latest = proofs.filter((proof) => proof.createdAt === latestAt);
    // Ambiguous simultaneous proofs must not resurrect an earlier green result.
    if (latest.length !== 1) {
      continue;
    }
    const proof = latest[0];
    if (
      !proof ||
      (proof.status !== "passed" && proof.status !== "failed") ||
      !proof.command?.trim() ||
      !proof.note?.trim()
    ) {
      continue;
    }
    const artifacts =
      card.metadata?.artifacts?.filter(
        (item) =>
          proof.label?.trim() &&
          item.createdAt === proof.createdAt &&
          item.label === proof.label &&
          item.url?.trim(),
      ) ?? [];
    const artifact = artifacts.length === 1 ? artifacts[0] : undefined;
    const rawUrl = proof.url?.trim() || artifact?.url?.trim();
    // Only absolute web evidence links: not relative local paths or blob/data URLs.
    if (!rawUrl || !/^https?:\/\//iu.test(rawUrl)) {
      continue;
    }
    const url = resolveSafeExternalUrl(rawUrl, window.location.href);
    if (!url || new URL(url).username || new URL(url).password) {
      continue;
    }
    rows.push({ card, proof, url });
  }
  rows.sort(
    (left, right) =>
      right.proof.createdAt - left.proof.createdAt || left.card.id.localeCompare(right.card.id),
  );
  return html` <section class="workboard-widget-mini" data-test-id="workboard-receipts-widget">
    <header><strong>${t("workboard.widget.receiptsTitle")}</strong></header>
    <p class="workboard-widget__state">${t("workboard.widget.receiptsScope")}</p>
    ${(["passed", "failed"] as const).map((status) => {
      const matching = rows.filter((row) => row.proof.status === status);
      const visible = matching.slice(0, limit);
      return html`<section data-receipt-status=${status}>
        <h3>
          ${status === "passed" ? t("workboard.widget.receiptsPassed") : t("workboard.widget.receiptsFailed")}
          (${matching.length})
        </h3>
        <div class="workboard-widget-mini__cards">
          ${
            visible.length
              ? visible.map(
                  ({ card, proof, url }) => html`
                    <details>
                      <summary>
                        <span aria-hidden="true">●</span> ${card.title} —
                        ${proof.label ?? proof.status}
                      </summary>
                      <p>
                        <time datetime=${new Date(proof.createdAt).toISOString()}
                          >${new Date(proof.createdAt).toLocaleString()}</time
                        >
                      </p>
                      <pre>${proof.command}</pre>
                      <p>${proof.note}</p>
                      <a href=${url} target="_blank" rel="noopener noreferrer"
                        >${t("workboard.widget.receiptsLink")}</a
                      >
                    </details>
                  `,
                )
              : html`<p class="workboard-widget__state">${t("workboard.widget.receiptsEmpty")}</p>`
          }
        </div>
        ${matching.length > visible.length ? html`<p>${t("workboard.widget.receiptsLimit", { shown: String(visible.length), total: String(matching.length) })}</p>` : ""}
      </section>`;
    })}
    <p role="status">
      ${t("workboard.widget.receiptsUnknown", { count: String(cards.length - rows.length) })}
    </p>
  </section>`;
}
