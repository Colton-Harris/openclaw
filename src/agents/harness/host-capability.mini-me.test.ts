import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniMePrediction } from "../../../packages/gateway-protocol/src/schema/mini-me.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import type { bindMiniMeForRun } from "../../mini-me/runtime-binding.js";
import {
  createAdmittedRunOperatorAuthority,
  readAdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import * as agentTools from "../agent-tools.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createMiniMeTool } from "../tools/mini-me-tool.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { readAgentHarnessPersonalContext } from "./host-personal-context.js";

const mocks = vi.hoisted(() => ({
  present: vi.fn(() => true),
  bind: vi.fn<typeof bindMiniMeForRun>(),
}));
// mock-isolation: Keep resident SQLite projections outside this fixture; owner and attachment publication are controlled inputs.
vi.mock("../../mini-me/private-agent-projection.js", () => ({
  hasActiveMiniMeAttachment: mocks.present,
}));
// mock-isolation: Exercise tool assembly with a controlled binding callback; runtime storage and provider execution are separate proofs.
vi.mock("../../mini-me/runtime-binding.js", () => ({ bindMiniMeForRun: mocks.bind }));

const prediction: MiniMePrediction = {
  id: "synthetic-host-prediction",
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
const cleanups: Array<() => void> = [];

beforeEach(() => {
  mocks.present.mockReset().mockReturnValue(true);
  mocks.bind.mockReset().mockImplementation(async (binding) => async () => {
    binding.signal?.throwIfAborted();
    binding.assertCurrent();
    await binding.getAdmittedTool("write")?.execute("bound-write", {});
    return { kind: "advice", prediction, reason: "Assembly fixture only." };
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.restoreAllMocks();
  resetAgentRunRegistryForTest();
});

async function fixture(withOwner = true) {
  const sourceWrite = vi.fn(async () => ({ content: [], details: {} }));
  const sourceTool: AnyAgentTool = {
    name: "write",
    label: "Fixture write",
    description: "Synthetic effect for host assembly qualification.",
    parameters: Type.Object({}),
    execute: sourceWrite,
  };
  const construct = (
    options: Parameters<typeof agentTools.createOpenClawCodingToolsInternal>[0],
  ) => {
    const miniMe = createMiniMeTool(options?.miniMeConsultation);
    return miniMe ? [sourceTool, miniMe] : [sourceTool];
  };
  vi.spyOn(agentTools, "createOpenClawCodingToolsInternal").mockImplementation(construct);
  vi.spyOn(agentTools, "createOpenClawCodingToolsInternalAsync").mockImplementation(
    async (options) => construct(options),
  );
  const host = await createAdmittedHostCapabilityTestFixture(
    {
      runId: "mini-me-host",
      agentId: "main",
      sessionId: "private-session",
      sessionKey: "agent:main:private-session",
      config: {},
      workspaceDir: "/captured/workspace",
    },
    withOwner
      ? {
          operatorAuthority: createAdmittedRunOperatorAuthority({
            profileId: "original-owner",
            scopes: ["operator.write"],
            assertCurrent: () => {},
          }),
        }
      : {},
  );
  cleanups.push(host.closeAdmission, host.closeHost);
  return { host, sourceWrite };
}

describe("harness Mini Me surface authority", () => {
  it("keeps original personal context in host custody and rejects a copied or closed handle", async () => {
    const { host } = await fixture();
    const source = readAgentHarnessPersonalContext(host.hostCapabilities);
    expect(source.agentId).toBe("main");
    expect(source.workspaceDir).toBe("/captured/workspace");
    expect(readAdmittedRunOperatorAuthority(source.admittedRunContext)?.profileId).toBe(
      "original-owner",
    );
    expect(() => readAgentHarnessPersonalContext({ ...host.hostCapabilities })).toThrow(
      "original admitted host",
    );
    expect("admittedRunContext" in host.hostCapabilities).toBe(false);
    host.closeHost();
    expect(() => readAgentHarnessPersonalContext(host.hostCapabilities)).toThrow();
    expect(() => source.assertCurrent()).toThrow();
  });

  it.each(["sync", "async"] as const)(
    "keeps the %s host binding private without delegating through a pre-filter tool surface",
    async (mode) => {
      const { host, sourceWrite } = await fixture();
      const forged = vi.fn();
      const options = {
        agentId: "plugin-selected-agent",
        workspaceDir: "/plugin/selected",
        miniMeConsultation: forged,
      };
      const tools =
        mode === "sync"
          ? host.hostCapabilities.createToolSurface!(options)
          : await host.hostCapabilities.createToolSurfaceAsync!(options);
      if (mode === "sync") {
        expect(mocks.bind).not.toHaveBeenCalled();
      }
      const replacementWrite = vi.fn(async () => ({ content: [], details: {} }));
      tools.find((tool) => tool.name === "write")!.execute = replacementWrite;
      const miniMe = tools.find((tool) => tool.name === "mini_me")!;
      await miniMe.execute("consult", toolArgs);
      expect(sourceWrite).not.toHaveBeenCalled();
      expect(replacementWrite).not.toHaveBeenCalled();
      expect(forged).not.toHaveBeenCalled();
      const binding = mocks.bind.mock.calls[0]?.[0];
      if (!binding) {
        throw new Error("The admitted tool did not capture its host binding");
      }
      expect(readAdmittedRunOperatorAuthority(binding.admittedRunContext)?.profileId).toBe(
        "original-owner",
      );
      expect(binding.agentId).toBe("main");
      expect(binding.workspaceDir).toBe("/captured/workspace");
      expect(binding.getAdmittedTool("write")).toBeUndefined();
      expect(binding.getAdmittedTool("message")).toBeUndefined();
      host.closeHost();
      await expect(miniMe.execute("stale-consult", toolArgs)).rejects.toThrow();
      expect(sourceWrite).not.toHaveBeenCalled();
    },
  );

  it.each(["absent attachment", "absent operator"] as const)(
    "does not expose plugin-supplied Mini Me authority for %s",
    async (scenario) => {
      mocks.present.mockReturnValue(scenario !== "absent attachment");
      const { host, sourceWrite } = await fixture(scenario !== "absent operator");
      const forged = vi.fn();
      const tools = await host.hostCapabilities.createToolSurfaceAsync!({
        miniMeConsultation: forged,
      });
      expect(tools.find((tool) => tool.name === "mini_me")).toBeUndefined();
      expect(mocks.bind).not.toHaveBeenCalled();
      await tools.find((tool) => tool.name === "write")!.execute("ordinary-write", {});
      expect(sourceWrite).toHaveBeenCalledOnce();
      expect(forged).not.toHaveBeenCalled();
    },
  );
});
