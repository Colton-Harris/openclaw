import { getRuntimeConfig } from "../../config/config.js";
import { readActiveTranscriptEntryAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readActiveMiniMeOwner } from "../../mini-me/private-agent-projection.js";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { scheduleSkillExperienceReview } from "../../skills/workshop/experience-review-default.js";
import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import type { EmbeddedForegroundPromptContext } from "../embedded-agent-runner/run/params.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { readAgentHarnessPersonalContext } from "./host-personal-context.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

const log = createSubsystemLogger("agents/harness");

type BaseAgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];
type AgentEndSideEffectsParams = Omit<BaseAgentEndSideEffectsParams, "ctx"> & {
  /** Original host custody, never reconstructed from hook identifiers. */
  hostCapabilities?: AgentHarnessHostCapabilities;
  admittedRunContext?: AdmittedRunContext;
  /** Exact completed-turn boundary; context loading stays off the foreground path. */
  skillExperienceReviewSource?: Pick<
    TranscriptEntryAnchor,
    "agentId" | "sessionId" | "sessionKey" | "storePath" | "entryId"
  >;
  ctx: BaseAgentEndSideEffectsParams["ctx"] & {
    authProfileId?: string;
    modelIterations?: number;
    modelContextWindowTokens?: number;
    skillWorkshopAvailable?: boolean;
    compacted?: boolean;
    foregroundPromptContext?: EmbeddedForegroundPromptContext;
  };
};

function scheduleMiniMeSettledSource(params: AgentEndSideEffectsParams): void {
  try {
    const host = params.hostCapabilities
      ? readAgentHarnessPersonalContext(params.hostCapabilities)
      : undefined;
    const admitted = host?.admittedRunContext ?? params.admittedRunContext;
    const sessionKey = host ? host.sessionKey : params.ctx.sessionKey;
    const trigger = host ? host.trigger : params.ctx.trigger;
    if (!admitted || !sessionKey || trigger !== "user") {
      return;
    }
    const operator = readAdmittedRunOperatorAuthority(admitted);
    if (!operator?.retain || !readActiveMiniMeOwner(operator.profileId)) {
      return;
    }
    const release = operator.retain();
    const config = (host ? host.config : params.ctx.config) ?? getRuntimeConfig();
    void import("../../mini-me/settled-source.js")
      .then(({ queueMiniMeSettledSource }) =>
        queueMiniMeSettledSource({ operatorAuthority: operator, sessionKey, config }),
      )
      .catch(() =>
        log.warn(
          "Mini Me could not admit this settled source update; inspect source status before retrying.",
        ),
      )
      .finally(release);
  } catch {
    log.warn("Mini Me source update was not admitted because its owner authority changed.");
  }
}

function runCoreAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  const usedSkills = consumeRunSkillUsage(params.ctx.runId);
  // CLI hook contexts omit skillWorkshopAvailable, so isEligibleContext rejects them.
  const source = params.skillExperienceReviewSource;
  if (!params.ctx.foregroundPromptContext || !source) {
    return;
  }
  // Hook contexts do not always carry the config; the runtime config is the owner at this boundary.
  const config = params.ctx.config ?? getRuntimeConfig();
  const ctx = { ...params.ctx, foregroundPromptContext: params.ctx.foregroundPromptContext };
  try {
    const anchor = readActiveTranscriptEntryAnchor(source);
    if (!anchor) {
      return;
    }
    scheduleSkillExperienceReview({
      event: params.event,
      ctx,
      usedSkills,
      config,
      source: anchor,
    });
  } catch (error) {
    // Side effects are observational; failures must not change the completed run result.
    log.warn(`skill experience review scheduling failed: ${String(error)}`);
  }
}

/** Starts agent-end side effects without waiting for completion. */
export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  scheduleMiniMeSettledSource(params);
  runCoreAgentEndSideEffects(params);
  runAgentHarnessAgentEndHook(params);
}

/** Runs agent-end side effects and waits for plugin/core completion. */
export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  scheduleMiniMeSettledSource(params);
  runCoreAgentEndSideEffects(params);
  await awaitAgentHarnessAgentEndHook(params);
}
