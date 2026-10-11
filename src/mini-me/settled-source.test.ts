import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MiniMeProfile,
  MiniMeSource,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { SessionMutationFactsUnavailableError } from "../gateway/session-sharing-incognito.js";
import type { prepareSessionMutationFacts } from "../gateway/session-sharing-preparation.js";
import type { queueMiniMeLearning } from "./automatic-learning.js";
import type * as hostStorage from "./host-storage.js";
import type { MiniMeContentSnapshot } from "./persistence.types.js";
import type { readActiveMiniMeOwner } from "./private-agent-projection.js";
import { queueMiniMeSettledSource } from "./settled-source.js";

const mocks = vi.hoisted(() => ({
  owner: vi.fn<typeof readActiveMiniMeOwner>(),
  generation: vi.fn<typeof hostStorage.assertMiniMeProfileGeneration>(),
  state: vi.fn<() => Pick<ReturnType<typeof hostStorage.miniMeHostState>, "read">>(),
  content: vi.fn<typeof hostStorage.withMiniMeContent>(),
  queue: vi.fn<typeof queueMiniMeLearning>(),
  facts: vi.fn<typeof prepareSessionMutationFacts>(),
}));
// mock-isolation: Keep resident SQLite projections outside this fixture; owner and attachment publication are controlled inputs.
vi.mock("./private-agent-projection.js", () => ({ readActiveMiniMeOwner: mocks.owner }));
// mock-isolation: Keep brokered databases out of this fixture; explicit ports control lifecycle and content commits.
vi.mock("./host-storage.js", () => ({
  assertMiniMeProfileGeneration: mocks.generation,
  miniMeHostState: mocks.state,
  withMiniMeContent: mocks.content,
}));
// mock-isolation: Observe settled-turn queue admission without starting background model work.
vi.mock("./automatic-learning.js", () => ({ queueMiniMeLearning: mocks.queue }));
// The real source owner decides privacy; only its session-facts boundary is recorded.
// mock-isolation: Supply controlled private membership and reset facts to the real source-reader policy.
vi.mock("../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: mocks.facts,
}));

const SELECTED = "agent:main:selected-private";
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
const selected: MiniMeSource = {
  id: "selected-source",
  selection: { kind: "conversation", sessionKey: SELECTED, mode: "ongoing" },
  revision: 0,
  status: "ready",
  lastIngestedAt: null,
  detail: null,
};
const pastOnly: MiniMeSource = {
  ...selected,
  id: "past-only-source",
  selection: { kind: "conversation", sessionKey: "agent:main:past-only", mode: "past-only" },
};
let visibility: "draft" | "shared";
const release = vi.fn();
const operatorAuthority = createAdmittedRunOperatorAuthority({
  profileId: "owner",
  scopes: ["operator.write"],
  assertCurrent: () => {},
});

beforeEach(() => {
  vi.resetAllMocks();
  visibility = "draft";
  mocks.owner.mockReturnValue({
    ownerId: "owner",
    miniMeId: profile.id,
    agentId: profile.agentId,
    lifecycle: "active",
    generation: 1,
    revision: 1,
  });
  mocks.state.mockReturnValue({
    read: vi.fn(async () => ({ profile, attachments: [], pendingDataChanges: [] })),
  });
  const snapshot: MiniMeContentSnapshot = {
    contentRevision: 1,
    historyCursor: null,
    sources: [selected, pastOnly],
    documents: [],
    beliefs: [],
    predictions: [],
    outcomes: [],
  };
  mocks.content.mockResolvedValue(snapshot);
  mocks.facts.mockImplementation(async ({ sessionKey }) => ({
    storageTarget: { agentId: "main", canonicalKey: sessionKey, storePath: "/synthetic/store" },
    bindCreation: () => {},
    readCurrent: () => ({
      target: {
        agentId: "main",
        canonicalKey: sessionKey,
        storeKey: sessionKey,
        storeKeys: [sessionKey],
        storePath: "/synthetic/store",
        entry: {
          sessionId: "selected-session",
          updatedAt: 1,
          visibility,
          createdActor: { type: "human", source: "profile", id: "owner" },
        },
      },
      membership: new Set(visibility === "draft" ? ["owner"] : ["owner", "teammate"]),
    }),
    release,
  }));
});

const settle = (sessionKey: string) =>
  queueMiniMeSettledSource({ operatorAuthority, sessionKey, config: {} });

describe("Mini Me settled-turn source admission", () => {
  it.each([
    ["shared", "agent:main:shared-team"],
    ["incognito", "agent:main:dashboard:incognito-owner"],
    ["unselected private", "agent:main:other-private"],
    ["past-only private", "agent:main:past-only"],
  ])("leaves an owner's %s turn ordinary without reading its source", async (kind, key) => {
    if (kind === "shared") {
      visibility = "shared";
    }
    await expect(settle(key)).resolves.toBeUndefined();
    expect(mocks.facts).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("queues learning for the selected ongoing private conversation and releases its source", async () => {
    await settle(SELECTED);
    expect(mocks.facts).toHaveBeenCalledOnce();
    expect(mocks.queue).toHaveBeenCalledOnce();
    expect(mocks.queue).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner",
        profile,
        operatorAuthority,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("re-prepares transiently invalidated settled-turn facts under the same owner", async () => {
    mocks.facts.mockRejectedValueOnce(new SessionMutationFactsUnavailableError());
    await settle(SELECTED);
    expect(mocks.facts).toHaveBeenCalledTimes(2);
    expect(mocks.queue).toHaveBeenCalledWith(expect.objectContaining({ operatorAuthority }));
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds failed settled-turn preparation without queueing a source", async () => {
    mocks.facts.mockRejectedValue(new SessionMutationFactsUnavailableError());
    await expect(settle(SELECTED)).rejects.toThrow("Session access facts are unavailable");
    expect(mocks.facts).toHaveBeenCalledTimes(3);
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("fails visibly when a selected conversation is no longer private", async () => {
    visibility = "shared";
    await expect(settle(SELECTED)).rejects.toThrow("selected private conversations");
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("revalidates profile consent before acquiring the selected source", async () => {
    mocks.generation.mockImplementation(() => {
      throw new Error("Mini Me owner, lifecycle or generation changed");
    });
    await expect(settle(SELECTED)).rejects.toThrow("generation changed");
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
