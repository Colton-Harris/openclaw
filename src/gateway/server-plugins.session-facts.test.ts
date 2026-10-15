import { afterAll, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import type { InternalSessionEntryCore } from "../config/sessions/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
const runtime = createPluginRuntime();

afterAll(async () => {
  await state?.cleanup();
});

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  state ??= await createOpenClawTestState({ scenario: "minimal" });
  state.applyEnv();
  const work = new AsyncWorkScope();
  let fixture: Fixture | undefined;
  try {
    await work.track(async () => {
      fixture = await createFixture("operator.read", false, {
        label: "Review the change",
        lifecycleRevision: "current-generation",
        status: "done",
        lastActivityAt: 1,
        observerDigest: {
          sessionKey,
          headline: "Ready for review",
          assessment: "The change is complete and awaits review.",
          health: "done",
          revision: 3,
          updatedAt: 10,
        },
      });
      const methodRegistry = createRequestGatewayMethodRegistry();
      fixture.context.getGatewayMethodRegistry = () => methodRegistry;
      try {
        await run(fixture);
      } finally {
        await fixture.close();
      }
    });
  } finally {
    try {
      await work.drain();
    } finally {
      await fixture?.removeSessions();
    }
  }
}

function read(fixture: Fixture, sessionKeys: readonly string[]) {
  return withPluginRuntimeGatewayRequestScope(
    {
      context: fixture.context,
      client: fixture.client,
      isWebchatConnect: () => false,
      pluginId: "workboard",
      pluginOrigin: "bundled",
    },
    () => runtime.gateway.readSessionFacts({ sessionKeys }),
  );
}

describe("trusted plugin session facts", () => {
  it("subscribes to narrow keyed invalidations until unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = runtime.gateway.subscribeSessionChanges(listener);
    try {
      sessionChanges.emit({
        agentId: "main",
        sessionKey,
        storePath: "/synthetic/private/store",
        facts: { kind: "removed" },
        factsInvalidated: "category",
      });
      sessionChanges.emit({ sessionKey, factsInvalidated: true });
      sessionChanges.emit({ agentId: "main", sessionKey });
      sessionChanges.emit({ all: true, scope: "stores", factsInvalidated: true });
      expect(listener.mock.calls).toEqual([
        [{ agentId: "main", sessionKey, factsInvalidated: "category" }],
        [{ agentId: "main", sessionKey, factsInvalidated: "true" }],
        [{ agentId: "main", sessionKey }],
      ]);
      unsubscribe();
      sessionChanges.emit({ agentId: "main", sessionKey });
      expect(listener).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe();
    }
  });

  it("lists shared sessions as a trusted service while retaining a scoped client's visibility", () =>
    withFixture(async (fixture) => {
      const foreignKey = "agent:main:foreign-shared";
      const incognitoKey = "agent:main:dashboard:incognito-service-roster";
      await fixture.seed(foreignKey, fixture.other.id, { visibility: "shared" });
      await fixture.seed(incognitoKey, fixture.profile.id, { incognito: true });
      setRuntimeConfigSnapshot({
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: {
                agents: ["main"],
                sessions: { others: "none" },
                scopes: ["operator.read"],
              },
            },
          },
        },
      });
      const list = (client?: Fixture["client"]) =>
        withPluginRuntimeGatewayRequestScope(
          {
            context: fixture.context,
            client,
            isWebchatConnect: () => false,
            pluginId: "workboard",
            pluginOrigin: "bundled",
          },
          () =>
            runtime.gateway.request<{ sessions: Array<{ key: string }> }>(
              "sessions.list",
              {
                configuredAgentsOnly: true,
                includeGlobal: false,
                includeUnknown: false,
                archived: false,
              },
              { scopes: ["operator.read"] },
            ),
        );
      expect((await list()).sessions.map(({ key }) => key).toSorted()).toEqual(
        [sessionKey, foreignKey].toSorted(),
      );
      expect((await list(fixture.client)).sessions.map(({ key }) => key)).toEqual([sessionKey]);
    }));

  it("projects admitted session identity, trajectory and canonical PR states", () =>
    withFixture(async (fixture) => {
      const privateKey = "agent:main:private-change";
      const queuedKey = "agent:main:queued-change";
      const observedRunPatch = {
        lastRunId: "observed-run",
        observerDigest: {
          sessionKey,
          runId: "observed-run",
          headline: "Ready for review",
          assessment: "The change is complete and awaits review.",
          health: "done",
          revision: 3,
          updatedAt: 10,
        },
      } satisfies Partial<InternalSessionEntryCore>;
      await fixture.seed(sessionKey, fixture.profile.id, observedRunPatch);
      await fixture.seed(privateKey, fixture.other.id, { visibility: "draft" });
      await fixture.seed(queuedKey, fixture.profile.id, { status: "queued" });
      fixture.load.mockResolvedValueOnce({
        pullRequests: [
          {
            number: 27,
            owner: "synthetic",
            repo: "project",
            title: "Change",
            branch: "change",
            url: "https://github.com/synthetic/project/pull/27",
            state: "merged",
          },
        ],
        rateLimited: false,
      });
      await fixture.subscriptions.replace(fixture.client.connId, [sessionKey, queuedKey]);
      const result = await read(fixture, [
        sessionKey,
        sessionKey,
        privateKey,
        queuedKey,
        "agent:main:absent",
      ]);
      expect(result.sessions).toHaveLength(2);
      expect(result).toMatchObject({
        sessions: [
          {
            key: sessionKey,
            sessionId: fixture.sessionId,
            lifecycleRevision: "current-generation",
            agentId: "main",
            label: "Review the change",
            run: "idle",
            runReceipt: { runId: "observed-run", status: "done" },
            goalStatus: "none",
            observerDigest: {
              health: "done",
              runId: "observed-run",
              headline: "Ready for review",
              assessment: "The change is complete and awaits review.",
              revision: 3,
            },
            pullRequests: [{ number: 27, state: "merged" }],
            archived: false,
            lastActivityAt: 1,
          },
          { key: queuedKey, run: "active" },
        ],
      });
      const listener = vi.fn();
      const unsubscribe = runtime.gateway.subscribeSessionChanges(listener);
      try {
        fixture.load.mockResolvedValueOnce({ pullRequests: [], rateLimited: false });
        await fixture.subscriptions.pollNow();
        expect((await read(fixture, [sessionKey])).sessions[0]?.pullRequests).toEqual([]);
        expect(listener).toHaveBeenCalledWith({ agentId: "main", sessionKey });
        listener.mockClear();
        sessionChanges.emit({ all: true, scope: "catalog" });
        expect(listener).toHaveBeenCalledWith({ agentId: "main", sessionKey });
        expect(listener).toHaveBeenCalledWith({ agentId: "main", sessionKey: queuedKey });
      } finally {
        unsubscribe();
      }
    }));

  it("keeps an unprovenanced legacy observer digest advisory without inferring a receipt", () =>
    withFixture(async (fixture) => {
      const result = await read(fixture, [sessionKey]);
      expect(result.sessions[0]).toMatchObject({
        run: "idle",
        goalStatus: "none",
        observerDigest: { health: "done", revision: 3 },
      });
      expect(result.sessions[0]).not.toHaveProperty("runReceipt");
      expect(result.sessions[0]?.observerDigest).not.toHaveProperty("runId");
    }));

  it.each(["done", "failed", "interrupted", "killed", "timeout"] as const)(
    "publishes the exact current terminal run receipt for %s",
    (status) =>
      withFixture(async (fixture) => {
        const runId = `terminal-${status}`;
        const terminalRunPatch = {
          status,
          lastRunId: runId,
        } satisfies Partial<InternalSessionEntryCore>;
        await fixture.seed(sessionKey, fixture.profile.id, terminalRunPatch);
        expect((await read(fixture, [sessionKey])).sessions[0]).toMatchObject({
          runReceipt: { runId, status },
          goalStatus: "none",
        });
      }),
  );

  it("keeps a completed turn separate from an ongoing canonical goal", () =>
    withFixture(async (fixture) => {
      const ongoingGoalPatch = {
        status: "done",
        lastRunId: "goal-turn",
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "Synthetic ongoing goal",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 1,
        },
      } satisfies Partial<InternalSessionEntryCore>;
      await fixture.seed(sessionKey, fixture.profile.id, ongoingGoalPatch);
      const session = (await read(fixture, [sessionKey])).sessions[0];
      expect(session).toMatchObject({
        runReceipt: { runId: "goal-turn", status: "done" },
        goalStatus: "active",
      });
      expect(session).not.toHaveProperty("goal");
      expect(session).not.toHaveProperty("objective");
    }));

  it("rejects an old observer and terminal receipt after a current successor starts", () =>
    withFixture(async (fixture) => {
      // Give this exact-run projection case its own synthetic session identity.
      const successorKey = `${sessionKey}-successor-${fixture.sessionId}`;
      const successorSessionId = `${fixture.sessionId}-successor`;
      const successorPatch = {
        sessionId: successorSessionId,
        status: "running",
        startedAt: 20,
        lastRunId: "previous-run",
        lifecycleRevision: "successor-generation",
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "Synthetic ongoing goal",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 1,
        },
        observerDigest: {
          sessionKey: successorKey,
          sessionId: successorSessionId,
          lifecycleRevision: "previous-generation",
          runId: "previous-run",
          headline: "Previous run says done",
          health: "done",
          revision: 4,
          updatedAt: 21,
        },
      } satisfies Partial<InternalSessionEntryCore>;
      await fixture.seed(successorKey, fixture.profile.id, successorPatch);
      fixture.context.chatAbortControllers.set("successor-run", {
        controller: new AbortController(),
        sessionKey: successorKey,
        sessionId: successorSessionId,
        agentId: "main",
        startedAtMs: 20,
        expiresAtMs: Date.now() + 60_000,
        executionStarted: true,
        projectSessionActive: true,
        controlUiVisible: true,
      });
      const previous = (await read(fixture, [successorKey])).sessions[0];
      expect(previous).toMatchObject({ run: "active", goalStatus: "active" });
      expect(previous).not.toHaveProperty("runReceipt");
      expect(previous).not.toHaveProperty("observerDigest");

      await fixture.seed(successorKey, fixture.profile.id, {
        sessionId: successorSessionId,
        observerDigest: {
          sessionKey: successorKey,
          sessionId: successorSessionId,
          lifecycleRevision: "successor-generation",
          runId: "successor-run",
          headline: "The current turn may need input",
          health: "waiting-on-user",
          revision: 5,
          updatedAt: 22,
        },
      });
      expect((await read(fixture, [successorKey])).sessions[0]).toMatchObject({
        run: "active",
        goalStatus: "active",
        observerDigest: { health: "waiting-on-user", runId: "successor-run", revision: 5 },
      });
    }));

  it("scopes canonical receipts to the viewer's current session access", () =>
    withFixture(async (fixture) => {
      const foreignKey = "agent:main:foreign-terminal";
      const foreignRunPatch = {
        visibility: "shared",
        status: "done",
        lastRunId: "foreign-run",
      } satisfies Partial<InternalSessionEntryCore>;
      await fixture.seed(foreignKey, fixture.other.id, foreignRunPatch);
      expect((await read(fixture, [foreignKey])).sessions[0]).toMatchObject({
        runReceipt: { runId: "foreign-run", status: "done" },
      });

      setRuntimeConfigSnapshot({
        ...fixture.cfg,
        gateway: {
          ...fixture.cfg.gateway,
          roles: {
            ...fixture.cfg.gateway?.roles,
            default: "reader",
            definitions: {
              reader: {
                agents: ["main"],
                sessions: { others: "none" },
                scopes: ["operator.read"],
              },
            },
          },
        },
      });
      expect((await read(fixture, [foreignKey])).sessions).toEqual([]);
    }));

  it("bounds batches and distinguishes unavailable PRs from known-empty state", () =>
    withFixture(async (fixture) => {
      await expect(
        read(
          fixture,
          Array.from({ length: 41 }, () => sessionKey),
        ),
      ).rejects.toThrow("at most 40");
      await expect(read(fixture, [" "])).rejects.toThrow("nonempty");
      fixture.load.mockRejectedValueOnce(new Error("Synthetic PR outage"));
      expect(await read(fixture, [sessionKey])).toMatchObject({
        sessions: [{ key: sessionKey, pullRequests: [], pullRequestsUnavailable: true }],
        warnings: ["Pull-request state is unavailable for some sessions."],
      });
    }));

  it("prepares pending membership under the service's bound Gateway without a connected client", () =>
    withFixture(async (fixture) => {
      const releaseForeground = retainSessionListForegroundWork();
      try {
        // Another operator's draft is creator-private; the service read has no sharing
        // filter, so the reader itself must keep it away from preview enrichment.
        const foreignDraft = "agent:main:foreign-draft";
        await fixture.seed(foreignDraft, fixture.other.id, { visibility: "draft" });
        await persistSessionTranscriptTurn(
          { agentId: "main", sessionKey, sessionId: fixture.sessionId },
          {
            messages: [{ message: { role: "assistant", content: "May I merge this change?" } }],
            touchSessionEntry: false,
            updateMode: "none",
          },
        );
        const projection = getSessionRowProjection(fixture.context)!;
        await projection.ensureMaterialized();
        sessionChanges.emit({ agentId: "main", sessionKey, factsInvalidated: "category" });
        expect(projection.needsMembershipPreparation()).toBe(true);
        expect(projection.sharingTargetState({ key: sessionKey, agentId: "main" }).status).toBe(
          "pending",
        );
        const result = await withPluginRuntimeGatewayRequestScope(
          {
            context: fixture.context,
            isWebchatConnect: () => false,
            pluginId: "workboard",
            pluginOrigin: "bundled",
          },
          () => runtime.gateway.readSessionFacts({ sessionKeys: [sessionKey, foreignDraft] }),
        );
        expect(result.sessions).toMatchObject([
          {
            key: sessionKey,
            sessionId: fixture.sessionId,
          },
        ]);
        expect(result.sessions.map((session) => session.key)).not.toContain(foreignDraft);
        // Optional transcript enrichment must not bypass foreground ownership.
        expect(result.sessions[0]?.lastMessagePreview).toBeUndefined();
      } finally {
        releaseForeground();
      }
    }));

  it.for(["current", "session", "owner"] as const)(
    "publishes background PR facts only while its lifetime remains current: %s",
    (lifetime, { signal }) =>
      withFixture(async (fixture) => {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const published = createDeferredCore();
        const listener = vi.fn();
        const subscribe = () =>
          runtime.gateway.subscribeSessionChanges((change) => {
            if (change.sessionKey === sessionKey) {
              listener();
              published.resolve();
            }
          });
        let unsubscribe = lifetime === "current" ? undefined : subscribe();
        fixture.load.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { pullRequests: [], rateLimited: false };
        });
        try {
          const result = await withinTest(read(fixture, [sessionKey]), signal);
          if (lifetime === "current") {
            expect(result.sessions).toMatchObject([
              { key: sessionKey, pullRequestsUnavailable: true },
            ]);
          }
          await withinTest(entered.promise, signal);
          if (lifetime === "current") {
            expect((await read(fixture, [sessionKey])).sessions[0]?.pullRequestsUnavailable).toBe(
              true,
            );
            expect(fixture.load).toHaveBeenCalledTimes(1);
            const projection = getSessionRowProjection(fixture.context)!;
            const query = { key: sessionKey, agentId: "main" };
            const before = projection.capture(query)!;
            const revision = before.databaseFactsRevision;
            const retainedFacts = before.retainedDatabaseFacts;
            expect(retainedFacts).toBeDefined();
            unsubscribe = subscribe();
            release.resolve();
            await withinTest(published.promise, signal);
            const ready = await read(fixture, [sessionKey]);
            expect(projection.capture(query)?.databaseFactsRevision).toBe(revision);
            expect(projection.capture(query)?.retainedDatabaseFacts).toBe(retainedFacts);
            expect(ready.sessions[0]?.pullRequestsUnavailable).toBeUndefined();
            expect(ready.warnings).toBeUndefined();
            expect(fixture.load).toHaveBeenCalledTimes(1);
            fixture.access.abort(new Error("Synthetic caller grant retired"));
            await expect(read(fixture, [sessionKey])).rejects.toThrow();
          } else {
            if (lifetime === "session") {
              await fixture.seed(sessionKey, fixture.other.id, { visibility: "draft" });
            }
            listener.mockClear();
            const stopping = lifetime === "owner" ? fixture.subscriptions.stop() : undefined;
            release.resolve();
            await (stopping ?? fixture.subscriptions.pollNow());
            expect(listener).not.toHaveBeenCalled();
          }
        } finally {
          release.resolve();
          unsubscribe?.();
        }
      }),
  );
});
