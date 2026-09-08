// Integration regressions for cron-owned heartbeat watchdog handoffs.
import { describe, expect, it, vi } from "vitest";
import {
  createIsolatedRegressionJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler,
  type HeartbeatRunResult,
} from "../../infra/heartbeat-wake.js";
import { saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { stopTimer } from "./timer-execution.js";
import { onTimer } from "./timer.test-support.js";

const heartbeatWatchdogFixtures = setupCronRegressionFixtures({
  prefix: "cron-heartbeat-watchdog-",
});

function requireJob(state: { store?: { jobs?: CronJob[] } | null }, id: string): CronJob {
  const job = state.store?.jobs?.find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`expected cron job ${id}`);
  }
  return job;
}

describe("cron heartbeat watchdog", () => {
  it.each(["busy", "running"] as const)(
    "records a %s monitor accurately beyond its deadline and permits the next recurrence",
    async (scenario) => {
      vi.useFakeTimers();
      const release = createDeferred<HeartbeatRunResult>();
      const handler = vi.fn(async () =>
        scenario === "busy"
          ? { status: "skipped" as const, reason: "requests-in-flight" }
          : release.promise,
      );
      const dispose = setHeartbeatWakeHandler(handler);
      let state: ReturnType<typeof createCronServiceState> | undefined;
      try {
        const store = heartbeatWatchdogFixtures.makeStorePath();
        const scheduledAt = Date.parse("2026-09-02T12:20:00.000Z");
        const everyMs = 30 * 60_000;
        const cronJob = createIsolatedRegressionJob({
          id: `ambient-${scenario}`,
          name: `ambient ${scenario}`,
          scheduledAt,
          schedule: { kind: "every", everyMs, anchorMs: scheduledAt - everyMs },
          payload: { kind: "heartbeat" },
          state: { nextRunAtMs: scheduledAt },
        });
        cronJob.sessionTarget = "main";
        await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });
        vi.setSystemTime(scheduledAt);
        let enqueued = createDeferred();
        state = createCronServiceState({
          cronEnabled: true,
          storePath: store.storePath,
          log: noopLogger,
          nowMs: () => Date.now(),
          defaultAgentId: "main",
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          resolveHeartbeatTimeoutMs: () => 300_000,
          requestHeartbeatAndWait: (wake, lifecycle) => {
            const result = requestHeartbeatAndWait({ ...wake, coalesceMs: 0 }, lifecycle);
            enqueued.resolve();
            return result;
          },
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });

        const firstTick = onTimer(state);
        await enqueued.promise;
        await vi.advanceTimersByTimeAsync(1);
        if (scenario === "busy") {
          await firstTick;
          expect(requireJob(state, cronJob.id).state.lastStatus).toBe("skipped");
          stopTimer(state);
        }
        await vi.advanceTimersByTimeAsync(300_000);
        await firstTick;
        stopTimer(state);
        expect(handler).toHaveBeenCalledOnce();
        const firstState = requireJob(state, cronJob.id).state;
        expect(firstState.lastStatus).toBe(scenario === "busy" ? "skipped" : "error");
        expect(firstState.lastError).toContain(
          scenario === "busy" ? "requests-in-flight" : "job execution timed out",
        );

        release.resolve({ status: "ran", durationMs: 1 });
        await vi.advanceTimersByTimeAsync(0);
        handler.mockResolvedValue({ status: "ran", durationMs: 1 });
        vi.setSystemTime(firstState.nextRunAtMs!);
        enqueued = createDeferred();
        const nextTick = onTimer(state);
        await enqueued.promise;
        await vi.advanceTimersByTimeAsync(1);
        await nextTick;
        expect(handler).toHaveBeenCalledTimes(2);
        expect(requireJob(state, cronJob.id).state.lastStatus).toBe("ok");
      } finally {
        if (state) {
          stopTimer(state);
        }
        release.resolve({ status: "ran", durationMs: 1 });
        dispose();
        const drain = setHeartbeatWakeHandler(async () => ({
          status: "skipped",
          reason: "disabled",
        }));
        await vi.advanceTimersByTimeAsync(250);
        drain();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    {
      name: "monitor",
      payload: { kind: "heartbeat" } as const,
      wakeMode: "next-heartbeat" as const,
    },
    {
      name: "main system event",
      payload: { kind: "systemEvent", text: "check heartbeat work" } as const,
      wakeMode: "now" as const,
    },
  ])(
    "disables the outer watchdog for an unlimited $name heartbeat",
    async ({ payload, wakeMode }) => {
      vi.useFakeTimers();
      try {
        const store = heartbeatWatchdogFixtures.makeStorePath();
        const scheduledAt = Date.parse("2026-09-02T12:20:00.000Z");
        const cronJob = createIsolatedRegressionJob({
          id: `unlimited-${payload.kind}`,
          name: `unlimited ${payload.kind}`,
          scheduledAt,
          schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
          payload,
          state: { nextRunAtMs: scheduledAt },
        });
        cronJob.sessionTarget = "main";
        cronJob.wakeMode = wakeMode;
        await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

        vi.setSystemTime(scheduledAt);
        const heartbeatStarted = createDeferred();
        const releaseHeartbeat = createDeferred();
        const runHeartbeat = async () => {
          heartbeatStarted.resolve();
          await releaseHeartbeat.promise;
          return { status: "ran" as const, durationMs: 1 };
        };
        const state = createCronServiceState({
          cronEnabled: true,
          storePath: store.storePath,
          log: noopLogger,
          nowMs: () => Date.now(),
          defaultAgentId: "main",
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          resolveHeartbeatTimeoutMs: vi.fn(() => undefined),
          requestHeartbeatAndWait:
            vi.fn<NonNullable<CronServiceDeps["requestHeartbeatAndWait"]>>(runHeartbeat),
          runHeartbeatOnce: vi.fn<NonNullable<CronServiceDeps["runHeartbeatOnce"]>>(runHeartbeat),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });

        const timerPromise = onTimer(state);
        let timerSettled = false;
        void timerPromise.then(() => {
          timerSettled = true;
        });
        await heartbeatStarted.promise;

        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(timerSettled).toBe(false);

        releaseHeartbeat.resolve();
        await timerPromise;
        expect(requireJob(state, cronJob.id).state.lastStatus).toBe("ok");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps the cron deadline while a heartbeat-backed trigger is still evaluating", async () => {
    vi.useFakeTimers();
    try {
      const store = heartbeatWatchdogFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-09-02T12:30:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "heartbeat-trigger-watchdog",
        name: "heartbeat trigger watchdog",
        scheduledAt,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt - 60_000 },
        payload: { kind: "systemEvent", text: "check heartbeat work" },
        state: { nextRunAtMs: scheduledAt },
      });
      cronJob.sessionTarget = "main";
      cronJob.wakeMode = "now";
      cronJob.trigger = { script: "return { fire: true };" };
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      vi.setSystemTime(scheduledAt);
      const triggerStarted = createDeferred();
      const resolveHeartbeatTimeoutMs = vi.fn(() => 15 * 60_000);
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => Date.now(),
        defaultAgentId: "main",
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runHeartbeatOnce: vi.fn(async () => ({ status: "ran" as const, durationMs: 1 })),
        resolveHeartbeatTimeoutMs,
        evaluateCronTrigger: vi.fn(async () => {
          triggerStarted.resolve();
          return await new Promise<never>(() => {});
        }),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      const timerPromise = onTimer(state);
      await triggerStarted.promise;
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      await timerPromise;

      expect(resolveHeartbeatTimeoutMs).not.toHaveBeenCalled();
      expect(state.deps.runHeartbeatOnce).not.toHaveBeenCalled();
      expect(requireJob(state, cronJob.id).state.lastError).toContain("job execution timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});
