import { Check } from "typebox/schema";
import { AgentsDeleteResultSchema } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { MiniMeProfile } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { createAgent } from "../agents/agent-create.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import { authorizeGatewaySessionCreation } from "../gateway/operator-role-policy.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { queueMiniMeLearning } from "./automatic-learning.js";
import {
  inspectMiniMeDocuments,
  projectMiniMeDocuments,
  removeMiniMeDocuments,
} from "./documents.js";
import {
  assertMiniMeProfileGeneration,
  miniMeHostState,
  miniMeLifecycleForOwner,
  withMiniMeContent,
} from "./host-storage.js";
import { MINI_ME_LIMITS } from "./learning.js";
import { predictMiniMeWithProvider } from "./providers.js";
import { createMiniMeService } from "./service.js";
import { listMiniMeConversationSources, retainMiniMeConversation } from "./sources.js";
import { prepareMiniMeWorkspaceGrants } from "./workspace-grants.js";
import { resolveMiniMeWorkspaceDir } from "./workspace.js";

export function miniMeForGateway(input: {
  options: GatewayRequestHandlerOptions;
  ownerId: string;
  operatorAuthority: AdmittedRunOperatorAuthority;
  assertCurrent(this: void): void;
}) {
  const { options, ownerId, operatorAuthority, assertCurrent } = input;
  const originalRuntimeConfig = options.context.getRuntimeConfig();
  let config = originalRuntimeConfig;
  const getConfig = () => {
    const current = options.context.getRuntimeConfig();
    // A just-committed agent can precede the Gateway's config watcher publication.
    return current !== originalRuntimeConfig ? current : config;
  };
  const guard =
    (profile: MiniMeProfile, assertion = assertCurrent) =>
    () => {
      assertion();
      operatorAuthority.assertCurrent();
      assertMiniMeProfileGeneration(ownerId, profile);
    };
  const queueLearning = (profile: MiniMeProfile) =>
    queueMiniMeLearning({
      ownerId,
      profile,
      config: getConfig(),
      operatorAuthority,
      assertCurrent: () => operatorAuthority.assertCurrent(),
    });
  return createMiniMeService({
    ownerId,
    assertCurrent,
    humanRequest: Boolean(
      options.client?.internal?.authenticatedOperator && !options.client.internal.syntheticClient,
    ),
    lifecycle: miniMeLifecycleForOwner(ownerId),
    state: miniMeHostState,
    withContent: (profile, assertion, consume) =>
      withMiniMeContent(profile, guard(profile, assertion), consume),
    async provision(profile, assertion) {
      const assertHost = guard(profile, assertion);
      const existing = getConfig().agents?.entries?.[profile.agentId];
      if (existing) {
        if (
          existing.miniMe?.ownerProfileId !== ownerId ||
          existing.miniMe.profileId !== profile.id
        ) {
          throw new Error("Mini Me agent binding conflicts with an existing agent");
        }
        return;
      }
      assertHost();
      const agentResult = await createAgent({
        entry: {
          id: profile.agentId,
          name: profile.name,
          miniMe: { ownerProfileId: ownerId, profileId: profile.id },
          decisionModel: profile.models.decisionModel ?? "",
          tools: { deny: ["*"] },
        },
        workspace: resolveMiniMeWorkspaceDir(profile),
        model: profile.models.conversationModel ?? undefined,
        skipBootstrap: true,
        beforePersistentApply: assertHost,
        assertIdentityInputAllowed: assertHost,
        onCommitted: (result) => {
          config = result.config;
        },
      });
      if (agentResult.status === "error") {
        throw new Error(agentResult.message);
      }
      config = agentResult.config;
    },
    async configureAgent(profile, assertion) {
      const assertHost = guard(profile, assertion);
      const result = await transformConfigFileWithRetry({
        writeOptions: { assertCurrent: assertHost },
        transform(current) {
          assertHost();
          const entry = current.agents?.entries?.[profile.agentId];
          if (entry?.miniMe?.ownerProfileId !== ownerId || entry.miniMe.profileId !== profile.id) {
            throw new Error("Mini Me agent ownership changed");
          }
          return {
            nextConfig: {
              ...current,
              agents: {
                ...current.agents,
                entries: {
                  ...current.agents?.entries,
                  [profile.agentId]: {
                    ...entry,
                    name: profile.name,
                    model: profile.models.conversationModel ?? undefined,
                    decisionModel: profile.models.decisionModel ?? "",
                  },
                },
              },
            },
          };
        },
      });
      config = result.nextConfig;
    },
    async deleteAgent(profile, assertion) {
      const assertHost = guard(profile, assertion);
      assertHost();
      await removeMiniMeDocuments({
        workspaceDir: resolveMiniMeWorkspaceDir(profile),
        assertCurrent: assertHost,
      });
      // Mini Me agent IDs are never reused: a recreated identity claims (removes) this
      // tombstone, and the shared journal completes only after an empty failed[] and no purge
      // failure. That receipt only ends this canonical step; the service owns erasure evidence.
      const { readAgentDeletionJournalStatusInWorker } =
        await import("../state/agent-deletion-journal.read.js");
      const status = await readAgentDeletionJournalStatusInWorker(profile.agentId);
      assertHost();
      if (status === "complete") {
        return;
      }
      const { deleteAgentWithGuard } = await import("../gateway/server-methods/agents.js");
      let accepted = false;
      await deleteAgentWithGuard(
        {
          context: options.context,
          client: options.client,
          params: { agentId: profile.agentId, deleteFiles: true },
          respond(ok, payload, error) {
            if (!ok) {
              throw new Error(error?.message ?? "Mini Me agent cleanup failed");
            }
            if (!Check(AgentsDeleteResultSchema, payload) || payload.agentId !== profile.agentId) {
              throw new Error("Mini Me agent cleanup returned an invalid completion receipt");
            }
            if (payload.failed?.length || payload.purgeFailed) {
              throw new Error("Mini Me agent cleanup is incomplete; retry deletion");
            }
            accepted = true;
          },
        },
        assertHost,
      );
      if (!accepted) {
        throw new Error("Mini Me cleanup has no completion receipt");
      }
    },
    project: (profile, store, assertion) =>
      projectMiniMeDocuments({
        ownerId,
        profile,
        store,
        workspaceDir: resolveMiniMeWorkspaceDir(profile),
        assertCurrent: guard(profile, assertion),
      }),
    inspectDocuments: (profile, documents, assertion) =>
      inspectMiniMeDocuments({
        profile,
        documents,
        workspaceDir: resolveMiniMeWorkspaceDir(profile),
        assertCurrent: guard(profile, assertion),
      }),
    assertAgentAllowed(agentId) {
      assertCurrent();
      const entry = getConfig().agents?.entries?.[agentId];
      if (!entry) {
        throw new Error("Choose an existing agent");
      }
      if (entry.miniMe) {
        throw new Error("Attach Mini Me to a working agent, not to a Mini Me agent");
      }
      const error = authorizeGatewaySessionCreation({
        cfg: getConfig(),
        agentId,
        client: options.client,
      });
      if (error) {
        throw new Error(error.message);
      }
    },
    prepareGrants: (agentId, grants, assertion) =>
      prepareMiniMeWorkspaceGrants({
        workspaceDir: resolveAgentWorkspaceDir(getConfig(), agentId),
        grants,
        assertCurrent: assertion,
      }),
    async validateSource(source, assertion) {
      assertion();
      if (source.kind === "conversation") {
        const retained = await retainMiniMeConversation({
          ownerId,
          sessionKey: source.sessionKey,
          getConfig,
          assertCurrent: assertion,
        });
        try {
          retained.assertCurrent();
        } finally {
          retained.release();
        }
      }
    },
    availableSources: (assertion) =>
      listMiniMeConversationSources({
        ownerId,
        context: options.context,
        client: options.client,
        assertCurrent: assertion,
      }),
    predict: (profile, choice, lifetime) =>
      predictMiniMeWithProvider(
        { ownerId, profile, config: getConfig(), operatorAuthority, ...lifetime },
        choice,
      ),
    queueLearning,
    capabilities: {
      maxSources: MINI_ME_LIMITS.sources,
      maxDocumentBytes: MINI_ME_LIMITS.documentBytes,
      maxOptions: MINI_ME_LIMITS.options,
      effects: [
        {
          effect: "workspace.edit",
          available: true,
          reason:
            "Exact local text edits in the embedded core runtime; safe mode retains a restorable preimage. Plugin harnesses (including Codex, Copilot, and AgentsAPI) provide advice only.",
        },
        {
          effect: "message.send",
          available: false,
          reason:
            "This build has no qualified final message transport. Ordinary owner-authorized messages remain available.",
        },
      ],
    },
  });
}
