import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../../app/context.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import type { BoardWidget } from "../types.ts";
import "./workboard-mini.ts";

const cards = [
  {
    id: "card-ready",
    title: "Ready card",
    status: "ready",
    priority: "high",
    labels: [],
    position: 1000,
    createdAt: 1,
    updatedAt: 1,
    agentId: "agent-a",
    metadata: { automation: { boardId: "ops" } },
  },
  {
    id: "card-running",
    title: "Running card",
    status: "running",
    priority: "normal",
    labels: [],
    position: 2000,
    createdAt: 1,
    updatedAt: 1,
    metadata: { automation: { boardId: "ops" } },
  },
  {
    id: "card-done",
    title: "Done card",
    status: "done",
    priority: "low",
    labels: [],
    position: 3000,
    createdAt: 1,
    updatedAt: 1,
    metadata: { automation: { boardId: "ops" } },
  },
] as const;

function pluginWidget(pluginKind: string, props: Record<string, unknown>): BoardWidget {
  return {
    name: pluginKind.replace(":", "-"),
    tabId: "main",
    contentKind: "plugin",
    pluginKind,
    props,
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "none",
    revision: 1,
  };
}

function createContext(
  request: ReturnType<typeof vi.fn<(method: string, params: unknown) => Promise<unknown>>>,
  events?: { listener?: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0] },
  includeCron = false,
): ApplicationContext {
  const subscribe = () => () => undefined;
  return {
    basePath: "/control",
    gateway: {
      snapshot: {
        client: {
          request: (method: string, params: unknown) =>
            method === "cron.runs" && !includeCron
              ? Promise.resolve({ entries: [] })
              : request(method, params),
        } as never,
        phase: "connected",
        hello: null,
        assistantAgentId: null,
        sessionKey: "agent:main:test",
        lastError: null,
        lastErrorCode: null,
      },
      subscribe,
      subscribeEvents: (
        listener: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0],
      ) => {
        if (events) {
          events.listener = listener;
        }
        return () => undefined;
      },
    } as unknown as ApplicationContext["gateway"],
  } as unknown as ApplicationContext;
}

async function mount<T extends HTMLElement>(
  element: T,
  context: ApplicationContext,
  request: ReturnType<typeof vi.fn<(method: string, params: unknown) => Promise<unknown>>>,
): Promise<T> {
  const provider = createApplicationContextProvider(context);
  provider.append(element);
  document.body.append(provider);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("workboard.cards.list", {}));
  await (element as T & { updateComplete: Promise<boolean> }).updateComplete;
  await vi.waitFor(() => expect(element.textContent).not.toContain("Loading Workboard"));
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("Workboard receipt view", () => {
  const proof = {
    id: "proof",
    status: "passed",
    createdAt: 10,
    command: "verify",
    note: "Local milestone, not deployment",
    label: "Acceptance",
    url: "https://example.com/receipt",
  };
  function evidenceCard(overrides: Record<string, unknown> = {}) {
    return {
      ...cards[0],
      title: "Evidence card",
      metadata: { automation: { boardId: "ops" }, proof: [proof] },
      ...overrides,
    };
  }
  async function show(data: unknown[], events?: Parameters<typeof createContext>[1]) {
    const request = vi.fn(async () => ({ cards: data }));
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", { view: "receipts" });
    await mount(element, createContext(request, events), request);
    await vi.waitFor(() =>
      expect(element.querySelector('[data-test-id="workboard-receipts-widget"]')).not.toBeNull(),
    );
    return { element, request };
  }
  it("shows recorded proof for unfinished cards, but never status-only completion", async () => {
    const { element } = await show([evidenceCard(), cards[2]]);
    expect(element.querySelector('[data-receipt-status="passed"]')?.textContent).toContain(
      "Evidence card",
    );
    expect(element.textContent).not.toContain("Done card");
    expect(element.textContent).toContain("Cards without complete linked evidence: 1");
    expect(element.querySelector("a")?.href).toBe("https://example.com/receipt");
    expect(element.textContent).toContain("not independently verified completion");
  });
  it.each([
    { status: "unknown" },
    { status: "skipped" },
    { command: "" },
    { note: "" },
    { url: "javascript:alert(1)" },
    { url: "file:///private/receipt" },
    { url: "/local/receipt" },
    { url: "https://user:password@example.com/" },
    { createdAt: Date.now() + 1000000 },
  ])("keeps incomplete or unsafe evidence out of recorded passes: %j", async (change) => {
    const { element } = await show([
      evidenceCard({
        metadata: { automation: { boardId: "ops" }, proof: [{ ...proof, ...change }] },
      }),
    ]);
    expect(element.querySelector("a")).toBeNull();
    expect(element.textContent).toContain("Cards without complete linked evidence: 1");
  });
  it("does not select an earlier pass over a later failure or conflicting proof", async () => {
    const { element } = await show([
      evidenceCard({
        boardId: "ops",
        metadata: { proof: [proof, { ...proof, id: "new", status: "failed", createdAt: 11 }] },
      }),
      evidenceCard({
        id: "conflict",
        boardId: "ops",
        title: "Conflict",
        metadata: { proof: [proof, { ...proof, id: "tie", status: "failed" }] },
      }),
    ]);
    expect(element.querySelector('[data-receipt-status="passed"] details')).toBeNull();
    expect(element.querySelector('[data-receipt-status="failed"]')?.textContent).toContain(
      "Evidence card",
    );
    expect(element.textContent).toContain("Cards without complete linked evidence: 1");
  });
  it("refreshes on the existing change event and exposes reload failure instead of stale green", async () => {
    const events: NonNullable<Parameters<typeof createContext>[1]> = {};
    const { element, request } = await show([evidenceCard()], events);
    request.mockResolvedValueOnce({ cards: [] });
    events.listener?.({ type: "event", event: "plugin.workboard.changed", payload: {} });
    await vi.waitFor(() => expect(element.querySelector("details")).toBeNull());
    request.mockRejectedValueOnce(new Error("Receipt source unavailable"));
    events.listener?.({ type: "event", event: "plugin.workboard.changed", payload: {} });
    await vi.waitFor(() =>
      expect(element.querySelector('[role="alert"]')?.textContent).toContain(
        "Receipt source unavailable",
      ),
    );
    expect(element.querySelector('[data-test-id="workboard-receipts-widget"]')).toBeNull();
  });
  it("escapes source text and never turns a local artifact path into a browser link", async () => {
    const { element } = await show([
      evidenceCard({
        title: "<img src=x onerror=alert(1)>",
        metadata: {
          proof: [{ ...proof, url: undefined }],
          artifacts: [
            { id: "artifact", createdAt: 10, label: "Acceptance", path: "/private/receipt" },
          ],
        },
        boardId: "ops",
      }),
    ]);
    expect(element.querySelector("img,script,a")).toBeNull();
    expect(element.textContent).toContain("Cards without complete linked evidence: 1");
  });
  it.each([undefined, "", "Acceptance"])(
    "requires one unambiguous labeled fallback artifact: %s",
    async (label) => {
      const artifact = { id: "a", createdAt: 10, label, url: "https://example.com/artifact" };
      const { element } = await show([
        evidenceCard({
          metadata: {
            proof: [{ ...proof, label, url: undefined }],
            artifacts: label === "Acceptance" ? [artifact, { ...artifact, id: "b" }] : [artifact],
          },
        }),
      ]);
      expect(element.querySelector("a")).toBeNull();
      expect(element.textContent).toContain("Cards without complete linked evidence: 1");
    },
  );
  it("shows historical failed attempts without inventing failed cards or successful retries", async () => {
    const { element } = await show([
      evidenceCard({
        status: "done",
        metadata: {
          attempts: [
            {
              id: "timeout",
              status: "failed",
              startedAt: 10,
              endedAt: 20,
              error: "<img src=x> timed out",
              runId: "run-timeout",
            },
            { id: "success", status: "succeeded", startedAt: 30, endedAt: 40 },
            { id: "blocked", status: "blocked", startedAt: 50, endedAt: 60 },
          ],
        },
      }),
    ]);
    const section = element.querySelector("[data-receipt-attempts]");
    expect(section?.querySelectorAll("details")).toHaveLength(1);
    expect(section?.textContent).toContain("run-timeout");
    expect(section?.textContent).toContain("<img src=x> timed out");
    expect(section?.querySelector("img,a")).toBeNull();
    expect(section?.textContent).toContain("Historical");
    expect(element.querySelector('[data-receipt-status="passed"] details')).toBeNull();
  });
  it.each([
    { endedAt: undefined },
    { endedAt: 9 },
    { endedAt: Date.now() + 1000000 },
    { startedAt: -1 },
    { id: "" },
    { status: "running" },
  ])("does not fabricate terminal failure from an incomplete attempt: %j", async (change) => {
    const { element } = await show([
      evidenceCard({
        metadata: {
          attempts: [{ id: "bad", status: "failed", startedAt: 10, endedAt: 20, ...change }],
        },
      }),
    ]);
    expect(element.querySelector("[data-receipt-attempts] details")).toBeNull();
    expect(element.textContent).toContain("coverage is incomplete");
  });
  it("bounds newest-first history and rejects conflicting duplicate attempt identities", async () => {
    const attempts = Array.from({ length: 7 }, (_, index) => ({
      id: `attempt-${index}`,
      status: "failed",
      startedAt: 10,
      endedAt: 20 + index,
    }));
    const { element } = await show([
      evidenceCard({
        metadata: {
          attempts: [
            ...attempts,
            { id: "ambiguous", status: "failed", startedAt: 10, endedAt: 40 },
            { id: "ambiguous", status: "succeeded", startedAt: 10, endedAt: 40 },
          ],
        },
      }),
    ]);
    const section = element.querySelector("[data-receipt-attempts]");
    expect(section?.querySelectorAll("details")).toHaveLength(5);
    expect(section?.querySelector("details")?.textContent).toContain("attempt-6");
    expect(section?.textContent).toContain("Showing 5 of 7");
    expect(section?.textContent).not.toContain("ambiguous");
  });
});

describe("Scheduled receipt history", () => {
  it("keeps scheduler failures visible while Workboard is pending or failed", async () => {
    const list = createDeferred<unknown>();
    const request = vi.fn(async (method: string) =>
      method === "workboard.cards.list"
        ? list.promise
        : {
            entries: [
              {
                jobId: "independent-failure",
                ts: 100,
                action: "finished",
                status: "error",
                error: "scheduler failed",
              },
            ],
          },
    );
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", { view: "receipts" });
    const provider = createApplicationContextProvider(createContext(request, undefined, true));
    provider.append(element);
    document.body.append(provider);
    await vi.waitFor(() =>
      expect(element.querySelector("[data-cron-receipts]")?.textContent).toContain(
        "independent-failure",
      ),
    );
    expect(element.textContent).toContain("Loading Workboard");
    list.reject(new Error("Workboard unavailable"));
    await vi.waitFor(() => expect(element.textContent).toContain("Workboard unavailable"));
    expect(element.querySelector("[data-cron-receipts]")?.textContent).toContain(
      "independent-failure",
    );
  });

  it("shares pending history across widgets and releases a failed request for retry", async () => {
    let page = createDeferred<{ entries: [] }>();
    const request = vi.fn(async (method: string) =>
      method === "cron.runs" ? page.promise : { cards: [] },
    );
    const context = createContext(request, undefined, true);
    const widgets: HTMLElementTagNameMap["openclaw-workboard-mini-widget"][] = [];
    for (const boardId of ["one", "two"]) {
      const widget = document.createElement("openclaw-workboard-mini-widget");
      widget.widget = pluginWidget("workboard:mini", { view: "receipts", boardId });
      await mount(widget, context, request);
      widgets.push(widget);
    }
    expect(request.mock.calls.filter(([method]) => method === "cron.runs")).toHaveLength(1);
    page.reject(new Error("shared failure"));
    await vi.waitFor(() => {
      for (const widget of widgets) {
        expect(widget.querySelector("[data-cron-receipts] [role=alert]")?.textContent).toContain(
          "shared failure",
        );
      }
    });
    page = createDeferred<{ entries: [] }>();
    for (const widget of widgets) {
      widget.querySelector<HTMLButtonElement>("[data-cron-receipts] button")!.click();
    }
    expect(request.mock.calls.filter(([method]) => method === "cron.runs")).toHaveLength(2);
    page.resolve({ entries: [] });
    await vi.waitFor(() => {
      for (const widget of widgets) {
        expect(widget.querySelector("[data-cron-receipts] [role=alert]")).toBeNull();
        expect(widget.querySelector("[data-cron-receipts]")?.textContent).toContain("0");
      }
    });
  });

  it("reports an invalid history page without losing card evidence", async () => {
    const request = vi.fn(async () => ({ cards: [] }));
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", { view: "receipts" });
    await mount(element, createContext(request, undefined, true), request);
    await vi.waitFor(() =>
      expect(element.querySelector("[data-cron-receipts] [role=alert]")?.textContent).toContain(
        "invalid page",
      ),
    );
    expect(element.querySelector("[data-test-id=workboard-receipts-widget]")).not.toBeNull();
  });

  it("shows recorded run and delivery failures, excludes intentional non-delivery, and clears stale rows on a denied refresh", async () => {
    let denied = false;
    const request = vi.fn(async (method: string) => {
      if (method === "workboard.cards.list") {
        return { cards: [] };
      }
      if (denied) {
        throw new Error("History access denied");
      }
      return {
        entries: [
          {
            jobId: "run-failure",
            ts: 100,
            action: "finished",
            status: "error",
            error: "<script>bad</script>",
          },
          {
            jobId: "delivery-failure",
            ts: 90,
            action: "finished",
            status: "ok",
            deliveryStatus: "not-delivered",
            deliveryError: "transport failed",
          },
          {
            jobId: "intentional-quiet",
            ts: 80,
            action: "finished",
            status: "ok",
            deliveryStatus: "not-delivered",
          },
          { jobId: "unreported", ts: 70, action: "finished" },
          { jobId: "future", ts: Date.now() + 60000, action: "finished", status: "error" },
        ],
        hasMore: true,
      };
    });
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", { view: "receipts" });
    await mount(element, createContext(request, undefined, true), request);
    await vi.waitFor(() =>
      expect(element.querySelector("[data-cron-receipts]")?.textContent).toContain(
        "transport failed",
      ),
    );
    expect(request).toHaveBeenCalledWith("cron.runs", {
      scope: "all",
      limit: 50,
      offset: 0,
      sortDir: "desc",
    });
    const pane = element.querySelector("[data-cron-receipts]")!;
    expect(pane.textContent).toContain("run-failure");
    expect(pane.textContent).not.toContain("intentional-quiet");
    expect(pane.textContent).not.toContain("unreported");
    expect(pane.textContent).not.toContain("future");
    expect(pane.querySelector("script")).toBeNull();
    expect(pane.textContent).toContain("Older history");
    denied = true;
    pane.querySelector("button")!.click();
    await vi.waitFor(() =>
      expect(pane.querySelector("[role=alert]")?.textContent).toContain("History access denied"),
    );
    expect(pane.textContent).not.toContain("run-failure");
    expect(request.mock.calls.filter(([method]) => method === "cron.runs")).toHaveLength(2);
  });

  it("does not request scheduler history for the default widget", async () => {
    const request = vi.fn(async () => ({ cards: [] }));
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", {});
    await mount(element, createContext(request, undefined, true), request);
    expect(request.mock.calls).toEqual([["workboard.cards.list", {}]]);
    expect(element.querySelector("[data-cron-receipts]")).toBeNull();
  });
});
