import { html, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { CronRunsResult } from "../../../api/types.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { t } from "../../../i18n/index.ts";

type PendingHistory = { promise: Promise<CronRunsResult>; invalidate: () => void };
const pendingHistory = new WeakMap<GatewayBrowserClient, PendingHistory>();
const subscriptions = new WeakMap<
  ApplicationContext["gateway"],
  { listeners: Set<() => void>; unsubscribe: () => void }
>();

export function subscribeCronReceiptHistory(
  gateway: ApplicationContext["gateway"],
  listener: () => void,
): () => void {
  let subscription = subscriptions.get(gateway);
  if (!subscription) {
    const listeners = new Set<() => void>();
    const unsubscribe = gateway.subscribeEvents((event) => {
      const snapshot = gateway.snapshot;
      if (event.event !== "cron" || snapshot.phase !== "connected" || !snapshot.client) {
        return;
      }
      const pending = pendingHistory.get(snapshot.client);
      if (pending) {
        pending.invalidate();
      }
      for (const notify of listeners) {
        notify();
      }
    });
    subscription = { listeners, unsubscribe };
    subscriptions.set(gateway, subscription);
  }
  subscription.listeners.add(listener);
  return () => {
    subscription.listeners.delete(listener);
    if (subscription.listeners.size === 0) {
      subscription.unsubscribe();
      subscriptions.delete(gateway);
    }
  };
}

export function loadCronReceiptHistory(client: GatewayBrowserClient): Promise<CronRunsResult> {
  const pending = pendingHistory.get(client);
  if (pending) {
    return pending.promise;
  }
  // Every consumer awaits the same post-event page, including events arriving
  // during a rejected request. Settled pages are never cached across retries.
  const requestPage = () =>
    client.request<CronRunsResult>("cron.runs", {
      scope: "all",
      limit: 50,
      offset: 0,
      sortDir: "desc",
    });
  let invalidated = false;
  const load = (async () => {
    let page = requestPage();
    while (true) {
      try {
        const result = await page;
        if (!result || !Array.isArray(result.entries)) {
          throw new Error(t("workboard.widget.receiptsCronInvalid"));
        }
        if (!invalidated) {
          return result;
        }
      } catch (error) {
        if (!invalidated) {
          throw error;
        }
      }
      invalidated = false;
      page = requestPage();
    }
  })();
  pendingHistory.set(client, {
    promise: load,
    invalidate: () => {
      invalidated = true;
    },
  });
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
