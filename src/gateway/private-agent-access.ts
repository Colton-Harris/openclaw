import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { resolveAgentEntry } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readMiniMePrivateAgentMetadata } from "../mini-me/private-agent-projection.js";
import { normalizeAgentIdStrict } from "../routing/session-key.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import { isSyntheticGatewayCaller } from "./server-methods/gateway-personal-caller.js";
import type { GatewayClient } from "./server-methods/types.js";

type Params = {
  cfg: OpenClawConfig;
  client: GatewayClient | null | undefined;
  agentId: string;
  ordinaryAgentMutation?: boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  authorityProfileId?: string;
};
class MiniMeManagedMutationError extends Error {
  constructor() {
    super(
      "Manage this agent in Mini Me settings so its model consent, learned data, and attachments stay consistent.",
    );
  }
}
function assertAccess({
  cfg,
  client,
  agentId,
  ordinaryAgentMutation,
  operatorAuthority,
  authorityProfileId,
}: Params): void {
  const normalized = normalizeAgentIdStrict(agentId);
  // An unrepresentable ID names no agent, private or ordinary; strict callers report not found.
  if (!normalized.ok) {
    return;
  }
  const normalizedAgentId = normalized.value;
  const metadata = readMiniMePrivateAgentMetadata(normalizedAgentId);
  const marker = resolveAgentEntry(cfg, normalizedAgentId)?.miniMe;
  if (!metadata && !marker) {
    return;
  }
  if (!metadata || metadata.lifecycle === "deleted" || metadata.lifecycle === "deleting") {
    throw new Error("Private agent access is unavailable");
  }
  if (
    marker &&
    (marker.ownerProfileId !== metadata.ownerId || marker.profileId !== metadata.miniMeId)
  ) {
    throw new Error("Private agent ownership classification changed");
  }
  let requester: string | undefined;
  if (operatorAuthority) {
    // Lifecycle services carry the original branded authority beyond the socket adapter.
    assertAdmittedRunOperatorAuthority(operatorAuthority);
    operatorAuthority.assertCurrent();
    if (authorityProfileId !== operatorAuthority.profileId) {
      throw new Error("Private agent requester authority changed");
    }
    requester = operatorAuthority.profileId;
  } else {
    if (!client || client.invalidated || client.connectionSignal?.aborted) {
      throw new Error("Private agents require their current owner");
    }
    const run = client.internal?.operatorRunAuthority;
    if (run) {
      assertAdmittedRunOperatorAuthority(run);
      run.assertCurrent();
      requester = run.profileId;
      if (
        client.internal?.operatorRoleActor?.kind !== "operator" ||
        client.internal.operatorRoleActor.profileId !== requester
      ) {
        throw new Error("Private agent requester authority changed");
      }
    } else if (!isSyntheticGatewayCaller(client)) {
      requester = client.authenticatedUserProfile?.profileId;
    }
  }
  if (!requester) {
    throw new Error("Private agents require their current owner");
  }
  const owner = captureResidentUserProfileAccess(metadata.ownerId);
  const person = captureResidentUserProfileAccess(requester);
  if (
    owner.readCurrentFacts().profileId !== metadata.ownerId ||
    person.readCurrentFacts().profileId !== metadata.ownerId
  ) {
    throw new Error("Private agents require their current owner");
  }
  owner.assertCurrent();
  person.assertCurrent();
  if (ordinaryAgentMutation) {
    throw new MiniMeManagedMutationError();
  }
}
/** Admin scope, a predicted approval, a system actor and config metadata cannot grant owner access. */
export function authorizePrivateMiniMeAgent(params: Params): ErrorShape | null {
  try {
    assertAccess(params);
    return null;
  } catch (error) {
    if (error instanceof MiniMeManagedMutationError) {
      return errorShape(ErrorCodes.INVALID_REQUEST, error.message);
    }
    return errorShape(ErrorCodes.FORBIDDEN, "This private agent requires its current owner.");
  }
}
/** Recheck against live caller and durable resident ownership after waits and before effects/disclosure. */
export function assertPrivateMiniMeAgentAccess(params: Params): void {
  assertAccess(params);
}
