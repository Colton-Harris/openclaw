import { assert, describe, expect, it } from "vitest";
import type { MiniMeBelief } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  applyMiniMeDecisionOutcome,
  buildMiniMeDecisionBatch,
  predictMiniMeBaseline,
} from "./prediction.js";

// Synthetic preferences exercise the deterministic contract; they are not owner acceptance.
const choice = {
  scope: "editor theme",
  question: "Which theme?",
  options: [
    { id: "a", label: "Light", value: "light" },
    { id: "b", label: "Dark", value: "dark" },
  ],
};
function belief(
  id: string,
  value: string,
  origin: MiniMeBelief["origin"] = "direct",
): MiniMeBelief {
  return {
    id,
    origin,
    status: "active",
    supersedes: null,
    createdAt: 1,
    preference: {
      document: "PREFERENCES.md",
      scope: "editor theme",
      statement: `Prefer ${value}.`,
      preferred: [value],
      avoided: [],
    },
    evidence: [{ sourceId: "manual", sourceRevision: id, excerpt: `Prefer ${value}.` }],
  };
}
const input = (beliefs: MiniMeBelief[]) => ({
  id: "prediction",
  agentId: null,
  choice,
  beliefs,
  profileGeneration: 1,
  contentRevision: 1,
  now: 2,
});

describe("Mini Me grounded choice", () => {
  it("uses a scoped correction over repeated inference while preserving a prior prediction", () => {
    const direct = belief("first", "light");
    const frozen = predictMiniMeBaseline(input([direct]));
    const correction = { ...belief("correction", "dark", "correction"), createdAt: 3 };
    const next = predictMiniMeBaseline(
      input([direct, correction, belief("inferred", "light", "inferred")]),
    );
    expect(frozen.optionId).toBe("a");
    expect(next).toMatchObject({
      optionId: "b",
      correctionApplied: true,
      authority: "advisory",
      uncertainty: "low",
      beliefIds: ["correction"],
    });
    expect(next.evidence).toEqual([
      { sourceId: "manual", sourceRevision: "correction", excerpt: "Prefer dark." },
    ]);
    expect(
      predictMiniMeBaseline({ ...input([correction]), choice: { ...choice, scope: "car color" } })
        .optionId,
    ).toBeNull();
    correction.preference.preferred[0] = "light";
    assert(correction.evidence[0]);
    assert(next.evidence[0]);
    correction.evidence[0].excerpt = "Changed after prediction";
    expect(next.evidence[0].excerpt).toBe("Prefer dark.");
    expect(frozen.optionId).toBe("a");
  });

  it.each([
    ["no evidence", []],
    ["conflicting direct preferences", [belief("a", "light"), belief("b", "dark")]],
    ["undone evidence", [{ ...belief("a", "light"), status: "undone" as const }]],
    ["superseded evidence", [{ ...belief("a", "light"), status: "superseded" as const }]],
  ])("abstains for %s", (_name, beliefs) => {
    expect(predictMiniMeBaseline(input(beliefs))).toMatchObject({
      optionId: null,
      uncertainty: "high",
      authority: "advisory",
    });
  });

  it("labels inferred choices and never treats provider confidence as correctness", () => {
    const state = input([belief("inferred", "light", "inferred")]);
    expect(predictMiniMeBaseline(state).uncertainty).toBe("medium");
    const result = applyMiniMeDecisionOutcome(state, {
      status: "ok",
      result: {
        model: "example/decision",
        answers: {
          preference: {
            type: "choice",
            choice: "b",
            probabilities: { a: 0, b: 1, abstain: 0 },
            confidence: 1,
          },
        },
      },
      provenance: {
        providerId: "example",
        rubricVersion: "mini-me.preference-choice.v1",
        runtimeGeneration: "provider-generation",
      },
    });
    expect(result).toMatchObject({
      optionId: "b",
      uncertainty: "medium",
      authority: "advisory",
      providerRuntimeGeneration: "provider-generation",
    });
    assert(state.beliefs[0]);
    expect(result.evidence).toEqual(state.beliefs[0].evidence);
  });

  it("does not send contradictory or corrected evidence for model reinterpretation", () => {
    expect(
      buildMiniMeDecisionBatch(input([belief("a", "light"), belief("b", "dark")])),
    ).toBeUndefined();
    const corrected = input([belief("a", "dark", "correction")]);
    expect(buildMiniMeDecisionBatch(corrected)).toBeUndefined();
    expect(
      applyMiniMeDecisionOutcome(corrected, { status: "unavailable", reason: "not-configured" })
        .optionId,
    ).toBe("b");
  });

  it("rejects ambiguous option identities instead of scoring an unrepresentable choice", () => {
    const option = choice.options[0];
    assert(option);
    expect(() =>
      predictMiniMeBaseline({
        ...input([]),
        choice: { ...choice, options: [option, option] },
      }),
    ).toThrow("distinct");
  });
});
