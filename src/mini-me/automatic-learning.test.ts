import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MiniMeProfile,
  MiniMeSource,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { SessionMutationFactsUnavailableError } from "../gateway/session-sharing-preparation.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { queueMiniMeLearning } from "./automatic-learning.js";
import type * as hostStorage from "./host-storage.js";
import { MINI_ME_LIMITS } from "./learning.js";
import { MiniMeLifecycleOwner } from "./lifecycle.js";
import type { MiniMeContentSnapshot } from "./persistence.types.js";
import type { extractMiniMePreferences } from "./providers.js";
import type { MiniMeContentStore } from "./service.types.js";
import type { isMiniMeConversationCursorComplete, readMiniMeConversation } from "./sources.js";

type LearningContentPort = Pick<
  MiniMeContentStore,
  "readSnapshot" | "sourceCursor" | "learnBatch" | "updateSourceStatus"
>;

const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn<typeof hostStorage.miniMeLifecycleForOwner>(),
  generation: vi.fn<typeof hostStorage.assertMiniMeProfileGeneration>(),
  state: vi.fn<() => Pick<ReturnType<typeof hostStorage.miniMeHostState>, "read">>(),
  content:
    vi.fn<
      (
        profile: MiniMeProfile,
        assertCurrent: () => void,
        consume: (store: LearningContentPort) => Promise<unknown>,
      ) => Promise<unknown>
    >(),
  extract: vi.fn<typeof extractMiniMePreferences>(),
  conversation: vi.fn<typeof readMiniMeConversation>(),
  complete: vi.fn<typeof isMiniMeConversationCursorComplete>(),
  project: vi.fn(async () => {}),
  warn: vi.fn(),
}));
// mock-isolation: Keep brokered databases out of this fixture; explicit ports control lifecycle and content commits.
vi.mock("./host-storage.js", () => ({
  miniMeLifecycleForOwner: mocks.lifecycle,
  assertMiniMeProfileGeneration: mocks.generation,
  miniMeHostState: mocks.state,
  withMiniMeContent: mocks.content,
}));
// mock-isolation: Isolate network and model execution so the fixture controls completion and cancellation ordering.
vi.mock("./providers.js", () => ({ extractMiniMePreferences: mocks.extract }));
// mock-isolation: Control conversation leases and page completion here; the real reader has its own privacy and paging tests.
vi.mock("./sources.js", () => ({
  readMiniMeConversation: mocks.conversation,
  isMiniMeConversationCursorComplete: mocks.complete,
}));
// mock-isolation: Observe projection requests without writing personal files from this scheduling fixture.
vi.mock("./documents.js", () => ({ projectMiniMeDocuments: mocks.project }));
// mock-isolation: Capture warning publication without opening process logging sinks.
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ warn: mocks.warn }) }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fixture(
  sourceKind: "document" | "conversation" = "document",
  mode: "past-only" | "ongoing" = "ongoing",
) {
  const profile: MiniMeProfile = {
    id: "mini-owner",
    agentId: "mini-agent",
    name: "Synthetic Mini Me",
    lifecycle: "active",
    learningPaused: false,
    generation: 1,
    revision: 1,
    models: { conversationModel: "fixture/extractor", decisionModel: null, allowInference: true },
    createdAt: 1,
    updatedAt: 1,
  };
  const source: MiniMeSource = {
    id: "selected-source",
    selection:
      sourceKind === "document"
        ? { kind: "document", name: "TASTE.md" }
        : { kind: "conversation", sessionKey: "agent:main:selected-private", mode },
    revision: 0,
    status: "pending",
    lastIngestedAt: null,
    detail: null,
  };
  const snapshot: MiniMeContentSnapshot = {
    contentRevision: 0,
    historyCursor: null,
    sources: [source],
    documents: [
      {
        name: "TASTE.md",
        content: "I prefer dark themes.",
        revision: 1,
        updatedAt: 1,
        external: {
          content: "Unimported external text must not become evidence.",
          baseRevision: 1,
        },
      },
    ],
    beliefs: [],
    predictions: [],
    outcomes: [],
  };
  const lifecycle = new MiniMeLifecycleOwner(() => {});
  let physicalGeneration = profile.generation;
  let cursor: string | null = null;
  const learnBatch = vi.fn<MiniMeContentStore["learnBatch"]>(async (input) => {
    cursor = input.cursor ?? null;
    source.status = input.sourceStatus?.status ?? "ready";
    source.detail = input.sourceStatus?.detail ?? null;
    snapshot.beliefs.push(...input.beliefs);
    return { contentRevision: ++snapshot.contentRevision, applied: input.beliefs };
  });
  const updateSourceStatus = vi.fn<MiniMeContentStore["updateSourceStatus"]>(async (input) => {
    source.status = input.status;
    source.detail = input.detail;
    return source;
  });
  // Persistence atomicity is owned by persistence.test.ts. This recording port
  // exercises queue/source admission and the real lifecycle owner only.
  const store = {
    readSnapshot: vi.fn(async () => snapshot),
    sourceCursor: vi.fn(async () => cursor),
    learnBatch,
    updateSourceStatus,
  } satisfies LearningContentPort;
  mocks.lifecycle.mockReturnValue(lifecycle);
  mocks.generation.mockImplementation((_owner, expected) => {
    if (expected.generation !== physicalGeneration) {
      throw new Error("generation changed");
    }
  });
  mocks.state.mockReturnValue({
    read: vi.fn(async () => ({ profile, attachments: [], pendingDataChanges: [] })),
  });
  mocks.content.mockImplementation(async (_profile, assertCurrent, consume) => {
    assertCurrent();
    const result = await consume(store);
    assertCurrent();
    return result;
  });
  const extracted = {
    preference: {
      document: "TASTE.md" as const,
      scope: "editor theme",
      statement: "Prefers dark themes",
      preferred: ["dark"],
      avoided: [],
    },
    evidence: [
      { sourceId: source.id, sourceRevision: "fixture-revision", excerpt: "I prefer dark themes." },
    ],
    origin: "inferred" as const,
  };
  mocks.extract.mockImplementation(async (_context, input) => [
    {
      ...extracted,
      evidence: [
        { sourceId: input.sourceId, sourceRevision: input.sourceRevision, excerpt: input.text },
      ],
    },
  ]);
  let conversationCurrent = true;
  let conversationRevision = "conversation-1";
  const releaseConversation = vi.fn();
  const assertConversation = () => {
    if (!conversationCurrent) {
      throw new Error("conversation is now shared");
    }
  };
  mocks.conversation.mockImplementation(async () => ({
    text: "I prefer dark themes.",
    revision: `${conversationRevision}-evidence`,
    cursor: conversationRevision,
    complete: true,
    restarted: false,
    assertCurrent: assertConversation,
    release: releaseConversation,
  }));
  /** A long conversation: one owner page per read, each cursor naming its examined end. */
  const pages = (count: number, options: { restartedAt?: number } = {}) => {
    mocks.conversation.mockImplementation(async (input) => {
      const position = input.cursor === null ? 0 : Number(input.cursor.slice("page-".length));
      const next = Math.min(count, position + 1);
      return {
        text: next > position ? `owner page ${next}` : "",
        revision: `evidence-${next}`,
        cursor: next > position ? `page-${next}` : (input.cursor ?? "page-0"),
        complete: next >= count,
        restarted: options.restartedAt === next,
        assertCurrent: assertConversation,
        release: releaseConversation,
      };
    });
  };
  mocks.complete.mockImplementation((value) => value === "past-complete");
  let holds = 0;
  let foregroundOpen = true;
  let originalCurrent = true;
  let releases = 0;
  const releaseWaiters: Array<{ count: number; resolve(): void }> = [];
  const releaseOperator = vi.fn(() => {
    holds--;
    releases++;
    for (const waiter of releaseWaiters) {
      if (releases >= waiter.count) {
        waiter.resolve();
      }
    }
  });
  const retainOperator = vi.fn(() => {
    holds++;
    return releaseOperator;
  });
  const makeRequest = () => {
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "owner",
      scopes: ["operator.write"],
      assertCurrent: () => {
        if (!originalCurrent || (!foregroundOpen && !holds)) {
          throw new Error("original source revoked");
        }
      },
      retain: retainOperator,
    });
    return {
      ownerId: "owner",
      profile,
      config: { agents: { entries: { "mini-agent": { workspace: "/synthetic/mini-workspace" } } } },
      operatorAuthority,
      assertCurrent: operatorAuthority.assertCurrent,
    };
  };
  const request = makeRequest();
  return {
    request,
    freshRequest: makeRequest,
    profile,
    source,
    snapshot,
    lifecycle,
    learnBatch,
    updateSourceStatus,
    retainOperator,
    releaseOperator,
    releaseConversation,
    extracted,
    closeForeground: () => {
      foregroundOpen = false;
    },
    revokeOriginal: () => {
      originalCurrent = false;
    },
    revokeConversation: () => {
      conversationCurrent = false;
    },
    changeGeneration: () => {
      physicalGeneration++;
    },
    advanceConversation: () => {
      conversationRevision = "conversation-2";
    },
    pages,
    storedCursor: () => cursor,
    setStoredCursor: (value: string | null) => {
      cursor = value;
    },
    holds: () => holds,
    done: async (count = 1) => {
      if (releases >= count) {
        return;
      }
      const done = createDeferred();
      releaseWaiters.push({ count, resolve: () => done.resolve() });
      await done.promise;
    },
  };
}

describe("Mini Me automatic selected-source queue", () => {
  it.each([false, true])(
    "leaves a closed foreground work scope without replacing owner authority (revoked=%s)",
    async (revoked) => {
      const f = fixture("conversation");
      mocks.extract.mockImplementation(async () =>
        runWithAsyncWorkResources(async () => [f.extracted]),
      );
      const foreground = new AsyncWorkScope();
      foreground.run(() => queueMiniMeLearning(f.request));
      await foreground.drain();
      f.closeForeground();
      if (revoked) {
        f.revokeOriginal();
      }
      await f.done();
      if (revoked) {
        expect(f.learnBatch).not.toHaveBeenCalled();
      } else {
        expect(f.learnBatch).toHaveBeenCalledOnce();
        expect(f.storedCursor()).toBe("conversation-1");
        expect(f.source.status).toBe("ready");
      }
      expect(f.holds()).toBe(0);
    },
  );

  it("reacquires invalidated conversation facts before retrying an uncommitted page", async () => {
    const f = fixture("conversation");
    mocks.extract.mockRejectedValueOnce(new SessionMutationFactsUnavailableError());
    queueMiniMeLearning(f.request);
    await f.done();
    expect(mocks.conversation).toHaveBeenCalledTimes(2);
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(f.learnBatch).toHaveBeenCalledOnce();
    expect(f.storedCursor()).toBe("conversation-1");
  });

  it("never refreshes the original owner's revoked authority during a source retry", async () => {
    const f = fixture("conversation");
    mocks.extract.mockImplementationOnce(async () => {
      f.revokeOriginal();
      throw new SessionMutationFactsUnavailableError();
    });
    queueMiniMeLearning(f.request);
    await f.done();
    expect(mocks.conversation).toHaveBeenCalledOnce();
    expect(f.learnBatch).not.toHaveBeenCalled();
  });

  it("bounds unavailable-fact retries and leaves the page uncommitted", async () => {
    const f = fixture("conversation");
    mocks.conversation.mockRejectedValue(new SessionMutationFactsUnavailableError());
    queueMiniMeLearning(f.request);
    await f.done();
    expect(mocks.conversation).toHaveBeenCalledTimes(3);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(f.learnBatch).not.toHaveBeenCalled();
    expect(f.storedCursor()).toBeNull();
    expect(f.source.status).toBe("unavailable");
  });

  it("does not retry through a newly shared conversation", async () => {
    const f = fixture("conversation");
    mocks.extract.mockRejectedValueOnce(new SessionMutationFactsUnavailableError());
    mocks.conversation
      .mockImplementationOnce(async () => ({
        text: "I prefer dark themes.",
        revision: "old",
        cursor: "conversation-1",
        complete: true,
        restarted: false,
        assertCurrent() {},
        release() {},
      }))
      .mockRejectedValue(new Error("conversation is now shared"));
    queueMiniMeLearning(f.request);
    await f.done();
    expect(mocks.conversation).toHaveBeenCalledTimes(2);
    expect(mocks.extract).toHaveBeenCalledOnce();
    expect(f.learnBatch).not.toHaveBeenCalled();
    expect(f.source.status).toBe("unavailable");
  });

  it("retains the genuine source past the foreground request and learns only authored document text", async () => {
    const f = fixture();
    queueMiniMeLearning(f.request);
    expect(f.retainOperator).toHaveBeenCalledOnce();
    f.closeForeground();
    await f.done();
    expect(mocks.extract).toHaveBeenCalledOnce();
    expect(mocks.extract).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: "I prefer dark themes." }),
    );
    expect(f.learnBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "selected-source",
        expectedCursor: null,
        beliefs: [
          expect.objectContaining({ origin: "inferred", status: "active", supersedes: null }),
        ],
      }),
    );
    expect(mocks.project).toHaveBeenCalledOnce();
    expect(f.holds()).toBe(0);
  });

  it("waits for the setup mutation before it reads sources", async () => {
    const f = fixture();
    const entered = createDeferred();
    const finish = createDeferred();
    const mutation = f.lifecycle.mutate(f.request.assertCurrent, async () => {
      queueMiniMeLearning(f.request);
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.extract).not.toHaveBeenCalled();
    finish.resolve();
    await mutation;
    await f.done();
    expect(f.learnBatch).toHaveBeenCalledOnce();
  });

  it.each(["conversation", "original source", "feature generation"] as const)(
    "fences model egress and belief commit after %s revocation",
    async (revocation) => {
      const f = fixture("conversation");
      const entered = createDeferred<Parameters<typeof extractMiniMePreferences>[0]>();
      const finish = createDeferred();
      mocks.extract.mockImplementation(async (context) => {
        entered.resolve(context);
        await finish.promise;
        return [f.extracted];
      });
      queueMiniMeLearning(f.request);
      const context = await entered.promise;
      if (revocation === "conversation") {
        f.revokeConversation();
      } else if (revocation === "original source") {
        f.revokeOriginal();
      } else {
        f.changeGeneration();
      }
      expect(context.assertCurrent).toThrow();
      finish.resolve();
      await f.done();
      expect(f.learnBatch).not.toHaveBeenCalled();
      expect(mocks.project).not.toHaveBeenCalled();
      expect(f.releaseConversation).toHaveBeenCalledOnce();
      if (revocation === "conversation") {
        expect(f.source.status).toBe("unavailable");
      } else {
        expect(f.updateSourceStatus).not.toHaveBeenCalled();
      }
    },
  );

  it("coalesces pending rereads without borrowing the active job's source or repeating unchanged evidence", async () => {
    const f = fixture("conversation");
    const entered = createDeferred();
    const finish = createDeferred();
    mocks.extract.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return [f.extracted];
    });
    queueMiniMeLearning(f.request);
    await entered.promise;
    f.advanceConversation();
    for (let count = 0; count < 12; count++) {
      queueMiniMeLearning(f.request);
    }
    expect(f.holds()).toBe(2);
    finish.resolve();
    await f.done(13);
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(f.learnBatch).toHaveBeenCalledTimes(2);
    queueMiniMeLearning(f.request);
    await f.done(14);
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(f.holds()).toBe(0);
  });

  it("drains a long conversation in bounded rounds under the one retained admission", async () => {
    const f = fixture("conversation");
    f.pages(5);
    queueMiniMeLearning(f.request);
    f.closeForeground();
    await f.done();
    expect(mocks.extract.mock.calls.map(([, input]) => input.text)).toEqual(
      [1, 2, 3, 4, 5].map((page) => `owner page ${page}`),
    );
    expect(f.learnBatch.mock.calls.map(([input]) => [input.expectedCursor, input.cursor])).toEqual([
      [null, "page-1"],
      ["page-1", "page-2"],
      ["page-2", "page-3"],
      ["page-3", "page-4"],
      ["page-4", "page-5"],
    ]);
    const committedStatuses = f.learnBatch.mock.calls.map(([input]) => input.sourceStatus);
    for (const status of committedStatuses.slice(0, -1)) {
      expect(status).toMatchObject({
        status: "pending",
        detail: expect.stringContaining("still learning"),
      });
    }
    expect(committedStatuses.at(-1)).toEqual({ status: "ready", detail: null });
    // Two pages per round: rounds one and two each disclose that learning continues.
    expect(
      f.updateSourceStatus.mock.calls.filter(([input]) => input.detail?.includes("still learning")),
    ).toHaveLength(2);
    expect(f.retainOperator).toHaveBeenCalledOnce();
    expect(f.source).toMatchObject({ status: "ready", detail: null });
    expect(f.holds()).toBe(0);
  });

  it("discloses the bounded admission limit and resumes from committed progress on a later trigger", async () => {
    const f = fixture("conversation");
    f.pages(67);
    queueMiniMeLearning(f.freshRequest());
    await f.done();
    expect(f.storedCursor()).toBe("page-66");
    expect(f.source).toMatchObject({
      status: "limit-reached",
      detail: expect.stringContaining("Pause and resume learning"),
    });
    expect(f.holds()).toBe(0);
    queueMiniMeLearning(f.request);
    await f.done(2);
    expect(f.storedCursor()).toBe("page-67");
    expect(f.source).toMatchObject({ status: "ready", detail: null });
  });

  it("publishes a cursor only with a committed page and resumes from it", async () => {
    const f = fixture("conversation");
    f.pages(3);
    mocks.extract
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => {
        throw new Error("provider failed");
      });
    queueMiniMeLearning(f.request);
    await f.done();
    expect(f.learnBatch).toHaveBeenCalledOnce();
    expect(f.storedCursor()).toBe("page-1");
    expect(f.source.status).toBe("unavailable");
    expect(f.releaseConversation).toHaveBeenCalledTimes(2);

    queueMiniMeLearning(f.request);
    await f.done(2);
    expect(mocks.conversation.mock.calls[2]?.[0].cursor).toBe("page-1");
    expect(f.learnBatch.mock.calls.slice(1).map(([input]) => input.expectedCursor)).toEqual([
      "page-1",
      "page-2",
    ]);
    expect(f.storedCursor()).toBe("page-3");
  });

  it("does not reread a finished past-only conversation", async () => {
    const f = fixture("conversation", "past-only");
    f.setStoredCursor("past-complete");
    f.source.status = "unavailable";
    queueMiniMeLearning(f.request);
    await f.done();
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(f.learnBatch).not.toHaveBeenCalled();
    expect(f.source).toMatchObject({ status: "ready", detail: null });
  });

  it("discloses a conversation restart after committing its new lineage", async () => {
    const f = fixture("conversation");
    f.pages(1, { restartedAt: 1 });
    queueMiniMeLearning(f.request);
    await f.done();
    expect(f.learnBatch).toHaveBeenCalledOnce();
    expect(f.source.status).toBe("ready");
    expect(f.source.detail).toContain("reset or rewritten");
  });

  it("cancels a long conversation without committing or continuing when a mutation starts", async () => {
    const f = fixture("conversation");
    f.pages(3);
    const entered = createDeferred();
    const finish = createDeferred();
    mocks.extract.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return [f.extracted];
    });
    queueMiniMeLearning(f.request);
    await entered.promise;
    const mutation = f.lifecycle.mutate(f.request.assertCurrent, async () => {});
    finish.resolve();
    await mutation;
    await f.done();
    expect(mocks.conversation).toHaveBeenCalledOnce();
    expect(f.learnBatch).not.toHaveBeenCalled();
    expect(f.storedCursor()).toBeNull();
    expect(f.releaseConversation).toHaveBeenCalledOnce();
    expect(f.holds()).toBe(0);
  });

  it("leaves a visible limit and no advanced cursor for oversized authored evidence", async () => {
    const f = fixture();
    f.snapshot.documents[0]!.content = "x".repeat(MINI_ME_LIMITS.inferenceBytes + 1);
    queueMiniMeLearning(f.request);
    await f.done();
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(f.learnBatch).not.toHaveBeenCalled();
    expect(f.source.status).toBe("limit-reached");
    expect(f.source.detail).toContain("Narrow this source");
  });

  it.each(["paused", "disabled", "no consent", "no model"] as const)(
    "does no background work when %s",
    (condition) => {
      const f = fixture();
      if (condition === "paused") {
        f.profile.learningPaused = true;
      }
      if (condition === "disabled") {
        f.profile.lifecycle = "disabled";
      }
      if (condition === "no consent") {
        f.profile.models.allowInference = false;
      }
      if (condition === "no model") {
        f.profile.models.conversationModel = null;
      }
      queueMiniMeLearning(f.request);
      expect(f.retainOperator).not.toHaveBeenCalled();
      expect(mocks.content).not.toHaveBeenCalled();
      expect(mocks.extract).not.toHaveBeenCalled();
    },
  );

  it.each(["forged source", "different owner", "unretainable source"] as const)(
    "rejects %s before scheduling any work",
    (condition) => {
      const f = fixture();
      let operatorAuthority: AdmittedRunOperatorAuthority = f.request.operatorAuthority;
      if (condition === "forged source") {
        operatorAuthority = { ...operatorAuthority };
      }
      if (condition === "unretainable source") {
        operatorAuthority = createAdmittedRunOperatorAuthority({
          profileId: "owner",
          scopes: ["operator.write"],
          assertCurrent: () => {},
        });
      }
      expect(() =>
        queueMiniMeLearning({
          ...f.request,
          ...(condition === "different owner" ? { ownerId: "other" } : {}),
          operatorAuthority,
        }),
      ).toThrow();
      expect(mocks.content).not.toHaveBeenCalled();
      expect(mocks.extract).not.toHaveBeenCalled();
    },
  );
});
