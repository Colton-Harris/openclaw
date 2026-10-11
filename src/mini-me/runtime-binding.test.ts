import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MiniMeChoice,
  MiniMeProfile,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { resetAgentRunRegistryForTest } from "../infra/agent-run-registry.js";
import type * as hostStorage from "./host-storage.js";
import type * as projection from "./private-agent-projection.js";
import { bindMiniMeForRun } from "./runtime-binding.js";
import type { retainMiniMeConversation } from "./sources.js";

const mocks = vi.hoisted(() => ({
  attachment: vi.fn<typeof projection.readActiveMiniMeAttachment>(),
  generation: vi.fn<typeof hostStorage.assertMiniMeProfileGeneration>(),
  state: vi.fn<() => Pick<ReturnType<typeof hostStorage.miniMeHostState>, "read">>(),
  lifecycle: vi.fn<typeof hostStorage.miniMeLifecycleForOwner>(),
  content: vi.fn<typeof hostStorage.withMiniMeContent>(),
  retain: vi.fn<typeof retainMiniMeConversation>(),
}));
// mock-isolation: Keep resident SQLite projections outside this fixture; owner and attachment publication are controlled inputs.
vi.mock("./private-agent-projection.js", () => ({
  readActiveMiniMeAttachment: mocks.attachment,
}));
// mock-isolation: Keep brokered databases out of this fixture; explicit ports control lifecycle and content commits.
vi.mock("./host-storage.js", () => ({
  assertMiniMeProfileGeneration: mocks.generation,
  miniMeHostState: mocks.state,
  miniMeLifecycleForOwner: mocks.lifecycle,
  withMiniMeContent: mocks.content,
}));
// mock-isolation: Control conversation leases and page completion here; the real reader has its own privacy and paging tests.
vi.mock("./sources.js", () => ({ retainMiniMeConversation: mocks.retain }));
// mock-isolation: Isolate network and model execution so the fixture controls completion and cancellation ordering.
vi.mock("./providers.js", () => ({ predictMiniMeWithProvider: vi.fn() }));
// mock-isolation: Observe projection requests without writing personal files from this scheduling fixture.
vi.mock("./documents.js", () => ({ projectMiniMeDocuments: vi.fn() }));

const profile: MiniMeProfile = {
  id: "mini-owner",
  agentId: "mini-agent",
  name: "Synthetic Mini Me",
  lifecycle: "active",
  learningPaused: false,
  generation: 1,
  revision: 1,
  models: { conversationModel: null, decisionModel: "fixture/decider", allowInference: true },
  createdAt: 1,
  updatedAt: 1,
};
const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.attachment.mockReturnValue({
    ownerId: "owner",
    miniMeId: profile.id,
    targetAgentId: "main",
    profileGeneration: 1,
    attachmentRevision: 1,
  });
  mocks.retain.mockResolvedValue({
    current: vi.fn<Awaited<ReturnType<typeof retainMiniMeConversation>>["current"]>(),
    assertCurrent: () => {},
    release: () => {},
  });
  mocks.state.mockReturnValue({
    read: vi.fn(async () => ({ profile, attachments: [], pendingDataChanges: [] })),
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  resetAgentRunRegistryForTest();
});

async function bind() {
  let ownerCurrent = true;
  let runCurrent = true;
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: "attached-run",
      agentId: "main",
      ingress: { kind: "system", boundary: "mini-me-binding-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef("attached-run"),
    operatorAuthority: createAdmittedRunOperatorAuthority({
      profileId: "owner",
      scopes: ["operator.write"],
      assertCurrent: () => {
        if (!ownerCurrent) {
          throw new Error("original owner revoked");
        }
      },
    }),
  });
  const admittedRunContext = await admission.admit("plugin-harness", "harness-attached-run");
  cleanups.push(admission.close);
  return {
    revokeOwner: () => {
      ownerCurrent = false;
    },
    revokeRun: () => {
      runCurrent = false;
    },
    run: () =>
      bindMiniMeForRun({
        admittedRunContext,
        config: {},
        agentId: "main",
        sessionKey: "agent:main:private-session",
        workspaceDir: "/synthetic/workspace",
        assertCurrent: () => {
          if (!runCurrent) {
            throw new Error("original run retired");
          }
        },
        getAdmittedTool: () => undefined,
      }),
  };
}

// Configure, attach and learn retire the resident projection while attached assistants build tools.
const unavailable = {
  "projection retired": () =>
    mocks.attachment.mockImplementation(() => {
      throw new Error("Private agent ownership is not ready");
    }),
  "state read retired": () =>
    mocks.state.mockReturnValue({
      read: vi.fn(async () => {
        throw new Error("Mini Me state is changing");
      }),
    }),
  "generation changed": () =>
    mocks.generation.mockImplementation(() => {
      throw new Error("Mini Me owner, lifecycle or generation changed");
    }),
};

describe("Mini Me runtime binding during Mini Me state changes", () => {
  it.each([
    "empty topic",
    "one option",
    "too many options",
    "duplicate values",
    "duplicate ids",
    "reserved abstain",
  ])("rejects %s before reading sources or opening a durable consultation", async (reason) => {
    const { run } = await bind();
    const consult = await run();
    expect(consult).toBeTypeOf("function");
    const choice: MiniMeChoice = {
      scope: "fixture",
      question: "Which text?",
      options: [
        { id: "a", label: "A", value: "a" },
        { id: "b", label: "B", value: "b" },
      ],
    };
    if (reason === "empty topic") {
      choice.scope = " ";
    }
    if (reason === "one option") {
      choice.options.pop();
    }
    if (reason === "too many options") {
      choice.options = Array.from({ length: 9 }, (_, index) => ({
        id: String(index),
        label: String(index),
        value: String(index),
      }));
    }
    if (reason === "duplicate values") {
      choice.options[1]!.value = " A ";
    }
    if (reason === "duplicate ids") {
      choice.options[1]!.id = "a";
    }
    if (reason === "reserved abstain") {
      choice.options[1]!.id = "abstain";
    }
    const reads = mocks.retain.mock.calls.length;
    await expect(consult!({ toolCallId: "invalid", choice, candidates: [] })).rejects.toThrow(
      "bounded choice with distinct options",
    );
    expect(mocks.retain).toHaveBeenCalledTimes(reads);
    expect(mocks.lifecycle).not.toHaveBeenCalled();
    expect(mocks.content).not.toHaveBeenCalled();
  });
  it.each(Object.keys(unavailable) as Array<keyof typeof unavailable>)(
    "omits only Mini Me when its %s before binding",
    async (scenario) => {
      unavailable[scenario]();
      const { run } = await bind();
      await expect(run()).resolves.toBeUndefined();
    },
  );

  it.each(["owner", "run"] as const)(
    "still fails the run when the original %s is revoked during that change",
    async (revoked) => {
      const fixture = await bind();
      mocks.state.mockReturnValue({
        read: vi.fn(async () => {
          if (revoked === "owner") {
            fixture.revokeOwner();
          } else {
            fixture.revokeRun();
          }
          throw new Error("Mini Me state is changing");
        }),
      });
      await expect(fixture.run()).rejects.toThrow(
        revoked === "owner" ? "original owner revoked" : "original run retired",
      );
    },
  );

  it("does not suppress source loss once a bound consultation is invoked", async () => {
    const { run } = await bind();
    const consult = await run();
    expect(consult).toBeTypeOf("function");
    mocks.retain.mockRejectedValueOnce(
      new Error("Mini Me can learn only from your selected private conversations"),
    );
    await expect(
      consult!({
        toolCallId: "consult",
        choice: {
          scope: "fixture",
          question: "Which text?",
          options: [
            { id: "a", label: "A", value: "a" },
            { id: "b", label: "B", value: "b" },
          ],
        },
        candidates: [],
      }),
    ).rejects.toThrow("selected private conversations");
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });
});
