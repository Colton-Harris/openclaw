import fs from "node:fs/promises";
import path from "node:path";
import {
  assert,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { MiniMeGrant } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareMiniMeWorkspaceAction } from "./effect-execution.js";
import { miniMeWorkspaceResource } from "./effect-scope.js";
import { parseMiniMeWorkspaceResource, prepareMiniMeWorkspaceGrants } from "./workspace-grants.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
let workspaceDir: string;
let rootReal: string;
let foreignReal: string;

function grant(resources: string[], overrides: Partial<MiniMeGrant> = {}): MiniMeGrant {
  return {
    id: "fixture-grant",
    effect: "workspace.edit",
    resources,
    maxActions: 3,
    maxBytes: 64,
    expiresAt: 5_000,
    ...overrides,
  };
}

function prepare(grants: MiniMeGrant[], assertCurrent: () => void = () => {}) {
  return prepareMiniMeWorkspaceGrants({ workspaceDir, grants, assertCurrent });
}

beforeAll(async () => {
  workspaceDir = dirs.make("mini-me-grants-");
  rootReal = await fs.realpath(workspaceDir);
  const foreignDir = dirs.make("mini-me-grants-foreign-");
  foreignReal = await fs.realpath(foreignDir);
  await fs.writeFile(path.join(foreignDir, "notes.md"), "foreign");

  await fs.writeFile(path.join(workspaceDir, "notes.md"), "notes");
  await fs.mkdir(path.join(workspaceDir, "docs"));
  await fs.writeFile(path.join(workspaceDir, "docs", "plan.txt"), "plan");
  await fs.writeFile(path.join(workspaceDir, "binary.txt"), Buffer.from([0xff, 0xfe, 0x00]));
  await fs.writeFile(path.join(workspaceDir, "big.md"), "x".repeat(65_537));
  await fs.writeFile(path.join(workspaceDir, "run.sh"), "echo fixture", { mode: 0o755 });
  await fs.chmod(path.join(workspaceDir, "run.sh"), 0o755);
  await fs.writeFile(path.join(workspaceDir, "hard-source.md"), "hard");
  await fs.link(path.join(workspaceDir, "hard-source.md"), path.join(workspaceDir, "hard.md"));
  await fs.symlink(path.join(workspaceDir, "notes.md"), path.join(workspaceDir, "link.md"));
  await fs.symlink(path.join(workspaceDir, "docs"), path.join(workspaceDir, "linked-docs"));
});

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prepareMiniMeWorkspaceGrants", () => {
  it("emits deduplicated, round-trippable resources the edit owner matches", async () => {
    const canonicalNotes = miniMeWorkspaceResource(rootReal, "notes.md");
    const unboundedBytes = (resources: string[]): MiniMeGrant => ({
      id: "unbounded-bytes",
      effect: "workspace.edit",
      resources,
      maxActions: 1,
      expiresAt: 5_000,
    });
    const prepared = await prepare([
      grant(["notes.md", "docs/plan.txt", canonicalNotes]),
      unboundedBytes(["notes.md"]),
    ]);

    expect(prepared).toEqual([
      grant([canonicalNotes, miniMeWorkspaceResource(rootReal, "docs/plan.txt")]),
      unboundedBytes([canonicalNotes]),
    ]);
    assert(prepared[0]);
    assert(prepared[1]);
    expect(Object.hasOwn(prepared[1], "maxBytes")).toBe(false);

    for (const relativePath of ["notes.md", "docs/plan.txt"]) {
      const { action } = await prepareMiniMeWorkspaceAction({
        workspaceDir,
        relativePath,
        content: "edited",
        assertCurrent() {},
      });
      expect(prepared[0].resources).toContain(action.resource);
      expect(parseMiniMeWorkspaceResource(action.resource)).toEqual({ rootReal, relativePath });
    }

    await expect(prepare(prepared)).resolves.toEqual(prepared);
  });

  it("rejects resources outside exact existing small text files", async () => {
    const cases: Array<[string, RegExp]> = [
      ["*.md", /wildcards/],
      ["docs/**", /wildcards/],
      ["docs", /regular files/],
      ["missing.md", /does not exist/],
      ["../outside.md", /\.\./],
      ["docs/../notes.md", /\.\./],
      ["./notes.md", /plain path/],
      [path.join(workspaceDir, "notes.md"), /absolute paths/],
      [miniMeWorkspaceResource(foreignReal, "notes.md"), /different workspace root/],
      [miniMeWorkspaceResource(rootReal, "../notes.md"), /\.\./],
      [`workspace:${JSON.stringify([rootReal, "notes.md"], null, 1)}`, /not a canonical/],
      ["link.md", /symbolic link/],
      ["linked-docs/plan.txt", /symbolic link/],
      ["hard.md", /hard links/],
      ["run.sh", /executable/],
      ["binary.txt", /UTF-8/],
      ["big.md", /65,536 bytes/],
    ];
    for (const [resource, error] of cases) {
      await expect(prepare([grant(["notes.md", resource])]), resource).rejects.toThrow(error);
    }
  });

  it("rejects unsupported, expired, malformed, and duplicate grants", async () => {
    const cases: Array<[MiniMeGrant[], RegExp]> = [
      [[grant(["notes.md"], { effect: "message.send" })], /message\.send/],
      [[grant(["notes.md"], { expiresAt: 1_000 })], /expired/],
      [[grant(["notes.md"], { expiresAt: Number.NaN })], /invalid/],
      [[grant(["notes.md"], { maxActions: 0 })], /invalid/],
      [[grant(["notes.md"], { maxActions: Number.POSITIVE_INFINITY })], /invalid/],
      [[grant(["notes.md"], { maxBytes: 10_485_761 })], /invalid/],
      [[grant([])], /invalid/],
      [[grant(["notes.md"]), grant(["docs/plan.txt"])], /more than once/],
    ];
    for (const [grants, error] of cases) {
      await expect(prepare(grants)).rejects.toThrow(error);
    }
  });

  it("stops at every authority check once the original authority is revoked", async () => {
    const grants = [grant(["notes.md", "docs/plan.txt"])];
    let checks = 0;
    await prepare(grants, () => {
      checks += 1;
    });
    expect(checks).toBeGreaterThan(3);

    for (let allowed = 0; allowed < checks; allowed += 1) {
      let seen = 0;
      await expect(
        prepare(grants, () => {
          seen += 1;
          if (seen > allowed) {
            throw new Error("fixture authority revoked");
          }
        }),
      ).rejects.toThrow("fixture authority revoked");
    }
  });
});
