/**
 * Projects agent activity onto key colours.
 *
 * Two independent inputs, deliberately kept separate:
 *
 * - **Agent events** (`api.agent.events.registerAgentEventSubscription`) are the
 *   live signal. They are what makes a key change while you watch it.
 * - **Session rows** are the cold-start signal. After a Gateway restart there
 *   are no events yet, but `status` and `lastRunError` still describe what every
 *   session was doing.
 *
 * The one rule binding them: a session row never overwrites a live agent event.
 * Otherwise the periodic row refresh would repaint a thinking key back to
 * whatever the row said a few seconds ago, and the device would visibly lag the
 * UI it is supposed to mirror.
 */
import type { MacropadSlotActivity } from "../contract.js";

/** Activity for a bound key. `unbound` is a slot fact, not a session fact. */
export type MacropadBoundActivity = Exclude<MacropadSlotActivity, "unbound">;

/** The subset of `AgentEventPayload` this plugin reads. */
export type AgentEventLike = {
  stream: string;
  ts?: number;
  sessionKey?: string;
  agentId?: string;
  data?: Record<string, unknown>;
};

/** The subset of `SessionRow` this plugin reads. */
export type SessionRowLike = {
  key: string;
  agentId?: string;
  label?: string;
  derivedTitle?: string;
  displayName?: string;
  color?: string;
  status?: string;
  lastRunError?: string;
  lastActivityAt?: number;
};

export type SessionActivityEntry = {
  activity: MacropadBoundActivity;
  source: "event" | "row";
  ts: number;
  agentId?: string;
  label?: string;
  /** Named sidebar tint, only ever learned from a session row. */
  color?: string;
};

export type SessionActivityState = {
  readonly entries: ReadonlyMap<string, SessionActivityEntry>;
};

export const EMPTY_ACTIVITY_STATE: SessionActivityState = { entries: new Map() };

function readPhase(data: Record<string, unknown> | undefined): string | undefined {
  const phase = data?.phase;
  return typeof phase === "string" ? phase : undefined;
}

/**
 * Map one agent event to an activity, or `undefined` when the event says
 * nothing about liveness.
 *
 * Streams this intentionally ignores (`usage`, `item`, `plan`, `patch`,
 * `compaction`, `command_output`, `tool`) all arrive mid-run and would only
 * re-assert `thinking`, which the lifecycle start already established.
 */
export function projectAgentEventActivity(
  event: AgentEventLike,
): MacropadBoundActivity | undefined {
  switch (event.stream) {
    case "lifecycle": {
      // `finishing` is an attempt fence, not a terminal phase: core emits it
      // without `executionSettled` and then emits `end` or `error` after. Going
      // idle on it would blink the key dark mid-run on every retry.
      const phase = readPhase(event.data);
      if (phase === "start") {
        return "thinking";
      }
      if (phase === "end") {
        return "idle";
      }
      if (phase === "error") {
        return "error";
      }
      return undefined;
    }
    case "approval": {
      // `requested` blocks the run; `resolved` releases it back into work.
      const phase = readPhase(event.data);
      if (phase === "resolved") {
        return "thinking";
      }
      const status = event.data?.status;
      if (phase === "requested" || status === "pending") {
        return "awaiting-approval";
      }
      return undefined;
    }
    case "thinking":
    case "assistant": {
      return "thinking";
    }
    case "error": {
      return "error";
    }
    default: {
      return undefined;
    }
  }
}

/** Map a session row to an activity. Rows always yield one - they describe a settled state. */
export function projectSessionRowActivity(row: SessionRowLike): MacropadBoundActivity {
  if (typeof row.lastRunError === "string" && row.lastRunError.trim().length > 0) {
    return "error";
  }
  switch (row.status) {
    case "failed":
    case "killed":
    case "timeout": {
      return "error";
    }
    case "running":
    case "queued": {
      return "thinking";
    }
    default: {
      // `done`, absent, or a status a newer Gateway added: nothing is happening.
      return "idle";
    }
  }
}

/** Best human-readable name for a session, in the order the sidebar prefers. */
export function sessionRowLabel(row: SessionRowLike): string | undefined {
  for (const candidate of [row.label, row.derivedTitle, row.displayName]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim().slice(0, 256);
    }
  }
  return undefined;
}

function accepts(current: SessionActivityEntry | undefined, next: SessionActivityEntry): boolean {
  if (!current) {
    return true;
  }
  if (next.source === "event" && current.source === "row") {
    return true;
  }
  if (next.source === "row" && current.source === "event") {
    return false;
  }
  return next.ts >= current.ts;
}

/**
 * Merge display metadata that only one source ever knows.
 *
 * Colour, label, and agent id arrive on rows; activity arrives on events.
 * Neither may erase the other's field, and a losing row must still be allowed
 * to teach a live session its tint - otherwise a session whose first signal was
 * an event never gets coloured at all.
 */
function mergeMetadata(
  current: SessionActivityEntry | undefined,
  next: Pick<SessionActivityEntry, "agentId" | "label" | "color">,
): Pick<SessionActivityEntry, "agentId" | "label" | "color"> {
  return {
    ...((next.agentId ?? current?.agentId) ? { agentId: next.agentId ?? current?.agentId } : {}),
    ...((next.label ?? current?.label) ? { label: next.label ?? current?.label } : {}),
    ...((next.color ?? current?.color) ? { color: next.color ?? current?.color } : {}),
  };
}

function write(
  state: SessionActivityState,
  sessionKey: string,
  next: SessionActivityEntry,
): SessionActivityState {
  const current = state.entries.get(sessionKey);
  const metadata = mergeMetadata(current, next);
  const winner: SessionActivityEntry = accepts(current, next)
    ? { activity: next.activity, source: next.source, ts: next.ts, ...metadata }
    : // SAFETY: `accepts` returns true whenever `current` is undefined.
      { ...(current as SessionActivityEntry), ...metadata };
  const entries = new Map(state.entries);
  entries.set(sessionKey, winner);
  return { entries };
}

/** Apply a live agent event. Events without a `sessionKey` cannot be attributed and are dropped. */
export function applyAgentEvent(
  state: SessionActivityState,
  event: AgentEventLike,
): SessionActivityState {
  const sessionKey = event.sessionKey;
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    return state;
  }
  const activity = projectAgentEventActivity(event);
  if (activity === undefined) {
    return state;
  }
  return write(state, sessionKey, {
    activity,
    source: "event",
    ts: typeof event.ts === "number" ? event.ts : 0,
    ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
  });
}

/** Apply a session-row snapshot. Loses to any activity a live event already set. */
export function applySessionRow(
  state: SessionActivityState,
  row: SessionRowLike,
): SessionActivityState {
  if (typeof row.key !== "string" || row.key.length === 0) {
    return state;
  }
  const label = sessionRowLabel(row);
  return write(state, row.key, {
    activity: projectSessionRowActivity(row),
    source: "row",
    ts: typeof row.lastActivityAt === "number" ? row.lastActivityAt : 0,
    ...(row.agentId === undefined ? {} : { agentId: row.agentId }),
    ...(label === undefined ? {} : { label }),
    ...(row.color === undefined ? {} : { color: row.color }),
  });
}

/** Entries retained beyond the currently bound sessions. */
export const MACROPAD_ACTIVITY_LIMIT = 256;

/**
 * Bound the activity map without losing what a key still needs.
 *
 * Dropping every unbound session looks tidier and is wrong: colours and labels
 * are only ever learned from session rows, and a session evicted before it gets
 * bound comes back untinted and unnamed. So bound sessions are always kept, and
 * only the remainder is trimmed - most recently active first.
 */
export function capActivity(
  state: SessionActivityState,
  keep: ReadonlySet<string>,
  limit = MACROPAD_ACTIVITY_LIMIT,
): SessionActivityState {
  const spare = [...state.entries].filter(([key]) => !keep.has(key));
  if (spare.length <= limit) {
    return state;
  }
  const retained = new Set([
    ...keep,
    ...spare
      .toSorted(([, left], [, right]) => right.ts - left.ts)
      .slice(0, limit)
      .map(([key]) => key),
  ]);
  const entries = new Map<string, SessionActivityEntry>();
  for (const [key, entry] of state.entries) {
    if (retained.has(key)) {
      entries.set(key, entry);
    }
  }
  return { entries };
}

export function lookupActivity(
  state: SessionActivityState,
  sessionKey: string,
): SessionActivityEntry | undefined {
  return state.entries.get(sessionKey);
}
