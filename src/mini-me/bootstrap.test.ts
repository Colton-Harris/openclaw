import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MINI_ME_DOCUMENT_NAMES,
  type MiniMeBelief,
  type MiniMeDocument,
  type MiniMePrediction,
  type MiniMeProfile,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentRunRegistryForTest } from "../infra/agent-run-registry.js";
import { loadPrivateMiniMeBootstrap } from "./bootstrap.js";
import { renderMiniMeDocument } from "./documents.js";
import type * as hostStorage from "./host-storage.js";
import { MiniMeLifecycleOwner } from "./lifecycle.js";
import type { MiniMeContentSnapshot } from "./persistence.types.js";

const mocks = vi.hoisted(() => ({
  generation: vi.fn<typeof hostStorage.assertMiniMeProfileGeneration>(),
  state: vi.fn<() => Pick<ReturnType<typeof hostStorage.miniMeHostState>, "read">>(),
  lifecycle: vi.fn<typeof hostStorage.miniMeLifecycleForOwner>(),
  content:
    vi.fn<
      (
        profile: MiniMeProfile,
        assertCurrent: () => void,
        consume: (store: { readExport(): Promise<MiniMeContentSnapshot> }) => Promise<unknown>,
      ) => Promise<unknown>
    >(),
}));
// mock-isolation: Keep brokered databases out of this fixture; explicit ports control lifecycle and content commits.
vi.mock("./host-storage.js", () => ({
  assertMiniMeProfileGeneration: mocks.generation,
  miniMeHostState: mocks.state,
  miniMeLifecycleForOwner: mocks.lifecycle,
  withMiniMeContent: mocks.content,
}));

const profile: MiniMeProfile = {
  id: "mini-owner",
  agentId: "mini-agent",
  name: "Synthetic Mini Me",
  lifecycle: "active",
  learningPaused: false,
  generation: 1,
  revision: 1,
  models: { conversationModel: null, decisionModel: null, allowInference: false },
  createdAt: 1,
  updatedAt: 1,
};
const belief: MiniMeBelief = {
  id: "belief-1",
  preference: {
    document: "SOUL.md",
    scope: "general",
    statement: "Prefers short synthetic answers",
    preferred: [],
    avoided: [],
  },
  origin: "direct",
  evidence: [{ sourceId: "source-1", sourceRevision: "1", excerpt: "keep it short" }],
  status: "active",
  supersedes: null,
  createdAt: 2,
};
const prediction: MiniMePrediction = {
  id: "prediction-1",
  agentId: null,
  choice: {
    scope: "general",
    question: "Synthetic lunch choice?",
    options: [
      { id: "a", label: "Soup", value: "soup" },
      { id: "b", label: "Salad", value: "salad" },
    ],
  },
  optionId: "a",
  explanation: "Synthetic fixture",
  uncertainty: "low",
  evidence: [],
  beliefIds: [],
  correctionApplied: false,
  provider: "fixture",
  rubricVersion: "1",
  providerRuntimeGeneration: null,
  createdAt: 3,
  profileGeneration: 1,
  contentRevision: 1,
  authority: "advisory",
};

let workspaceDir: string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let snapshot: MiniMeContentSnapshot;
let lifecycle: MiniMeLifecycleOwner;
const cleanups: Array<() => void | Promise<void>> = [];

function documents(): MiniMeDocument[] {
  return MINI_ME_DOCUMENT_NAMES.map((name) => ({
    name,
    content: `Authored ${name}\n`,
    revision: 2,
    updatedAt: 1,
  }));
}

function render(
  document: MiniMeDocument,
  content: Pick<MiniMeContentSnapshot, "beliefs" | "predictions" | "outcomes"> = snapshot,
  owner: MiniMeProfile = profile,
): string {
  return renderMiniMeDocument(owner, document, content.beliefs, content);
}

function canonical(name: string): MiniMeDocument {
  const document = snapshot.documents.find((item) => item.name === name);
  if (!document) {
    throw new Error(`fixture is missing ${name}`);
  }
  return document;
}

async function project(
  content: Pick<MiniMeContentSnapshot, "beliefs" | "predictions" | "outcomes"> = snapshot,
) {
  for (const document of snapshot.documents) {
    await fs.writeFile(path.join(workspaceDir, document.name), render(document, content));
  }
}

/** Learning and prediction commit while their projections never land. */
function commitWithoutProjection() {
  const before = { beliefs: [], predictions: [], outcomes: [] };
  snapshot = { ...snapshot, beliefs: [belief], predictions: [prediction], contentRevision: 2 };
  return before;
}

function config(ownerProfileId = "owner"): OpenClawConfig {
  return {
    agents: {
      entries: {
        [profile.agentId]: {
          workspace: workspaceDir,
          miniMe: { ownerProfileId, profileId: profile.id },
        },
      },
    },
  };
}

async function load(cfg = config()) {
  const runId = `mini-me-bootstrap-run-${cleanups.length}`;
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: profile.agentId,
      ingress: { kind: "system", boundary: "mini-me-bootstrap-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    operatorAuthority: createAdmittedRunOperatorAuthority({
      profileId: "owner",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    }),
  });
  const admittedRunContext = await admission.admit("plugin-harness", `${runId}-harness`);
  cleanups.push(admission.close);
  return loadPrivateMiniMeBootstrap({
    workspaceDir,
    config: cfg,
    agentId: profile.agentId,
    admittedRunContext,
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  workspaceDir = await fs.realpath(tempDirs.make("openclaw-mini-me-bootstrap-"));
  snapshot = {
    contentRevision: 1,
    historyCursor: null,
    documents: documents(),
    sources: [],
    beliefs: [],
    predictions: [],
    outcomes: [],
  };
  lifecycle = new MiniMeLifecycleOwner(() => {});
  mocks.lifecycle.mockReturnValue(lifecycle);
  mocks.state.mockReturnValue({
    read: vi.fn(async () => ({ profile, attachments: [], pendingDataChanges: [] })),
  });
  mocks.content.mockImplementation(async (_profile, assertCurrent, consume) => {
    assertCurrent();
    return consume({ readExport: async () => snapshot });
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  resetAgentRunRegistryForTest();
});

describe("loadPrivateMiniMeBootstrap", () => {
  it("serves current canonical projections unchanged", async () => {
    await project();

    const files = await load();

    expect(files.map((file) => file.name)).toEqual([...MINI_ME_DOCUMENT_NAMES]);
    for (const file of files) {
      expect(file).toMatchObject({ miniMe: true, missing: false });
      expect(file.content).toBe(render(canonical(file.name)));
    }
  });

  it("serves canonical generated material when a committed change outran its projection", async () => {
    await project(commitWithoutProjection());
    const soulOnDisk = await fs.readFile(path.join(workspaceDir, "SOUL.md"), "utf8");

    const files = await load();

    const soul = files.find((file) => file.name === "SOUL.md");
    const decisions = files.find((file) => file.name === "DECISIONS.md");
    expect(soul?.content).toBe(render(canonical("SOUL.md")));
    expect(soul?.content).toContain("Prefers short synthetic answers");
    expect(decisions?.content).toBe(render(canonical("DECISIONS.md")));
    expect(decisions?.content).toContain("Prediction prediction-1");
    // Recovery is read-only; the projection owner still repairs disk.
    await expect(fs.readFile(path.join(workspaceDir, "SOUL.md"), "utf8")).resolves.toBe(soulOnDisk);
  });

  it("accepts an older same-owner revision whose authored text equals canonical", async () => {
    const stale = commitWithoutProjection();
    await project(stale);
    await fs.writeFile(
      path.join(workspaceDir, "SOUL.md"),
      render({ ...canonical("SOUL.md"), revision: 1 }, stale),
    );

    const files = await load();

    expect(files.find((file) => file.name === "SOUL.md")?.content).toBe(
      render(canonical("SOUL.md")),
    );
  });

  it("recovers an intact old file after a canonical authored edit but preserves a new external edit", async () => {
    await project();
    const filePath = path.join(workspaceDir, "SOUL.md");
    const before = await fs.readFile(filePath, "utf8");
    const document = canonical("SOUL.md");
    document.revision += 1;
    document.content = "New canonical self-description\n";
    const files = await load();
    expect(files.find((file) => file.name === "SOUL.md")?.content).toBe(render(document));
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
    await fs.writeFile(filePath, before.replace("Authored SOUL.md", "An unimported external edit"));
    await expect(load()).rejects.toThrow("Review and import the external SOUL.md edit");
  });

  it.each([
    [
      "an external authored edit",
      (stale: string) => stale.replace("Authored SOUL.md", "Edited outside Mini Me"),
    ],
    [
      "a re-rendered authored edit",
      () => render({ ...canonical("SOUL.md"), content: "Different authored text\n" }),
    ],
    ["a future revision", () => render({ ...canonical("SOUL.md"), revision: 3 })],
    [
      "another Mini Me header",
      () => render(canonical("SOUL.md"), snapshot, { ...profile, id: "other-mini" }),
    ],
    ["another file's header", () => render(canonical("OPINIONS.md"))],
    [
      "an altered generated body",
      (stale: string) =>
        stale.replace("<!-- /openclaw-mini-me", "tampered\n<!-- /openclaw-mini-me"),
    ],
    ["a missing header", () => "Authored SOUL.md\n"],
    ["an unparseable header", () => "<!-- openclaw-mini-me {not json -->\nAuthored SOUL.md\n"],
  ])("still requires review for %s", async (_case, mutate) => {
    await project(commitWithoutProjection());
    const filePath = path.join(workspaceDir, "SOUL.md");
    const changed = mutate(await fs.readFile(filePath, "utf8"));
    await fs.writeFile(filePath, changed);

    await expect(load()).rejects.toThrow("Review and import the external SOUL.md edit");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(changed);
  });

  it("rejects a missing file and an aliased stale projection", async () => {
    await project(commitWithoutProjection());
    const filePath = path.join(workspaceDir, "SOUL.md");
    const outside = `${workspaceDir}-outside.md`;
    await fs.rename(filePath, outside);
    cleanups.push(() => fs.rm(outside, { force: true }));

    await expect(load()).rejects.toThrow("Review and import the external SOUL.md edit");
    await fs.symlink(outside, filePath);
    await expect(load()).rejects.toThrow("Review and import the external SOUL.md edit");
  });

  it("keeps owner, lifecycle and generation fences ahead of recovery", async () => {
    await project(commitWithoutProjection());

    await expect(load(config("someone-else"))).rejects.toThrow(
      "Mini Me files require the original owning person",
    );

    mocks.state.mockReturnValue({
      read: vi.fn(async () => ({
        profile: { ...profile, lifecycle: "disabling" as const },
        attachments: [],
        pendingDataChanges: [],
      })),
    });
    await expect(load()).rejects.toThrow("Mini Me private context is unavailable");

    mocks.state.mockReturnValue({
      read: vi.fn(async () => ({ profile, attachments: [], pendingDataChanges: [] })),
    });
    mocks.generation.mockImplementation(() => {
      throw new Error("Mini Me owner, lifecycle or generation changed");
    });
    await expect(load()).rejects.toThrow("Mini Me owner, lifecycle or generation changed");
  });
});
