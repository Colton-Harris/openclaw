import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHistoryWorkerRequest } from "../config/sessions/session-history-types.js";
import type { prepareSessionMutationFacts } from "../gateway/session-sharing-preparation.js";
import { attachOpenClawTranscriptMeta } from "../gateway/session-transcript-entry-message.js";
import type {
  ReadRecentSessionMessagesResult,
  SessionTranscriptPageOptions,
} from "../gateway/session-transcript-read.types.js";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.message.js";
import type { UserTurnInput } from "../sessions/user-turn-transcript.types.js";
import { MINI_ME_LIMITS } from "./learning.js";
import {
  isMiniMeConversationCursorComplete,
  MINI_ME_CONVERSATION_PAGE_BYTES,
  MINI_ME_CONVERSATION_PAGE_MESSAGES,
  miniMeOwnerSourceText,
  readMiniMeConversation,
} from "./sources.js";

const mocks = vi.hoisted(() => ({
  facts: vi.fn<typeof prepareSessionMutationFacts>(),
  page: vi.fn<
    (
      request: SessionHistoryWorkerRequest,
      signal?: AbortSignal,
    ) => Promise<ReadRecentSessionMessagesResult>
  >(),
}));
// The real source owner decides privacy; only its session-facts boundary is recorded.
// mock-isolation: Supply controlled private membership and reset facts to the real source-reader policy.
vi.mock("../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: mocks.facts,
}));
// mock-isolation: Control bounded page replies and continuity failures without a real transcript worker in this reader unit fixture.
vi.mock("../config/sessions/session-history-worker-runtime.js", () => ({
  readSessionHistoryPageInWorker: mocks.page,
}));

const SESSION_KEY = "agent:main:selected-private";
type Entry = { rawSeq: number; message: Record<string, unknown> };

/**
 * Synthetic admitted transcript: display entries, their continuity source, and
 * the `message-page` window/byte contract the real projection reader enforces.
 */
let entries: Entry[];
let displaySource: string;
let rawSeq: number;
let visibility: "draft" | "shared";
let sessionId: string;
let lifecycleRevision: string;
let beforeReturn: (() => void) | undefined;
const release = vi.fn();

function append(message: Record<string, unknown>) {
  entries.push({ rawSeq: rawSeq++, message });
}
/** Persisted through the canonical user-turn writer, as Gateway chat sends are. */
function userTurn(text: string, input: Omit<UserTurnInput, "text"> = {}) {
  return { ...buildPersistedUserTurnMessage({ text, timestamp: 1, ...input }) };
}
function profileTurn(text: string, id: string, input: Omit<UserTurnInput, "text"> = {}) {
  return userTurn(text, { sender: { id, identity: { type: "profile", id } }, ...input });
}
function owner(text: string) {
  append(profileTurn(text, "owner"));
}
function bytes(entry: Entry) {
  return Buffer.byteLength(JSON.stringify(entry.message), "utf8");
}

function readPage(options: SessionTranscriptPageOptions): ReadRecentSessionMessagesResult {
  const anchor = options.expectedReadWindow?.anchor;
  const changed =
    options.expectedReadWindow !== undefined &&
    (options.expectedReadWindow.source !== displaySource ||
      (anchor !== undefined && entries[anchor.seq - 1]?.rawSeq !== anchor.rawSeq));
  const total = entries.length;
  const end = changed
    ? total
    : Math.min(total, Math.max(0, (options.beforeSeq ?? total + 1) - 1) - options.offset);
  const requestedStart = Math.max(0, end - options.maxMessages);
  let start = end;
  let used = 0;
  for (let index = end - 1; index >= requestedStart; index--) {
    const size = bytes(entries[index]!);
    const exempt = options.allowOversizedFirst && start === end;
    if (!exempt && used + size > (options.maxBytes ?? Number.POSITIVE_INFINITY)) {
      break;
    }
    used += size;
    start = index;
  }
  const omittedOversized = options.maxMessages > 0 && end > 0 && start === end;
  const consumedStart = omittedOversized ? end - 1 : start;
  const selected = entries.slice(start, end);
  const last = start + selected.length;
  return {
    // The real projection merges `seq` into the persisted message metadata.
    messages: selected.map((entry, index) =>
      attachOpenClawTranscriptMeta(entry.message, { seq: start + index + 1 }),
    ),
    totalMessages: total,
    ...(consumedStart > 0 ? { olderOffset: end - consumedStart } : {}),
    ...(omittedOversized ? { omittedOversized: true } : {}),
    ...(changed ? { windowReset: true } : {}),
    readWindow: {
      source: displaySource,
      latestResetRawSeq: null,
      ...(selected.length ? { anchor: { rawSeq: entries[last - 1]!.rawSeq, seq: last } } : {}),
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  entries = [];
  displaySource = "display-1";
  rawSeq = 10;
  visibility = "draft";
  sessionId = "selected-session";
  lifecycleRevision = "lifecycle-1";
  beforeReturn = undefined;
  mocks.facts.mockImplementation(async () => ({
    storageTarget: { agentId: "main", canonicalKey: SESSION_KEY, storePath: "/synthetic/store" },
    bindCreation: () => {},
    readCurrent: () => ({
      target: {
        agentId: "main",
        canonicalKey: SESSION_KEY,
        storeKey: SESSION_KEY,
        storeKeys: [SESSION_KEY],
        storePath: "/synthetic/store",
        entry: {
          sessionId,
          lifecycleRevision,
          updatedAt: 1,
          visibility,
          createdActor: { type: "human", source: "profile", id: "owner" },
        },
      },
      membership: new Set(visibility === "draft" ? ["owner"] : ["owner", "teammate"]),
    }),
    release,
  }));
  mocks.page.mockImplementation(async (request, signal) => {
    signal?.throwIfAborted();
    if (request.kind !== "message-page") {
      throw new Error(`unexpected ${request.kind} read`);
    }
    const result = readPage(request.params.options);
    beforeReturn?.();
    return result;
  });
});

function pageOptions() {
  return mocks.page.mock.calls.map(([request]) => {
    if (request.kind !== "message-page") {
      throw new Error("unexpected read");
    }
    return request.params.options;
  });
}

async function read(
  cursor: string | null,
  mode: "past-only" | "ongoing" = "ongoing",
  signal?: AbortSignal,
) {
  const page = await readMiniMeConversation({
    ownerId: "owner",
    sessionKey: SESSION_KEY,
    getConfig: () => ({}),
    assertCurrent: () => {},
    mode,
    cursor,
    signal,
  });
  page.release();
  return page;
}

async function drain(cursor: string | null, mode: "past-only" | "ongoing" = "ongoing") {
  const texts: string[] = [];
  let current = cursor;
  for (let pages = 0; pages < 50; pages++) {
    const page = await read(current, mode);
    if (page.cursor !== current && page.text) {
      texts.push(page.text);
    }
    current = page.cursor;
    if (page.complete) {
      return { texts, cursor: current, pages: pages + 1 };
    }
  }
  throw new Error("conversation did not drain");
}

describe("Mini Me conversation cursor", () => {
  it("continues an ongoing conversation past 100 entries in bounded pages of owner-only text", async () => {
    for (let index = 0; index < 120; index++) {
      owner(`owner ${index}`);
      append({ role: "assistant", content: `reply ${index}` });
    }
    append(profileTurn("teammate text", "teammate"));
    append(profileTurn("relayed text", "owner", { provenance: { kind: "inter_session" } }));
    const first = await drain(null);
    expect(first.pages).toBe(3);
    expect(first.texts.join("\n\n").split("\n\n")).toEqual(
      Array.from({ length: 120 }, (_, index) => `owner ${index}`),
    );
    for (const options of pageOptions()) {
      expect(options.maxMessages).toBeLessThanOrEqual(MINI_ME_CONVERSATION_PAGE_MESSAGES);
      expect(options.maxBytes).toBe(MINI_ME_CONVERSATION_PAGE_BYTES);
    }
    expect(release).toHaveBeenCalledTimes(3);

    const idle = await read(first.cursor);
    expect(idle).toMatchObject({ cursor: first.cursor, text: "", complete: true });

    owner("owner later");
    append({ role: "assistant", content: "later reply" });
    const next = await read(first.cursor);
    expect(next).toMatchObject({ text: "owner later", complete: true, restarted: false });
    expect(next.revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(next.revision).not.toBe(idle.revision);
  });

  it("shrinks byte-limited windows and refuses an oversized entry without skipping it", async () => {
    owner("before");
    append({ role: "assistant", content: "x".repeat(MINI_ME_CONVERSATION_PAGE_BYTES + 1) });
    owner("after");
    const first = await read(null);
    expect(first.text).toBe("before");
    await expect(read(first.cursor)).rejects.toThrow("bounded import window");
    expect(pageOptions().some((options) => options.allowOversizedFirst)).toBe(false);
  });

  it("fails visibly on one owner message over the inference limit without a cursor", async () => {
    owner("small");
    owner("y".repeat(MINI_ME_LIMITS.inferenceBytes + 1));
    const first = await read(null);
    expect(first.text).toBe("small");
    release.mockClear();
    await expect(read(first.cursor)).rejects.toThrow("evidence exceeds");
    expect(release).toHaveBeenCalledOnce();
  });

  it("pins a past-only snapshot, then finishes without another read", async () => {
    for (let index = 0; index < 150; index++) {
      owner(`past ${index}`);
    }
    const first = await read(null, "past-only");
    expect(first.complete).toBe(false);
    owner("after selection");
    const rest = await drain(first.cursor, "past-only");
    expect([first.text, ...rest.texts].join("\n\n").split("\n\n")).toEqual(
      Array.from({ length: 150 }, (_, index) => `past ${index}`),
    );
    expect(isMiniMeConversationCursorComplete(rest.cursor)).toBe(true);
    mocks.page.mockClear();
    await expect(read(rest.cursor, "past-only")).resolves.toMatchObject({
      cursor: rest.cursor,
      complete: true,
      text: "",
    });
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("restarts an ongoing source whose window or session was rewritten", async () => {
    owner("old");
    const first = await read(null);
    entries = [];
    displaySource = "display-2";
    owner("rewritten");
    const rewritten = await read(first.cursor);
    expect(rewritten).toMatchObject({ text: "rewritten", restarted: true, complete: true });

    sessionId = "reset-session";
    lifecycleRevision = "lifecycle-2";
    entries = [];
    owner("after reset");
    const reset = await read(rewritten.cursor);
    expect(reset).toMatchObject({ text: "after reset", restarted: true });
    expect(reset.revision).not.toBe(rewritten.revision);
  });

  it("refuses to continue a past-only snapshot after its lineage changed", async () => {
    for (let index = 0; index < 150; index++) {
      owner(`past ${index}`);
    }
    const first = await read(null, "past-only");
    lifecycleRevision = "lifecycle-2";
    await expect(read(first.cursor, "past-only")).rejects.toThrow("select it again");
  });

  it("rechecks the private owner after the page read and releases on failure", async () => {
    owner("private");
    beforeReturn = () => {
      visibility = "shared";
    };
    await expect(read(null)).rejects.toThrow("selected private conversations");
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses invalid progress and a session reset during the read without publishing a cursor", async () => {
    await expect(read("invalid-cursor", "past-only")).rejects.toThrow("progress is invalid");
    await expect(read("invalid-cursor", "ongoing")).rejects.toThrow("progress is invalid");
    expect(mocks.page).not.toHaveBeenCalled();
    owner("private");
    beforeReturn = () => {
      sessionId = "replacement-session";
    };
    await expect(read(null)).rejects.toThrow("reset while learning");
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("forwards cancellation to the reader and releases the source", async () => {
    owner("private");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(read(null, "ongoing", controller.signal)).rejects.toThrow("cancelled");
    expect(mocks.page.mock.calls[0]?.[1]).toBe(controller.signal);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("Mini Me owner source text", () => {
  // Paged messages carry the writer's metadata merged with the reader's `seq`.
  const paged = (message: Record<string, unknown>, meta: Record<string, unknown> = {}) =>
    attachOpenClawTranscriptMeta(message, { ...meta, seq: 1 });
  const text = (message: unknown) => miniMeOwnerSourceText(message, "owner");

  it("accepts only visible external-user turns the writer attributed to the owner profile", () => {
    expect(text(paged(profileTurn("mine", "owner")))).toBe("mine");
    expect(
      text(paged(profileTurn("explicit", "owner", { provenance: { kind: "external_user" } }))),
    ).toBe("explicit");
    expect(
      text(
        paged({
          ...profileTurn("", "owner"),
          content: [
            { type: "text", text: "first" },
            { type: "image", data: "x" },
            { type: "text", text: "second" },
          ],
        }),
      ),
    ).toBe("first\nsecond");
  });

  it("rejects turns the writer records for anyone or anything else", () => {
    const rejected = [
      profileTurn("teammate", "teammate"),
      profileTurn("relayed", "owner", { provenance: { kind: "inter_session" } }),
      profileTurn("system", "owner", { provenance: { kind: "internal_system" } }),
      profileTurn("hidden", "owner", { display: false }),
      // A channel observation with the same raw id is not the Gateway profile.
      userTurn("observed", {
        sender: {
          id: "owner",
          identity: {
            type: "observation",
            id: "owner",
            pluginId: "telegram",
            accountId: null,
            senderKind: "human",
          },
        },
      }),
      // Display labels alone never become identity.
      userTurn("labelled", { sender: { id: "owner", name: "owner", username: "owner" } }),
    ];
    for (const message of rejected) {
      expect(text(paged(message))).toBeUndefined();
    }
  });

  it("rejects forged, malformed, conflicting and non-user metadata", () => {
    const ownerIdentity = { type: "profile", id: "owner" };
    const forged = [
      paged(
        { role: "user", content: "relayed", provenance: { kind: "inter_session" } },
        { senderId: "owner", senderIdentity: ownerIdentity },
      ),
      paged(
        { role: "user", content: "unknown provenance", provenance: { kind: "relay" } },
        { senderId: "owner", senderIdentity: ownerIdentity },
      ),
      paged(
        { role: "user", content: "hidden", display: false },
        { senderId: "owner", senderIdentity: ownerIdentity },
      ),
      // The earlier synthetic top-level shape is not a persisted contract.
      paged({ role: "user", content: "legacy", sender: { identity: ownerIdentity } }),
      paged({ role: "user", content: "no sender id" }, { senderIdentity: ownerIdentity }),
      paged(
        { role: "user", content: "conflicting id" },
        { senderId: "teammate", senderIdentity: ownerIdentity },
      ),
      paged(
        { role: "user", content: "extra field" },
        { senderId: "owner", senderIdentity: { ...ownerIdentity, name: "owner" } },
      ),
      paged(
        { role: "assistant", content: "reply" },
        { senderId: "owner", senderIdentity: ownerIdentity },
      ),
      { role: "user", content: "string meta", __openclaw: "owner" },
    ];
    for (const message of forged) {
      expect(text(message)).toBeUndefined();
    }
  });
});
