import { afterEach, describe, expect, it, vi } from "vitest";
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
  request: ReturnType<typeof vi.fn>,
  events?: { listener?: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0] },
): ApplicationContext {
  const subscribe = () => () => undefined;
  return {
    basePath: "/control",
    gateway: {
      snapshot: {
        client: { request } as never,
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
  request: ReturnType<typeof vi.fn>,
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
});
