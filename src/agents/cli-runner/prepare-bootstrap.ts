import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../bootstrap-files.js";
import { cliBackendLog } from "./log.js";
import type { RunCliAgentParams } from "./types.js";

/** Carry the host's admitted personal-context custody into CLI bootstrap preparation. */
export async function prepareCliBootstrapContext(input: {
  params: RunCliAgentParams;
  workspaceDir: string;
  agentId: string;
  skipsTurnPreparation: boolean;
}) {
  if (input.skipsTurnPreparation) {
    return { bootstrapFiles: [], contextFiles: [] };
  }
  const { params, workspaceDir, agentId } = input;
  return resolveBootstrapContextForRun({
    admittedRunContext: params.admittedRunContext,
    preparedRunAdmission: params.preparedRunAdmission,
    workspaceDir: params.bootstrapWorkspaceDir ?? workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    bootstrapUserProfileId: params.bootstrapUserProfileId,
    chatType: params.chatType ?? params.sessionEntry?.chatType,
    agentId,
    contextMode: params.bootstrapContextMode,
    runKind: params.bootstrapContextRunKind,
    warn: makeBootstrapWarn({
      sessionLabel: params.sessionKey ?? params.sessionId,
      workspaceDir,
      warn: (message) => cliBackendLog.warn(message),
    }),
  });
}
