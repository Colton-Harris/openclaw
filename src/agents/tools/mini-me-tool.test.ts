import { describe, expect, it, vi } from "vitest";
import type { MiniMePrediction } from "../../../packages/gateway-protocol/src/schema/mini-me.js";
import type { MiniMeToolConsultation } from "../../mini-me/consultation.js";
import { createMiniMeTool } from "./mini-me-tool.js";

function fixture() {
  const prediction: MiniMePrediction = {
    id: "fixture-prediction",
    agentId: "fixture-agent",
    choice: {
      scope: "fixture",
      question: "Which layout?",
      options: [
        { id: "compact", label: "Compact", value: "compact" },
        { id: "expanded", label: "Expanded", value: "expanded" },
      ],
    },
    optionId: "compact",
    explanation: "Fixture evidence.",
    uncertainty: "low",
    evidence: [{ sourceId: "fixture-source", sourceRevision: "1", excerpt: "Prefer compact." }],
    beliefIds: [],
    correctionApplied: false,
    provider: "fixture",
    rubricVersion: "fixture-1",
    providerRuntimeGeneration: null,
    createdAt: 1,
    profileGeneration: 1,
    contentRevision: 1,
    authority: "advisory",
  };
  const consult = vi.fn<MiniMeToolConsultation>(async () => ({
    kind: "advice",
    prediction,
    reason: "Don't decide is selected.",
  }));
  const tool = createMiniMeTool(consult)!;
  const args = {
    choice: prediction.choice,
    candidates: [
      {
        optionId: "compact",
        effect: "workspace.edit",
        relativePath: "notes.txt",
        content: "compact",
      },
    ],
  };
  return { prediction, consult, tool, args };
}

describe("Mini Me host-bound tool", () => {
  it("is absent without an admitted private-owner binding", () => {
    expect(createMiniMeTool()).toBeNull();
  });

  it("passes bounded choices to the captured host with its actual call id and signal", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const result = await f.tool.execute("host-call", f.args, signal);
    expect(f.consult).toHaveBeenCalledWith({ ...f.args, toolCallId: "host-call", signal });
    expect(result.details).toMatchObject({ kind: "advice", prediction: { authority: "advisory" } });
    const invocation = f.consult.mock.calls[0]?.[0];
    if (!invocation) {
      throw new Error("The tool did not consult its admitted host");
    }
    expect(Object.isFrozen(invocation.choice)).toBe(true);
  });

  it.each(["ownerId", "approved", "mode", "grants"])(
    "rejects model-supplied %s authority",
    async (key) => {
      const f = fixture();
      await expect(f.tool.execute("fixture-call", { ...f.args, [key]: true })).rejects.toThrow(
        "bounded candidates",
      );
      expect(f.consult).not.toHaveBeenCalled();
    },
  );

  it("rejects arbitrary tools and self-classified safe candidates", async () => {
    const f = fixture();
    for (const candidate of [
      { optionId: "compact", effect: "shell", command: "echo fixture" },
      { ...f.args.candidates[0], safe: true },
    ]) {
      await expect(
        f.tool.execute("fixture-call", { ...f.args, candidates: [candidate] }),
      ).rejects.toThrow("bounded candidates");
    }
    expect(f.consult).not.toHaveBeenCalled();
  });

  it("does not serialize settlement errors or nested tool implementation results", async () => {
    const f = fixture();
    f.consult.mockResolvedValueOnce({
      kind: "executed",
      prediction: f.prediction,
      execution: {
        outcome: {
          state: "succeeded",
          value: { content: [], details: { privateImplementation: "unrelated secret" } },
        },
        settlement: { state: "unconfirmed", error: { debug: "private storage detail" } },
        restoreRelease: { state: "unconfirmed", error: { debug: "private cleanup detail" } },
      },
    });
    const result = await f.tool.execute("fixture-call", f.args);
    expect(result.details).toMatchObject({
      execution: { outcome: { state: "succeeded" }, settlement: { state: "unconfirmed" } },
    });
    expect(JSON.stringify(result)).not.toContain("unrelated secret");
    expect(JSON.stringify(result)).not.toContain("private storage detail");
    expect(result.details).toMatchObject({
      execution: { restoreRelease: { state: "unconfirmed" } },
    });
    expect(JSON.stringify(result)).not.toContain("private cleanup detail");
  });
});
