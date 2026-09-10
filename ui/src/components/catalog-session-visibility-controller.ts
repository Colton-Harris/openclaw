import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type {
  SessionCatalog,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type {
  UsersPrefsGetResult,
  UsersPrefsSetResult,
} from "../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { lookupCatalogSession, parseCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { showToast } from "../lib/toast.ts";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";

const PREFIX = "ui.catalog.hidden.";
type HiddenSession = {
  identity: string;
  sourceRevision: string;
  updatedAt: number;
  createdAt?: number;
  /** Explicit closed-work receipt supplied by the owning operator, not inferred from a title. */
  closedOwner?: { key: string; sessionId: string };
};
type VisibilityAction = "hide" | "restore";

function identity(
  catalogId: string,
  hostId: string,
  session: Pick<SessionCatalogSession, "sourceHomeId" | "threadId">,
): string {
  return JSON.stringify([catalogId, hostId, session.sourceHomeId, session.threadId]);
}

function preferenceKey(value: string): string {
  return PREFIX + bytesToHex(sha256(new TextEncoder().encode(value)));
}

/** A personal display preference, never a lifecycle archive or an idle-runner claim.
 * Discovery and history remain unchanged; live owners, selected, offline, and changed rows stay visible.
 */
export class CatalogSessionVisibilityController implements ReactiveController {
  private client: GatewayBrowserClient | null = null;
  private profileId: string | undefined;
  private generation = 0;
  private unsubscribe?: () => void;
  private ready = false;
  private hidden = new Map<string, HiddenSession>();
  private closedOwners = new Map<string, string>();
  private ownerGeneration = 0;
  private catalogsSnapshot: readonly SessionCatalog[] | undefined;
  private readonly showingHidden = new Set<string>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly source: {
      gateway: () => ApplicationGateway | undefined;
      catalogs: () => readonly SessionCatalog[];
      selectedKey: () => string;
    },
  ) {
    host.addController(this);
  }

  hostUpdate(): void {
    const gateway = this.source.gateway();
    const profileId = gateway?.snapshot.selfUser?.id;
    const client =
      gateway?.snapshot.phase === "connected" && profileId ? gateway.snapshot.client : null;
    if (client === this.client && profileId === this.profileId) {
      const catalogs = this.source.catalogs();
      if (catalogs !== this.catalogsSnapshot) {
        this.catalogsSnapshot = catalogs;
        void this.loadClosedOwners();
      }
      return;
    }
    this.reset();
    this.client = client;
    this.profileId = profileId;
    if (client && gateway) {
      this.unsubscribe = gateway.subscribeEvents((event) => {
        if (event.event === "users.prefs.changed") {
          void this.load();
        } else if (event.event === "sessions.changed" || event.event === "session.message") {
          // Clear cached closure immediately; resumed, unarchived, or replacement owners
          // remain visible while their current native row is being checked.
          void this.loadClosedOwners();
        }
      });
      void this.load();
    }
  }

  hostDisconnected(): void {
    this.reset();
  }

  private reset(): void {
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.client = null;
    this.profileId = undefined;
    this.ready = false;
    this.hidden.clear();
    this.ownerGeneration += 1;
    this.closedOwners.clear();
    this.catalogsSnapshot = undefined;
    this.showingHidden.clear();
    this.pending.clear();
  }

  private async load(): Promise<void> {
    const client = this.client;
    const generation = ++this.generation;
    if (!client) {
      return;
    }
    try {
      const result = await client.request<UsersPrefsGetResult>("users.prefs.get", {});
      if (this.generation !== generation) {
        return;
      }
      if (result.status !== "ok") {
        this.ready = false;
        this.hidden.clear();
        this.host.requestUpdate();
        return;
      }
      this.hidden = new Map(
        Object.entries(result.entries).flatMap(([key, value]) => {
          if (
            !key.startsWith(PREFIX) ||
            !isRecord(value) ||
            typeof value.identity !== "string" ||
            value.identity.length > 4096 ||
            typeof value.sourceRevision !== "string" ||
            !value.sourceRevision ||
            (value.closedOwner !== undefined &&
              (!isRecord(value.closedOwner) ||
                typeof value.closedOwner.key !== "string" ||
                !value.closedOwner.key ||
                typeof value.closedOwner.sessionId !== "string" ||
                !value.closedOwner.sessionId)) ||
            key !== preferenceKey(value.identity) ||
            typeof value.updatedAt !== "number" ||
            !Number.isFinite(value.updatedAt) ||
            (value.createdAt !== undefined &&
              (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)))
          ) {
            return [];
          }
          return [
            [
              value.identity,
              {
                identity: value.identity,
                sourceRevision: value.sourceRevision,
                updatedAt: value.updatedAt,
                ...(typeof value.createdAt === "number" ? { createdAt: value.createdAt } : {}),
                ...(isRecord(value.closedOwner) &&
                typeof value.closedOwner.key === "string" &&
                typeof value.closedOwner.sessionId === "string"
                  ? {
                      closedOwner: {
                        key: value.closedOwner.key,
                        sessionId: value.closedOwner.sessionId,
                      },
                    }
                  : {}),
              },
            ],
          ];
        }),
      );
      this.ready = true;
      await this.loadClosedOwners();
    } catch {
      // Unavailable personal preferences must not hide any source rows.
      if (this.generation === generation) {
        this.ready = false;
      }
    }
    this.host.requestUpdate();
  }

  private async loadClosedOwners(): Promise<void> {
    const client = this.client;
    const generation = ++this.ownerGeneration;
    this.closedOwners.clear();
    const wanted = new Set(
      [...this.hidden.values()].flatMap((value) =>
        value.closedOwner ? [value.closedOwner.key] : [],
      ),
    );
    if (!client || wanted.size === 0) {
      return;
    }
    this.host.requestUpdate();
    const verified = new Map<string, string>();
    let offset = 0;
    try {
      // The native list owns fresh run/descendant state; describe is only a persisted row.
      // Missing/inaccessible rows, bounded-out pages and unknown liveness never hide an owner.
      for (let page = 0; page < 100; page += 1) {
        const result = await client.request<SessionsListResult>("sessions.list", {
          archived: true,
          limit: 100,
          offset,
        });
        if (generation !== this.ownerGeneration || client !== this.client) {
          return;
        }
        for (const row of result.sessions) {
          if (wanted.has(row.key) && this.ownerClosed(row) && row.sessionId) {
            verified.set(row.key, row.sessionId);
          }
          wanted.delete(row.key);
        }
        if (
          wanted.size === 0 ||
          !result.hasMore ||
          result.nextOffset == null ||
          result.nextOffset <= offset
        ) {
          break;
        }
        offset = result.nextOffset;
      }
      this.closedOwners = verified;
    } catch {
      // A preference is not authority to hide an owner whose current state cannot be read.
    }
    this.host.requestUpdate();
  }

  private ownerClosed(row: GatewaySessionRow): boolean {
    return (
      row.archived === true &&
      row.status === "done" &&
      row.hasActiveRun === false &&
      row.activeRunIds?.length === 0 &&
      row.hasActiveSubagentRun === false &&
      row.subagentRunState === "historical" &&
      row.placement?.state === "local" &&
      !row.placementMove &&
      !row.worktree &&
      !row.pinned &&
      !row.hasAutomation &&
      !row.agentStatus
    );
  }

  private ownerMatches(session: SessionCatalogSession, saved: HiddenSession): boolean {
    if (!session.sessionKey) {
      return !saved.closedOwner;
    }
    return (
      saved.closedOwner?.key === session.sessionKey &&
      this.closedOwners.get(session.sessionKey) === saved.closedOwner.sessionId
    );
  }

  showsHidden(catalogId: string): boolean {
    return this.showingHidden.has(catalogId);
  }

  toggleShowHidden(catalogId: string): void {
    if (!this.showingHidden.delete(catalogId)) {
      this.showingHidden.add(catalogId);
    }
    this.host.requestUpdate();
  }

  private eligible(session: SessionCatalogSession): boolean {
    return (
      Boolean(session.sourceHomeId) &&
      Boolean(session.sourceRevision) &&
      (session.status === "stored" || session.status === "idle") &&
      typeof session.updatedAt === "number" &&
      Number.isFinite(session.updatedAt)
    );
  }

  project(catalogs: readonly SessionCatalog[]): SessionCatalog[] {
    const selectedKey = this.source.selectedKey();
    const selected = parseCatalogSessionKey(selectedKey);
    return catalogs.map((catalog) => ({
      ...catalog,
      hosts: catalog.hosts.map((host) => ({
        ...host,
        sessions: host.sessions.filter((session) => {
          if (
            !this.ready ||
            this.showsHidden(catalog.id) ||
            catalog.error ||
            !host.connected ||
            host.error ||
            !this.eligible(session) ||
            session.sessionKey === selectedKey ||
            (selected?.catalogId === catalog.id &&
              selected.hostId === host.hostId &&
              selected.threadId === session.threadId)
          ) {
            return true;
          }
          const saved = this.hidden.get(identity(catalog.id, host.hostId, session));
          return !saved || !this.matches(session, saved) || !this.ownerMatches(session, saved);
        }),
      })),
    }));
  }

  private matches(
    session: SessionCatalogSession,
    revision: Pick<CatalogSessionMenuRequest, "sourceRevision" | "updatedAt" | "createdAt">,
  ): boolean {
    return (
      session.sourceRevision === revision.sourceRevision &&
      session.updatedAt === revision.updatedAt &&
      session.createdAt === revision.createdAt
    );
  }

  action(request: CatalogSessionMenuRequest): VisibilityAction | null {
    if (!this.ready || !this.client || !request.sourceHomeId) {
      return null;
    }
    const catalog = this.source
      .catalogs()
      .find((candidate) => candidate.id === request.key.catalogId);
    const host = catalog?.hosts.find((candidate) => candidate.hostId === request.key.hostId);
    const session = host?.sessions.find(
      (candidate) =>
        candidate.threadId === request.key.threadId &&
        candidate.sourceHomeId === request.sourceHomeId,
    );
    if (!session || catalog?.error || !host?.connected || host.error) {
      return null;
    }
    if (this.hidden.has(identity(request.key.catalogId, request.key.hostId, session))) {
      return "restore";
    }
    // Adopted work needs an explicit closed-owner receipt, supplied through personal prefs
    // only after the operator reconciles the outcome. Archive status is not completion proof.
    return !session.sessionKey && this.eligible(session) && this.matches(session, request)
      ? "hide"
      : null;
  }

  async set(request: CatalogSessionMenuRequest, action: VisibilityAction): Promise<void> {
    const client = this.client;
    if (!client || this.action(request) !== action) {
      showToast({ message: t("chat.catalog.visibilityUnavailable") });
      return;
    }
    const sourceIdentity = identity(request.key.catalogId, request.key.hostId, {
      threadId: request.key.threadId,
      sourceHomeId: request.sourceHomeId,
    });
    if (this.pending.has(sourceIdentity)) {
      return;
    }
    this.pending.add(sourceIdentity);
    const profileId = this.profileId;
    const isCurrent = () => client === this.client && profileId === this.profileId;
    try {
      let value: HiddenSession | null = null;
      if (action === "hide") {
        // Menu snapshots may predate new native writes. Reuse the paginated source lookup,
        // then bind the preference to its exact revision; this never claims a runner is idle.
        const fresh = await lookupCatalogSession({
          client,
          key: request.key,
          sourceHomeId: request.sourceHomeId,
          agentId: request.agentId,
          isCurrent,
        });
        if (!isCurrent()) {
          return;
        }
        const session = fresh?.session;
        if (
          !fresh?.host?.connected ||
          fresh.host.error ||
          !session ||
          session.sessionKey ||
          !this.eligible(session) ||
          !this.matches(session, request) ||
          this.action(request) !== action
        ) {
          throw new Error(t("chat.catalog.visibilityUnavailable"));
        }
        value = {
          identity: sourceIdentity,
          sourceRevision: session.sourceRevision!,
          updatedAt: session.updatedAt!,
          ...(session.createdAt !== undefined ? { createdAt: session.createdAt } : {}),
        };
      }
      const result = await client.request<UsersPrefsSetResult>("users.prefs.set", {
        entries: { [preferenceKey(sourceIdentity)]: value },
      });
      if (client !== this.client || profileId !== this.profileId) {
        return;
      }
      if (result.status !== "ok") {
        throw new Error(t("chat.catalog.visibilityUnavailable"));
      }
      // Re-read the canonical preference store: concurrent browser/device updates must
      // not be overwritten by optimistic copies of an earlier snapshot.
      await this.load();
      if (!isCurrent()) {
        return;
      }
      showToast({
        message: t(action === "hide" ? "chat.catalog.hiddenRecovery" : "chat.catalog.restored"),
        ...(action === "hide"
          ? { actionLabel: t("common.undo"), onAction: () => void this.set(request, "restore") }
          : {}),
      });
    } catch {
      if (client === this.client && profileId === this.profileId) {
        showToast({ message: t("chat.catalog.visibilityUnavailable") });
      }
    } finally {
      if (isCurrent()) {
        this.pending.delete(sourceIdentity);
      }
    }
  }
}
