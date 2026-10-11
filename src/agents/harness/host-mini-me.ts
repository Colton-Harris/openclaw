import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MiniMeToolConsultation } from "../../mini-me/consultation.js";
import { hasActiveMiniMeAttachment } from "../../mini-me/private-agent-projection.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { registerAgentHarnessPersonalContext } from "./host-personal-context.js";

type HostMiniMeAttempt = Pick<EmbeddedRunAttemptParams, "admittedRunContext"> &
  Partial<
    Pick<
      EmbeddedRunAttemptParams,
      | "agentId"
      | "sessionId"
      | "sessionKey"
      | "trigger"
      | "bootstrapWorkspaceDir"
      | "workspaceDir"
      | "cwd"
    >
  >;

type HostMiniMeCustody = {
  /** The required-workspace floor captured by the host, when one applies. */
  capturedWorkspaceDir?: string;
  config?: OpenClawConfig;
  requesterProfileId?: string;
  assertActive: () => void;
  bindSignal: () => AbortSignal;
};

/**
 * Captures the run identity by value before any plugin handoff can mutate the attempt.
 * `bind` runs once the host has fixed its workspace and liveness owners.
 */
export function captureHostMiniMeRun(attempt: HostMiniMeAttempt) {
  const admittedRunContext = attempt.admittedRunContext;
  const agentId = attempt.agentId;
  const sessionId = attempt.sessionId;
  const sessionKey = attempt.sessionKey;
  const trigger = attempt.trigger;
  const bind = (host: HostMiniMeCustody) => {
    const { config, requesterProfileId, assertActive } = host;
    const workspaceDir =
      host.capturedWorkspaceDir ??
      attempt.bootstrapWorkspaceDir ??
      attempt.workspaceDir ??
      attempt.cwd;
    const prepare = (assertCurrent: () => void = assertActive) => {
      if (
        !requesterProfileId ||
        !config ||
        !agentId ||
        !workspaceDir ||
        !hasActiveMiniMeAttachment(requesterProfileId, agentId)
      ) {
        return undefined;
      }
      let pending: Promise<MiniMeToolConsultation | undefined> | undefined;
      const read = () => {
        assertActive();
        assertCurrent();
        return (pending ??= import("../../mini-me/runtime-binding.js").then(
          async ({ bindMiniMeForRun }) => {
            assertActive();
            assertCurrent();
            return await bindMiniMeForRun({
              admittedRunContext,
              config,
              agentId,
              sessionKey,
              sessionId,
              workspaceDir,
              signal: host.bindSignal(),
              assertCurrent: () => {
                assertActive();
                assertCurrent();
              },
              // Harnesses may replace or exclude these tools after construction,
              // or execute against a remote workspace. This pre-filter surface
              // cannot qualify a delegated effect. Advice remains available.
              getAdmittedTool: () => undefined,
            });
          },
        ));
      };
      const consult: MiniMeToolConsultation = async (input) => {
        const binding = await read();
        assertActive();
        assertCurrent();
        if (!binding) {
          throw new Error("Mini Me is unavailable for this admitted run.");
        }
        return await binding(input);
      };
      return { read, consult };
    };
    const register = (capabilities: AgentHarnessHostCapabilities) =>
      registerAgentHarnessPersonalContext(capabilities, {
        admittedRunContext,
        config,
        agentId,
        workspaceDir,
        sessionKey,
        trigger,
        assertCurrent: assertActive,
      });
    return { prepare, register };
  };
  return { bind };
}
