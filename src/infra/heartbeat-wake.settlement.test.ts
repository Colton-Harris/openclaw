import { afterEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeat,
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

describe("heartbeat wake settlement", () => {
  let disposeHandler: (() => void) | undefined;

  afterEach(async () => {
    resetGatewayWorkAdmission();
    if (vi.isFakeTimers()) {
      disposeHandler?.();
      disposeHandler = setHeartbeatWakeHandler(async () => ({
        status: "skipped",
        reason: "disabled",
      }));
      await vi.runAllTimersAsync();
    }
    disposeHandler?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setHandler(handler: Parameters<typeof setHeartbeatWakeHandler>[0]) {
    disposeHandler = setHeartbeatWakeHandler(handler);
  }

  it("settles every caller represented by one coalesced wake", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 7 });
    setHandler(handler);
    const wake = { source: "interval" as const, intent: "scheduled" as const, reason: "interval" };
    const resultA = requestHeartbeatAndWait({ ...wake, agentId: "main", coalesceMs: 100 });
    const resultB = requestHeartbeatAndWait({ ...wake, agentId: "main", coalesceMs: 100 });

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ ...wake, agentId: "main" });
    await expect(Promise.all([resultA, resultB])).resolves.toEqual([
      { status: "ran", durationMs: 7 },
      { status: "ran", durationMs: 7 },
    ]);
  });

  it("keeps an awaited cron wake pending across a retryable skip", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHandler(handler);
    const result = requestHeartbeatAndWait({
      source: "cron",
      intent: "scheduled",
      reason: "interval",
      coalesceMs: 0,
    });
    const settled = vi.fn();
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual({ status: "ran", durationMs: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("detaches an aborted waiter without cancelling its shared wake", async () => {
    vi.useFakeTimers();
    let finishChild: (() => void) | undefined;
    const child = new Promise<void>((resolve) => {
      finishChild = resolve;
    });
    const handler = vi.fn(async () => {
      await child;
      return { status: "ran" as const, durationMs: 1 };
    });
    setHandler(handler);
    const controller = new AbortController();
    const result = requestHeartbeatAndWait(
      { source: "interval", intent: "scheduled", reason: "interval", coalesceMs: 0 },
      { abortSignal: controller.signal },
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    controller.abort();
    await expect(result).resolves.toEqual({
      status: "failed",
      reason: "heartbeat wake cancelled",
    });

    finishChild?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(["requests-in-flight", "cron-in-progress", "preempted", "channel-not-ready"])(
    "settles an ambient monitor on %s without an orphan retry, then runs its next tick",
    async (reason) => {
      vi.useFakeTimers();
      const skipped = { status: "skipped" as const, reason };
      const handler = vi.fn().mockResolvedValue(skipped);
      setHandler(handler);
      const wake = {
        source: "interval" as const,
        intent: "scheduled" as const,
        reason: "interval",
        coalesceMs: 0,
      };
      const settled = vi.fn();
      void requestHeartbeatAndWait(wake, { retryOnBusy: false }).then(settled);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith(skipped);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(handler).toHaveBeenCalledOnce();

      handler.mockResolvedValue({ status: "ran", durationMs: 7 });
      const next = requestHeartbeatAndWait(wake, { retryOnBusy: false });
      await vi.advanceTimersByTimeAsync(1);
      await expect(next).resolves.toEqual({ status: "ran", durationMs: 7 });
    },
  );

  it.each(["task", "event", "scheduled"] as const)(
    "preserves a coalesced %s wake when an ambient monitor settles busy",
    async (intent) => {
      vi.useFakeTimers();
      const handler = vi
        .fn()
        .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
        .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
      setHandler(handler);
      const settled = vi.fn();
      void requestHeartbeatAndWait(
        { source: "interval", intent: "scheduled", coalesceMs: 0 },
        { retryOnBusy: false },
      ).then(settled);
      const tasks =
        intent === "task" ? [{ jobId: "task", name: "task", prompt: "check work" }] : undefined;
      requestHeartbeat({ source: "cron", intent, tasks, coalesceMs: 0 });

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith({
        status: "skipped",
        reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[1]?.[0]).toMatchObject({ intent, ...(tasks ? { tasks } : {}) });
    },
  );

  it.each([false, true])(
    "cancels a queued monitor without orphan work (shared task: %s)",
    async (sharedTask) => {
      vi.useFakeTimers();
      const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      setHandler(handler);
      const controller = new AbortController();
      const result = requestHeartbeatAndWait(
        { source: "interval", intent: "scheduled", coalesceMs: 100 },
        { retryOnBusy: false, abortSignal: controller.signal },
      );
      if (sharedTask) {
        requestHeartbeat({ source: "cron", intent: "task", coalesceMs: 100 });
      }
      controller.abort();
      await expect(result).resolves.toMatchObject({ status: "failed" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(handler).toHaveBeenCalledTimes(sharedTask ? 1 : 0);
      if (sharedTask) {
        expect(handler.mock.calls[0]?.[0]).toMatchObject({ intent: "task" });
      }
    },
  );
});
