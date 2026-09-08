import { createHash, randomUUID } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { OpenClawPluginService } from "../api.js";

const MAX_SUMMARY = 2_000;
const MAX_NEXT_ACTION = 1_000;
const MAX_DELIVERY_TEXT = 4_000;
const MAX_ARTIFACT_FIELD = 500;
const MAX_ATTEMPTS = 12;
const REMINDER_INTERVAL_MS = 15 * 60_000;

export type HandoffAttemptState = "attempted" | "delivered" | "failed" | "unknown";
export type HandoffRecipient = {
  channel?: string;
  accountId?: string;
  conversationId?: string;
  to?: string;
  threadId?: string | number;
  sessionKey?: string;
};
export type HandoffArtifact = { label: string; url?: string; path?: string; mimeType?: string };
export type HandoffAttempt = {
  id: string;
  deliveryAttemptId: string;
  fingerprint: string;
  state: HandoffAttemptState;
  attemptedAt: number;
  terminalAt?: number;
  messageId?: string;
  error?: string;
};
export type HandoffRecord = {
  id: string;
  createdAt: number;
  summary: string;
  artifact: HandoffArtifact;
  nextAction: string;
  deliveryText: string;
  recipient: HandoffRecipient;
  ownerProfileId?: string;
  attempts: HandoffAttempt[];
  acknowledged?: { at: number; kind: "reply" | "explicit" | "gateway"; messageId?: string };
  reminder: {
    maximum: number;
    used: number;
    category: "agent-finished";
    quietHours: "native-preferences";
    nextAt: number;
    lastAt?: number;
  };
};
export type HandoffMessageContext = {
  channelId?: string;
  accountId?: string;
  to?: string;
  conversationId?: string;
  sessionKey?: string;
  threadId?: string | number;
  deliveryAttemptId?: string;
};
export type HandoffMessageReceived = HandoffMessageContext & {
  from?: string;
  content: string;
  replyToId?: string;
  replyToIdFull?: string;
};
export type HandoffMessageSent = HandoffMessageContext & {
  to?: string;
  content: string;
  success: boolean;
  messageId?: string;
  error?: string;
};
export type HandoffMessageSending = HandoffMessageContext & { to?: string; content: string };
export type HandoffCreateInput = {
  summary: string;
  artifact: HandoffArtifact;
  nextAction: string;
  deliveryText: string;
  recipient: HandoffRecipient;
  ownerProfileId?: string;
  idempotencyKey?: string;
};

export type HandoffReminderPreferences = {
  enabled: boolean;
  inQuietHours: boolean;
};

type HandoffChangeListener = () => void;

function bounded(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(field + " is required.");
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new Error(field + " must be " + max + " characters or fewer.");
  }
  return trimmed;
}
function optionalBounded(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : bounded(value, max, "artifact field");
}
function normalizeArtifact(input: HandoffArtifact): HandoffArtifact {
  const artifact: HandoffArtifact = {
    label: bounded(input?.label, MAX_ARTIFACT_FIELD, "artifact.label"),
  };
  for (const key of ["url", "path", "mimeType"] as const) {
    const value = optionalBounded(input?.[key], key === "mimeType" ? 128 : MAX_ARTIFACT_FIELD);
    if (value) {
      artifact[key] = value;
    }
  }
  return artifact;
}
function normalizeRecipient(input: HandoffRecipient): HandoffRecipient {
  const recipient: HandoffRecipient = {};
  for (const key of ["channel", "accountId", "conversationId", "to", "sessionKey"] as const) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) {
      recipient[key] = value.trim().slice(0, 500);
    }
  }
  if (typeof input?.threadId === "string" || typeof input?.threadId === "number") {
    recipient.threadId = input.threadId;
  }
  if (!recipient.channel || !recipient.to) {
    throw new Error("trusted delivery route requires channel and to.");
  }
  return recipient;
}
function routeFingerprint(
  message: HandoffMessageContext & { to?: string; content: string },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        message.channelId,
        message.accountId,
        message.conversationId,
        message.sessionKey,
        message.threadId,
        message.to,
        message.content,
      ]),
    )
    .digest("hex");
}
function scopedIdempotencyId(
  ownerProfileId: string | undefined,
  recipient: HandoffRecipient,
  idempotencyKey: string,
): string {
  return (
    "handoff:" +
    createHash("sha256")
      .update(JSON.stringify([ownerProfileId ?? null, recipient, idempotencyKey]))
      .digest("hex")
  );
}

function sameIdempotentPayload(left: HandoffRecord, right: HandoffRecord): boolean {
  return (
    JSON.stringify({
      summary: left.summary,
      artifact: left.artifact,
      nextAction: left.nextAction,
      deliveryText: left.deliveryText,
      recipient: left.recipient,
      ownerProfileId: left.ownerProfileId ?? null,
    }) ===
    JSON.stringify({
      summary: right.summary,
      artifact: right.artifact,
      nextAction: right.nextAction,
      deliveryText: right.deliveryText,
      recipient: right.recipient,
      ownerProfileId: right.ownerProfileId ?? null,
    })
  );
}
function routeMatchesProvided(
  recipient: HandoffRecipient,
  message: HandoffMessageContext & { to?: string; from?: string },
): boolean {
  const actualTarget = message.to ?? message.from;
  for (const [expected, actual] of [
    [recipient.channel, message.channelId],
    [recipient.accountId, message.accountId],
    [recipient.conversationId, message.conversationId],
    [recipient.sessionKey, message.sessionKey],
    [recipient.threadId, message.threadId],
  ]) {
    if (actual !== undefined && expected !== undefined && expected !== actual) {
      return false;
    }
  }
  return actualTarget === undefined || recipient.to === actualTarget;
}

function routeMatches(
  recipient: HandoffRecipient,
  message: HandoffMessageContext & { to?: string; from?: string },
): boolean {
  for (const [expected, actual] of [
    [recipient.channel, message.channelId],
    [recipient.accountId, message.accountId],
    [recipient.conversationId, message.conversationId],
    [recipient.sessionKey, message.sessionKey],
    [recipient.threadId, message.threadId],
  ]) {
    if (expected !== undefined && expected !== actual) {
      return false;
    }
  }
  return recipient.to === undefined || recipient.to === (message.to ?? message.from);
}
function isExplicitAck(content: string): boolean {
  return /^(?:ack(?:nowledged)?|received|got it|seen|understood|done)\s*[.!]?$/iu.test(
    content.trim(),
  );
}
function updateRecord(record: HandoffRecord, update: (next: HandoffRecord) => void): HandoffRecord {
  const next = structuredClone(record);
  update(next);
  return next;
}
function terminalState(
  event: HandoffMessageSent,
): Pick<HandoffAttempt, "state" | "messageId" | "error"> {
  if (event.success) {
    return { state: "delivered", ...(event.messageId ? { messageId: event.messageId } : {}) };
  }
  if (event.messageId) {
    return {
      state: "unknown",
      messageId: event.messageId,
      ...(event.error ? { error: event.error } : {}),
    };
  }
  return { state: "failed", ...(event.error ? { error: event.error } : {}) };
}

export function createHandoffService(params: {
  store: PluginStateKeyedStore<HandoffRecord>;
  now?: () => number;
}) {
  const now = params.now ?? Date.now;
  const listeners = new Set<HandoffChangeListener>();
  const changed = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const update = async (id: string, updater: (record: HandoffRecord) => HandoffRecord) => {
    let updated: HandoffRecord | undefined;
    if (!params.store.update) {
      throw new Error("handoff state store does not support atomic updates.");
    }
    await params.store.update(id, (current) => {
      if (!current) {
        return undefined;
      }
      updated = updater(current);
      return updated;
    });
    if (updated) {
      changed();
    }
    return updated;
  };
  const listAll = async () => (await params.store.entries()).map((entry) => entry.value);
  const create = async (input: HandoffCreateInput): Promise<HandoffRecord> => {
    const key = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : undefined;
    const recipient = normalizeRecipient(input.recipient);
    const ownerProfileId = input.ownerProfileId
      ? bounded(input.ownerProfileId, 200, "ownerProfileId")
      : undefined;
    const id = key
      ? scopedIdempotencyId(ownerProfileId, recipient, bounded(key, 300, "idempotencyKey"))
      : "handoff:" + randomUUID();
    const record: HandoffRecord = {
      id,
      createdAt: now(),
      summary: bounded(input.summary, MAX_SUMMARY, "summary"),
      artifact: normalizeArtifact(input.artifact),
      nextAction: bounded(input.nextAction, MAX_NEXT_ACTION, "nextAction"),
      deliveryText: bounded(input.deliveryText, MAX_DELIVERY_TEXT, "deliveryText"),
      recipient,
      ...(ownerProfileId ? { ownerProfileId } : {}),
      attempts: [],
      reminder: {
        maximum: 3,
        used: 0,
        category: "agent-finished",
        quietHours: "native-preferences",
        nextAt: now(),
      },
    };
    if (!(await params.store.registerIfAbsent(id, record))) {
      const existing = await params.store.lookup(id);
      if (!existing) {
        throw new Error("handoff idempotency record disappeared.");
      }
      if (!sameIdempotentPayload(existing, record)) {
        throw new Error("idempotency key is already bound to different handoff data.");
      }
      return existing;
    }
    changed();
    return record;
  };
  const markAttempted = async (event: HandoffMessageSending): Promise<void> => {
    const deliveryAttemptId = event.deliveryAttemptId?.trim();
    if (!deliveryAttemptId) {
      return;
    }
    if (!event.channelId || !event.to) {
      return;
    }
    const candidates = (await listAll()).filter(
      (candidate) =>
        !candidate.acknowledged &&
        !candidate.attempts.some((attempt) => attempt.state === "unknown") &&
        candidate.deliveryText === event.content &&
        routeMatchesProvided(candidate.recipient, event),
    );
    // Equal text and route are not enough to identify an item. Ambiguity must
    // remain unresolved rather than silently binding a real send to the newest row.
    if (candidates.length !== 1) {
      return;
    }
    const record = candidates[0];
    if (!record || record.attempts.length >= MAX_ATTEMPTS) {
      return;
    }
    const attemptFingerprint = routeFingerprint(event);
    await update(record.id, (current) =>
      updateRecord(current, (next) => {
        if (
          next.acknowledged ||
          next.attempts.some((attempt) => attempt.deliveryAttemptId === deliveryAttemptId) ||
          next.attempts.some((attempt) => attempt.state === "unknown")
        ) {
          return;
        }
        next.attempts.push({
          id: "attempt:" + deliveryAttemptId,
          deliveryAttemptId,
          fingerprint: attemptFingerprint,
          state: "attempted",
          attemptedAt: now(),
        });
      }),
    );
  };
  const markSent = async (event: HandoffMessageSent): Promise<void> => {
    const deliveryAttemptId = event.deliveryAttemptId?.trim();
    if (!deliveryAttemptId) {
      return;
    }
    const records = await listAll();
    const matches = records.filter((record) =>
      record.attempts.some((attempt) => attempt.deliveryAttemptId === deliveryAttemptId),
    );
    // The native attempt id is the durable correlation key. Content may be
    // transformed, chunked, or absent from a late terminal callback; never
    // rebind that callback by searching for matching text.
    if (matches.length !== 1) {
      return;
    }
    const record = matches[0];
    if (!record || !routeMatchesProvided(record.recipient, event)) {
      return;
    }
    const terminal = terminalState(event);
    await update(record.id, (current) =>
      updateRecord(current, (next) => {
        const attempt = next.attempts.find(
          (candidate) => candidate.deliveryAttemptId === deliveryAttemptId,
        );
        if (attempt?.state === "attempted") {
          Object.assign(attempt, terminal, { terminalAt: now() });
        }
      }),
    );
  };
  const acknowledge = async (
    id: string,
    kind: "reply" | "explicit" | "gateway",
    messageId?: string,
  ) => {
    const result = await update(id, (current) =>
      updateRecord(current, (next) => {
        if (!next.acknowledged) {
          next.acknowledged = { at: now(), kind, ...(messageId ? { messageId } : {}) };
        }
      }),
    );
    if (!result) {
      throw new Error("handoff not found: " + id);
    }
    return result;
  };
  const markReceived = async (event: HandoffMessageReceived): Promise<void> => {
    if (!event.channelId || (!event.from && !event.to)) {
      return;
    }
    const records = (await listAll())
      .filter((record) => !record.acknowledged && routeMatchesProvided(record.recipient, event))
      .toSorted((left, right) => right.createdAt - left.createdAt);
    const replyTo = event.replyToIdFull ?? event.replyToId;
    for (const record of records) {
      if (replyTo && record.attempts.some((attempt) => attempt.messageId === replyTo)) {
        await acknowledge(record.id, "reply", replyTo);
        return;
      }
    }
    const delivered = records.filter((record) =>
      record.attempts.some((attempt) => attempt.state === "delivered"),
    );
    const [onlyDelivered] = delivered;
    // A bare “got it” is not enough to acknowledge a generated, attempted, or
    // uncertain item. It can only stop reminders after native delivery was
    // durably confirmed on this exact route.
    if (isExplicitAck(event.content) && delivered.length === 1 && onlyDelivered) {
      await acknowledge(onlyDelivered.id, "explicit");
    }
  };
  const claimReminder = async (
    id: string,
    scope: { ownerProfileId?: string; context?: HandoffMessageContext },
    preferences: HandoffReminderPreferences,
    at = now(),
  ) => {
    const current = await params.store.lookup(id);
    if (
      (!scope.ownerProfileId && !scope.context) ||
      !current ||
      current.acknowledged ||
      (scope.ownerProfileId !== undefined && current.ownerProfileId !== scope.ownerProfileId) ||
      (scope.context !== undefined && !routeMatches(current.recipient, scope.context))
    ) {
      throw new Error("handoff not found.");
    }
    let claimed: HandoffRecord | undefined;
    if (!params.store.update) {
      throw new Error("handoff state store does not support atomic updates.");
    }
    await params.store.update(id, (record) => {
      if (
        !record ||
        record.acknowledged ||
        record.reminder.used >= record.reminder.maximum ||
        at < record.reminder.nextAt ||
        !preferences.enabled ||
        preferences.inQuietHours
      ) {
        return record;
      }
      claimed = updateRecord(record, (next) => {
        next.reminder.used += 1;
        next.reminder.lastAt = at;
        next.reminder.nextAt = at + REMINDER_INTERVAL_MS;
      });
      return claimed;
    });
    if (claimed) {
      changed();
    }
    return claimed;
  };
  const claimDueReminders = async (
    scope: { ownerProfileId?: string; context?: HandoffMessageContext },
    preferences: HandoffReminderPreferences,
    at = now(),
    limit = 3,
  ) => {
    if (!scope.ownerProfileId && !scope.context) {
      throw new Error("handoff reminder scope is required.");
    }
    const all = await listAll();
    const visible = scope.ownerProfileId
      ? all.filter((record) => record.ownerProfileId === scope.ownerProfileId)
      : all.filter((record) => scope.context && routeMatches(record.recipient, scope.context));
    const claimed: HandoffRecord[] = [];
    for (const record of visible.toSorted((left, right) => left.createdAt - right.createdAt)) {
      if (claimed.length >= Math.max(0, Math.min(limit, 3))) {
        break;
      }
      const next = await claimReminder(record.id, scope, preferences, at);
      if (next) {
        claimed.push(next);
      }
    }
    return claimed;
  };
  return {
    create,
    listAll,
    listForProfile: async (profileId: string) =>
      (await listAll()).filter((record) => record.ownerProfileId === profileId),
    listForContext: async (context: HandoffMessageContext) =>
      (await listAll()).filter((record) => routeMatches(record.recipient, context)),
    acknowledgeForContext: async (id: string, context: HandoffMessageContext) => {
      const record = await params.store.lookup(id);
      if (!record || !routeMatches(record.recipient, context)) {
        throw new Error("handoff not found.");
      }
      return acknowledge(id, "gateway");
    },
    acknowledge,
    markAttempted,
    markSent,
    markReceived,
    claimReminder,
    claimDueReminders,
    subscribe(listener: HandoffChangeListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export type HandoffService = ReturnType<typeof createHandoffService>;

export function createHandoffChangeEventService(
  handoffs: ReturnType<typeof createHandoffService>,
): OpenClawPluginService & { stop: () => void } {
  let unsubscribe: (() => void) | undefined;
  let gatewayEvents: Parameters<NonNullable<OpenClawPluginService["start"]>>[0]["gatewayEvents"];
  return {
    id: "workboard-handoff-events",
    start(ctx) {
      gatewayEvents = ctx.gatewayEvents;
      unsubscribe = handoffs.subscribe(() =>
        gatewayEvents?.emit("handoff", { revision: Date.now() }, { scope: "operator.read" }),
      );
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      gatewayEvents = undefined;
    },
  };
}
