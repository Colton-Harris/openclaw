import { html, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { CronRunsResult } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";

const pendingHistory = new WeakMap<GatewayBrowserClient, Promise<CronRunsResult>>();

export function loadCronReceiptHistory(client: GatewayBrowserClient): Promise<CronRunsResult> {
  const pending = pendingHistory.get(client);
  if (pending) {
    return pending;
  }
  // Share only the in-flight page for this authenticated connection. Settled
  // results are never cached, so retry cannot retain a denied or stale page.
  const load = client
    .request<CronRunsResult>("cron.runs", {
      scope: "all",
      limit: 50,
      offset: 0,
      sortDir: "desc",
    })
    .then((result) => {
      if (!result || !Array.isArray(result.entries)) {
        throw new Error(t("workboard.widget.receiptsCronInvalid"));
      }
      return result;
    });
  pendingHistory.set(client, load);
  const release = () => pendingHistory.delete(client);
  void load.then(release, release);
  return load;
}

export function renderCronReceiptHistory(result: CronRunsResult, limit: number): TemplateResult {
  const now = Date.now();
  const entries = result.entries.slice(0, 50);
  const failures = entries.filter(
    (entry) =>
      entry.action === "finished" &&
      entry.jobId.trim() &&
      Number.isFinite(entry.ts) &&
      entry.ts > 0 &&
      entry.ts <= now &&
      (entry.status === "error" ||
        (entry.deliveryStatus === "not-delivered" && Boolean(entry.deliveryError?.trim()))),
  );
  const visible = failures.slice(0, limit);
  return html`
    <p role="status">
      ${t("workboard.widget.receiptsCronCoverage", { count: String(entries.length) })}
    </p>
    ${
      visible.length
        ? visible.map(
            (entry) => html`<details>
              <summary>
                <span aria-hidden="true">●</span> ${entry.jobId} —
                ${entry.status === "error" ? t("workboard.widget.receiptsCronRunFailed") : t("workboard.widget.receiptsCronDeliveryFailed")}
              </summary>
              <time datetime=${new Date(entry.ts).toISOString()}
                >${new Date(entry.ts).toLocaleString()}</time
              >
              <pre>
${entry.error || entry.deliveryError || t("workboard.widget.receiptsAttemptNoError")}</pre>
              ${entry.error && entry.deliveryError ? html`<pre>${entry.deliveryError}</pre>` : ""}
            </details>`,
          )
        : html`<p>${t("workboard.widget.receiptsCronEmpty")}</p>`
    }
    ${failures.length > visible.length ? html`<p>${t("workboard.widget.receiptsLimit", { shown: String(visible.length), total: String(failures.length) })}</p>` : ""}
    ${result.hasMore ? html`<p>${t("workboard.widget.receiptsCronMore")}</p>` : ""}
  `;
}
