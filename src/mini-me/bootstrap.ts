import path from "node:path";
import {
  MINI_ME_DOCUMENT_NAMES,
  type MiniMeDocument,
  type MiniMeProfile,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  readRunOperatorAuthority,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { AgentHarnessHostCapabilities } from "../agents/harness/host-capability-types.js";
import { readAgentHarnessPersonalContext } from "../agents/harness/host-personal-context.js";
import type { WorkspaceBootstrapFile } from "../agents/workspace-bootstrap-policy.js";
import {
  readWorkspaceFileWithGuards,
  setWorkspaceFileSourceIdentity,
} from "../agents/workspace-file-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { inspectMiniMeDocument, renderMiniMeDocument } from "./documents.js";
import {
  assertMiniMeProfileGeneration,
  miniMeHostState,
  miniMeLifecycleForOwner,
  withMiniMeContent,
} from "./host-storage.js";

/** Six private files reach only their own admitted agent, outside shared bootstrap caches. */
export async function loadPrivateMiniMeBootstrap(input: {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId: string;
  hostCapabilities?: AgentHarnessHostCapabilities;
  admittedRunContext?: AdmittedRunContext;
  preparedRunAdmission?: PreparedAgentRunAdmission;
}): Promise<WorkspaceBootstrapFile[]> {
  const host = input.hostCapabilities
    ? readAgentHarnessPersonalContext(input.hostCapabilities)
    : undefined;
  let params = input;
  if (host) {
    if (
      !host.config ||
      !host.workspaceDir ||
      host.agentId !== input.agentId ||
      path.resolve(host.workspaceDir) !== path.resolve(input.workspaceDir)
    ) {
      throw new Error("Mini Me context must use the original host's agent and workspace");
    }
    params = { ...input, config: host.config, admittedRunContext: host.admittedRunContext };
  }
  const marker = params.config.agents?.entries?.[params.agentId]?.miniMe;
  if (
    !marker ||
    path.resolve(params.workspaceDir) !==
      path.resolve(resolveAgentWorkspaceDir(params.config, params.agentId))
  ) {
    return [];
  }
  const operator = readRunOperatorAuthority(params);
  if (!operator || operator.profileId !== marker.ownerProfileId) {
    throw new Error("Mini Me files require the original owning person");
  }
  const assertOwner = () => {
    host?.assertCurrent();
    operator.assertCurrent();
    params.preparedRunAdmission?.assertSourceCurrent();
  };
  return miniMeLifecycleForOwner(operator.profileId).read(
    assertOwner,
    async ({ assertCurrent }) => {
      const current = await miniMeHostState(assertCurrent).read(
        operator.profileId,
        marker.profileId,
      );
      if (
        !current ||
        current.profile.agentId !== params.agentId ||
        current.profile.lifecycle !== "active" ||
        current.pendingDataChanges.length
      ) {
        throw new Error("Mini Me private context is unavailable");
      }
      const profile = current.profile;
      const assertProfile = () => {
        assertCurrent();
        assertMiniMeProfileGeneration(operator.profileId, profile);
      };
      const snapshot = await withMiniMeContent(profile, assertProfile, (store) =>
        store.readExport({
          ownerId: operator.profileId,
          miniMeId: profile.id,
          agentId: profile.agentId,
          generation: profile.generation,
        }),
      );
      const files: WorkspaceBootstrapFile[] = [];
      for (const name of MINI_ME_DOCUMENT_NAMES) {
        const document = snapshot.documents.find((item) => item.name === name);
        if (!document) {
          throw new Error("Mini Me personal file is missing");
        }
        const filePath = path.join(params.workspaceDir, name);
        const loaded = await readWorkspaceFileWithGuards({
          workspaceDir: params.workspaceDir,
          filePath,
          rejectAliases: true,
          useCache: false,
        });
        assertProfile();
        const content = renderMiniMeDocument(profile, document, snapshot.beliefs, snapshot);
        if (
          !loaded.ok ||
          (loaded.content !== content && !isIntactPastProjection(loaded.content, profile, document))
        ) {
          throw new Error(
            `Review and import the external ${name} edit in Mini Me before continuing`,
          );
        }
        // The guarded read still pins this path; a lagging projection serves canonical bytes.
        const file: WorkspaceBootstrapFile = {
          name,
          path: filePath,
          content,
          missing: false,
          miniMe: true,
        };
        setWorkspaceFileSourceIdentity(file, loaded.sourceIdentity);
        files.push(file);
      }
      return files;
    },
  );
}

/**
 * Canonical edits, learning and predictions commit before their file projection.
 * An intact older projection may lag either authored or generated canonical data.
 * Any authored edit, foreign or future header, or altered generated body still needs review.
 */
function isIntactPastProjection(
  text: string,
  profile: MiniMeProfile,
  document: MiniMeDocument,
): boolean {
  let observed: ReturnType<typeof inspectMiniMeDocument>;
  try {
    observed = inspectMiniMeDocument(text, profile, document.name);
  } catch {
    return false;
  }
  return (
    !observed.authoredChanged &&
    (observed.revision < document.revision ||
      (observed.revision === document.revision && observed.authored === document.content))
  );
}
