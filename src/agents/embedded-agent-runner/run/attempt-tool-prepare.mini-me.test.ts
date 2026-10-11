import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { MiniMePrediction } from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import type { bindMiniMeForRun } from "../../../mini-me/runtime-binding.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { createMiniMeTool } from "../../tools/mini-me-tool.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { getHoisted, resetEmbeddedAttemptHarness } from "./attempt-spawn-workspace.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

const mocks = vi.hoisted(() => ({
  present: vi.fn(() => true),
  bind: vi.fn<typeof bindMiniMeForRun>(),
}));
// mock-isolation: Keep resident SQLite projections outside this fixture; owner and attachment publication are controlled inputs.
vi.mock("../../../mini-me/private-agent-projection.js", () => ({
  hasActiveMiniMeAttachment: mocks.present,
}));
// mock-isolation: Exercise tool assembly with a controlled binding callback; runtime storage and provider execution are separate proofs.
vi.mock("../../../mini-me/runtime-binding.js", () => ({ bindMiniMeForRun: mocks.bind }));

const prediction: MiniMePrediction = {
  id: "synthetic-embedded-prediction",
  agentId: "main",
  choice: {
    scope: "fixture",
    question: "Which text?",
    options: [
      { id: "a", label: "A", value: "a" },
      { id: "b", label: "B", value: "b" },
    ],
  },
  optionId: "a",
  explanation: "Synthetic assembly fixture.",
  uncertainty: "low",
  evidence: [],
  beliefIds: [],
  correctionApplied: false,
  provider: "fixture",
  rubricVersion: "fixture",
  providerRuntimeGeneration: null,
  createdAt: 1,
  profileGeneration: 1,
  contentRevision: 1,
  authority: "advisory",
};
const toolArgs = { choice: prediction.choice, candidates: [] };
const hoisted = getHoisted();
const cleanups: Array<() => void | Promise<void>> = [];
let writes: Array<Mock<AnyAgentTool["execute"]>>;

beforeEach(() => {
  resetEmbeddedAttemptHarness();
  writes = [];
  mocks.present.mockReset().mockReturnValue(true);
  mocks.bind.mockReset().mockImplementation(async (binding) => async () => {
    binding.signal?.throwIfAborted();
    binding.assertCurrent();
    const write = binding.getAdmittedTool("write");
    await write?.execute("fixture-write", {});
    return {
      kind: write ? "advice" : "pending-owner",
      prediction,
      reason: "Assembly fixture only.",
    };
  });
  hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => {
    const execute = vi.fn<AnyAgentTool["execute"]>(async () => ({ content: [], details: {} }));
    writes.push(execute);
    const write: AnyAgentTool = {
      name: "write",
      label: "Fixture write",
      description: "Synthetic effect for embedded assembly qualification.",
      parameters: Type.Object({}),
      execute,
    };
    const miniMe = createMiniMeTool(options?.miniMeConsultation);
    return miniMe ? [write, miniMe] : [write];
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

async function fixture(options: { withOwner?: boolean; toolsAllow?: string[] } = {}) {
  const config = { tools: { codeMode: false, toolSearch: { enabled: false } } };
  const admission = prepareAgentRunAdmission({
    cfg: config,
    facts: {
      runId: "mini-me-embedded",
      agentId: "main",
      ingress: { kind: "system", boundary: "mini-me-assembly-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef("mini-me-embedded"),
    ...(options.withOwner === false
      ? {}
      : {
          operatorAuthority: createAdmittedRunOperatorAuthority({
            profileId: "original-owner",
            scopes: ["operator.write"],
            assertCurrent: () => {},
          }),
        }),
  });
  cleanups.push(admission.close);
  // Only tool preparation runs; unrelated transcript/model fields belong to the shared harness.
  const attempt = {
    config,
    runId: "mini-me-embedded",
    sessionId: "mini-me-private",
    sessionKey: "agent:main:mini-me-private",
    agentDir: "/tmp/mini-me-assembly-agent",
    modelId: "test-model",
    provider: "anthropic",
    model: makeProviderModelFixture({
      id: "test-model",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    }),
    authProfileStore: { version: 1, profiles: {} },
    admittedRunContext: await admission.admit("embedded"),
    toolsAllow: options.toolsAllow,
  } as EmbeddedRunAttemptInternalParams;
  const prepared = await prepareEmbeddedAttemptToolBase({
    attempt,
    agentDir: attempt.agentDir!,
    setup: createAttemptSetupFixture({ sandboxSessionKey: attempt.sessionKey! }),
    markCoreToolStage: () => {},
    onYield: async () => {},
    runAbortController: new AbortController(),
    runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
    skillUsagePaths: [],
    skillsSnapshot: undefined,
    codeModeSkills: [],
    toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
  });
  cleanups.push(
    () => prepared.toolSurfaceRuntime.cleanup(),
    () => prepared.releaseTools("test-complete"),
  );
  return prepared;
}

describe("embedded Mini Me surface lifetime", () => {
  it("consults only the final allowlisted effect surface", async () => {
    const prepared = await fixture({ toolsAllow: ["mini_me"] });
    const result = await prepared.toolsRaw
      .find((tool) => tool.name === "mini_me")!
      .execute("consult", toolArgs);
    expect(result.details).toMatchObject({ kind: "pending-owner" });
    expect(writes[0]).not.toHaveBeenCalled();
  });

  it("retires a retained consultation when permissions replace its tool generation", async () => {
    const prepared = await fixture();
    const first = prepared.toolsRaw.find((tool) => tool.name === "mini_me")!;
    await first.execute("first-consult", toolArgs);
    expect(writes[0]).toHaveBeenCalledOnce();
    await prepared.refreshPermissionMode(null, () => {});
    await expect(first.execute("stale-consult", toolArgs)).rejects.toThrow();
    const current = prepared.toolsRaw.find((tool) => tool.name === "mini_me")!;
    await current.execute("current-consult", toolArgs);
    expect(writes[0]).toHaveBeenCalledOnce();
    expect(writes[1]).toHaveBeenCalledOnce();
  });

  it.each(["absent attachment", "absent operator"] as const)(
    "preserves ordinary tools without binding Mini Me for %s",
    async (scenario) => {
      mocks.present.mockReturnValue(scenario !== "absent attachment");
      const prepared = await fixture({ withOwner: scenario !== "absent operator" });
      expect(prepared.toolsRaw.find((tool) => tool.name === "mini_me")).toBeUndefined();
      expect(mocks.bind).not.toHaveBeenCalled();
      await prepared.toolsRaw.find((tool) => tool.name === "write")!.execute("ordinary", {});
      expect(writes[0]).toHaveBeenCalledOnce();
    },
  );
});
