import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import { createMentionsCapability, type MentionsCapability } from "../app/mentions.ts";
import type {
  SidebarAttentionStoreController as StoreController,
  SidebarAttentionStoreSources,
} from "../app/sidebar-attention-store.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { createInitialCronState, loadCronJobsPage, loadCronStatus } from "../lib/cron/index.ts";
import { loadModelAuthStatus } from "../lib/model-auth.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  dismissSidebarAttention,
  dismissalStoreKey,
  isSidebarAttentionDismissed,
  loadDismissals,
  reconcileSidebarAttentionDismissals,
  type SidebarAttentionDismissals,
  type SidebarAttentionDismissal,
} from "./sidebar-attention-dismissals.ts";
import {
  buildScopeUpgradeInboxEntry,
  buildSidebarInboxEntries,
  buildUpdateInboxEntry,
  type SidebarInboxEntry,
  type SidebarHandoff,
} from "./sidebar-attention-entries.ts";
import {
  buildSidebarAttentionEntries,
  compareSidebarAttentionEntries,
} from "./sidebar-attention-items.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";

type SidebarAttentionOwner = {
  connectionRevision: number;
  profileId: string | null;
};

const VISIBILITY_REFRESH_MIN_AGE_MS = 60_000;
const IDLE_REFRESH_INTERVAL_MS = 10 * 60_000;

export class SidebarAttentionStoreController implements StoreController {
  readonly mentions: MentionsCapability;
  private cronJobs: CronJob[] = [];
  private handoffs: SidebarHandoff[] = [];
  private handoffError: string | null = null;
  private cronSchedulerEnabled: boolean | null = null;
  private modelAuthStatus: ModelAuthStatusResult | null = null;
  private modelAuthAgentId: string | null = null;
  private loadedOwner: SidebarAttentionOwner | null = null;
  private loadedClient = this.sources.gateway.snapshot.client;
  private loadedAgentScope = { ...this.sources.agentSelection.state };
  private cronLoadedAtMs = 0;
  private modelAuthLoadedAtMs = 0;
  private dismissedScope: string | null = null;
  private dismissed: SidebarAttentionDismissals = {};
  private loadGeneration = 0;
  private cronRefresh: { generation: number; requested: boolean } | null = null;
  private modelAuthRefresh: { generation: number; requested: boolean } | null = null;
  private readonly stopGateway: () => void;
  private readonly stopEvents: () => void;
  private readonly stopSelection: () => void;
  private readonly stopAgents: () => void;
  private readonly stopOverlays: () => void;
  private readonly stopMentions: () => void;
  private readonly idleRefreshTimer: ReturnType<typeof globalThis.setInterval>;

  constructor(
    private readonly sources: SidebarAttentionStoreSources,
    private readonly onChange: () => void,
  ) {
    // Load with the Inbox, but keep its profile state across presenter unmounts.
    this.mentions = createMentionsCapability(sources.gateway, {
      connectionBootstrap: sources.connectionBootstrap,
    });
    this.loadedClient = null;
    this.stopGateway = sources.gateway.subscribe(() => this.synchronizeGateway());
    this.stopEvents = sources.gateway.subscribeEvents((event) => {
      if (event.event === "cron" || event.event === "plugin.workboard.handoff") {
        this.load(false);
      }
    });
    this.stopSelection = sources.agentSelection.subscribe(() => this.synchronizeGateway());
    this.stopAgents = sources.agents.subscribe(onChange);
    this.stopOverlays = sources.overlays.subscribe(onChange);
    this.stopMentions = this.mentions.subscribe(onChange);
    document.addEventListener("visibilitychange", this.refreshIfStale);
    globalThis.addEventListener("storage", this.syncDismissalsFromStorage);
    this.idleRefreshTimer = globalThis.setInterval(this.refreshIfStale, IDLE_REFRESH_INTERVAL_MS);
    this.synchronizeGateway();
  }

  get entries(): readonly SidebarInboxEntry[] {
    return this.buildEntries().filter(
      (entry) => !entry.dismissal || !isSidebarAttentionDismissed(this.dismissed, entry.dismissal),
    );
  }

  private owner(): SidebarAttentionOwner {
    return {
      connectionRevision: this.sources.gateway.connectionRevision,
      profileId: this.sources.gateway.snapshot.selfUser?.id ?? null,
    };
  }

  private ownerEquals(left: SidebarAttentionOwner, right: SidebarAttentionOwner): boolean {
    return (
      left.connectionRevision === right.connectionRevision && left.profileId === right.profileId
    );
  }

  private clearHealth(): void {
    this.cronJobs = [];
    this.handoffs = [];
    this.handoffError = null;
    this.cronSchedulerEnabled = null;
    this.modelAuthStatus = null;
    this.modelAuthAgentId = null;
  }

  private cronOwnerByJobId(): ReadonlyMap<string, string> | undefined {
    const selection = this.sources.agentSelection.state;
    const roster = this.sources.agents.state.agentsList;
    if (selection.scopeId !== null || !roster) {
      return undefined;
    }
    const namesByAgentId = new Map(
      roster.agents.map((agent) => [normalizeAgentId(agent.id), normalizeAgentLabel(agent)]),
    );
    const defaultId = normalizeAgentId(roster.defaultId);
    return new Map(
      this.cronJobs.map((job) => {
        const ownerId = normalizeAgentId(job.agentId ?? defaultId);
        return [job.id, namesByAgentId.get(ownerId) ?? ownerId];
      }),
    );
  }

  private buildEntries(): SidebarInboxEntry[] {
    const gateway = this.sources.gateway.snapshot;
    if (gateway.phase !== "connected") {
      return [];
    }
    const overlay = this.sources.overlays.snapshot;
    const updateState = resolveSidebarUpdateAttention(this.sources);
    const update = buildUpdateInboxEntry({
      canDismiss: updateState.canUpdate,
      dismissal: updateState.dismissal,
      forced: updateState.forced,
      requiresAction: updateState.forced || (updateState.canUpdate && updateState.actionable),
      severity: overlay.updateStatusBanner?.tone === "danger" ? "error" : "warning",
      visible: updateState.present,
    });
    const scopeUpgrade = buildScopeUpgradeInboxEntry({
      scopes: gateway.hello?.auth?.scopes,
      state: this.sources.scopeUpgrade.state,
    });
    const attention = buildSidebarAttentionEntries({
      cronJobs: this.cronJobs,
      handoffs: this.handoffs,
      handoffError: this.handoffError ?? undefined,
      cronSchedulerEnabled: this.cronSchedulerEnabled,
      cronOwnerByJobId: this.cronOwnerByJobId(),
      modelAuthStatus: this.modelAuthStatus,
      modelAuthAgentId: this.modelAuthAgentId,
      now: Date.now(),
    }).toSorted(compareSidebarAttentionEntries);
    return buildSidebarInboxEntries({
      approvals: overlay.approvalQueue,
      attention,
      mentions: this.mentions.snapshot.items,
      scopeUpgrade,
      update,
    });
  }

  private reconcileDismissals(scope: {
    cronInventoryComplete: boolean;
    modelAuthAgentId: string | null;
  }): void {
    if (!this.dismissedScope) {
      return;
    }
    this.dismissed = reconcileSidebarAttentionDismissals({
      active: this.buildEntries().flatMap((entry) => (entry.dismissal ? [entry.dismissal] : [])),
      gatewayUrl: this.dismissedScope,
      scope,
    });
  }

  private load(refreshModelAuth = true): void {
    const gateway = this.sources.gateway.snapshot;
    const client = gateway.client;
    if (gateway.phase !== "connected" || !client) {
      return;
    }
    const owner = this.owner();
    const agentScope = { ...this.sources.agentSelection.state };
    const generation = this.loadGeneration;
    this.loadedOwner = owner;
    this.loadedClient = client;
    this.loadedAgentScope = agentScope;
    const current = () =>
      generation === this.loadGeneration &&
      this.sources.gateway.snapshot.phase === "connected" &&
      this.sources.gateway.snapshot.client === client &&
      this.ownerEquals(owner, this.owner()) &&
      this.sources.agentSelection.state.selectedId === agentScope.selectedId &&
      this.sources.agentSelection.state.scopeId === agentScope.scopeId;
    const publishSource = (scope: {
      cronInventoryComplete: boolean;
      modelAuthAgentId: string | null;
    }) => {
      if (!current()) {
        return;
      }
      if (scope.modelAuthAgentId) {
        this.modelAuthLoadedAtMs = Date.now();
      } else {
        this.cronLoadedAtMs = Date.now();
      }
      this.reconcileDismissals(scope);
      this.onChange();
    };
    const handoffMethods = gateway.hello?.features?.methods;
    if (handoffMethods?.includes("workboard.handoffs.list")) {
      try {
        void Promise.resolve(client.request("workboard.handoffs.reminders.claim", {})).catch(
          () => undefined,
        );
      } catch {
        // Older gateways do not expose the optional reminder claim method.
      }
      try {
        void Promise.resolve(client.request("workboard.handoffs.list", {}))
          .then((response) => {
            if (!current()) {
              return;
            }
            const rows = (response as { handoffs?: unknown }).handoffs;
            this.handoffError = null;
            this.handoffs = Array.isArray(rows)
              ? rows.filter((row): row is SidebarHandoff => {
                  if (!row || typeof row !== "object") {
                    return false;
                  }
                  const value = row as Record<string, unknown>;
                  return (
                    typeof value.id === "string" &&
                    typeof value.createdAt === "number" &&
                    typeof value.summary === "string" &&
                    typeof value.nextAction === "string" &&
                    Boolean(value.artifact) &&
                    typeof value.artifact === "object" &&
                    typeof (value.artifact as Record<string, unknown>).label === "string" &&
                    Array.isArray(value.attempts)
                  );
                })
              : [];
            this.onChange();
          })
          .catch(() => {
            if (current()) {
              // Keep the last scoped result visible. A transient RPC failure must
              // never turn an unresolved receipt into an apparent disappearance.
              this.handoffError = "Handoff state is stale; refresh failed.";
              this.onChange();
            }
          });
      } catch {
        // Older gateways without the handoff method leave other Inbox sources live.
      }
    }
    if (this.cronRefresh?.generation === generation) {
      this.cronRefresh.requested = true;
    } else {
      const refresh = { generation, requested: true };
      this.cronRefresh = refresh;
      void (async () => {
        try {
          // One scope owns both reads. Events during either read request one
          // trailing inventory; retired scopes never drain queued network work.
          while (refresh.requested && current()) {
            refresh.requested = false;
            const cron = createInitialCronState({ client, connected: true });
            cron.cronAgentId = agentScope.scopeId;
            await Promise.all([loadCronJobsPage(cron), loadCronStatus(cron)]);
            if (current()) {
              if (!cron.cronJobsError) {
                this.cronJobs = cron.cronJobs;
              }
              if (!cron.cronError) {
                this.cronSchedulerEnabled = cron.cronStatus?.enabled ?? null;
              }
              publishSource({
                // Keep progress visible under sustained events, but only a fresh,
                // successful inventory can establish absence and retire dismissals.
                cronInventoryComplete:
                  agentScope.scopeId === null &&
                  !cron.cronJobsHasMore &&
                  !refresh.requested &&
                  !cron.cronJobsError &&
                  !cron.cronError,
                modelAuthAgentId: null,
              });
            }
          }
        } finally {
          if (this.cronRefresh === refresh) {
            this.cronRefresh = null;
          }
        }
      })();
    }
    if (
      (refreshModelAuth || agentScope.selectedId !== this.modelAuthAgentId) &&
      agentScope.selectedId
    ) {
      if (this.modelAuthRefresh?.generation === generation) {
        // Only explicit freshness loads queue auth work; cron events cannot
        // invalidate a pending auth response or schedule another auth request.
        this.modelAuthRefresh.requested ||= refreshModelAuth;
      } else {
        const refresh = { generation, requested: true };
        const agentId = agentScope.selectedId;
        this.modelAuthRefresh = refresh;
        void (async () => {
          try {
            while (refresh.requested && current()) {
              refresh.requested = false;
              const status = await loadModelAuthStatus(client, { agentId }).catch(() => null);
              if (current()) {
                this.modelAuthStatus = status;
                this.modelAuthAgentId = agentId;
                publishSource({ cronInventoryComplete: false, modelAuthAgentId: agentId });
              }
            }
          } finally {
            if (this.modelAuthRefresh === refresh) {
              this.modelAuthRefresh = null;
            }
          }
        })();
      }
    } else if (!agentScope.selectedId) {
      this.modelAuthStatus = null;
      this.modelAuthAgentId = null;
    }
  }

  acknowledgeHandoff = async (id: string): Promise<void> => {
    const client = this.sources.gateway.snapshot.client;
    const owner = this.owner();
    if (!client || this.sources.gateway.snapshot.phase !== "connected" || !owner.profileId) {
      this.handoffError = "A signed-in profile is required to acknowledge this receipt.";
      this.onChange();
      return;
    }
    try {
      await client.request("workboard.handoffs.acknowledge", { id });
      this.handoffs = this.handoffs.map((handoff) =>
        handoff.id === id ? { ...handoff, acknowledged: { kind: "gateway" } } : handoff,
      );
      this.handoffError = null;
      this.onChange();
    } catch {
      this.handoffError = "Receipt acknowledgment failed; the handoff remains unresolved.";
      this.onChange();
    }
  };

  private synchronizeGateway(): void {
    const snapshot = this.sources.gateway.snapshot;
    const gatewayUrl = this.sources.gateway.connection.gatewayUrl;
    if (gatewayUrl && gatewayUrl !== this.dismissedScope) {
      this.dismissedScope = gatewayUrl;
      this.dismissed = loadDismissals(gatewayUrl);
    }
    if (snapshot.phase !== "connected" || !snapshot.client) {
      this.loadGeneration += 1;
      this.loadedOwner = null;
      this.loadedClient = null;
      this.clearHealth();
      this.onChange();
      return;
    }
    const owner = this.owner();
    const agentScope = this.sources.agentSelection.state;
    const ownerChanged = this.loadedOwner !== null && !this.ownerEquals(owner, this.loadedOwner);
    if (ownerChanged) {
      this.clearHealth();
      this.onChange();
    }
    if (
      !ownerChanged &&
      snapshot.client === this.loadedClient &&
      agentScope.selectedId === this.loadedAgentScope.selectedId &&
      agentScope.scopeId === this.loadedAgentScope.scopeId
    ) {
      return;
    }
    let scopeChanged = false;
    if (agentScope.selectedId !== this.loadedAgentScope.selectedId) {
      this.modelAuthStatus = null;
      this.modelAuthAgentId = null;
      scopeChanged = true;
    }
    if (agentScope.scopeId !== this.loadedAgentScope.scopeId) {
      this.cronJobs = [];
      scopeChanged = true;
    }
    if (scopeChanged) {
      this.onChange();
    }
    this.loadGeneration += 1;
    this.load();
  }

  private readonly refreshIfStale = () => {
    // Recent cron events cannot postpone an overdue auth refresh.
    const loadedAtMs = this.sources.agentSelection.state.selectedId
      ? Math.min(this.cronLoadedAtMs, this.modelAuthLoadedAtMs)
      : this.cronLoadedAtMs;
    if (
      document.visibilityState === "visible" &&
      Date.now() - loadedAtMs >= VISIBILITY_REFRESH_MIN_AGE_MS
    ) {
      this.load();
    }
  };

  private readonly syncDismissalsFromStorage = (event: StorageEvent) => {
    if (
      this.dismissedScope &&
      (event.key === null || event.key === dismissalStoreKey(this.dismissedScope))
    ) {
      this.syncDismissals();
    }
  };

  syncDismissals(): void {
    if (this.dismissedScope) {
      this.dismissed = loadDismissals(this.dismissedScope);
      this.onChange();
    }
  }

  dismiss(dismissal: SidebarAttentionDismissal): void {
    const run = this.sources.overlays.snapshot.updateRun;
    if (
      dismissal.kind === "updateAvailable" &&
      run &&
      run.status !== "running" &&
      dismissal.signature === JSON.stringify(["run", run.runId])
    ) {
      this.sources.overlays.acknowledgeUpdateRun();
      return;
    }
    if (this.dismissedScope) {
      this.dismissed = dismissSidebarAttention(this.dismissedScope, dismissal);
      this.onChange();
    }
  }

  dispose(): void {
    this.loadGeneration += 1;
    this.stopGateway();
    this.stopEvents();
    this.stopSelection();
    this.stopAgents();
    this.stopOverlays();
    this.stopMentions();
    this.mentions.dispose();
    document.removeEventListener("visibilitychange", this.refreshIfStale);
    globalThis.removeEventListener("storage", this.syncDismissalsFromStorage);
    globalThis.clearInterval(this.idleRefreshTimer);
  }
}
