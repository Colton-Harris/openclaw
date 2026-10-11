import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateAgentsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { prepareOperatorModelPresentation } from "../operator-model-presentation.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveOperatorRolePolicy,
} from "../operator-role-policy.js";
import { authorizePrivateMiniMeAgent } from "../private-agent-access.js";
import { listAgentsForGateway } from "../session-utils.js";
import {
  readPreparedServerMethodModelCatalog,
  readPreparedServerMethodModelCatalogs,
} from "./optional-model-catalog.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentListHandler: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
}) => {
  if (!assertValidParams(params, validateAgentsListParams, "agents.list", respond)) {
    return;
  }

  const cfg = context.getRuntimeConfig();
  const agentIds = listAgentIds(cfg).filter(
    (agentId) => authorizePrivateMiniMeAgent({ cfg, client, agentId }) === null,
  );
  const modelCatalogByAgentId = context.readPreparedGatewayModelCatalogBatch
    ? await readPreparedServerMethodModelCatalogs(context, agentIds)
    : new Map(
        await Promise.all(
          agentIds.map(
            async (agentId) =>
              [agentId, await readPreparedServerMethodModelCatalog(context, { agentId })] as const,
          ),
        ),
      );
  const result = await listAgentsForGateway(cfg, {
    visibleAgentIds: new Set(agentIds),
    modelCatalogByAgentId,
    includeSystem: hasGatewayClientCap(client?.connect.caps, GATEWAY_CLIENT_CAPS.AGENT_KIND),
    httpAvatarBasePath:
      client?.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI
        ? (cfg.gateway?.controlUi?.basePath ?? "")
        : undefined,
  });
  const currentConfig = context.getRuntimeConfig();
  const roleError = authorizeCurrentOperatorRoleScopes(client, currentConfig);
  if (roleError) {
    respond(false, undefined, roleError);
    return;
  }
  const allowedAgents = resolveOperatorRolePolicy(client, currentConfig)?.agents;
  const privateVisible = result.agents.filter(
    (agent) =>
      authorizePrivateMiniMeAgent({ cfg: currentConfig, client, agentId: agent.id }) === null,
  );
  const agents =
    allowedAgents && allowedAgents !== "*"
      ? privateVisible.filter((agent) => allowedAgents.includes(agent.id))
      : privateVisible;
  const privateDefaultHidden =
    authorizePrivateMiniMeAgent({ cfg: currentConfig, client, agentId: result.defaultId }) !== null;
  if (privateDefaultHidden && !agents.length) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, "No accessible agent is available."),
    );
    return;
  }
  const policy = prepareOperatorModelPresentation({
    cfg: currentConfig,
    policyConfig: context.getCommittedRuntimeConfig?.() ?? currentConfig,
    client,
  });
  respond(
    true,
    {
      ...result,
      ...(privateDefaultHidden ? { defaultId: agents[0]!.id } : {}),
      agents: policy
        ? agents.map((agent) =>
            policy.forAgent(agent.id, modelCatalogByAgentId.get(agent.id)?.entries).agent(agent),
          )
        : agents,
    },
    undefined,
  );
};
