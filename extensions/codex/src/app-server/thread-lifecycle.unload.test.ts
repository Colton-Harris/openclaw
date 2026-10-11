import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexServerNotification, CodexThread } from "./protocol.js";
import { prepareCodexThreadResume } from "./thread-lifecycle-adoption.js";

const owners = vi.hoisted(() => ({
  assertLifetime: vi.fn(),
  readPreflight: vi.fn(),
}));

vi.mock("./shared-client.js", () => ({
  captureCodexAppServerClientLifetime: () => owners.assertLifetime,
}));
vi.mock("./thread-policy.js", () => ({
  assertAdoptedCodexThreadResumeAllowed: owners.readPreflight,
  assertCodexSupervisionThreadLineage: vi.fn(),
}));
vi.mock("./client-runtime.js", () => ({ isCodexAppServerLiveThreadClaimed: () => false }));
vi.mock("./thread-lifecycle-io.js", () => ({ resumeExistingCodexThread: vi.fn() }));
vi.mock("./thread-lifecycle-warm.js", () => ({ releaseCodexConsumedLiveThread: vi.fn() }));

function unloadFixture(initialStatus: "idle" | "notLoaded" = "idle") {
  let handler: ((notification: CodexServerNotification) => void) | undefined;
  const controller = new AbortController();
  const assertActive = vi.fn();
  const assertCurrent = vi.fn();
  const withCurrent = vi.fn(async (run: () => void) => run());
  const request = vi.fn(async () => ({
    thread: { id: "native-owner", status: { type: "idle" } } as CodexThread,
  }));
  const dispose = vi.fn(() => {
    handler = undefined;
  });
  owners.readPreflight.mockResolvedValue({ id: "native-owner", status: { type: initialStatus } });
  const params = {
    client: {
      request,
      addNotificationHandler: (next: typeof handler) => {
        handler = next;
        return dispose;
      },
    },
    params: { hostCapabilities: { assertActive } },
    signal: controller.signal,
    assertCurrent,
    authority: { withCurrent },
  };
  return {
    request,
    controller,
    assertActive,
    assertCurrent,
    withCurrent,
    dispose,
    notify: (threadId: string) =>
      handler?.({
        method: "thread/status/changed",
        params: { threadId, status: { type: "notLoaded" } },
      }),
    prepare: () =>
      prepareCodexThreadResume(params as never, { threadId: "native-owner" } as never, {} as never),
  };
}

describe("Codex native unload handoff", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    owners.assertLifetime.mockReset();
    owners.readPreflight.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts an already unloaded exact thread without another read", async () => {
    const fixture = unloadFixture("notLoaded");
    const prepared = await fixture.prepare();
    await prepared.waitUntilUnloaded();
    expect(() => prepared.assertConfigured()).not.toThrow();
    expect(fixture.request).not.toHaveBeenCalled();
    prepared.dispose();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it("accepts matching read proof only under current host and physical ownership", async () => {
    const fixture = unloadFixture();
    fixture.request.mockResolvedValue({
      thread: { id: "native-owner", status: { type: "notLoaded" } } as CodexThread,
    });
    const prepared = await fixture.prepare();
    expect(() => prepared.assertConfigured()).toThrow("did not confirm unloading");
    await prepared.waitUntilUnloaded();
    expect(fixture.request).toHaveBeenCalledWith(
      "thread/read",
      { threadId: "native-owner", includeTurns: false },
      {
        signal: fixture.controller.signal,
        timeoutMs: 1_000,
        assertCurrent: expect.any(Function),
        withCurrent: fixture.withCurrent,
      },
    );
    expect(() => prepared.assertConfigured()).not.toThrow();
    expect(fixture.assertActive).toHaveBeenCalled();
    expect(fixture.assertCurrent).toHaveBeenCalled();
    expect(owners.assertLifetime).toHaveBeenCalled();
    prepared.dispose();
  });

  it("ignores another thread's notification and accepts this thread's teardown", async () => {
    const fixture = unloadFixture();
    const prepared = await fixture.prepare();
    const waiting = prepared.waitUntilUnloaded();
    fixture.notify("another-thread");
    await vi.advanceTimersByTimeAsync(50);
    expect(() => prepared.assertConfigured()).toThrow("did not confirm unloading");
    fixture.notify("native-owner");
    await vi.advanceTimersByTimeAsync(50);
    await waiting;
    expect(() => prepared.assertConfigured()).not.toThrow();
    prepared.dispose();
  });

  it.each([
    { id: "wrong-thread", type: "notLoaded", error: "different thread" },
    { id: "native-owner", type: "active", error: "active in another runner" },
    { id: "native-owner", type: "unknown", error: "unverified" },
  ])("rejects invalid unload proof: $id/$type", async ({ id, type, error }) => {
    const fixture = unloadFixture();
    fixture.request.mockResolvedValue({ thread: { id, status: { type } } as CodexThread });
    const prepared = await fixture.prepare();
    await expect(prepared.waitUntilUnloaded()).rejects.toThrow(error);
    expect(() => prepared.assertConfigured()).toThrow("did not confirm unloading");
    prepared.dispose();
  });

  it("bounds missing unload proof without treating an idle read as teardown", async () => {
    const fixture = unloadFixture();
    const prepared = await fixture.prepare();
    const waiting = prepared.waitUntilUnloaded();
    const failure = expect(waiting).rejects.toThrow("bounded handoff");
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    expect(() => prepared.assertConfigured()).toThrow("did not confirm unloading");
    prepared.dispose();
  });

  it("rejects teardown notifications contradicted by the ensuing loaded snapshot", async () => {
    const fixture = unloadFixture();
    const prepared = await fixture.prepare();
    fixture.request.mockImplementation(async () => {
      fixture.notify("native-owner");
      return { thread: { id: "native-owner", status: { type: "idle" } } as CodexThread };
    });
    const waiting = prepared.waitUntilUnloaded();
    const failure = expect(waiting).rejects.toThrow("bounded handoff");
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    expect(() => prepared.assertConfigured()).toThrow("did not confirm unloading");
    prepared.dispose();
  });

  it("cancels the polling wait with the original reason and no later reads", async () => {
    const fixture = unloadFixture();
    const prepared = await fixture.prepare();
    const waiting = prepared.waitUntilUnloaded();
    const reason = new Error("owner canceled handoff");
    const failure = expect(waiting).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    fixture.controller.abort(reason);
    await failure;
    expect(fixture.request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    prepared.dispose();
  });

  it("rechecks physical ownership after an awaited read before accepting its proof", async () => {
    const fixture = unloadFixture();
    const prepared = await fixture.prepare();
    const reason = new Error("physical owner changed");
    fixture.request.mockImplementationOnce(async () => {
      owners.assertLifetime.mockImplementation(() => {
        throw reason;
      });
      return { thread: { id: "native-owner", status: { type: "notLoaded" } } as CodexThread };
    });
    await expect(prepared.waitUntilUnloaded()).rejects.toBe(reason);
    expect(() => prepared.assertConfigured()).toThrow(reason);
    prepared.dispose();
  });
});
