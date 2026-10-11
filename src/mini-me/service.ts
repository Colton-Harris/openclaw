import { randomUUID } from "node:crypto";
import type * as M from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { newMiniMeDocumentCorrections } from "./document-corrections.js";
import { renderMiniMeDocument } from "./documents.js";
import { MINI_ME_LIMITS, miniMeEvidenceRevision, normalizeMiniMeValue } from "./learning.js";
import {
  miniMeOperationFingerprint,
  MiniMePersistenceError,
  type MiniMeContentScope,
} from "./persistence.js";
import { miniMeStage, createMiniMeMutation } from "./service-operation.js";
import { createMiniMeReadOperations } from "./service-reads.js";
import type {
  MiniMeContentStore,
  MiniMeServiceDependencies,
  MiniMeStateStore,
  MiniMeMutationContext as MutationContext,
} from "./service.types.js";

export function createMiniMeService(deps: MiniMeServiceDependencies) {
  const ownerId = deps.ownerId;
  const scope = (profile: M.MiniMeProfile): MiniMeContentScope => ({
    ownerId,
    miniMeId: profile.id,
    agentId: profile.agentId,
    generation: profile.generation,
  });
  const empty = (): M.MiniMeSnapshot => ({
    profile: null,
    contentRevision: 0,
    documents: [],
    sources: [],
    beliefs: [],
    predictions: [],
    outcomes: [],
    attachments: [],
    capabilities: deps.capabilities,
    historyCursor: null,
  });
  const requireProfile = async (state: MiniMeStateStore) => {
    const found = await state.read(ownerId);
    if (!found || found.profile.lifecycle === "deleted") {
      throw new MiniMePersistenceError("not-found", "Create your Mini Me first");
    }
    return found;
  };
  const snapshot = async (assertCurrent: () => void, full = false): Promise<M.MiniMeSnapshot> => {
    const current = await deps.state(assertCurrent).read(ownerId);
    if (!current || current.profile.lifecycle === "deleted") {
      return empty();
    }
    if (current.pendingDataChanges.length || current.profile.lifecycle === "deleting") {
      throw new MiniMePersistenceError(
        "lifecycle",
        "Mini Me removal is pending; resume the original operation",
      );
    }
    const content = await deps.withContent(current.profile, assertCurrent, (store) =>
      full ? store.readExport(scope(current.profile)) : store.readSnapshot(scope(current.profile)),
    );
    const documents = await deps.inspectDocuments(
      current.profile,
      content.documents,
      assertCurrent,
    );
    assertCurrent();
    return {
      ...content,
      documents,
      profile: current.profile,
      attachments: current.attachments,
      capabilities: deps.capabilities,
    };
  };
  const initialize = (profile: M.MiniMeProfile, store: MiniMeContentStore, operationId: string) =>
    store.initialize({
      scope: scope(profile),
      operationId: miniMeStage(operationId, `initialize:${profile.generation}`),
    });

  const mutate = createMiniMeMutation(deps, { scope, snapshot, requireProfile });

  const readContent = (profile: M.MiniMeProfile, assertCurrent: () => void) =>
    deps.withContent(profile, assertCurrent, (store) => store.readExport(scope(profile)));
  async function validatePreference(
    context: Pick<MutationContext, "profile" | "assertCurrent">,
    preference: M.MiniMePreference,
    corrects?: string,
  ) {
    if (!deps.humanRequest) {
      throw new Error("Direct preferences require the original owner input");
    }
    if (!corrects) {
      return;
    }
    const content = await readContent(context.profile, context.assertCurrent);
    const prior = content.beliefs.find((belief) => belief.id === corrects);
    if (!prior) {
      throw new MiniMePersistenceError("not-found", "Corrected belief is unavailable");
    }
    if (normalizeMiniMeValue(prior.preference.scope) !== normalizeMiniMeValue(preference.scope)) {
      throw new MiniMePersistenceError(
        "invalid",
        "A correction must use the original preference scope",
      );
    }
  }
  async function validateDocument(
    context: Pick<MutationContext, "profile" | "assertCurrent">,
    params: M.MiniMeDocumentSetParams,
    checkRevision: boolean,
  ) {
    if (Buffer.byteLength(params.content, "utf8") > MINI_ME_LIMITS.documentBytes) {
      throw new Error("Document exceeds 64 KiB UTF-8");
    }
    const content = await readContent(context.profile, context.assertCurrent);
    const documents = await deps.inspectDocuments(
      context.profile,
      content.documents,
      context.assertCurrent,
    );
    const file = documents.find((document) => document.name === params.name);
    if (!file || (checkRevision && file.revision !== params.expectedRevision)) {
      throw new MiniMePersistenceError(
        "conflict",
        "Document changed; inspect its current revision",
      );
    }
    if (file.external && file.external.content !== params.content) {
      throw new MiniMePersistenceError(
        "conflict",
        "An external file edit is preserved. Review and import it before applying another revision",
      );
    }
    // Validate the bounded file including generated evidence before changing its
    // canonical revision, so an oversized import cannot strand a partial commit.
    renderMiniMeDocument(
      context.profile,
      { ...file, content: params.content, revision: file.revision + 1 },
      content.beliefs,
      content,
    );
    if (params.name === "DECISIONS.md") {
      const corrections = newMiniMeDocumentCorrections(file.content, params.content);
      for (const correction of corrections) {
        await validatePreference(context, correction);
      }
    }
  }

  async function reviseGeneration(context: MutationContext) {
    return context.state.advanceGeneration({
      scope: scope(context.profile),
      operationId: miniMeStage(context.operationId, "generation"),
      expectedRevision: context.profile.revision,
    });
  }
  async function withChangedContent(
    context: MutationContext,
    apply: (profile: M.MiniMeProfile, store: MiniMeContentStore) => Promise<unknown>,
  ) {
    const profile = await reviseGeneration(context);
    await deps.withContent(profile, context.assertCurrent, async (store) => {
      await initialize(profile, store, context.operationId);
      await apply(profile, store);
      await deps.project(profile, store, context.assertCurrent);
    });
    deps.queueLearning(profile);
  }
  async function manualBelief(
    context: MutationContext,
    profile: M.MiniMeProfile,
    store: MiniMeContentStore,
    preference: M.MiniMePreference,
    corrects?: string,
    correction = Boolean(corrects),
  ) {
    if (!deps.humanRequest) {
      throw new Error("Direct preferences require the original owner input");
    }
    const content = await store.readSnapshot(scope(profile));
    let source = content.sources.find((item) => item.selection.kind === "manual");
    if (!source) {
      source = {
        id: miniMeStage(profile.id, "manual"),
        selection: { kind: "manual", label: "Direct owner input" },
        revision: 0,
        status: "ready",
        lastIngestedAt: null,
        detail: null,
      };
      await store.addSource({
        scope: scope(profile),
        operationId: miniMeStage(context.operationId, "manual-source"),
        source,
      });
    }
    const belief: M.MiniMeBelief = {
      id: miniMeStage(context.operationId, "belief"),
      preference: { ...preference, scope: normalizeMiniMeValue(preference.scope) },
      origin: correction ? "correction" : "direct",
      status: "active",
      supersedes: corrects ?? null,
      evidence: [
        {
          sourceId: source.id,
          sourceRevision: miniMeEvidenceRevision(
            JSON.stringify({ operationId: context.operationId, preference }),
          ),
          excerpt: preference.statement,
        },
      ],
      createdAt: context.createdAt,
    };
    const result = await store.learnBatch({
      scope: scope(profile),
      operationId: miniMeStage(context.operationId, "belief-write"),
      beliefs: [belief],
    });
    const admitted = result.applied.find((item) => item.id === belief.id);
    if (!admitted) {
      throw new MiniMePersistenceError(
        "conflict",
        "This preference was not admitted; inspect its source and learning history",
      );
    }
    return admitted;
  }

  return {
    ...createMiniMeReadOperations(deps, { scope, snapshot, requireProfile }),
    create: (params: M.MiniMeCreateParams) =>
      deps.lifecycle.mutate(deps.assertCurrent, async () => {
        if (!deps.humanRequest) {
          throw new Error("Mini Me opt-in requires its authenticated owner");
        }
        const assertCurrent = deps.assertCurrent;
        const state = deps.state(assertCurrent);
        const requestFingerprint = miniMeOperationFingerprint(params);
        const previous = await state.operationLookup({ ownerId, operationId: params.operationId });
        if (
          previous &&
          (previous.kind !== "create" || previous.requestFingerprint !== requestFingerprint)
        ) {
          throw new MiniMePersistenceError(
            "operation-conflict",
            "Operation ID belongs to another request",
          );
        }
        if (previous?.state === "complete") {
          return snapshot(assertCurrent);
        }
        const attachments = [];
        for (const attachment of params.attachments) {
          deps.assertAgentAllowed(attachment.agentId);
          attachments.push({
            ...attachment,
            grants: await deps.prepareGrants(attachment.agentId, attachment.grants, assertCurrent),
          });
        }
        if (!previous) {
          if (await state.read(ownerId)) {
            throw new MiniMePersistenceError("conflict", "This owner already has a Mini Me");
          }
          if (
            new Set(params.attachments.map((item) => item.agentId)).size !==
            params.attachments.length
          ) {
            throw new MiniMePersistenceError("invalid", "Select each attached agent only once");
          }
          for (const source of params.sources) {
            await deps.validateSource(source, assertCurrent);
          }
          for (const attachment of params.attachments) {
            deps.assertAgentAllowed(attachment.agentId);
          }
        }
        const rootScope = { ownerId, miniMeId: "" };
        const root = await state.beginOperation({
          scope: rootScope,
          operationId: params.operationId,
          kind: "create",
          requestFingerprint: miniMeOperationFingerprint(params),
        });
        if (root.state === "complete") {
          return snapshot(assertCurrent);
        }
        let profile = await state.beginCreate({
          ownerId,
          operationId: miniMeStage(params.operationId, "profile"),
          name: params.name,
          models: params.models,
        });
        const current = await state.read(ownerId, profile.id);
        if (current && current.profile.lifecycle !== "preparing") {
          // Activation follows all provisioning/source/attachment commits. Resume only
          // its remaining receipt; never re-provision or replay activation with a new revision.
          profile = current.profile;
          if (profile.lifecycle !== "deleted" && profile.lifecycle !== "deleting") {
            await deps.withContent(profile, assertCurrent, (store) =>
              initialize(profile, store, params.operationId),
            );
          }
          await state.finishOperation({
            scope: rootScope,
            operationId: params.operationId,
            kind: "create",
            requestFingerprint,
          });
          if (profile.lifecycle === "active") {
            deps.queueLearning(profile);
          }
          return snapshot(assertCurrent);
        }
        for (const source of params.sources) {
          await deps.validateSource(source, assertCurrent);
        }
        for (const attachment of params.attachments) {
          deps.assertAgentAllowed(attachment.agentId);
        }
        await deps.provision(profile, assertCurrent);
        await deps.withContent(profile, assertCurrent, async (store) => {
          await initialize(profile, store, params.operationId);
          for (const [index, selection] of params.sources.entries()) {
            await store.addSource({
              scope: scope(profile),
              operationId: miniMeStage(params.operationId, `source:${index}`),
              source: {
                id: miniMeStage(params.operationId, `source-id:${index}`),
                selection,
                revision: 0,
                status: selection.kind === "manual" ? "ready" : "pending",
                lastIngestedAt: null,
                detail: null,
              },
            });
          }
          await deps.project(profile, store, assertCurrent);
        });
        for (const attachment of attachments) {
          await state.setAttachment({
            ...attachment,
            scope: scope(profile),
            expectedRevision: 0,
            operationId: miniMeStage(params.operationId, `attach:${attachment.agentId}`),
          });
        }
        profile = (await requireProfile(state)).profile;
        profile = await state.activate({
          scope: scope(profile),
          operationId: miniMeStage(params.operationId, "activate"),
          expectedRevision: profile.revision,
        });
        await deps.withContent(profile, assertCurrent, (store) =>
          initialize(profile, store, params.operationId),
        );
        await state.finishOperation({
          scope: rootScope,
          operationId: params.operationId,
          kind: "create",
          requestFingerprint: miniMeOperationFingerprint(params),
        });
        deps.queueLearning(profile);
        return snapshot(assertCurrent);
      }),
    configure: (params: M.MiniMeConfigureParams) =>
      mutate(
        "configure",
        params,
        async (context) => {
          const { operationId, expectedRevision, ...patch } = params;
          let profile: M.MiniMeProfile;
          if (patch.enabled === false) {
            profile = await context.state.closeLifecycle({
              scope: scope(context.profile),
              operationId: miniMeStage(operationId, "close"),
              expectedRevision,
              lifecycle: "disabling",
            });
            await deps.withContent(profile, context.assertCurrent, (store) =>
              initialize(profile, store, operationId),
            );
            await context.state.finalizeLifecycle({
              scope: scope(profile),
              operationId: miniMeStage(operationId, "disabled"),
              expectedRevision: profile.revision,
              lifecycle: "disabled",
            });
          } else {
            profile = await context.state.configure({
              scope: scope(context.profile),
              operationId: miniMeStage(operationId, "configure"),
              expectedRevision,
              patch,
            });
            await deps.configureAgent(profile, context.assertCurrent);
            await deps.withContent(profile, context.assertCurrent, (store) =>
              initialize(profile, store, operationId),
            );
            deps.queueLearning(profile);
          }
        },
        async ({ profile }) => {
          if (params.enabled === false && profile.lifecycle !== "active") {
            throw new MiniMePersistenceError("lifecycle", "Mini Me is not enabled");
          }
        },
      ),
    learn: (params: M.MiniMeLearnParams) =>
      mutate(
        "learn",
        params,
        (context) =>
          withChangedContent(context, (profile, store) =>
            manualBelief(context, profile, store, params.preference, params.corrects),
          ),
        (context) => validatePreference(context, params.preference, params.corrects),
      ),
    undo: (params: M.MiniMeUndoParams) =>
      mutate(
        "undo",
        params,
        (context) =>
          withChangedContent(context, (profile, store) =>
            store.undo({
              scope: scope(profile),
              operationId: miniMeStage(params.operationId, "undo"),
              beliefId: params.beliefId,
            }),
          ),
        async (context) => {
          const content = await readContent(context.profile, context.assertCurrent);
          if (!content.beliefs.some((belief) => belief.id === params.beliefId)) {
            throw new MiniMePersistenceError("not-found", "Learned belief is unavailable");
          }
        },
      ),
    documentSet: (params: M.MiniMeDocumentSetParams) =>
      mutate(
        "document.set",
        params,
        async (context) => {
          const current = await context.state.read(ownerId, context.profile.id);
          if (!current) {
            throw new MiniMePersistenceError("not-found", "Mini Me profile is unavailable");
          }
          await validateDocument({ ...context, profile: current.profile }, params, false);
          await withChangedContent(context, async (profile, store) => {
            const previous =
              params.name === "DECISIONS.md"
                ? ((await store.readSnapshot(scope(profile))).documents.find(
                    (document) => document.name === params.name,
                  )?.content ?? "")
                : "";
            const corrections =
              params.name === "DECISIONS.md"
                ? newMiniMeDocumentCorrections(previous, params.content)
                : [];
            for (const [index, correction] of corrections.entries()) {
              await manualBelief(
                {
                  ...context,
                  operationId: miniMeStage(params.operationId, `file-correction:${index}`),
                },
                profile,
                store,
                correction,
                undefined,
                true,
              );
            }
            await store.reviseDocument({
              scope: scope(profile),
              operationId: miniMeStage(params.operationId, "document"),
              name: params.name,
              expectedRevision: params.expectedRevision,
              content: params.content,
            });
          });
        },
        (context) => validateDocument(context, params, true),
      ),
    sourceAdd: (params: M.MiniMeSourceAddParams) =>
      mutate(
        "source.add",
        params,
        async (context) => {
          await deps.validateSource(params.source, context.assertCurrent);
          await withChangedContent(context, (profile, store) =>
            store.addSource({
              scope: scope(profile),
              operationId: miniMeStage(params.operationId, "source"),
              source: {
                id: miniMeStage(params.operationId, "source-id"),
                selection: params.source,
                revision: 0,
                status: params.source.kind === "manual" ? "ready" : "pending",
                lastIngestedAt: null,
                detail: null,
              },
            }),
          );
        },
        async (context) => {
          await deps.validateSource(params.source, context.assertCurrent);
          const content = await readContent(context.profile, context.assertCurrent);
          if (content.sources.length >= MINI_ME_LIMITS.sources) {
            throw new MiniMePersistenceError("limit-reached", "Mini Me source limit is reached");
          }
        },
      ),
    sourceRemove: (params: M.MiniMeSourceRemoveParams) =>
      mutate("source.remove", params, async (context) => {
        const changeId = miniMeStage(params.operationId, "source-removal");
        const profile = await context.state.advanceGeneration({
          scope: scope(context.profile),
          operationId: changeId,
          expectedRevision: context.profile.revision,
          change: { kind: "remove-source", sourceId: params.sourceId },
        });
        await deps.withContent(profile, context.assertCurrent, async (store) => {
          await initialize(profile, store, params.operationId);
          await store.removeSource({
            scope: scope(profile),
            operationId: miniMeStage(params.operationId, "purge-source"),
            sourceId: params.sourceId,
          });
          await deps.project(profile, store, context.assertCurrent);
        });
        await context.state.completeDataChange({
          scope: scope(profile),
          operationId: miniMeStage(params.operationId, "source-removed"),
          dataChangeId: changeId,
        });
      }),
    attach: (params: M.MiniMeAttachParams) =>
      mutate(
        "attach",
        params,
        async (context) => {
          deps.assertAgentAllowed(params.agentId);
          await context.state.setAttachment({
            ...params,
            grants: await deps.prepareGrants(params.agentId, params.grants, context.assertCurrent),
            scope: scope(context.profile),
            operationId: miniMeStage(params.operationId, "attach"),
          });
          const { profile } = await requireProfile(context.state);
          await deps.withContent(profile, context.assertCurrent, (store) =>
            initialize(profile, store, params.operationId),
          );
        },
        async ({ attachments, assertCurrent }) => {
          deps.assertAgentAllowed(params.agentId);
          await deps.prepareGrants(params.agentId, params.grants, assertCurrent);
          if (
            (attachments.find((item) => item.agentId === params.agentId)?.revision ?? 0) !==
            params.expectedRevision
          ) {
            throw new MiniMePersistenceError(
              "conflict",
              "Attachment changed; inspect its current revision",
            );
          }
        },
      ),
    detach: (params: M.MiniMeDetachParams) =>
      mutate(
        "detach",
        params,
        async (context) => {
          await context.state.detachAttachment({
            ...params,
            scope: scope(context.profile),
            operationId: miniMeStage(params.operationId, "detach"),
          });
          const { profile } = await requireProfile(context.state);
          await deps.withContent(profile, context.assertCurrent, (store) =>
            initialize(profile, store, params.operationId),
          );
        },
        async ({ attachments }) => {
          if (!attachments.some((item) => item.agentId === params.agentId)) {
            throw new MiniMePersistenceError("conflict", "Agent is already detached from Mini Me");
          }
        },
      ),
    outcome: (params: M.MiniMeOutcomeParams) =>
      mutate(
        "outcome",
        params,
        async (context) => {
          if (!deps.humanRequest) {
            throw new Error("An agent or delegated action cannot report a genuine owner decision");
          }
          await withChangedContent(context, async (profile, store) => {
            const prediction = await store.readExactPrediction({
              scope: scope(profile),
              predictionId: params.predictionId,
            });
            if (
              !prediction ||
              !prediction.choice.options.some((option) => option.id === params.optionId)
            ) {
              throw new Error("Frozen choice is unavailable");
            }
            if (context.createdAt <= prediction.createdAt) {
              throw new Error("The owner decision must follow the frozen prediction");
            }
            const correction = params.correction
              ? await manualBelief(
                  context,
                  profile,
                  store,
                  params.correction,
                  prediction.beliefIds[0],
                  true,
                )
              : undefined;
            await store.appendOutcome({
              scope: scope(profile),
              operationId: miniMeStage(params.operationId, "outcome"),
              outcome: {
                id: miniMeStage(params.operationId, "outcome-id"),
                predictionId: prediction.id,
                optionId: params.optionId,
                origin: "owner",
                matched: prediction.optionId === params.optionId,
                correctionId: correction?.id ?? null,
                createdAt: context.createdAt,
              },
            });
          });
        },
        async (context) => {
          if (!deps.humanRequest) {
            throw new Error("An agent or delegated action cannot report a genuine owner decision");
          }
          const content = await readContent(context.profile, context.assertCurrent);
          const prediction = content.predictions.find((item) => item.id === params.predictionId);
          if (
            !prediction ||
            !prediction.choice.options.some((option) => option.id === params.optionId)
          ) {
            throw new MiniMePersistenceError("not-found", "Frozen choice is unavailable");
          }
          if (Date.now() <= prediction.createdAt) {
            throw new MiniMePersistenceError(
              "invalid",
              "The owner decision must follow the frozen prediction",
            );
          }
          if (
            content.outcomes.some(
              (item) => item.predictionId === prediction.id && item.origin === "owner",
            )
          ) {
            throw new MiniMePersistenceError("conflict", "Decision outcome is already recorded");
          }
          if (params.correction) {
            await validatePreference(context, params.correction, prediction.beliefIds[0]);
          }
        },
      ),
    delete: (params: M.MiniMeDeleteParams) =>
      mutate("delete", params, async (context) => {
        const profile = await context.state.closeLifecycle({
          scope: scope(context.profile),
          operationId: miniMeStage(params.operationId, "close"),
          expectedRevision: params.expectedRevision,
          lifecycle: "deleting",
        });
        // Only this profile-keyed receipt proves erasure: generic agent deletion can complete its
        // journal while retaining files. Any delete operation ID resumes after it without
        // reopening the content database that canonical cleanup may already have retired.
        const erasure = {
          scope: scope(profile),
          operationId: miniMeStage(profile.id, "content-erased"),
          kind: "delete.content-erased",
          requestFingerprint: miniMeOperationFingerprint([profile.id, profile.agentId]),
        };
        const erased = await context.state.operationStatus(erasure);
        if (
          erased &&
          (erased.kind !== erasure.kind || erased.requestFingerprint !== erasure.requestFingerprint)
        ) {
          throw new MiniMePersistenceError(
            "operation-conflict",
            "Erasure receipt identity changed",
          );
        }
        if (erased?.state !== "complete") {
          await deps.withContent(profile, context.assertCurrent, async (store) => {
            await initialize(profile, store, params.operationId);
            // Purge drops the initialize receipt but keeps its own, so a stable ID would replay
            // over the row a retry re-initialized. Each attempt purges afresh instead.
            await store.purge({
              scope: scope(profile),
              operationId: miniMeStage(params.operationId, `purge:${randomUUID()}`),
            });
          });
          await context.state.beginOperation(erasure);
          await context.state.finishOperation(erasure);
        }
        await deps.deleteAgent(profile, context.assertCurrent);
        await context.state.finalizeLifecycle({
          scope: scope(profile),
          operationId: miniMeStage(params.operationId, "deleted"),
          expectedRevision: profile.revision,
          lifecycle: "deleted",
        });
      }),
  };
}
