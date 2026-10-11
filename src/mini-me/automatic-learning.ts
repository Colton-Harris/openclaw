import { randomUUID } from "node:crypto";
import type {
  MiniMeBelief,
  MiniMeProfile,
  MiniMeSource,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SessionMutationFactsUnavailableError } from "../gateway/session-sharing-incognito.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { projectMiniMeDocuments } from "./documents.js";
import { publishMiniMeChanged } from "./events.js";
import {
  assertMiniMeProfileGeneration,
  miniMeHostState,
  miniMeLifecycleForOwner,
  withMiniMeContent,
} from "./host-storage.js";
import { MINI_ME_LIMITS, miniMeEvidenceRevision } from "./learning.js";
import type { MiniMeLifecycleOwner } from "./lifecycle.js";
import { miniMeOperationFingerprint, type MiniMeContentScope } from "./persistence.types.js";
import { extractMiniMePreferences } from "./providers.js";
import {
  isMiniMeConversationCursorComplete,
  readMiniMeConversation,
  type MiniMeConversationPage,
} from "./sources.js";
import { resolveMiniMeWorkspaceDir } from "./workspace.js";

/** Conversation pages (one extraction each) per selected source in one job round. */
const CONVERSATION_PAGES_PER_JOB = 2;
/** Rounds one admission may continue; a later trigger resumes from the durable cursor. */
const MAX_CONTINUATIONS = 32;
const NO_PREFERENCES_DETAIL = "No supported preferences were extracted from this source revision.";
const CONTINUING_DETAIL =
  "Mini Me is still learning from this conversation; it continues from where it stopped.";
const RUN_LIMIT_DETAIL =
  "This import reached its per-run limit. Pause and resume learning to continue from saved progress.";
const RESTARTED_DETAIL =
  "This conversation was reset or rewritten, so Mini Me learned from its current visible history.";

type LearningRequest = {
  ownerId: string;
  profile: MiniMeProfile;
  config: OpenClawConfig;
  operatorAuthority: AdmittedRunOperatorAuthority;
  /** Original source assertion, independent of the completed RPC/run lifetime. */
  assertCurrent(this: void): void;
};
type LearningJob = LearningRequest & {
  release(): void;
  continuations: number;
  sourceRefreshes: number;
};
type LearningQueue = { pending: LearningJob[]; running: boolean };
const queues = resolveGlobalSingleton(
  Symbol.for("openclaw.miniMeLearningQueues"),
  () => new WeakMap<MiniMeLifecycleOwner, LearningQueue>(),
);
const log = createSubsystemLogger("mini-me");

function releaseSource(release: () => void): void {
  try {
    release();
  } catch {
    log.warn("Mini Me could not release a retained learning source cleanly.");
  }
}

function learningAllowed(profile: MiniMeProfile): boolean {
  return (
    profile.lifecycle === "active" &&
    !profile.learningPaused &&
    profile.models.allowInference &&
    Boolean(profile.models.conversationModel)
  );
}

function sourceFailure(error: unknown): Pick<MiniMeSource, "status" | "detail"> {
  const reason = error && typeof error === "object" && "reason" in error ? error.reason : undefined;
  const message = error instanceof Error ? error.message : "";
  const limited =
    reason === "limit-reached" ||
    /bounded import window|evidence exceeds|source exceeds|retained data limit|projection limit/i.test(
      message,
    );
  return limited
    ? {
        status: "limit-reached",
        detail:
          "Learning hit a source or retained-data limit. Narrow this source or inspect and delete learned data before retrying.",
      }
    : {
        status: "unavailable",
        detail:
          "This source could not be learned from. Check its private access and selected model, then retry.",
      };
}

/** Resolves true when a conversation committed progress but has more to examine. */
async function runLearning(job: LearningJob, lifecycle: MiniMeLifecycleOwner): Promise<boolean> {
  await lifecycle.whenMutationsSettled(job.assertCurrent);
  return await lifecycle.read(job.assertCurrent, async (lifetime) => {
    const assertFeature = () => {
      lifetime.assertCurrent();
      assertMiniMeProfileGeneration(job.ownerId, job.profile);
    };
    assertFeature();
    const current = await miniMeHostState(assertFeature).read(job.ownerId, job.profile.id);
    assertFeature();
    if (
      !current ||
      current.profile.id !== job.profile.id ||
      current.profile.agentId !== job.profile.agentId ||
      current.profile.generation !== job.profile.generation ||
      !learningAllowed(current.profile) ||
      current.pendingDataChanges.length
    ) {
      throw new Error("Mini Me learning consent or source generation changed.");
    }
    const scope: MiniMeContentScope = {
      ownerId: job.ownerId,
      miniMeId: job.profile.id,
      agentId: job.profile.agentId,
      generation: job.profile.generation,
    };
    const snapshot = await withMiniMeContent(job.profile, assertFeature, (store) =>
      store.readSnapshot(scope),
    );
    assertFeature();
    // Source admission already caps this collection. Refuse corrupt/unbounded state.
    if (snapshot.sources.length > MINI_ME_LIMITS.sources) {
      throw new Error("Mini Me selected source limit is exceeded.");
    }
    const updateStatus = async (
      source: MiniMeSource,
      status: Pick<MiniMeSource, "status" | "detail">,
    ) => {
      assertFeature();
      await withMiniMeContent(job.profile, assertFeature, (store) =>
        store.updateSourceStatus({
          scope,
          operationId: randomUUID(),
          sourceId: source.id,
          ...status,
        }),
      );
    };
    const markReady = async (source: MiniMeSource, assertSource: () => void) => {
      if (source.status === "ready") {
        return;
      }
      await withMiniMeContent(job.profile, assertSource, (store) =>
        projectMiniMeDocuments({
          ownerId: job.ownerId,
          profile: job.profile,
          workspaceDir: resolveMiniMeWorkspaceDir(job.profile),
          store,
          assertCurrent: assertSource,
        }),
      );
      await updateStatus(source, { status: "ready", detail: null });
    };
    /** Extract one bounded page and atomically commit its beliefs with the next cursor. */
    const learn = async (
      source: MiniMeSource,
      evidence: { text: string; revision: string; expectedCursor: string | null; cursor: string },
      assertSource: () => void,
    ): Promise<number> => {
      const { text, revision } = evidence;
      assertSource();
      if (Buffer.byteLength(text, "utf8") > MINI_ME_LIMITS.inferenceBytes) {
        throw new Error("Selected owner evidence exceeds the bounded inference limit.");
      }
      if (source.status !== "pending" || source.detail) {
        await updateStatus(source, { status: "pending", detail: null });
      }
      const extracted = text.trim()
        ? await extractMiniMePreferences(
            {
              ownerId: job.ownerId,
              profile: job.profile,
              config: job.config,
              operatorAuthority: job.operatorAuthority,
              signal: lifetime.signal,
              assertCurrent: assertSource,
            },
            { text, sourceId: source.id, sourceRevision: revision },
          )
        : [];
      assertSource();
      const createdAt = Date.now();
      const beliefs: MiniMeBelief[] = extracted.map(
        (entry) =>
          Object.assign({}, entry, {
            id: miniMeOperationFingerprint([scope, source.id, revision, entry]),
            status: "active" as const,
            supersedes: null,
            createdAt,
          }) as MiniMeBelief,
      );
      await withMiniMeContent(job.profile, assertSource, async (store) => {
        assertSource();
        await store.learnBatch({
          scope,
          operationId: miniMeOperationFingerprint([
            "automatic-learning",
            scope,
            source.id,
            evidence.expectedCursor,
            evidence.cursor,
          ]),
          sourceId: source.id,
          expectedCursor: evidence.expectedCursor,
          cursor: evidence.cursor,
          beliefs,
        });
        assertSource();
        await projectMiniMeDocuments({
          ownerId: job.ownerId,
          profile: job.profile,
          workspaceDir: resolveMiniMeWorkspaceDir(job.profile),
          store,
          assertCurrent: assertSource,
        });
      });
      return beliefs.length;
    };
    let continuation = false;
    for (const source of snapshot.sources) {
      const selection = source.selection;
      if (selection.kind === "manual") {
        continue;
      }
      try {
        assertFeature();
        let cursor = await withMiniMeContent(job.profile, assertFeature, (store) =>
          store.sourceCursor({ scope, sourceId: source.id }),
        );
        assertFeature();
        if (selection.kind === "document") {
          const document = snapshot.documents.find((item) => item.name === selection.name);
          if (!document) {
            throw new Error("Selected Mini Me document is unavailable.");
          }
          // Canonical authored text only: generated file projections never become evidence.
          const text = document.content;
          const revision = miniMeEvidenceRevision(
            JSON.stringify([document.name, document.revision, text]),
          );
          if (cursor === revision) {
            await markReady(source, assertFeature);
            continue;
          }
          const learned = await learn(
            source,
            { text, revision, expectedCursor: cursor, cursor: revision },
            assertFeature,
          );
          if (!learned) {
            await updateStatus(source, { status: "ready", detail: NO_PREFERENCES_DETAIL });
          }
          continue;
        }
        if (selection.mode === "past-only" && isMiniMeConversationCursorComplete(cursor)) {
          await markReady(source, assertFeature);
          continue;
        }
        let restarted = false;
        let advanced = false;
        let learnedAny = false;
        let complete = false;
        for (let pages = 0; pages < CONVERSATION_PAGES_PER_JOB && !complete; pages++) {
          let retained: MiniMeConversationPage | undefined;
          try {
            retained = await readMiniMeConversation({
              ownerId: job.ownerId,
              sessionKey: selection.sessionKey,
              getConfig: () => job.config,
              assertCurrent: assertFeature,
              signal: lifetime.signal,
              mode: selection.mode,
              cursor,
            });
            const page = retained;
            const assertSource = () => {
              assertFeature();
              page.assertCurrent();
            };
            assertSource();
            complete = page.complete;
            restarted ||= page.restarted;
            // Nothing new was examined: no provider call and no cursor write.
            if (page.cursor === cursor) {
              break;
            }
            advanced = true;
            learnedAny =
              (await learn(
                source,
                {
                  text: page.text,
                  revision: page.revision,
                  expectedCursor: cursor,
                  cursor: page.cursor,
                },
                assertSource,
              )) > 0 || learnedAny;
            cursor = page.cursor;
          } finally {
            if (retained) {
              const retainedSource = retained;
              releaseSource(() => retainedSource.release());
            }
          }
        }
        if (!advanced) {
          await markReady(source, assertFeature);
          continue;
        }
        // Only committed progress may earn a continuation round.
        if (!complete) {
          continuation = true;
        }
        // learnBatch published "ready"; disclose remaining work, a restart or an empty result.
        const runLimitReached = !complete && job.continuations >= MAX_CONTINUATIONS;
        const detail = !complete
          ? runLimitReached
            ? RUN_LIMIT_DETAIL
            : CONTINUING_DETAIL
          : restarted
            ? RESTARTED_DETAIL
            : learnedAny
              ? null
              : NO_PREFERENCES_DETAIL;
        if (detail) {
          await updateStatus(source, {
            status: complete ? "ready" : runLimitReached ? "limit-reached" : "pending",
            detail,
          });
        }
      } catch (error) {
        // Session publication can invalidate retained facts during a legitimate append.
        // Restart from durable progress under the same original owner, with fresh private
        // source admission. Never reuse the invalid facts or commit their model result.
        assertFeature();
        if (
          error instanceof SessionMutationFactsUnavailableError &&
          job.sourceRefreshes < 2 &&
          job.continuations < MAX_CONTINUATIONS
        ) {
          job.sourceRefreshes++;
          return true;
        }
        // A retired owner/profile cannot publish even status. A source that alone
        // became shared can report unavailability without retaining its new text.
        await updateStatus(source, sourceFailure(error));
      }
    }
    assertFeature();
    publishMiniMeChanged(job.ownerId);
    return continuation;
  });
}

async function drain(queue: LearningQueue, lifecycle: MiniMeLifecycleOwner): Promise<void> {
  try {
    let job: LearningJob | undefined;
    while ((job = queue.pending.shift())) {
      let continued = false;
      try {
        const remaining = await runLearning(job, lifecycle);
        const profileId = job.profile.id;
        // Long sources drain in bounded rounds behind other queued work, under this
        // job's own lease. A newer pending job for the profile resumes the cursor instead.
        if (
          remaining &&
          job.continuations < MAX_CONTINUATIONS &&
          !queue.pending.some((entry) => entry.profile.id === profileId)
        ) {
          job.continuations++;
          queue.pending.push(job);
          continued = true;
        }
      } catch {
        // No provider/source exception text: it may contain private prompt data.
        log.warn(
          "Mini Me learning stopped before it could publish source status. Inspect Mini Me and retry from an active owner session.",
        );
      } finally {
        if (!continued) {
          const completedJob = job;
          releaseSource(() => completedJob.release());
        }
      }
    }
  } finally {
    queue.running = false;
  }
}

/** Admit bounded background work using the original owner's retained source. */
export function queueMiniMeLearning(input: LearningRequest): void {
  if (!learningAllowed(input.profile)) {
    return;
  }
  const operatorAuthority = input.operatorAuthority;
  const sourceAssertion = input.assertCurrent;
  const ownerId = input.ownerId;
  const assertCurrent = () => {
    sourceAssertion();
    assertAdmittedRunOperatorAuthority(operatorAuthority);
    if (operatorAuthority.profileId !== ownerId) {
      throw new Error("Mini Me learning requires its original owner authority.");
    }
  };
  assertCurrent();
  if (!operatorAuthority.retain) {
    throw new Error(
      "Automatic learning requires a retainable original owner source. Retry from an authenticated owner session.",
    );
  }
  const release = operatorAuthority.retain();
  let admitted = false;
  try {
    assertCurrent();
    const profile = freezeJsonSnapshot(structuredClone(input.profile));
    const config = freezeJsonSnapshot(structuredClone(input.config));
    const lifecycle = miniMeLifecycleForOwner(ownerId);
    let queue = queues.get(lifecycle);
    if (!queue) {
      queue = { pending: [], running: false };
      queues.set(lifecycle, queue);
    }
    const job: LearningJob = {
      ownerId,
      profile,
      config,
      operatorAuthority,
      assertCurrent,
      release,
      continuations: 0,
      sourceRefreshes: 0,
    };
    // A pending rerun adopts the newest genuine source lease. Active work keeps
    // its own captured source and is never granted authority by the replacement.
    const previousIndex = queue.pending.findIndex((entry) => entry.profile.id === profile.id);
    if (previousIndex >= 0) {
      const previous = queue.pending[previousIndex];
      queue.pending[previousIndex] = job;
      if (previous) {
        releaseSource(() => previous.release());
      }
    } else {
      if (queue.pending.length + (queue.running ? 1 : 0) >= MINI_ME_LIMITS.queuePerOwner) {
        throw new Error(
          "Mini Me automatic learning queue is full; this learning work was not accepted.",
        );
      }
      queue.pending.push(job);
    }
    admitted = true;
    if (!queue.running) {
      queue.running = true;
      // The retained owner authorizes this queue; the completed foreground run's
      // async-work scope must not close underneath its later isolated completion.
      runOutsideAsyncWorkScope(() =>
        setImmediate(() => {
          void drain(queue, lifecycle);
        }),
      );
    }
  } finally {
    if (!admitted) {
      releaseSource(release);
    }
  }
}
