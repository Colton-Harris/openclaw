import type {
  MiniMeOperationGetResult,
  MiniMePredictParams,
  MiniMeSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorSelfReadAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import { generateUUID } from "../uuid.ts";
import {
  mutateMiniMe,
  predictMiniMe,
  readMiniMe,
  readMiniMeHistory,
  type MiniMeMutationMethod,
  type MiniMeMutationParams,
} from "./client.ts";
import {
  readMiniMeOperationReceipts,
  writeMiniMeOperationReceipts,
  type MiniMeOperationMethod,
} from "./operation-journal.ts";

export type MiniMeControllerState = {
  snapshot: MiniMeSnapshot | null;
  ownerKey: string | null;
  connected: boolean;
  identified: boolean;
  canWrite: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  operationStatus: "unknown" | "pending" | null;
  originalMethod: MiniMeOperationMethod | null;
  reviewOperation: boolean;
};

type PendingOperation = (
  | {
      kind: "mutation";
      method: MiniMeMutationMethod;
      params: MiniMeMutationParams[MiniMeMutationMethod];
    }
  | { kind: "prediction"; params: MiniMePredictParams }
  | { kind: "restored"; method: MiniMeOperationMethod }
) & {
  ownerKey: string;
  gatewayUrl: string;
  operationId: string;
  startedAt: number;
  replay: boolean;
};

export class MiniMeController {
  state: MiniMeControllerState = {
    snapshot: null,
    ownerKey: null,
    connected: false,
    identified: false,
    canWrite: false,
    loading: false,
    busy: false,
    error: null,
    operationStatus: null,
    originalMethod: null,
    reviewOperation: false,
  };
  private client: GatewayBrowserClient | null = null;
  private pending: PendingOperation | null = null;
  private parked: PendingOperation[] = [];
  private generation = 0;
  private readGeneration = 0;
  private listeners = new Set<() => void>();
  private stopGateway: (() => void) | null = null;
  private stopEvents: (() => void) | null = null;
  constructor(private readonly context: Pick<ApplicationContext, "gateway">) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.stopGateway) {
      this.stopGateway = this.context.gateway.subscribe(() => this.sync());
      this.stopEvents = this.context.gateway.subscribeEvents((event) => {
        if (event.event === "miniMe.changed" && !this.state.busy) {
          void this.refresh();
        }
      });
      this.sync();
    }
    listener();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.stopGateway?.();
        this.stopEvents?.();
        this.stopGateway = null;
        this.stopEvents = null;
        this.generation += 1;
        this.readGeneration += 1;
        this.client = null;
        this.state = {
          snapshot: null,
          ownerKey: null,
          connected: false,
          identified: false,
          canWrite: false,
          loading: false,
          busy: false,
          error: null,
          operationStatus: null,
          originalMethod: null,
          reviewOperation: false,
        };
      }
    };
  }
  private publish() {
    for (const listener of this.listeners) {
      listener();
    }
  }
  private sync() {
    const gateway = this.context.gateway.snapshot;
    const connected = gateway.phase === "connected";
    const identified =
      connected &&
      Boolean(gateway.selfUser?.id) &&
      hasOperatorSelfReadAccess(gateway.hello?.auth ?? null);
    const ownerKey = identified ? gateway.selfUser!.id : null;
    const canWrite = identified && hasOperatorWriteAccess(gateway.hello?.auth ?? null);
    const changed =
      gateway.client !== this.client ||
      ownerKey !== this.state.ownerKey ||
      connected !== this.state.connected;
    this.client = gateway.client;
    if (
      this.pending &&
      ((ownerKey && ownerKey !== this.pending.ownerKey) ||
        this.context.gateway.connection.gatewayUrl !== this.pending.gatewayUrl)
    ) {
      this.pending = null;
      this.parked = [];
    }
    if (changed) {
      this.generation += 1;
      this.readGeneration += 1;
      this.state = {
        snapshot: null,
        ownerKey,
        connected,
        identified,
        canWrite,
        loading: false,
        busy: false,
        error: null,
        operationStatus: null,
        originalMethod: null,
        reviewOperation: false,
      };
    } else {
      this.state = { ...this.state, connected, identified, canWrite };
    }
    if (identified && !this.pending) {
      const gatewayUrl = this.context.gateway.connection.gatewayUrl;
      const recovered = readMiniMeOperationReceipts(gatewayUrl, ownerKey!).map(
        (receipt): PendingOperation =>
          Object.assign({}, receipt, {
            kind: "restored" as const,
            replay: true,
            ownerKey: ownerKey!,
            gatewayUrl,
          }),
      );
      this.pending = recovered.shift() ?? null;
      this.parked = recovered;
    }
    if (this.pending && identified && changed) {
      this.state = {
        ...this.state,
        operationStatus: "unknown",
        originalMethod: this.method(this.pending),
        reviewOperation: false,
      };
    }
    this.publish();
    if (changed && identified) {
      if (this.pending) {
        void this.checkOperation();
      } else {
        void this.refresh();
      }
    }
  }
  private current(client: GatewayBrowserClient, generation: number) {
    return (
      this.client === client &&
      this.generation === generation &&
      this.state.identified &&
      this.context.gateway.snapshot.phase === "connected"
    );
  }
  async refresh(allowPending = false, preservedError: string | null = null): Promise<void> {
    const client = this.client,
      generation = this.generation;
    if (!client || !this.state.identified || this.state.busy || (this.pending && !allowPending)) {
      return;
    }
    const read = ++this.readGeneration;
    this.state = { ...this.state, loading: true, error: preservedError };
    this.publish();
    try {
      const snapshot = await readMiniMe(client);
      if (this.current(client, generation) && read === this.readGeneration) {
        this.state = { ...this.state, snapshot, error: preservedError };
      }
    } catch (error) {
      if (this.current(client, generation) && read === this.readGeneration) {
        this.state = { ...this.state, error: formatUiError(error) };
      }
    } finally {
      if (this.current(client, generation) && read === this.readGeneration) {
        this.state = { ...this.state, loading: false };
        this.publish();
      }
    }
  }
  private method(operation: PendingOperation): MiniMeOperationMethod {
    return operation.kind === "prediction" ? "miniMe.predict" : operation.method;
  }
  private journal() {
    const ownerKey = this.state.ownerKey;
    if (!ownerKey) {
      return;
    }
    writeMiniMeOperationReceipts(
      this.context.gateway.connection.gatewayUrl,
      ownerKey,
      [this.pending, ...this.parked]
        .filter((item): item is PendingOperation => item !== null)
        .map((item) => ({
          method: this.method(item),
          operationId: item.operationId,
          startedAt: item.startedAt,
        })),
    );
  }
  private settle() {
    this.pending = this.parked.shift() ?? null;
    this.state = {
      ...this.state,
      operationStatus: this.pending ? "unknown" : null,
      originalMethod: this.pending ? this.method(this.pending) : null,
      reviewOperation: false,
    };
    this.journal();
  }
  get needsOriginalInputs() {
    return this.pending?.kind === "restored";
  }
  reviewOriginalInputs() {
    if (
      this.pending?.kind !== "restored" ||
      this.state.operationStatus === null ||
      this.state.busy
    ) {
      return;
    }
    this.state = { ...this.state, reviewOperation: true, error: null };
    this.publish();
  }
  private prepare(
    method: MiniMeOperationMethod,
    shutdown = false,
  ): { operationId?: string; startedAt: number } | null {
    if (!this.state.ownerKey || !this.state.canWrite || this.state.busy) {
      return null;
    }
    if (
      this.pending?.kind === "restored" &&
      this.state.reviewOperation &&
      this.method(this.pending) === method
    ) {
      return { operationId: this.pending.operationId, startedAt: this.pending.startedAt };
    }
    if (this.pending && shutdown) {
      this.parked.push(this.pending);
      this.pending = null;
    }
    if (!this.pending) {
      return { startedAt: Date.now() };
    }
    if (this.state.reviewOperation) {
      this.state = {
        ...this.state,
        error: t("miniMe.operationMethodMismatch", { method: this.method(this.pending) }),
      };
      this.publish();
    }
    return null;
  }
  async mutate<M extends MiniMeMutationMethod>(
    method: M,
    params: MiniMeMutationParams[M],
  ): Promise<boolean> {
    const shutdown =
      method === "miniMe.delete" ||
      (method === "miniMe.configure" && "enabled" in params && params.enabled === false);
    const receipt = this.prepare(method, shutdown);
    if (!receipt || !this.state.ownerKey) {
      return false;
    }
    const operationId = receipt.operationId ?? params.operationId;
    this.pending = {
      kind: "mutation",
      method,
      params: { ...params, operationId },
      operationId,
      startedAt: receipt.startedAt,
      replay: Boolean(receipt.operationId),
      ownerKey: this.state.ownerKey,
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
    };
    this.journal();
    return this.dispatchPending();
  }
  async predict(params: MiniMePredictParams): Promise<boolean> {
    const receipt = this.prepare("miniMe.predict");
    if (!receipt || !this.state.ownerKey) {
      return false;
    }
    const operationId = receipt.operationId ?? params.operationId;
    this.pending = {
      kind: "prediction",
      params: { ...params, operationId },
      operationId,
      startedAt: receipt.startedAt,
      replay: Boolean(receipt.operationId),
      ownerKey: this.state.ownerKey,
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
    };
    this.journal();
    return this.dispatchPending();
  }
  private async dispatchPending(): Promise<boolean> {
    const client = this.client,
      generation = this.generation,
      pending = this.pending;
    if (
      !client ||
      !pending ||
      pending.kind === "restored" ||
      !this.state.canWrite ||
      pending.ownerKey !== this.state.ownerKey
    ) {
      return false;
    }
    this.readGeneration += 1;
    this.state = { ...this.state, busy: true, error: null };
    this.publish();
    try {
      if (pending.kind === "prediction") {
        const prediction = await predictMiniMe(client, pending.params);
        if (!this.current(client, generation) || this.pending !== pending) {
          return false;
        }
        if (this.state.snapshot) {
          this.state = {
            ...this.state,
            snapshot: {
              ...this.state.snapshot,
              predictions: [
                prediction,
                ...this.state.snapshot.predictions.filter((item) => item.id !== prediction.id),
              ],
            },
          };
        }
      } else {
        const snapshot = await mutateMiniMe(client, pending.method, pending.params);
        if (!this.current(client, generation) || this.pending !== pending) {
          return false;
        }
        this.state = { ...this.state, snapshot };
      }
      this.settle();
      return true;
    } catch (error) {
      if (!this.current(client, generation) || this.pending !== pending) {
        return false;
      }
      // A finite response can follow a partial commit. Retain that operation until
      // its durable receipt establishes completion or a rejection before admission.
      let status: MiniMeOperationGetResult["status"] = "unknown";
      if (error instanceof GatewayRequestError) {
        try {
          const receipt = await client.request<MiniMeOperationGetResult>("miniMe.operation.get", {
            operationId: pending.operationId,
          });
          if (!this.current(client, generation) || this.pending !== pending) {
            return false;
          }
          status = receipt.status;
          if (
            status === "completed" ||
            status === "failed" ||
            (status === "unknown" && !pending.replay)
          ) {
            this.settle();
          }
        } catch {
          // The receipt lookup also lost its response. The original request remains
          // unresolved; only the owner may explicitly resume it with the same ID.
        }
      }
      if (!this.current(client, generation)) {
        return false;
      }
      this.state = {
        ...this.state,
        error: formatUiError(error),
        operationStatus: this.pending ? (status === "pending" ? "pending" : "unknown") : null,
        originalMethod: this.pending ? this.method(this.pending) : null,
        reviewOperation: false,
      };
      return false;
    } finally {
      if (this.current(client, generation)) {
        this.state = { ...this.state, busy: false };
        this.publish();
      }
    }
  }
  async checkOperation(): Promise<void> {
    const client = this.client,
      generation = this.generation,
      pending = this.pending;
    if (
      !client ||
      !pending ||
      !this.state.identified ||
      pending.ownerKey !== this.state.ownerKey ||
      this.state.busy
    ) {
      return;
    }
    this.state = { ...this.state, busy: true };
    this.publish();
    try {
      const result = await client.request<MiniMeOperationGetResult>("miniMe.operation.get", {
        operationId: pending.operationId,
      });
      if (!this.current(client, generation) || this.pending !== pending) {
        return;
      }
      if (result.status === "completed" || result.status === "failed") {
        this.settle();
        this.state = { ...this.state, error: result.error ?? null };
      } else {
        this.state = { ...this.state, operationStatus: result.status };
      }
    } catch (error) {
      if (this.current(client, generation)) {
        this.state = { ...this.state, error: formatUiError(error), operationStatus: "unknown" };
      }
    } finally {
      if (this.current(client, generation)) {
        this.state = { ...this.state, busy: false };
        this.publish();
        await this.refresh(true, this.state.error);
      }
    }
  }
  async retryOperation(): Promise<void> {
    if (
      this.state.operationStatus === null ||
      this.state.busy ||
      this.pending?.kind === "restored"
    ) {
      return;
    }
    await this.checkOperation();
    if (this.state.operationStatus !== null && this.pending) {
      this.pending.replay = true;
      await this.dispatchPending();
    }
  }
  async loadMore(): Promise<void> {
    const client = this.client,
      generation = this.generation;
    const cursor = this.state.snapshot?.historyCursor;
    if (!client || !cursor || this.state.loading || this.state.busy) {
      return;
    }
    this.state = { ...this.state, loading: true, error: null };
    this.publish();
    try {
      const history = await readMiniMeHistory(client, cursor);
      const snapshot = this.state.snapshot;
      if (!this.current(client, generation) || !snapshot) {
        return;
      }
      const merge = <T extends { id: string }>(previous: T[], next: T[]) => [
        ...previous,
        ...next.filter((item) => !previous.some((old) => old.id === item.id)),
      ];
      this.state = {
        ...this.state,
        snapshot: {
          ...snapshot,
          beliefs: merge(snapshot.beliefs, history.beliefs),
          predictions: merge(snapshot.predictions, history.predictions),
          outcomes: merge(snapshot.outcomes, history.outcomes),
          historyCursor: history.cursor,
        },
      };
    } catch (error) {
      if (this.current(client, generation)) {
        this.state = { ...this.state, error: formatUiError(error) };
      }
    } finally {
      if (this.current(client, generation)) {
        this.state = { ...this.state, loading: false };
        this.publish();
      }
    }
  }
  operationId() {
    return generateUUID();
  }
}

const controllers = new WeakMap<ApplicationContext, MiniMeController>();
export function miniMeController(context: ApplicationContext): MiniMeController {
  let controller = controllers.get(context);
  if (!controller) {
    controller = new MiniMeController(context);
    controllers.set(context, controller);
  }
  return controller;
}
