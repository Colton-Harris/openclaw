import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { MiniMeProfile } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import { resolveAgentHarnessSelectionDecision } from "../agents/harness/selection-decision.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  MINI_ME_EXTRACTION_INSTRUCTIONS,
  MINI_ME_LIMITS,
  parseMiniMeExtraction,
} from "./learning.js";
import {
  applyMiniMeDecisionOutcome,
  buildMiniMeDecisionBatch,
  MINI_ME_RUBRIC_VERSION,
  predictMiniMeBaseline,
  type MiniMePredictionInput,
} from "./prediction.js";

export type MiniMeProviderContext = {
  ownerId: string;
  profile: MiniMeProfile;
  config: OpenClawConfig;
  operatorAuthority: AdmittedRunOperatorAuthority;
  signal: AbortSignal;
  assertCurrent(this: void): void;
};

function assertOwner(context: MiniMeProviderContext): void {
  context.assertCurrent();
  context.signal.throwIfAborted();
  assertAdmittedRunOperatorAuthority(context.operatorAuthority);
  if (
    context.operatorAuthority.profileId !== context.ownerId ||
    context.profile.lifecycle !== "active"
  ) {
    throw new Error("Mini Me model work requires its active original owner");
  }
}

/** Reuses the shadow adviser's isolated extraction route, with feature consent at egress. */
export async function extractMiniMePreferences(
  context: MiniMeProviderContext,
  source: {
    text: string;
    sourceId: string;
    sourceRevision: string;
  },
) {
  assertOwner(context);
  const configured = context.profile.models.conversationModel;
  if (!context.profile.models.allowInference || !configured || context.profile.learningPaused) {
    throw new Error("Mini Me automatic inference has no current destination consent");
  }
  if (Buffer.byteLength(source.text, "utf8") > MINI_ME_LIMITS.inferenceBytes) {
    throw new Error("Mini Me selected evidence exceeds its inference limit");
  }
  const { model, profile: authProfileId } = splitTrailingAuthProfile(configured);
  const selected = parseProviderModelRef(model);
  if (!selected) {
    throw new Error("Mini Me requires an explicit provider/model for learning");
  }
  const selection = resolveAgentHarnessSelectionDecision({
    config: context.config,
    provider: selected.provider,
    modelId: selected.model,
    agentId: context.profile.agentId,
  });
  // This existing isolated runner exception retains remote helpers; source ingestion
  // must not acquire a service-owned tool surface merely to extract preferences.
  if (selection.policy.runtime === "agentsapi") {
    throw new Error("This model runtime cannot guarantee tool-free Mini Me extraction");
  }
  const { runIsolatedCompletion } = await import("../agents/isolated-completion.js");
  assertOwner(context);
  const result = await runIsolatedCompletion({
    config: context.config,
    provider: selected.provider,
    model: selected.model,
    agentId: context.profile.agentId,
    authProfileId,
    operatorAuthority: context.operatorAuthority,
    assertCurrent: () => assertOwner(context),
    systemPrompt: MINI_ME_EXTRACTION_INSTRUCTIONS,
    prompt: JSON.stringify({ selectedSourceText: source.text }),
    timeoutMs: MINI_ME_LIMITS.inferenceDeadlineMs,
    abortSignal: context.signal,
    streamParams: { maxTokens: 4096 },
  });
  assertOwner(context);
  return parseMiniMeExtraction({ ...source, response: result.text });
}

/** Jev is an optional registered Decision provider; core imports no vendor implementation. */
export async function predictMiniMeWithProvider(
  context: MiniMeProviderContext,
  input: MiniMePredictionInput,
) {
  assertOwner(context);
  const baseline = predictMiniMeBaseline(input);
  if (
    !context.profile.models.decisionModel ||
    (baseline.optionId && baseline.uncertainty === "low")
  ) {
    return baseline;
  }
  const batch = buildMiniMeDecisionBatch(input);
  if (!batch) {
    return baseline;
  }
  if (
    resolveAgentConfig(context.config, context.profile.agentId)?.decisionModel !==
    context.profile.models.decisionModel
  ) {
    throw new Error("Mini Me Decision destination changed after owner consent");
  }
  const [{ evaluateDecisionInRegistry }, { getPluginRegistryForContext }] = await Promise.all([
    import("../decisions/runtime.js"),
    import("../plugins/runtime/gateway-request-scope.js"),
  ]);
  assertOwner(context);
  const result = await evaluateDecisionInRegistry(
    batch,
    {
      agentId: context.profile.agentId,
      purpose: "mini-me.preference-choice",
      rubricVersion: MINI_ME_RUBRIC_VERSION,
      timeoutMs: MINI_ME_LIMITS.inferenceDeadlineMs,
      signal: context.signal,
    },
    getPluginRegistryForContext(),
    context.config,
    undefined,
    () => {
      assertOwner(context);
      return true;
    },
  );
  assertOwner(context);
  return applyMiniMeDecisionOutcome(input, result);
}
