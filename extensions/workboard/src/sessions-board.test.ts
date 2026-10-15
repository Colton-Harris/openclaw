import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDefaultWorkboardSessionsBoardSpec,
  type WorkboardSessionFacts,
  type WorkboardSessionsBoardSpec,
  type WorkboardSessionsColumn,
} from "@openclaw/workboard-contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkboardSessionsBoardService } from "./sessions-board.js";
import { WorkboardBoardStore } from "./store-boards.js";
import { createKernelStores } from "./test/sqlite-kernel.js";

// The service consumes the redaction contract, not the host diagnostics scheduler.
vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  redactToolPayloadText: (text: string) => text,
}));

let tempDir: string;
let nextDatabase = 0;
beforeAll(() => {
  // openclaw-temp-dir: allow keeps this synchronous SQLite fixture out of test-env's compiled-worker graph.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-board-"));
});
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

type ServiceParams = Parameters<typeof createWorkboardSessionsBoardService>[0];
const BOARD_ID = "sessions";
const NOW = 10_000_000;
const FOCUS_COLUMN: WorkboardSessionsColumn = {
  id: "focus",
  label: "Focus",
  description: "Active sessions.",
  match: { run: ["active"] },
};
const OTHER_COLUMN: WorkboardSessionsColumn = {
  id: "other",
  label: "Other",
  description: "Remaining sessions.",
  fallback: true,
};
const DEFAULT_COLUMNS = ["needs-input", "stuck", "working", "in-review", "merged", "done"];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());
function facts(id: string, overrides: Partial<WorkboardSessionFacts> = {}): WorkboardSessionFacts {
  return {
    key: `agent:main:${id}`,
    sessionId: `session-${id}`,
    agentId: "main",
    label: id,
    run: "idle",
    pullRequests: [],
    archived: false,
    lastActivityAt: NOW,
    ...overrides,
  };
}
function rosterRow(
  row: WorkboardSessionFacts,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const active = row.run === "active";
  const status = active
    ? "running"
    : (row.runReceipt?.status ??
      (row.run === "failed" ? "failed" : row.observerDigest ? "done" : undefined));
  const lastRunId = row.runReceipt?.runId ?? row.observerDigest?.runId;
  return {
    key: row.key,
    sessionId: row.sessionId,
    label: row.label,
    derivedTitle: row.derivedTitle,
    ...(status !== undefined ? { status } : {}),
    ...(lastRunId !== undefined ? { lastRunId } : {}),
    ...(active ? { hasActiveRun: true } : {}),
    ...(active
      ? { activeRunIds: row.observerDigest?.runId ? [row.observerDigest.runId] : [] }
      : {}),
    ...(row.goalStatus !== undefined && row.goalStatus !== "none"
      ? { goal: { status: row.goalStatus } }
      : {}),
    archived: row.archived,
    lastActivityAt: row.lastActivityAt,
    ...overrides,
  };
}
async function withService(
  options: Parameters<typeof createFixture>[0],
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const fixture = await createFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.service.stop();
    await fixture.store.close();
  }
}
async function createFixture(options: {
  facts: WorkboardSessionFacts[];
  spec?: Partial<WorkboardSessionsBoardSpec>;
  roster?: unknown[];
}) {
  const stores = createKernelStores(path.join(tempDir, `${nextDatabase++}.sqlite`));
  const store = new WorkboardBoardStore(stores.cards, {
    ...stores,
    runWithWriteAuthority: async (assertCurrent, run) => {
      assertCurrent();
      return await run();
    },
  });
  await store.upsertBoard({ id: BOARD_ID, kind: "sessions" });
  await store.updateSessionsBoard(BOARD_ID, {
    columns: [FOCUS_COLUMN, OTHER_COLUMN],
    ...options.spec,
  });
  const state: { facts: WorkboardSessionFacts[]; roster: unknown[] } = {
    facts: options.facts,
    roster: options.roster ?? options.facts.map((row) => rosterRow(row)),
  };
  const request = vi
    .fn()
    .mockImplementation(async () => ({ sessions: state.roster, hasMore: false }));
  const readSessionFacts = vi
    .fn<ServiceParams["gateway"]["readSessionFacts"]>()
    .mockImplementation(async ({ sessionKeys }) => ({
      sessions: state.facts.filter((session) => sessionKeys.includes(session.key)),
    }));
  let listener: Parameters<ServiceParams["gateway"]["subscribeSessionChanges"]>[0] | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const gateway = {
    request,
    readSessionFacts,
    subscribeSessionChanges: (callback: NonNullable<typeof listener>) => {
      listener = callback;
      return unsubscribe;
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = createWorkboardSessionsBoardService({ store, gateway });
  const context = { config: {}, stateDir: "unused", logger };
  const repair = vi.spyOn(store, "repairSessionPlacements");
  await service.start(context);
  return {
    store,
    stores,
    state,
    request,
    readSessionFacts,
    logger,
    service,
    unsubscribe,
    repair,
    context,
    emit: (key: string) => listener?.({ agentId: "main", sessionKey: key }),
  };
}

describe("Sessions board rules and live facts", () => {
  it("rejects a move when caller authority ends during the facts read", async () => {
    await withService({ facts: [facts("one")] }, async ({ service, store, readSessionFacts }) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let active = true;
      readSessionFacts.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { sessions: [facts("one")] };
      });
      const pending = service.move(BOARD_ID, facts("one").key, "other", {
        assertCurrent() {
          if (!active) {
            throw new Error("Caller authority is no longer active.");
          }
        },
      });
      const rejected = expect(pending).rejects.toThrow("Caller authority is no longer active.");
      await entered.promise;
      active = false;
      release.resolve();
      await rejected;
      expect(await store.listSessionPlacements(BOARD_ID)).toEqual([]);
    });
  });

  const digest = {
    health: "on-track",
    runId: "current-run",
    headline: "Making progress",
    revision: 1,
  } as const;
  it.each([
    {
      name: "custom rules with conjunctions, alternatives, and unknown PR state",
      spec: {
        scope: { includeArchived: true },
        columns: [
          {
            id: "review",
            label: "Review",
            description: "Active reviewed work.",
            match: [
              {
                health: ["on-track"],
                run: ["active"],
                pullRequest: ["open"],
                archived: false,
              },
              { run: ["failed"], archived: false },
            ],
          },
          {
            id: "active",
            label: "Active",
            description: "All active work.",
            match: { run: ["active"] },
          },
          {
            id: "no-pr",
            label: "No PR",
            description: "Confirmed no pull request.",
            match: { pullRequest: ["none"] },
          },
          OTHER_COLUMN,
        ],
      },
      facts: [
        facts("all", {
          run: "active",
          observerDigest: digest,
          pullRequests: [{ number: 1, state: "open" }],
        }),
        facts("no-digest", { run: "active", pullRequests: [{ number: 2, state: "open" }] }),
        facts("active-no-pr", { run: "active", observerDigest: digest }),
        facts("archived", {
          run: "active",
          observerDigest: digest,
          archived: true,
          pullRequests: [{ number: 3, state: "open" }],
        }),
        facts("idle-pr", {
          observerDigest: digest,
          pullRequests: [{ number: 4, state: "open" }],
        }),
        facts("none"),
        facts("unknown", { pullRequestsUnavailable: true }),
        facts("failed", { run: "failed" }),
      ],
      placements: [
        ["all", "review"],
        ["no-digest", "active"],
        ["active-no-pr", "active"],
        ["archived", "active"],
        ["idle-pr", "other"],
        ["none", "no-pr"],
        ["unknown", "other"],
        ["failed", "review"],
      ],
      columns: ["review", "active", "no-pr", "other"],
      warning: "pull-request information is unavailable",
    },
    {
      name: "default rule priority for unobserved runs and PRs",
      spec: createDefaultWorkboardSessionsBoardSpec(),
      facts: [
        facts("active", { run: "active" }),
        facts("failed", { run: "failed" }),
        facts("unhealthy-active", {
          run: "active",
          observerDigest: { health: "stuck", headline: "Stuck", revision: 1 },
        }),
        facts("needs-input", {
          run: "active",
          observerDigest: { health: "waiting-on-user", headline: "Approval", revision: 1 },
        }),
        facts("review", { pullRequests: [{ number: 1, state: "open" }] }),
        facts("merged", { pullRequests: [{ number: 2, state: "merged" }] }),
        facts("idle"),
      ],
      placements: [
        ["active", "working"],
        ["failed", "stuck"],
        ["unhealthy-active", "stuck"],
        ["needs-input", "needs-input"],
        ["review", "in-review"],
        ["merged", "merged"],
        ["idle", "done"],
      ],
      columns: DEFAULT_COLUMNS,
      warning: undefined,
    },
  ] satisfies Array<{
    name: string;
    spec: Partial<WorkboardSessionsBoardSpec>;
    facts: WorkboardSessionFacts[];
    placements: string[][];
    columns: string[];
    warning: string | undefined;
  }>)(
    "classifies sessions using $name",
    async ({ spec, facts: rows, placements, columns, warning }) => {
      await withService({ spec, facts: rows }, async ({ service, store, request }) => {
        const read = await service.read(BOARD_ID);
        expect(read.columns.map((column) => column.id)).toEqual(columns);
        expect(
          read.sessions.map(({ label, columnId, source }) => [label, columnId, source]),
        ).toEqual(placements.map(([label, columnId]) => [label, columnId, "state"]));
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual([]);
        if (warning) {
          expect(read.warning).toContain(warning);
          expect(read.sessions.find((session) => session.label === "unknown")?.reason).toBe(
            "facts-unavailable",
          );
        } else {
          expect(read.warning).toBeUndefined();
        }
        expect(request).toHaveBeenCalledWith(
          "sessions.list",
          expect.objectContaining({
            configuredAgentsOnly: true,
            includeGlobal: false,
            includeUnknown: false,
          }),
          { scopes: ["operator.read"] },
        );
      });
    },
  );

  it("uses only current run and goal receipts for Finished while keeping observer needs-input advisory", async () => {
    const columns: WorkboardSessionsColumn[] = [
      {
        id: "needs-input",
        label: "Needs input (observer)",
        description: "The current observer says this session may need user input.",
        match: { health: ["waiting-on-user"] },
      },
      {
        id: "working",
        label: "Working",
        description: "A run is currently active.",
        match: { run: ["active"] },
      },
      {
        id: "finished",
        label: "Finished",
        description: "The latest run completed and no current goal remains unfinished.",
        match: {
          runReceiptStatus: ["done"],
          goalStatus: ["complete", "none"],
        },
      },
      {
        id: "stopped",
        label: "Stopped",
        description: "The latest run was interrupted or the current goal is paused.",
        match: [{ runReceiptStatus: ["interrupted", "killed"] }, { goalStatus: ["paused"] }],
      },
      {
        id: "stuck",
        label: "Stuck or failed",
        description: "Current failure, blocked goal, or advisory stuck/failed health.",
        match: [
          { health: ["stuck", "failed"] },
          { run: ["failed"] },
          { runReceiptStatus: ["failed", "timeout"] },
          { goalStatus: ["blocked", "budget_limited", "usage_limited"] },
        ],
      },
      {
        id: "unclassified",
        label: "Unclassified",
        description: "No current canonical receipt classifies this session.",
        fallback: true,
      },
    ];
    const rows = [
      facts("active-with-stale-done", {
        run: "active",
        runReceipt: { runId: "old-run", status: "done" },
        goalStatus: "none",
        observerDigest: {
          health: "done",
          runId: "old-run",
          headline: "Old run says done",
          revision: 1,
        },
      }),
      facts("active-waiting-advisory", {
        run: "active",
        goalStatus: "active",
        observerDigest: {
          health: "waiting-on-user",
          runId: "current-waiting-run",
          headline: "Approval may be needed",
          revision: 2,
        },
      }),
      facts("observer-waiting", {
        observerDigest: {
          health: "waiting-on-user",
          runId: "observer-waiting-run",
          headline: "May need input",
          revision: 3,
        },
      }),
      facts("observer-waiting-unprovenanced", {
        observerDigest: {
          health: "waiting-on-user",
          headline: "Legacy digest without a current run identity",
          revision: 4,
        },
      }),
      facts("failed", {
        runReceipt: { runId: "failed-run", status: "failed" },
        goalStatus: "active",
      }),
      facts("blocked-goal", { goalStatus: "blocked" }),
      facts("finished-no-goal", {
        runReceipt: { runId: "finished-run", status: "done" },
        goalStatus: "none",
      }),
      facts("finished-goal", {
        runReceipt: { runId: "goal-run", status: "done" },
        goalStatus: "complete",
      }),
      facts("one-turn-ongoing-goal", {
        runReceipt: { runId: "turn-run", status: "done" },
        goalStatus: "active",
      }),
      facts("unknown-goal", {
        runReceipt: { runId: "unknown-goal-run", status: "done" },
      }),
      facts("interrupted", {
        runReceipt: { runId: "interrupted-run", status: "interrupted" },
        goalStatus: "none",
      }),
      facts("killed", {
        runReceipt: { runId: "killed-run", status: "killed" },
        goalStatus: "none",
      }),
      facts("paused-goal", { goalStatus: "paused" }),
      facts("idle-unknown"),
    ];
    const roster = rows.map((row) =>
      rosterRow(
        row,
        row.label === "unknown-goal"
          ? { goal: { status: "unknown" } }
          : row.label === "active-with-stale-done"
            ? { activeRunIds: ["successor-run"] }
            : {},
      ),
    );
    await withService({ facts: rows, roster, spec: { columns } }, async ({ service }) => {
      const read = await service.read(BOARD_ID);
      expect(read.sessions.map(({ label, columnId }) => [label, columnId])).toEqual([
        ["active-with-stale-done", "working"],
        ["active-waiting-advisory", "needs-input"],
        ["observer-waiting", "needs-input"],
        ["observer-waiting-unprovenanced", "unclassified"],
        ["failed", "stuck"],
        ["blocked-goal", "stuck"],
        ["finished-no-goal", "finished"],
        ["finished-goal", "finished"],
        ["one-turn-ongoing-goal", "unclassified"],
        ["unknown-goal", "unclassified"],
        ["interrupted", "stopped"],
        ["killed", "stopped"],
        ["paused-goal", "stopped"],
        ["idle-unknown", "unclassified"],
      ]);
    });
  });

  it("ignores contradictory pins to canonical lifecycle columns while preserving legacy pins", async () => {
    const columns: WorkboardSessionsColumn[] = [
      {
        id: "finished",
        label: "Finished",
        description: "The latest run is done and the current goal is complete or absent.",
        match: { runReceiptStatus: ["done"], goalStatus: ["complete", "none"] },
      },
      OTHER_COLUMN,
    ];
    const unknown = facts("pinned-unknown");
    const active = facts("pinned-active", {
      run: "active",
      runReceipt: { runId: "previous-run", status: "done" },
      goalStatus: "none",
    });
    const roster = [
      rosterRow(unknown, { goal: { status: "unknown" } }),
      rosterRow(active, {
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["current-run"],
        lastRunId: "previous-run",
      }),
    ];
    await withService(
      { facts: [unknown, active], roster, spec: { columns } },
      async ({ service, store }) => {
        const board = await store.getSessionsBoard(BOARD_ID);
        for (const row of [unknown, active]) {
          expect(
            await store.writeSessionPlacement(
              BOARD_ID,
              {
                sessionKey: row.key,
                columnId: "finished",
                source: "operator",
                reason: "Existing operator pin",
                factsHash: "",
                updatedAt: NOW,
              },
              { expectedSpec: board.sessions },
            ),
          ).toBe(true);
        }

        expect((await service.read(BOARD_ID)).sessions).toMatchObject([
          { key: unknown.key, columnId: "other", source: "state" },
          { key: active.key, columnId: "other", source: "state" },
        ]);
        await expect(service.move(BOARD_ID, unknown.key, "finished")).rejects.toThrow(
          "current lifecycle facts do not match",
        );
        await expect(service.move(BOARD_ID, active.key, "finished")).rejects.toThrow(
          "current lifecycle facts do not match",
        );

        expect((await service.move(BOARD_ID, unknown.key, "other")).sessions).toMatchObject([
          { key: unknown.key, columnId: "other", source: "operator" },
          { key: active.key, columnId: "other", source: "state" },
        ]);
      },
    );
  });

  it.each(["dirty cache with failed refresh", "clean cache with a mismatched current roster"])(
    "does not reuse Finished or observer health after a successor starts (%s)",
    async (transition) => {
      const columns: WorkboardSessionsColumn[] = [
        {
          id: "needs-input",
          label: "Needs input",
          description: "The current observer says input may be needed.",
          match: { health: ["waiting-on-user"] },
        },
        {
          id: "working",
          label: "Working",
          description: "A run is active according to the current session list.",
          match: { run: ["active"] },
        },
        {
          id: "finished",
          label: "Finished",
          description: "The latest run is done and the current goal is complete or absent.",
          match: { runReceiptStatus: ["done"], goalStatus: ["complete", "none"] },
        },
        {
          id: "unclassified",
          label: "Unclassified",
          description: "No current canonical facts classify this session.",
          fallback: true,
        },
      ];
      const previous = facts("successor", {
        label: "Previous run",
        runReceipt: { runId: "previous-run", status: "done" },
        goalStatus: "none",
        observerDigest: {
          health: "waiting-on-user",
          runId: "previous-run",
          headline: "Previous run may need input",
          revision: 1,
        },
      });
      await withService(
        { facts: [previous], roster: [rosterRow(previous)], spec: { columns } },
        async ({ service, state, emit, readSessionFacts }) => {
          expect((await service.read(BOARD_ID)).sessions[0]?.columnId).toBe("needs-input");
          state.roster = [
            rosterRow(previous, {
              label: "Successor run",
              status: "running",
              hasActiveRun: true,
              activeRunIds: ["successor-run"],
              lastRunId: "previous-run",
              goal: { status: "active" },
            }),
          ];
          if (transition === "dirty cache with failed refresh") {
            emit(previous.key);
            readSessionFacts.mockRejectedValueOnce(new Error("synthetic refresh unavailable"));
          }
          const current = await service.read(BOARD_ID);
          expect(current.sessions[0]).toMatchObject({
            label: "Previous run",
            run: "active",
            goalStatus: "active",
            columnId: "working",
            source: "state",
          });
          expect(current.sessions[0]).not.toHaveProperty("runReceipt");
          expect(current.sessions[0]).not.toHaveProperty("observerDigest");
          if (transition === "dirty cache with failed refresh") {
            expect(current.warning).toContain("synthetic refresh unavailable");
          }
        },
      );
    },
  );

  it("repairs only old-default rules at startup, preserves custom boards and ordering, and is idempotent", async () => {
    await withService(
      { facts: [] },
      async ({ service, store, context, logger, repair, readSessionFacts }) => {
        expect(repair).toHaveBeenCalledOnce();
        await service.read(BOARD_ID);
        await service.read(BOARD_ID);
        expect(repair).toHaveBeenCalledOnce();
        expect(readSessionFacts).not.toHaveBeenCalled();
        await service.stop();
        const oldSpec = createDefaultWorkboardSessionsBoardSpec();
        const oldOrder = ["needs-input", "working", "stuck", "in-review", "merged", "done"];
        oldSpec.columns.sort((a, b) => oldOrder.indexOf(a.id) - oldOrder.indexOf(b.id));
        for (const column of oldSpec.columns) {
          if (column.id === "working") {
            column.match = { run: ["active"], health: ["on-track", "grinding", "wrapping-up"] };
            column.label = "Building";
            column.description = "My own description";
          } else if (column.id === "stuck") {
            column.match = { health: ["stuck", "failed"] };
          }
        }
        oldSpec.scope = { maxAgeHours: 24 };
        await store.updateSessionsBoard(BOARD_ID, oldSpec);
        await store.upsertBoard({ id: "custom", kind: "sessions" });
        const customSpec = structuredClone(oldSpec);
        customSpec.columns = customSpec.columns.map((column) =>
          column.id === "working" ? { ...column, match: { run: ["active"] } } : column,
        );
        const custom = await store.updateSessionsBoard("custom", customSpec);
        await store.upsertBoard({ id: "custom-order", kind: "sessions" });
        const reordered = structuredClone(oldSpec);
        reordered.columns.reverse();
        await store.updateSessionsBoard("custom-order", reordered);
        logger.info.mockClear();
        await service.start(context);
        const repaired = await store.getSessionsBoard(BOARD_ID);
        expect(repaired.sessions.columns.map((column) => column.id)).toEqual(DEFAULT_COLUMNS);
        expect(repaired.sessions.columns.find((column) => column.id === "working")).toMatchObject({
          label: "Building",
          description: "My own description",
          match: { run: ["active"] },
        });
        expect(repaired.sessions.columns.find((column) => column.id === "stuck")?.match).toEqual([
          { health: ["stuck", "failed"] },
          { run: ["failed"] },
        ]);
        expect(repaired.sessions.scope).toEqual({ maxAgeHours: 24 });
        expect(await store.getSessionsBoard("custom")).toEqual(custom);
        expect(
          (await store.getSessionsBoard("custom-order")).sessions.columns.map(
            (column) => column.id,
          ),
        ).toEqual(oldOrder.toReversed());
        expect(logger.info).toHaveBeenCalledExactlyOnceWith(
          "Sessions board updated default rules on 2 boards.",
        );
        await service.stop();
        await service.start(context);
        expect(await store.getSessionsBoard(BOARD_ID)).toEqual(repaired);
        expect(logger.info).toHaveBeenCalledOnce();
        await service.stop();
        repair.mockResolvedValueOnce({ placements: 3, boards: 0 });
        logger.info.mockClear();
        await service.start(context);
        expect(logger.info).toHaveBeenCalledExactlyOnceWith(
          "Sessions board removed 3 non-operator placements.",
        );
      },
    );
  });

  it("shares cached facts across boards, invalidates only changed keys, and coalesces notifications", async () => {
    await withService(
      { facts: [facts("one"), facts("two")] },
      async ({ service, store, state, emit, readSessionFacts, unsubscribe }) => {
        const changed = vi.spyOn(store, "announceChangeEpoch");
        expect(readSessionFacts).not.toHaveBeenCalled();
        emit(facts("one").key);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(changed).not.toHaveBeenCalled();
        await service.read(BOARD_ID);
        await store.upsertBoard({ id: "second", kind: "sessions" });
        await service.read("second");
        expect(readSessionFacts).toHaveBeenCalledOnce();
        changed.mockClear();
        state.facts = [facts("one", { run: "active" }), facts("two")];
        emit(facts("one").key);
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({ columnId: "focus" });
        state.facts = [
          facts("one", { run: "active", label: "Updated during burst" }),
          facts("two"),
        ];
        for (let event = 1; event < 100; event += 1) {
          await vi.advanceTimersByTimeAsync(40);
          emit(event === 99 ? "agent:main:not-cached" : facts("one").key);
        }
        await vi.advanceTimersByTimeAsync(1_039);
        expect(changed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(changed).toHaveBeenCalledOnce();
        const read = await service.read(BOARD_ID);
        expect(readSessionFacts.mock.calls.map(([input]) => input.sessionKeys)).toEqual([
          [facts("one").key, facts("two").key],
          [facts("one").key],
          [facts("one").key],
        ]);
        expect(read.sessions[0]).toMatchObject({
          columnId: "focus",
          label: "Updated during burst",
        });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(changed).toHaveBeenCalledOnce();
        emit(facts("two").key);
        await service.stop();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(changed).toHaveBeenCalledOnce();
      },
    );
  });

  it("announces new sessions and refreshes unavailable PR facts only on publication", async () => {
    await withService({ facts: [] }, async ({ service, store, state, emit, readSessionFacts }) => {
      expect((await service.read(BOARD_ID)).sessions).toEqual([]);
      const changed = vi.spyOn(store, "announceChangeEpoch");
      state.roster = state.facts = [facts("new", { pullRequestsUnavailable: true })];
      emit(facts("new").key);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changed).toHaveBeenCalledOnce();
      expect((await service.read(BOARD_ID)).warning).toContain(
        "pull-request information is unavailable",
      );
      state.facts = [facts("new", { pullRequests: [{ number: 1, state: "open" }] })];
      expect((await service.read(BOARD_ID)).warning).toContain(
        "pull-request information is unavailable",
      );
      vi.setSystemTime(NOW + 30 * 60_000);
      await service.read(BOARD_ID);
      expect(readSessionFacts).toHaveBeenCalledOnce();
      emit(facts("new").key);
      expect((await service.read(BOARD_ID)).warning).toBeUndefined();
      expect(readSessionFacts).toHaveBeenCalledTimes(2);
    });
  });

  it("shares a concurrent roster and facts pass, retaining unchanged facts without age expiry", async () => {
    await withService(
      { facts: Array.from({ length: 81 }, (_, index) => facts(String(index))) },
      async ({ service, request, readSessionFacts }) => {
        const [first, second] = await Promise.all([service.read(BOARD_ID), service.read(BOARD_ID)]);
        expect(first).toEqual(second);
        expect(first.sessions).toHaveLength(81);
        expect(request).toHaveBeenCalledOnce();
        expect(readSessionFacts.mock.calls.map(([input]) => input.sessionKeys.length)).toEqual([
          40, 40, 1,
        ]);
        vi.setSystemTime(NOW + 10 * 60_000 - 1);
        await service.read(BOARD_ID);
        expect(readSessionFacts).toHaveBeenCalledTimes(3);
        vi.setSystemTime(NOW + 10 * 60_000);
        await service.read(BOARD_ID);
        expect(readSessionFacts).toHaveBeenCalledTimes(3);
      },
    );
  });

  it("shares a board facts pass while preserving each caller's visible roster and people", async () => {
    await withService(
      { facts: [facts("shared"), facts("private")] },
      async ({ service, request, readSessionFacts }) => {
        const people = [
          { identity: { type: "profile", id: "one" }, label: "One", sessionCount: 2 },
        ];
        request
          .mockResolvedValueOnce({ sessions: [facts("shared"), facts("private")], people })
          .mockResolvedValueOnce({ sessions: [facts("shared")], people: [] });
        const [owner, viewer] = await Promise.all([
          service.read(BOARD_ID, { includePeople: true }, { assertCurrent() {} }),
          service.read(BOARD_ID, { includePeople: true }, { assertCurrent() {} }),
        ]);
        expect(owner.sessions.map(({ label }) => label)).toEqual(["shared", "private"]);
        expect(owner.people).toEqual(people);
        expect(viewer.sessions.map(({ label }) => label)).toEqual(["shared"]);
        expect(viewer.people).toEqual([]);
        expect(readSessionFacts).toHaveBeenCalledOnce();
      },
    );
  });

  it("keeps pins across fact changes and returns to rules when their column is deleted", async () => {
    await withService(
      { facts: [facts("one", { run: "active" })] },
      async ({ service, store, state, emit }) => {
        await service.move(BOARD_ID, facts("one").key, "other");
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({
          columnId: "other",
          source: "operator",
        });
        state.facts = [
          facts("one", { observerDigest: { health: "stuck", headline: "Stuck", revision: 1 } }),
        ];
        state.roster = state.facts.map((row) => rosterRow(row));
        emit(facts("one").key);
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({
          columnId: "other",
          source: "operator",
        });
        await service.update(BOARD_ID, {
          columns: [FOCUS_COLUMN, { ...OTHER_COLUMN, id: "fallback" }],
        });
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({
          columnId: "fallback",
          source: "state",
        });
        expect(
          (await store.listSessionPlacements(BOARD_ID)).every((pin) => pin.source === "operator"),
        ).toBe(true);
      },
    );
  });

  it("shows failure reasons, keeps stale facts, and falls back for unread sessions", async () => {
    await withService(
      { facts: [facts("known", { run: "active" })] },
      async ({ service, state, emit, readSessionFacts, logger }) => {
        await service.read(BOARD_ID);
        state.roster = [...state.roster, rosterRow(facts("new"))];
        emit(facts("known").key);
        readSessionFacts.mockRejectedValue(new Error("facts backend offline"));
        const read = await service.read(BOARD_ID);
        expect(read.warning).toContain(
          "Session facts are unavailable for 2 sessions: Error: facts backend offline. Showing last-known details; current lifecycle and goal labels use the session list, and stale terminal receipts or observer health are suppressed.",
        );
        expect(read.sessions).toMatchObject([
          { key: facts("known").key, run: "active", columnId: "focus" },
          { key: facts("new").key, columnId: "other", reason: "facts-unavailable" },
        ]);
        await service.read(BOARD_ID);
        expect(logger.warn).toHaveBeenCalledOnce();
        state.facts = [...state.facts, facts("new")];
        readSessionFacts.mockResolvedValue({ sessions: state.facts });
        expect((await service.read(BOARD_ID)).warning).toBeUndefined();
        emit(facts("known").key);
        readSessionFacts.mockRejectedValue(new Error("second outage"));
        expect((await service.read(BOARD_ID)).warning).toContain("second outage");
        expect(logger.warn).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("uses current roster run and goal facts after a first-seen supplemental read fails", async () => {
    const columns: WorkboardSessionsColumn[] = [
      {
        id: "working",
        label: "Working",
        description: "A run is active according to the current session list.",
        match: { run: ["active"] },
      },
      {
        id: "blocked",
        label: "Blocked",
        description: "The current goal is blocked.",
        match: { goalStatus: ["blocked"] },
      },
      {
        id: "finished",
        label: "Finished",
        description: "A current terminal receipt confirms completion.",
        match: { runReceiptStatus: ["done"], goalStatus: ["complete", "none"] },
      },
      {
        id: "needs-input",
        label: "Needs input",
        description: "The observer reports that input may be needed.",
        match: { health: ["waiting-on-user"] },
      },
      {
        id: "no-pr",
        label: "No pull request",
        description: "Supplemental facts confirm no pull request.",
        match: { pullRequest: ["none"] },
      },
      {
        id: "unclassified",
        label: "Unclassified",
        description: "No available rule classifies this session.",
        fallback: true,
      },
    ];
    const active = facts("first-seen-active");
    const blocked = facts("first-seen-blocked");
    const unknown = facts("first-seen-unknown");
    const roster = [
      rosterRow(active, {
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["run"],
      }),
      rosterRow(blocked, { goal: { status: "blocked" } }),
      rosterRow(unknown),
    ];
    await withService(
      { facts: [active, blocked, unknown], roster, spec: { columns } },
      async ({ service, readSessionFacts }) => {
        readSessionFacts.mockRejectedValue(new Error("supplemental facts unavailable"));
        const read = await service.read(BOARD_ID);
        expect(read.sessions.map((s) => [s.label, s.columnId, s.reason])).toEqual([
          ["first-seen-active", "working", "facts-unavailable"],
          ["first-seen-blocked", "blocked", "facts-unavailable"],
          ["first-seen-unknown", "unclassified", "facts-unavailable"],
        ]);
        expect(read.sessions[2]).not.toHaveProperty("runReceipt");
        expect(read.sessions[2]).not.toHaveProperty("observerDigest");
        expect(read.warning).toContain("supplemental facts unavailable");
      },
    );
  });

  it("does not let an in-flight read overwrite a newer invalidation", async () => {
    await withService(
      { facts: [facts("one")] },
      async ({ service, state, emit, readSessionFacts }) => {
        await service.read(BOARD_ID);
        emit(facts("one").key);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        readSessionFacts.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { sessions: [facts("one")] };
        });
        const pending = service.read(BOARD_ID);
        await entered.promise;
        emit(facts("one").key);
        release.resolve();
        await pending;
        // The current Gateway roster, not the completed facts request, owns the run projection.
        const active = facts("one", { run: "active" });
        state.roster = [rosterRow(active)];
        readSessionFacts.mockResolvedValue({ sessions: [facts("one", { run: "active" })] });
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({ columnId: "focus" });
        expect(readSessionFacts).toHaveBeenCalledTimes(3);
      },
    );
  });

  it("intersects each caller roster with current identities and excludes the Board agent", async () => {
    const own = facts("board-agent");
    await withService(
      { facts: [own, facts("one"), facts("hidden")], spec: { agentSessionKey: own.key } },
      async ({ service, state }) => {
        expect((await service.read(BOARD_ID)).sessions.map((session) => session.key)).toEqual([
          facts("one").key,
          facts("hidden").key,
        ]);
        const replacement = facts("one", { sessionId: "replacement" });
        state.roster = [replacement];
        expect((await service.read(BOARD_ID)).sessions).toEqual([]);
        state.facts = [replacement];
        expect((await service.read(BOARD_ID)).sessions).toMatchObject([
          { sessionId: "replacement" },
        ]);
        state.roster = [own];
        await expect(service.move(BOARD_ID, own.key, "other")).rejects.toThrow(
          "not available in this board's scope",
        );
      },
    );
  });

  it("forwards people views without changing the board or pins", async () => {
    await withService(
      { facts: [facts("one"), facts("two")] },
      async ({ service, store, request }) => {
        await service.read(BOARD_ID);
        const board = await store.getSessionsBoard(BOARD_ID);
        const people = [
          { identity: { type: "profile", id: "profile-one" }, label: "Alex", sessionCount: 1 },
        ];
        for (const view of [
          { involvingMe: true, includePeople: true },
          { involvingProfileId: "profile-one", includePeople: true },
          { involvingMe: false, includePeople: false },
        ]) {
          request.mockClear();
          request.mockResolvedValueOnce({ sessions: [facts("one")], people, hasMore: false });
          const read = await service.read(BOARD_ID, view);
          expect(request).toHaveBeenCalledExactlyOnceWith(
            "sessions.list",
            expect.objectContaining(view),
            { scopes: ["operator.read"] },
          );
          expect(read.sessions.map(({ key }) => key)).toEqual([facts("one").key]);
          expect(read.people).toBe(view.includePeople ? people : undefined);
        }
        expect(await store.getSessionsBoard(BOARD_ID)).toEqual(board);
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual([]);
      },
    );
  });
});
