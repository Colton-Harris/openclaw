import { WORKBOARD_SESSIONS_GOAL_STATUSES } from "@openclaw/workboard-contract";
import type {
  WorkboardSessionFacts,
  WorkboardSessionsBoard,
  WorkboardSessionsBoardRead,
  WorkboardSessionsBoardView,
  WorkboardSessionsColumn,
} from "@openclaw/workboard-contract";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import {
  isIncognitoSessionKey,
  resolveAgentIdFromSessionKey,
} from "openclaw/plugin-sdk/session-key-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi, OpenClawPluginService } from "../api.js";
import { sessionMatchesColumn, sessionsBoardFallback } from "./sessions-board-rules.js";
import type { WorkboardBoardStore } from "./store-boards.js";

type Gateway = Pick<
  OpenClawPluginApi["runtime"]["gateway"],
  "request" | "readSessionFacts" | "subscribeSessionChanges"
>;
type SessionsBoardServiceParams = {
  store: WorkboardBoardStore;
  gateway: Gateway;
  now?: () => number;
};
type CallerAuthority = { assertCurrent: () => void };
type Operations = {
  read: (
    boardId: string,
    view?: WorkboardSessionsBoardView,
    caller?: CallerAuthority,
  ) => Promise<WorkboardSessionsBoardRead>;
  update: (
    boardId: string,
    patch: unknown,
    caller?: CallerAuthority,
  ) => Promise<WorkboardSessionsBoard>;
  move: (
    boardId: string,
    sessionKey: string,
    columnId: string,
    caller?: CallerAuthority,
  ) => Promise<WorkboardSessionsBoardRead>;
};
export type WorkboardSessionsBoardService = OpenClawPluginService &
  Operations & { stop: () => Promise<void> };
type Owner = Operations & { cancel: () => void; stop: () => Promise<void> };
type CachedFacts = { sessionId: string; facts?: WorkboardSessionFacts; dirty: boolean };
type RosterSession = {
  facts: WorkboardSessionFacts;
  status?: string;
  lastRunId?: string;
  lifecycleRevision?: string;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
};
const FACTS_BATCH_SIZE = 40;

function rosterRunIsActive(row: RosterSession): boolean {
  return (
    row.hasActiveRun === true ||
    row.status === "queued" ||
    row.status === "running" ||
    (row.activeRunIds?.length ?? 0) > 0
  );
}

function hasCurrentRunReceipt(
  facts: WorkboardSessionFacts | undefined,
  cached: CachedFacts | undefined,
  row: RosterSession,
): boolean {
  const receipt = facts?.runReceipt;
  return (
    cached?.dirty === false &&
    !rosterRunIsActive(row) &&
    row.status !== undefined &&
    row.status !== "queued" &&
    row.status !== "running" &&
    row.lastRunId !== undefined &&
    receipt?.runId === row.lastRunId &&
    receipt.status === row.status &&
    (row.lifecycleRevision === undefined || facts?.lifecycleRevision === row.lifecycleRevision)
  );
}

function hasCurrentObserverDigest(
  facts: WorkboardSessionFacts | undefined,
  cached: CachedFacts | undefined,
  row: RosterSession,
  requireCurrentRun: boolean,
): boolean {
  const digest = facts?.observerDigest;
  if (
    cached?.dirty !== false ||
    !digest ||
    (row.lifecycleRevision !== undefined && facts?.lifecycleRevision !== row.lifecycleRevision)
  ) {
    return false;
  }
  if (digest.runId === undefined) {
    return !requireCurrentRun;
  }
  if (!digest.runId) {
    return false;
  }
  if (
    requireCurrentRun &&
    row.status === undefined &&
    row.hasActiveRun === undefined &&
    row.activeRunIds === undefined
  ) {
    return false;
  }
  if (rosterRunIsActive(row)) {
    return row.activeRunIds?.includes(digest.runId) === true;
  }
  return row.lastRunId !== undefined && digest.runId === row.lastRunId;
}

function currentFacts(
  row: RosterSession,
  cached: CachedFacts | undefined,
  requireCurrentObserverRun: boolean,
): WorkboardSessionFacts {
  const known = cached?.sessionId === row.facts.sessionId ? cached.facts : undefined;
  const facts = known ? { ...row.facts, ...known } : row.facts;
  const baseFacts = { ...facts };
  delete baseFacts.goalStatus;
  delete baseFacts.runReceipt;
  delete baseFacts.observerDigest;
  const runReceipt = hasCurrentRunReceipt(known, cached, row) ? known?.runReceipt : undefined;
  const observerDigest = hasCurrentObserverDigest(known, cached, row, requireCurrentObserverRun)
    ? known?.observerDigest
    : undefined;
  return {
    ...baseFacts,
    key: row.facts.key,
    sessionId: row.facts.sessionId,
    agentId: row.facts.agentId,
    archived: row.facts.archived,
    lastActivityAt: row.facts.lastActivityAt,
    run:
      row.status !== undefined || row.hasActiveRun !== undefined || row.activeRunIds !== undefined
        ? row.facts.run
        : (known?.run ?? row.facts.run),
    // The session list is the current source for goal state; missing or malformed is unknown.
    ...(row.facts.goalStatus !== undefined ? { goalStatus: row.facts.goalStatus } : {}),
    ...(runReceipt ? { runReceipt } : {}),
    ...(observerDigest ? { observerDigest } : {}),
  };
}

function canonicalLifecycleRules(column: WorkboardSessionsColumn) {
  if (column.match === undefined) {
    return [];
  }
  const alternatives = Array.isArray(column.match) ? column.match : [column.match];
  return alternatives.filter(
    (rule) => rule.runReceiptStatus !== undefined || rule.goalStatus !== undefined,
  );
}

function columnUsesCanonicalLifecycleMatches(column: WorkboardSessionsColumn): boolean {
  return canonicalLifecycleRules(column).length > 0;
}

function sessionMatchesCanonicalLifecycleColumn(
  facts: WorkboardSessionFacts,
  column: WorkboardSessionsColumn,
): boolean {
  const rules = canonicalLifecycleRules(column);
  return rules.length > 0 && sessionMatchesColumn(facts, { ...column, match: rules });
}

function hasCanonicalLifecycleMatches(board: WorkboardSessionsBoard): boolean {
  return board.sessions.columns.some(columnUsesCanonicalLifecycleMatches);
}

function activeState() {
  return resolveGlobalSingleton<{ owner?: Owner }>(
    Symbol.for("openclaw.workboard.sessionsBoardService"),
    () => ({}),
    (state) => {
      state.owner?.cancel();
      state.owner = undefined;
    },
  );
}

/** Uses the existing Gateway session-list owner in the invoking caller's scope. */
async function listSessions(
  gateway: Gateway,
  board: WorkboardSessionsBoard,
  view?: WorkboardSessionsBoardView,
) {
  const sessions = new Map<string, RosterSession>();
  let people: WorkboardSessionsBoardRead["people"];
  let offset = 0;
  for (;;) {
    const payload = await gateway.request<{
      sessions: unknown[];
      hasMore?: boolean;
      nextOffset?: number;
      people?: WorkboardSessionsBoardRead["people"];
    }>(
      "sessions.list",
      {
        limit: 1000,
        offset,
        configuredAgentsOnly: true,
        includeGlobal: false,
        includeUnknown: false,
        archived: board.sessions.scope?.includeArchived ? "all" : false,
        sortBy: "activity",
        activeMinutes: Math.max(1, Math.ceil((board.sessions.scope?.maxAgeHours ?? 72) * 60)),
        ...(board.sessions.scope?.agentIds?.length === 1
          ? { agentId: board.sessions.scope.agentIds[0] }
          : {}),
        ...view,
      },
      { scopes: ["operator.read"] },
    );
    if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
      throw new Error("sessions.list returned an invalid Sessions board roster.");
    }
    if (offset === 0 && view?.includePeople) {
      people = payload.people;
    }
    for (const session of payload.sessions) {
      if (
        isRecord(session) &&
        typeof session.key === "string" &&
        typeof session.sessionId === "string" &&
        session.visibility !== "draft" &&
        session.incognito !== true &&
        !isIncognitoSessionKey(session.key)
      ) {
        const status = typeof session.status === "string" ? session.status : undefined;
        const activeRunIds = Array.isArray(session.activeRunIds)
          ? session.activeRunIds.filter((runId): runId is string => typeof runId === "string")
          : undefined;
        const active =
          session.hasActiveRun === true ||
          status === "queued" ||
          status === "running" ||
          (activeRunIds?.length ?? 0) > 0;
        const observedGoalStatus =
          isRecord(session.goal) && typeof session.goal.status === "string"
            ? session.goal.status
            : undefined;
        const goalStatus =
          session.goal === undefined
            ? "none"
            : observedGoalStatus === undefined
              ? undefined
              : WORKBOARD_SESSIONS_GOAL_STATUSES.find(
                  (candidate) => candidate === observedGoalStatus,
                );
        sessions.set(session.key, {
          facts: {
            key: session.key,
            sessionId: session.sessionId,
            agentId: resolveAgentIdFromSessionKey(session.key),
            label: typeof session.label === "string" ? session.label : undefined,
            derivedTitle:
              typeof session.derivedTitle === "string" ? session.derivedTitle : undefined,
            run: active
              ? "active"
              : status === "failed" ||
                  status === "killed" ||
                  status === "timeout" ||
                  typeof session.lastRunError === "string"
                ? "failed"
                : "idle",
            ...(goalStatus !== undefined ? { goalStatus } : {}),
            pullRequests: [],
            archived: session.archived === true,
            lastActivityAt:
              typeof session.lastActivityAt === "number"
                ? session.lastActivityAt
                : typeof session.updatedAt === "number"
                  ? session.updatedAt
                  : Date.now(),
          },
          ...(status !== undefined ? { status } : {}),
          ...(typeof session.lastRunId === "string" ? { lastRunId: session.lastRunId } : {}),
          ...(typeof session.lifecycleRevision === "string"
            ? { lifecycleRevision: session.lifecycleRevision }
            : {}),
          ...(typeof session.hasActiveRun === "boolean"
            ? { hasActiveRun: session.hasActiveRun }
            : status === "queued" || status === "running" || (activeRunIds?.length ?? 0) > 0
              ? { hasActiveRun: true }
              : {}),
          ...(activeRunIds !== undefined ? { activeRunIds } : {}),
        });
      }
    }
    if (payload.hasMore !== true) {
      return { sessions, people };
    }
    const next = payload.nextOffset;
    if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= offset) {
      throw new Error("sessions.list returned an invalid Sessions board page cursor.");
    }
    offset = next;
  }
}

function inScope(facts: WorkboardSessionFacts, board: WorkboardSessionsBoard, now: number) {
  const scope = board.sessions.scope;
  // The board's own agent conversation edits the board; it is not work to place on it.
  return (
    facts.key !== board.sessions.agentSessionKey &&
    (!scope?.agentIds?.length || scope.agentIds.includes(facts.agentId)) &&
    (scope?.includeArchived === true || !facts.archived) &&
    facts.lastActivityAt >= now - (scope?.maxAgeHours ?? 72) * 3_600_000
  );
}

function createOwner(
  params: SessionsBoardServiceParams,
  context: ParametersOfStart,
  isCurrent: () => boolean,
): Owner {
  const cache = new Map<string, CachedFacts>();
  const refreshes = new Map<string, Promise<void>>();
  const reads = new Map<string, Promise<WorkboardSessionsBoardRead>>();
  const now = params.now ?? Date.now;
  let stopped = false;
  let hasRead = false;
  let factsFailureLogged = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const assertCurrent = () => {
    if (stopped || !isCurrent()) {
      throw new Error("Sessions board service is no longer active.");
    }
  };
  const interactiveAuthority = (caller?: CallerAuthority) => () => {
    assertCurrent();
    caller?.assertCurrent();
  };
  const unsubscribe = params.gateway.subscribeSessionChanges(({ sessionKey }) => {
    const previous = cache.get(sessionKey);
    if (stopped || !hasRead) {
      return;
    }
    // Replacing the cell also rejects a result started before this publication.
    if (previous) {
      cache.set(sessionKey, { ...previous, dirty: true });
    }
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped && isCurrent()) {
        params.store.announceChangeEpoch();
      }
    }, 5_000);
    timer.unref?.();
  });
  const read = async (
    id: string,
    view?: WorkboardSessionsBoardView,
    caller?: CallerAuthority,
  ): Promise<WorkboardSessionsBoardRead> => {
    const assertReadCurrent = interactiveAuthority(caller);
    assertReadCurrent();
    const board = await params.store.getSessionsBoard(id);
    hasRead = true;
    const { sessions: roster, people } = await listSessions(params.gateway, board, view);
    assertReadCurrent();
    const unavailable = new Set<string>();
    const reasons = new Set<string>();
    // Results belong to this caller's roster; omitted facts are not permission to reuse old data.
    const omitted = new Set<string>();
    while (refreshes.has(id)) {
      // A departing caller must not retire another reader's live authority.
      await refreshes.get(id)?.catch(() => {});
      assertReadCurrent();
    }
    const missing = [...roster.values()].filter((row) => {
      const cached = cache.get(row.facts.key);
      return (
        row.facts.key !== board.sessions.agentSessionKey &&
        (!cached || cached.sessionId !== row.facts.sessionId || cached.dirty)
      );
    });
    const refresh = async () => {
      for (let offset = 0; offset < missing.length; offset += FACTS_BATCH_SIZE) {
        const batch = missing.slice(offset, offset + FACTS_BATCH_SIZE);
        for (const row of batch) {
          if (cache.get(row.facts.key)?.sessionId !== row.facts.sessionId) {
            cache.set(row.facts.key, { sessionId: row.facts.sessionId, dirty: true });
          }
        }
        const before = new Map(batch.map((row) => [row.facts.key, cache.get(row.facts.key)]));
        try {
          const result = await params.gateway.readSessionFacts({
            sessionKeys: batch.map((row) => row.facts.key),
          });
          assertReadCurrent();
          const returned = new Map(result.sessions.map((facts) => [facts.key, facts]));
          for (const row of batch) {
            const facts = returned.get(row.facts.key);
            if (!facts || facts.sessionId !== row.facts.sessionId) {
              omitted.add(row.facts.key);
              if (cache.get(row.facts.key) === before.get(row.facts.key)) {
                cache.delete(row.facts.key);
              }
            } else if (cache.get(row.facts.key) === before.get(row.facts.key)) {
              cache.set(row.facts.key, { sessionId: facts.sessionId, facts, dirty: false });
            }
          }
        } catch (error) {
          assertReadCurrent();
          for (const row of batch) {
            unavailable.add(row.facts.key);
          }
          reasons.add(redactToolPayloadText(String(error)).replace(/\s+/g, " ").slice(0, 300));
        }
      }
    };
    if (missing.length) {
      const computation = refresh();
      refreshes.set(id, computation);
      try {
        await computation;
      } finally {
        if (refreshes.get(id) === computation) {
          refreshes.delete(id);
        }
      }
    }
    const placements = new Map(
      (await params.store.listSessionPlacements(id)).map((entry) => [entry.sessionKey, entry]),
    );
    assertReadCurrent();
    const fallback = sessionsBoardFallback(board);
    const requireCurrentObserverRun = hasCanonicalLifecycleMatches(board);
    const sessions: WorkboardSessionsBoardRead["sessions"] = [];
    for (const row of roster.values()) {
      if (omitted.has(row.facts.key)) {
        continue;
      }
      const cached = cache.get(row.facts.key);
      const known = cached?.sessionId === row.facts.sessionId ? cached.facts : undefined;
      const facts = currentFacts(row, cached, requireCurrentObserverRun);
      if (!inScope(facts, board, now())) {
        continue;
      }
      const pin = placements.get(row.facts.key);
      const pinColumn = board.sessions.columns.find((column) => column.id === pin?.columnId);
      const pinned =
        pin?.source === "operator" &&
        pinColumn !== undefined &&
        (!columnUsesCanonicalLifecycleMatches(pinColumn) ||
          sessionMatchesCanonicalLifecycleColumn(facts, pinColumn));
      const factsForMatching = known ? facts : { ...facts, pullRequestsUnavailable: true };
      const match = board.sessions.columns.find((column) =>
        sessionMatchesColumn(factsForMatching, column),
      );
      sessions.push({
        ...facts,
        columnId: pinned ? pin.columnId : (match ?? fallback).id,
        source: pinned ? "operator" : "state",
        reason: pinned
          ? pin.reason
          : !known || (!match && facts.pullRequestsUnavailable)
            ? "facts-unavailable"
            : match
              ? "Matched column rules"
              : "fallback",
      });
    }
    const warnings: string[] = [];
    if (unavailable.size) {
      const warning = `Session facts are unavailable for ${unavailable.size} sessions: ${[...reasons].join("; ")}. Showing last-known details; current lifecycle and goal labels use the session list, and stale terminal receipts or observer health are suppressed.`;
      warnings.push(warning);
      if (!factsFailureLogged) {
        context.logger.warn(warning);
      }
      factsFailureLogged = true;
    } else {
      factsFailureLogged = false;
    }
    if (sessions.some((session) => session.pullRequestsUnavailable)) {
      warnings.push(
        "Some pull-request information is unavailable. The board updates when background facts are ready.",
      );
    }
    return {
      board,
      columns: board.sessions.columns,
      sessions,
      ...(people !== undefined ? { people } : {}),
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  };
  const cancel = () => {
    stopped = true;
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
    }
    timer = undefined;
    cache.clear();
  };
  return {
    read(id, view, caller) {
      // A caller's roster and people facets cannot be shared with a different viewer.
      if (caller) {
        return read(id, view, caller);
      }
      const key = JSON.stringify([id, view]);
      const pending = reads.get(key);
      if (pending) {
        return pending;
      }
      const computation = read(id, view).finally(() => {
        if (reads.get(key) === computation) {
          reads.delete(key);
        }
      });
      reads.set(key, computation);
      return computation;
    },
    cancel,
    async stop() {
      cancel();
    },
    async update(id, patch, caller) {
      const assertWriteCurrent = interactiveAuthority(caller);
      assertWriteCurrent();
      return await params.store.updateSessionsBoard(id, patch, assertWriteCurrent);
    },
    async move(id, sessionKey, columnId, caller) {
      const assertWriteCurrent = interactiveAuthority(caller);
      assertWriteCurrent();
      const board = await params.store.getSessionsBoard(id);
      const targetColumn = board.sessions.columns.find((column) => column.id === columnId);
      if (!targetColumn) {
        throw new Error("Unknown Sessions board column.");
      }
      const { sessions: visible } = await listSessions(params.gateway, board);
      const rosterRow = visible.get(sessionKey);
      if (!rosterRow) {
        throw new Error("Session is not available in this board's scope.");
      }
      const result = await params.gateway.readSessionFacts({ sessionKeys: [sessionKey] });
      const facts = result.sessions.find(
        (entry) =>
          entry.key === sessionKey &&
          entry.sessionId === rosterRow.facts.sessionId &&
          inScope(entry, board, now()),
      );
      if (!facts) {
        throw new Error("Session is not available in this board's scope.");
      }
      const projectedFacts = currentFacts(
        rosterRow,
        { sessionId: facts.sessionId, facts, dirty: false },
        hasCanonicalLifecycleMatches(board),
      );
      if (
        columnUsesCanonicalLifecycleMatches(targetColumn) &&
        !sessionMatchesCanonicalLifecycleColumn(projectedFacts, targetColumn)
      ) {
        throw new Error("Session's current lifecycle facts do not match this board column.");
      }
      const previous = (await params.store.listSessionPlacements(id)).find(
        (entry) => entry.sessionKey === sessionKey,
      );
      if (
        !(await params.store.writeSessionPlacement(
          id,
          {
            sessionKey,
            columnId,
            source: "operator",
            reason: "Moved by operator",
            factsHash: "",
            updatedAt: now(),
            expectedUpdatedAt: previous?.updatedAt,
          },
          { expectedSpec: board.sessions, assertCurrent: assertWriteCurrent },
        ))
      ) {
        throw new Error("Sessions board changed. Refresh and retry the move.");
      }
      return await read(id, undefined, caller);
    },
  };
}

type ParametersOfStart = Parameters<OpenClawPluginService["start"]>[0];

/** Prepared tool registries delegate to the one running plugin service. */
export function createWorkboardSessionsBoardService(
  params: SessionsBoardServiceParams,
): WorkboardSessionsBoardService {
  let owned: Owner | undefined;
  const current = () => {
    const owner = activeState().owner;
    if (!owner) {
      throw new Error("Sessions board service is unavailable.");
    }
    return owner;
  };
  return {
    id: "workboard-sessions-board",
    async start(context) {
      const state = activeState();
      await state.owner?.stop();
      state.owner = undefined;
      const repaired = await params.store.repairSessionPlacements();
      if (repaired.placements) {
        context.logger.info(
          `Sessions board removed ${repaired.placements} non-operator placements.`,
        );
      }
      if (repaired.boards) {
        context.logger.info(`Sessions board updated default rules on ${repaired.boards} boards.`);
      }
      const owner = createOwner(params, context, () => activeState().owner === owner);
      owned = state.owner = owner;
    },
    async stop() {
      if (!owned) {
        return;
      }
      const owner = owned;
      owned = undefined;
      if (activeState().owner === owner) {
        activeState().owner = undefined;
      }
      await owner.stop();
    },
    read: (id, view, caller) => current().read(id, view, caller),
    update: (id, patch, caller) => current().update(id, patch, caller),
    move: (id, key, column, caller) => current().move(id, key, column, caller),
  };
}
