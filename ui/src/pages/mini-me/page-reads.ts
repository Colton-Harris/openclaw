import type {
  MiniMeActionGetResult,
  MiniMeActionsResult,
  MiniMeSourcesAvailableResult,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { exportMiniMe, type MiniMeClient } from "../../lib/mini-me/client.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import {
  captureMiniMeProfileRead,
  downloadMiniMeFile,
  miniMeBeforeFilename,
} from "./profile-reads.ts";

type ProfileRead = NonNullable<ReturnType<typeof captureMiniMeProfileRead>>;
type ReadError = (error: string) => void;

export async function exportMiniMeData(
  gateway: () => ApplicationGatewaySnapshot,
  error: ReadError,
) {
  const client = gateway().client,
    owner = gateway().selfUser?.id;
  if (!client || !owner) {
    return;
  }
  try {
    const result = await exportMiniMe(client);
    if (
      gateway().client !== client ||
      gateway().selfUser?.id !== owner ||
      gateway().phase !== "connected"
    ) {
      return;
    }
    downloadMiniMeFile(JSON.stringify(result, null, 2), "application/json", "mini-me-export.json");
  } catch (cause) {
    if (gateway().client === client && gateway().selfUser?.id === owner) {
      error(formatUiError(cause));
    }
  }
}

export async function loadMiniMeActions(options: {
  read: ProfileRead;
  current: () => boolean;
  more: boolean;
  actions: () => MiniMeActionsResult | null;
  publish: (actions: MiniMeActionsResult) => void;
  error: ReadError;
}) {
  const { read, current, more, actions, publish, error } = options;
  try {
    const cursor = actions()?.cursor;
    const result = await read.client.request<MiniMeActionsResult>(
      "miniMe.actions",
      more && cursor ? { cursor } : {},
    );
    if (!current()) {
      return;
    }
    publish({
      ...result,
      receipts: more ? [...(actions()?.receipts ?? []), ...result.receipts] : result.receipts,
    });
  } catch (cause) {
    if (current()) {
      error(formatUiError(cause));
    }
  }
}

export async function downloadMiniMeBefore(
  read: ProfileRead,
  current: () => boolean,
  receiptId: string,
  error: ReadError,
) {
  try {
    const result = await read.client.request<MiniMeActionGetResult>("miniMe.action.get", {
      receiptId,
    });
    if (!current()) {
      return;
    }
    downloadMiniMeFile(
      result.before.utf8,
      "text/plain;charset=utf-8",
      miniMeBeforeFilename(result.receipt.resource),
    );
  } catch (cause) {
    if (current()) {
      error(formatUiError(cause));
    }
  }
}

export function miniMeOptionsError(results: PromiseSettledResult<unknown>[]): string | null {
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => formatUiError(result.reason));
  return errors.length ? errors.join(" · ") : null;
}

export function readMiniMeOptions(client: MiniMeClient, ensureAgents: () => Promise<unknown>) {
  return Promise.allSettled([
    ensureAgents(),
    loadModelCatalog(client, {}),
    client.request<MiniMeSourcesAvailableResult>("miniMe.sources.available", {}),
  ]);
}
