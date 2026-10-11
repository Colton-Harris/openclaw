import type {
  MiniMeAttachParams,
  MiniMeConfigureParams,
  MiniMeCreateParams,
  MiniMeDeleteParams,
  MiniMeDetachParams,
  MiniMeDocumentSetParams,
  MiniMeExportResult,
  MiniMeHistoryResult,
  MiniMeLearnParams,
  MiniMeOutcomeParams,
  MiniMePredictParams,
  MiniMePrediction,
  MiniMeSnapshot,
  MiniMeSourceAddParams,
  MiniMeSourceRemoveParams,
  MiniMeUndoParams,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type MiniMeMutationParams = {
  "miniMe.create": MiniMeCreateParams;
  "miniMe.configure": MiniMeConfigureParams;
  "miniMe.document.set": MiniMeDocumentSetParams;
  "miniMe.source.add": MiniMeSourceAddParams;
  "miniMe.source.remove": MiniMeSourceRemoveParams;
  "miniMe.learn": MiniMeLearnParams;
  "miniMe.undo": MiniMeUndoParams;
  "miniMe.outcome": MiniMeOutcomeParams;
  "miniMe.attach": MiniMeAttachParams;
  "miniMe.detach": MiniMeDetachParams;
  "miniMe.delete": MiniMeDeleteParams;
};
export type MiniMeMutationMethod = keyof MiniMeMutationParams;
export type MiniMeClient = Pick<GatewayBrowserClient, "request">;

export function readMiniMe(client: MiniMeClient): Promise<MiniMeSnapshot> {
  return client.request<MiniMeSnapshot>("miniMe.get", {});
}
export function mutateMiniMe<M extends MiniMeMutationMethod>(
  client: MiniMeClient,
  method: M,
  params: MiniMeMutationParams[M],
): Promise<MiniMeSnapshot> {
  return client.request<MiniMeSnapshot>(method, params);
}
export function predictMiniMe(client: MiniMeClient, params: MiniMePredictParams) {
  return client.request<MiniMePrediction>("miniMe.predict", params);
}
export function exportMiniMe(client: MiniMeClient) {
  return client.request<MiniMeExportResult>("miniMe.export", {});
}
export function readMiniMeHistory(client: MiniMeClient, cursor: string) {
  return client.request<MiniMeHistoryResult>("miniMe.history", { cursor });
}
