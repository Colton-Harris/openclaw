import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDatabaseRequestExecutionSource } from "../state/openclaw-agent-execution-contract.js";
import { openOpenClawAgentSqliteWorkerStore } from "../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type {
  MiniMeContentPersistenceOptions,
  MiniMeContentWorkerOperations,
  MiniMePersistenceOptions,
  MiniMeStateWorkerOperations,
} from "./persistence.types.js";
import {
  invalidateMiniMePrivateAgentProjection,
  prepareMiniMePrivateAgentProjection,
} from "./private-agent-projection.js";
export * from "./persistence.types.js";
/** The caller supplies the authenticated person and live feature fence. These facades mint no identity authority. */
export function createMiniMeStatePersistence(options: MiniMePersistenceOptions) {
  async function execute<Key extends keyof MiniMeStateWorkerOperations>(
    type: Key,
    input: MiniMeStateWorkerOperations[Key]["input"],
  ): Promise<MiniMeStateWorkerOperations[Key]["output"]> {
    options.assertCurrent();
    const context = captureOpenClawStateWorkerContext(options.state);
    const metadataMutation = [
      "miniMe.beginCreate",
      "miniMe.activate",
      "miniMe.configure",
      "miniMe.setAttachment",
      "miniMe.detachAttachment",
      "miniMe.closeLifecycle",
      "miniMe.finalizeLifecycle",
      "miniMe.advanceGeneration",
    ].includes(type);
    if (metadataMutation) {
      invalidateMiniMePrivateAgentProjection(options.state, true);
    }
    let result: MiniMeStateWorkerOperations[Key]["output"];
    try {
      result = await runOpenClawStateWorkerOperation(
        context,
        (scope) => scope.execute({ type, input }),
        {
          assertCurrent: options.assertCurrent,
          createAdmission: () => {
            let phase: "transaction" | "commit" | "complete" = "transaction";
            return {
              nativeLocations: [context.admission.databasePath],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                context.admission.assertCurrent();
                options.assertCurrent();
                if (request.stage !== phase) {
                  throw new Error("Mini Me shared mutation admission is out of order");
                }
                phase = phase === "transaction" ? "commit" : "complete";
                if (!grant()) {
                  throw new Error("Mini Me shared mutation authority expired");
                }
              }),
            };
          },
        },
      );
    } finally {
      if (metadataMutation) {
        // Close reads that overlapped any commit, including another owner's.
        // Refresh even after rejection or lost requester authority: these are
        // host-owned privacy facts, not a private response to the retired caller.
        invalidateMiniMePrivateAgentProjection(options.state, true);
        await prepareMiniMePrivateAgentProjection(options.state);
      }
    }
    options.assertCurrent();
    return result;
  }
  return {
    execute,
    read: (ownerId: string, miniMeId?: string) => execute("miniMe.read", { ownerId, miniMeId }),
    beginCreate: (input: MiniMeStateWorkerOperations["miniMe.beginCreate"]["input"]) =>
      execute("miniMe.beginCreate", input),
    activate: (input: MiniMeStateWorkerOperations["miniMe.activate"]["input"]) =>
      execute("miniMe.activate", input),
    configure: (input: MiniMeStateWorkerOperations["miniMe.configure"]["input"]) =>
      execute("miniMe.configure", input),
    advanceGeneration: (input: MiniMeStateWorkerOperations["miniMe.advanceGeneration"]["input"]) =>
      execute("miniMe.advanceGeneration", input),
    readPendingDataChanges: (
      scope: MiniMeStateWorkerOperations["miniMe.readPendingDataChanges"]["input"]["scope"],
    ) => execute("miniMe.readPendingDataChanges", { scope }),
    completeDataChange: (
      input: MiniMeStateWorkerOperations["miniMe.completeDataChange"]["input"],
    ) => execute("miniMe.completeDataChange", input),
    setAttachment: (input: MiniMeStateWorkerOperations["miniMe.setAttachment"]["input"]) =>
      execute("miniMe.setAttachment", input),
    detachAttachment: (input: MiniMeStateWorkerOperations["miniMe.detachAttachment"]["input"]) =>
      execute("miniMe.detachAttachment", input),
    closeLifecycle: (input: MiniMeStateWorkerOperations["miniMe.closeLifecycle"]["input"]) =>
      execute("miniMe.closeLifecycle", input),
    finalizeLifecycle: (input: MiniMeStateWorkerOperations["miniMe.finalizeLifecycle"]["input"]) =>
      execute("miniMe.finalizeLifecycle", input),
    beginOperation: (input: MiniMeStateWorkerOperations["miniMe.beginOperation"]["input"]) =>
      execute("miniMe.beginOperation", input),
    finishOperation: (input: MiniMeStateWorkerOperations["miniMe.finishOperation"]["input"]) =>
      execute("miniMe.finishOperation", input),
    operationLookup: (input: MiniMeStateWorkerOperations["miniMe.operationLookup"]["input"]) =>
      execute("miniMe.operationLookup", input),
    operationStatus: (input: MiniMeStateWorkerOperations["miniMe.operationStatus"]["input"]) =>
      execute("miniMe.operationStatus", input),
    reserve: (input: MiniMeStateWorkerOperations["miniMe.reserve"]["input"]) =>
      execute("miniMe.reserve", input),
    consume: (input: MiniMeStateWorkerOperations["miniMe.consume"]["input"]) =>
      execute("miniMe.consume", input),
    settle: (input: MiniMeStateWorkerOperations["miniMe.settle"]["input"]) =>
      execute("miniMe.settle", input),
  };
}
export function createMiniMeContentPersistence(options: MiniMeContentPersistenceOptions) {
  async function execute<Key extends keyof MiniMeContentWorkerOperations>(
    type: Key,
    input: MiniMeContentWorkerOperations[Key]["input"],
  ): Promise<MiniMeContentWorkerOperations[Key]["output"]> {
    options.assertCurrent();
    options.execution.assertCurrent();
    if (input.scope.agentId !== options.execution.agentId) {
      throw new Error("Mini Me content scope targets another canonical agent");
    }
    if (type === "initialize") {
      // Native creation and schema preparation use the existing executor, separately from content publication.
      const source: AgentDatabaseRequestExecutionSource = {
        assertCurrent: () => {
          options.assertCurrent();
          options.execution.assertCurrent();
        },
        createAdmission(binding) {
          return () => ({
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              binding.authorize(request);
              binding.assertCurrent();
              options.assertCurrent();
              if (!grant()) {
                throw new Error("Mini Me agent preparation authority expired");
              }
            }, binding.attachment),
          });
        },
      };
      await runOpenClawAgentWorkerWrite(options.databaseOptions, () =>
        options.execution.prepare(source),
      );
      options.assertCurrent();
    }
    const worker = await openOpenClawAgentSqliteWorkerStore<MiniMeContentWorkerOperations>(
      options.databaseOptions,
      { execution: options.execution },
      {
        moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.miniMeContent),
        input: { agentId: options.execution.agentId },
      },
    );
    try {
      const result = await worker.execute({ type, input }, options.assertCurrent);
      options.assertCurrent();
      return result;
    } finally {
      await worker.close();
    }
  }
  return {
    execute,
    initialize: (input: MiniMeContentWorkerOperations["initialize"]["input"]) =>
      execute("initialize", input),
    recordActionRestore: (input: MiniMeContentWorkerOperations["recordActionRestore"]["input"]) =>
      execute("recordActionRestore", input),
    releaseActionRestore: (input: MiniMeContentWorkerOperations["releaseActionRestore"]["input"]) =>
      execute("releaseActionRestore", input),
    readActionRestore: (input: MiniMeContentWorkerOperations["readActionRestore"]["input"]) =>
      execute("readActionRestore", input),
    readActionRestores: (input: MiniMeContentWorkerOperations["readActionRestores"]["input"]) =>
      execute("readActionRestores", input),
    readSnapshot: (scope: MiniMeContentWorkerOperations["readSnapshot"]["input"]["scope"]) =>
      execute("readSnapshot", { scope }),
    readExactPrediction: (input: MiniMeContentWorkerOperations["readExactPrediction"]["input"]) =>
      execute("readExactPrediction", input),
    readExport: (scope: MiniMeContentWorkerOperations["readExport"]["input"]["scope"]) =>
      execute("readExport", { scope }),
    readBeliefs: (input: MiniMeContentWorkerOperations["readBeliefs"]["input"]) =>
      execute("readBeliefs", input),
    history: (input: MiniMeContentWorkerOperations["history"]["input"]) =>
      execute("history", input),
    addSource: (input: MiniMeContentWorkerOperations["addSource"]["input"]) =>
      execute("addSource", input),
    updateSourceStatus: (input: MiniMeContentWorkerOperations["updateSourceStatus"]["input"]) =>
      execute("updateSourceStatus", input),
    removeSource: (input: MiniMeContentWorkerOperations["removeSource"]["input"]) =>
      execute("removeSource", input),
    sourceCursor: (input: MiniMeContentWorkerOperations["sourceCursor"]["input"]) =>
      execute("sourceCursor", input),
    learnBatch: (input: MiniMeContentWorkerOperations["learnBatch"]["input"]) =>
      execute("learnBatch", input),
    reviseDocument: (input: MiniMeContentWorkerOperations["reviseDocument"]["input"]) =>
      execute("reviseDocument", input),
    undo: (input: MiniMeContentWorkerOperations["undo"]["input"]) => execute("undo", input),
    freezePrediction: (input: MiniMeContentWorkerOperations["freezePrediction"]["input"]) =>
      execute("freezePrediction", input),
    appendOutcome: (input: MiniMeContentWorkerOperations["appendOutcome"]["input"]) =>
      execute("appendOutcome", input),
    purge: (input: MiniMeContentWorkerOperations["purge"]["input"]) => execute("purge", input),
  };
}
