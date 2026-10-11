import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { MiniMeSourcesAvailableResult } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import { readSessionHistoryPageInWorker } from "../config/sessions/session-history-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient, GatewayRequestContext } from "../gateway/server-methods/types.js";
import { requireSessionRowProjection } from "../gateway/session-row-projection-access.js";
import { prepareSessionMutationFacts } from "../gateway/session-sharing-preparation.js";
import { listProjectedSessions } from "../gateway/session-utils-list.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import type { TranscriptReadWindow } from "../sessions/transcript-read-window.js";
import { MINI_ME_LIMITS, miniMeEvidenceRevision } from "./learning.js";

/**
 * Owner evidence is the user-turn writer's attribution: the closed
 * `__openclaw.senderIdentity` it records only for visible external-user turns,
 * bound to `__openclaw.senderId`. Labels and other fields never establish identity.
 */
export function miniMeOwnerSourceText(message: unknown, ownerId: string): string | undefined {
  if (!isRecord(message) || message.role !== "user" || message.display === false) {
    return undefined;
  }
  if (
    message.provenance !== undefined &&
    normalizeInputProvenance(message.provenance)?.kind !== "external_user"
  ) {
    return undefined;
  }
  const meta = isRecord(message["__openclaw"]) ? message["__openclaw"] : undefined;
  const identity = readTranscriptSenderIdentity(meta?.senderIdentity);
  if (identity?.type !== "profile" || identity.id !== ownerId || meta?.senderId !== ownerId) {
    return undefined;
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  return message.content
    .flatMap((item) =>
      isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n");
}

/** A selected conversation must stay private to the same canonical person across every await. */
export async function retainMiniMeConversation(input: {
  ownerId: string;
  sessionKey: string;
  getConfig(): OpenClawConfig;
  assertCurrent(this: void): void;
}) {
  input.assertCurrent();
  const parsed = parseAgentSessionKey(input.sessionKey);
  if (!parsed || isIncognitoSessionKey(input.sessionKey)) {
    throw new Error("Select a durable private OpenClaw conversation");
  }
  const facts = await prepareSessionMutationFacts({
    cfg: input.getConfig(),
    sessionKey: input.sessionKey,
    agentId: parsed.agentId,
  });
  const current = () => {
    input.assertCurrent();
    const observed = facts.readCurrent(input.getConfig());
    const target = observed.target;
    // OpenClaw's owner-only collaboration mode is named "draft" on the wire.
    if (
      !target ||
      target.entry.visibility !== "draft" ||
      sessionCreatorProfileId(target.entry.createdActor) !== input.ownerId ||
      [...observed.membership].some((id) => id !== input.ownerId) ||
      target.entry.createdActor?.type !== "human" ||
      target.entry.heartbeatIsolatedBaseSessionKey
    ) {
      throw new Error("Mini Me can learn only from your selected private conversations");
    }
    return target;
  };
  try {
    current();
  } catch (error) {
    facts.release();
    throw error;
  }
  return {
    current,
    assertCurrent: () => {
      current();
    },
    release: facts.release,
  };
}

/** Display entries per page; each page becomes at most one bounded extraction. */
export const MINI_ME_CONVERSATION_PAGE_MESSAGES = 100;
/** Raw serialized transcript bytes per page read; owner text has its own inference cap. */
export const MINI_ME_CONVERSATION_PAGE_BYTES = 256 * 1024;
// Two shrink sequences (100 entries to one) around one restart.
const MAX_PAGE_READS = 20;
const CURSOR_PREFIX = "mini-me-conversation-v1:";
const CURSOR_MAX_LENGTH = 4096;

/**
 * Durable progress through one conversation lineage. `position` counts examined
 * display entries; `window` is the reader's continuity anchor at that position.
 * Past-only sources pin `end` to the history length seen by their first read.
 */
type ConversationCursor = {
  sessionId: string;
  lifecycleRevision: string | null;
  position: number;
  end: number | null;
  window: TranscriptReadWindow | null;
};

export type MiniMeConversationPage = {
  /** Selected owner text from the newly examined entries only. */
  text: string;
  /** Evidence lineage: session, lifecycle, display source, examined range and text. */
  revision: string;
  /** Next durable cursor; equals the input cursor when nothing new was examined. */
  cursor: string;
  /** Ongoing: caught up with current history. Past-only: pinned snapshot drained. */
  complete: boolean;
  /** The stored lineage was reset, relinked or rewritten; reading restarted at its start. */
  restarted: boolean;
  assertCurrent(this: void): void;
  release(): void;
};

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function encodeConversationCursor(cursor: ConversationCursor): string {
  const encoded = CURSOR_PREFIX + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  // An unreadable stored cursor would restart the source on every job.
  if (encoded.length > CURSOR_MAX_LENGTH) {
    throw new Error("Mini Me conversation cursor is too long");
  }
  return encoded;
}

function decodeReadWindow(value: unknown): TranscriptReadWindow | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const { source, latestResetRawSeq, anchor } = value;
  if (source !== undefined && typeof source !== "string") {
    return undefined;
  }
  if (latestResetRawSeq !== null && !isCount(latestResetRawSeq)) {
    return undefined;
  }
  if (anchor === undefined) {
    return { source, latestResetRawSeq };
  }
  if (!isRecord(anchor) || !isCount(anchor.rawSeq) || !isCount(anchor.seq)) {
    return undefined;
  }
  return { source, latestResetRawSeq, anchor: { rawSeq: anchor.rawSeq, seq: anchor.seq } };
}

function decodeConversationCursor(value: string | null): ConversationCursor | undefined {
  if (!value?.startsWith(CURSOR_PREFIX) || value.length > CURSOR_MAX_LENGTH) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const { sessionId, lifecycleRevision, position, end } = parsed;
  const window = decodeReadWindow(parsed.window);
  if (
    typeof sessionId !== "string" ||
    (lifecycleRevision !== null && typeof lifecycleRevision !== "string") ||
    !isCount(position) ||
    (end !== null && (!isCount(end) || end < position)) ||
    window === undefined
  ) {
    return undefined;
  }
  return { sessionId, lifecycleRevision, position, end, window };
}

/**
 * A past-only source is finished when its pinned snapshot is drained. Invalid
 * progress must be surfaced, never interpreted as successful import.
 */
export function isMiniMeConversationCursorComplete(cursor: string | null): boolean {
  if (cursor === null) {
    return false;
  }
  const decoded = decodeConversationCursor(cursor);
  if (!decoded) {
    throw new Error("Mini Me conversation progress is invalid; remove and reselect the source");
  }
  return decoded.end !== null && decoded.position >= decoded.end;
}

function transcriptMessageSeq(message: unknown): number | undefined {
  const meta =
    isRecord(message) && isRecord(message["__openclaw"]) ? message["__openclaw"] : undefined;
  return meta && isCount(meta.seq) ? meta.seq : undefined;
}

/**
 * Read the next bounded page after `cursor`. Progress never passes an entry that
 * was not examined: byte-truncated windows shrink, an oversized owner message
 * fails visibly, and a changed lineage restarts (ongoing) or fails (past-only).
 */
export async function readMiniMeConversation(
  input: Parameters<typeof retainMiniMeConversation>[0] & {
    mode: "past-only" | "ongoing";
    cursor: string | null;
    signal?: AbortSignal;
  },
): Promise<MiniMeConversationPage> {
  const retained = await retainMiniMeConversation(input);
  try {
    const source = retained.current();
    const lineage = {
      sessionId: source.entry.sessionId,
      lifecycleRevision: source.entry.lifecycleRevision ?? null,
    };
    const fresh: ConversationCursor = { ...lineage, position: 0, end: null, window: null };
    const previous = decodeConversationCursor(input.cursor);
    if (input.cursor !== null && !previous) {
      throw new Error("Mini Me conversation progress is invalid; remove and reselect the source");
    }
    const assertLineage = () => {
      const current = retained.current();
      if (
        current.entry.sessionId !== lineage.sessionId ||
        (current.entry.lifecycleRevision ?? null) !== lineage.lifecycleRevision
      ) {
        throw new Error("This conversation was reset while learning; retry its current history");
      }
    };
    const sameLineage =
      previous?.sessionId === lineage.sessionId &&
      previous.lifecycleRevision === lineage.lifecycleRevision;
    // No entry was examined: keep the stored bytes unless the lineage or snapshot changed.
    const unchanged = (state: ConversationCursor, restarted: boolean): MiniMeConversationPage => ({
      text: "",
      revision: miniMeEvidenceRevision(JSON.stringify([state, ""])),
      cursor:
        input.cursor !== null && state === previous
          ? input.cursor
          : encodeConversationCursor(state),
      complete: true,
      restarted,
      assertCurrent: assertLineage,
      release: () => retained.release(),
    });
    if (input.mode === "past-only") {
      if (input.cursor !== null && isMiniMeConversationCursorComplete(input.cursor)) {
        return { ...unchanged(previous ?? fresh, false), cursor: input.cursor };
      }
      if (previous && !sameLineage) {
        throw new Error(
          "This conversation was reset or rewritten before its past history finished importing; select it again",
        );
      }
    }
    let state = previous && sameLineage ? previous : fresh;
    let restarted = Boolean(previous) && !sameLineage;
    let count = MINI_ME_CONVERSATION_PAGE_MESSAGES;
    const target = {
      agentId: source.agentId,
      sessionId: source.entry.sessionId,
      sessionKey: source.canonicalKey,
      storePath: source.storePath,
    };
    for (let reads = 0; reads < MAX_PAGE_READS; reads++) {
      const limit = state.end === null ? count : Math.min(count, state.end - state.position);
      if (limit <= 0) {
        return unchanged(state, restarted);
      }
      const page = await readSessionHistoryPageInWorker(
        {
          kind: "message-page",
          params: {
            target,
            options: {
              offset: 0,
              beforeSeq: state.position + limit + 1,
              maxMessages: limit,
              maxBytes: MINI_ME_CONVERSATION_PAGE_BYTES,
              allowOversizedFirst: false,
              captureReadWindow: true,
              ...(state.window ? { expectedReadWindow: state.window } : {}),
            },
          },
        },
        input.signal,
      );
      assertLineage();
      if (page.windowReset || page.totalMessages < state.position) {
        if (input.mode === "past-only") {
          throw new Error(
            "This conversation was reset or rewritten before its past history finished importing; select it again",
          );
        }
        if (state === fresh) {
          throw new Error("Mini Me could not read a stable conversation window");
        }
        state = fresh;
        restarted = true;
        count = MINI_ME_CONVERSATION_PAGE_MESSAGES;
        continue;
      }
      if (input.mode === "past-only" && state.end === null) {
        state = { ...state, end: page.totalMessages };
      }
      const end = Math.min(page.totalMessages, state.position + limit);
      if (end <= state.position) {
        const caughtUp = state === previous ? state : { ...state, window: page.readWindow ?? null };
        return unchanged(caughtUp, restarted);
      }
      const start = page.olderOffset === undefined ? 0 : end - page.olderOffset;
      if (page.omittedOversized || start > state.position) {
        // The byte budget stopped before this cursor: shrink rather than skip the prefix.
        if (end - state.position > 1) {
          count = Math.max(1, Math.floor((end - state.position) / 2));
        } else {
          throw new Error("This conversation exceeds the bounded import window");
        }
        continue;
      }
      if (!page.readWindow) {
        throw new Error("Mini Me could not verify conversation continuity");
      }
      const texts: string[] = [];
      for (const message of page.messages) {
        const text = miniMeOwnerSourceText(message, input.ownerId);
        if (!text?.trim()) {
          continue;
        }
        const seq = transcriptMessageSeq(message);
        if (seq === undefined) {
          throw new Error("Mini Me could not place a conversation message");
        }
        if (seq > state.position && seq <= end) {
          texts.push(text);
        }
      }
      const text = texts.join("\n\n");
      if (Buffer.byteLength(text, "utf8") > MINI_ME_LIMITS.inferenceBytes) {
        if (end - state.position > 1) {
          count = Math.max(1, Math.floor((end - state.position) / 2));
          continue;
        }
        throw new Error("Selected owner evidence exceeds 32 KiB");
      }
      const next: ConversationCursor = { ...state, position: end, window: page.readWindow };
      return {
        text,
        revision: miniMeEvidenceRevision(
          JSON.stringify([
            lineage.sessionId,
            lineage.lifecycleRevision,
            page.readWindow.source ?? null,
            state.position,
            end,
            text,
          ]),
        ),
        cursor: encodeConversationCursor(next),
        complete: next.end === null ? end >= page.totalMessages : end >= next.end,
        restarted,
        assertCurrent: assertLineage,
        release: () => retained.release(),
      };
    }
    throw new Error("This conversation exceeds the bounded import window");
  } catch (error) {
    retained.release();
    throw error;
  }
}

export async function listMiniMeConversationSources(input: {
  ownerId: string;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  assertCurrent(this: void): void;
}): Promise<MiniMeSourcesAvailableResult> {
  input.assertCurrent();
  const result = await listProjectedSessions({
    projection: requireSessionRowProjection(input.context),
    context: input.context,
    client: input.client,
    opts: {
      limit: 50,
      creatorId: input.ownerId,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
      includeDerivedTitles: false,
      includeLastMessage: false,
    },
  });
  input.assertCurrent();
  const conversations: MiniMeSourcesAvailableResult["conversations"] = [];
  for (const row of result.sessions) {
    if (row.visibility !== "draft" || !row.agentId || row.createdActor?.type !== "human") {
      continue;
    }
    const retained = await retainMiniMeConversation({
      ownerId: input.ownerId,
      sessionKey: row.key,
      getConfig: input.context.getRuntimeConfig,
      assertCurrent: input.assertCurrent,
    }).catch(() => undefined);
    if (!retained) {
      continue;
    }
    try {
      retained.assertCurrent();
      conversations.push({
        sessionKey: row.key,
        agentId: row.agentId,
        title: (row.displayName ?? row.label ?? row.key).slice(0, 512),
        updatedAt: row.updatedAt ?? 0,
      });
    } finally {
      retained.release();
    }
  }
  input.assertCurrent();
  return { conversations };
}
