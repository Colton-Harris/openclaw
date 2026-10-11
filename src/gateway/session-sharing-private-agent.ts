import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { authorizePrivateMiniMeAgent } from "./private-agent-access.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import type { SessionMutationAuthorizationParams } from "./session-sharing-authorization.js";
import { resolveSessionMutationTargets } from "./session-sharing-target-input.js";

/** Enforce private owner access before session administration shortcuts. */
export function authorizePrivateMiniMeSessionTargets(
  params: SessionMutationAuthorizationParams,
  getConfig: () => OpenClawConfig,
): ErrorShape | null {
  // The same resident owner gate precedes all administrative sharing shortcuts.
  const privateTargets =
    resolveSessionMutationTargets({
      method: params.method,
      requestParams: params.requestParams,
      context: params.context,
    }) ?? [];
  if (privateTargets.length) {
    const cfg = getConfig();
    for (const target of privateTargets) {
      const agent = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
      if (agent.ok) {
        const error = authorizePrivateMiniMeAgent({
          cfg,
          client: params.client,
          agentId: agent.agentId,
        });
        if (error) {
          return error;
        }
      }
    }
  }
  return null;
}
