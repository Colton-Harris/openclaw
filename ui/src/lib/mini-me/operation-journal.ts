import { getSafeSessionStorage } from "../../local-storage.ts";
import type { MiniMeMutationMethod } from "./client.ts";

export type MiniMeOperationMethod = MiniMeMutationMethod | "miniMe.predict";
export type MiniMeOperationReceipt = {
  method: MiniMeOperationMethod;
  operationId: string;
  startedAt: number;
};
const methods = new Set<MiniMeOperationMethod>([
  "miniMe.create",
  "miniMe.configure",
  "miniMe.document.set",
  "miniMe.source.add",
  "miniMe.source.remove",
  "miniMe.learn",
  "miniMe.undo",
  "miniMe.attach",
  "miniMe.detach",
  "miniMe.delete",
  "miniMe.outcome",
  "miniMe.predict",
]);
function key(gatewayUrl: string, ownerKey: string) {
  const url = new URL(gatewayUrl);
  return `openclaw.mini-me.operations.v1:${encodeURIComponent(url.origin + url.pathname)}:${encodeURIComponent(ownerKey)}`;
}
/** A tab retains operation identity only. Source text and mutation payloads never enter storage. */
export function readMiniMeOperationReceipts(
  gatewayUrl: string,
  ownerKey: string,
): MiniMeOperationReceipt[] {
  try {
    const value: unknown = JSON.parse(
      getSafeSessionStorage()?.getItem(key(gatewayUrl, ownerKey)) ?? "[]",
    );
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is MiniMeOperationReceipt =>
      Boolean(
        item &&
        typeof item === "object" &&
        methods.has(item.method) &&
        typeof item.operationId === "string" &&
        item.operationId.length <= 128 &&
        Number.isFinite(item.startedAt),
      ),
    );
  } catch {
    return [];
  }
}
export function writeMiniMeOperationReceipts(
  gatewayUrl: string,
  ownerKey: string,
  receipts: MiniMeOperationReceipt[],
) {
  try {
    const storageKey = key(gatewayUrl, ownerKey);
    if (receipts.length) {
      getSafeSessionStorage()?.setItem(storageKey, JSON.stringify(receipts));
    } else {
      getSafeSessionStorage()?.removeItem(storageKey);
    }
  } catch {
    // In-memory reconciliation still works when browser storage is unavailable.
  }
}
