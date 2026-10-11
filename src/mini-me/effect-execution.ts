import { createHash } from "node:crypto";
import syncFs from "node:fs";
import path from "node:path";
import type { AnyAgentTool } from "../agents/agent-tools.types.js";
import { toRelativeWorkspacePath } from "../agents/path-policy.js";
import { decodeUtf8File } from "../agents/utf8-file.js";
import { WORKSPACE_BOOTSTRAP_FILENAMES } from "../agents/workspace-bootstrap-policy.js";
import { hashFileMutationSnapshotSync } from "../infra/file-descriptor.js";
import { root as fsRoot, type Root } from "../infra/fs-safe.js";
import type {
  MiniMeDelegationAction,
  MiniMeDelegationFence,
  MiniMeEffectResult,
} from "./delegation.types.js";
import {
  captureMiniMeEffectPreparation,
  miniMeWorkspaceResource,
  withMiniMeEffectScope,
} from "./effect-scope.js";

export const MINI_ME_MAX_WORKSPACE_TEXT_BYTES = 65_536;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function relativeResourcePath(rootReal: string, absolutePath: string): string {
  return toRelativeWorkspacePath(rootReal, absolutePath).split(path.sep).join("/");
}

function isLowImpactTextPath(relative: string): boolean {
  const parts = relative.split("/");
  const name = parts.at(-1)?.toUpperCase() ?? "";
  return (
    /\.(?:md|txt)$/i.test(name) &&
    parts.every((part) => !part.startsWith(".") && part.toLowerCase() !== "skills") &&
    !new Set(
      [...WORKSPACE_BOOTSTRAP_FILENAMES, "TOOLS.md", "SKILL.md", "HEARTBEAT.md"].map((file) =>
        file.toUpperCase(),
      ),
    ).has(name)
  );
}

/** A durable restorable receipt, not this snapshot alone, can qualify Decide safe. */
export async function prepareMiniMeWorkspaceAction(input: {
  workspaceDir: string;
  relativePath: string;
  content: string;
  assertCurrent: () => void;
}) {
  input.assertCurrent();
  if (Buffer.byteLength(input.content) > MINI_ME_MAX_WORKSPACE_TEXT_BYTES) {
    throw new Error("Mini Me workspace edits are limited to small existing text files.");
  }
  const root = await fsRoot(input.workspaceDir);
  const relative = toRelativeWorkspacePath(
    input.workspaceDir,
    path.resolve(input.workspaceDir, input.relativePath),
  );
  const absolutePath = path.resolve(root.rootReal, relative);
  const original = await root.read(absolutePath, {
    maxBytes: MINI_ME_MAX_WORKSPACE_TEXT_BYTES,
    hardlinks: "reject",
    symlinks: "reject",
  });
  input.assertCurrent();
  if ((original.stat.mode & 0o111) !== 0) {
    throw new Error("Executable files are outside Mini Me's text-edit qualification.");
  }
  const before = decodeUtf8File(original.buffer, absolutePath);
  const action: MiniMeDelegationAction = Object.freeze({
    effect: "workspace.edit",
    resource: miniMeWorkspaceResource(
      root.rootReal,
      relativeResourcePath(root.rootReal, absolutePath),
    ),
    expectedContentHash: sha256(original.buffer),
    content: input.content,
  });
  return {
    action,
    absolutePath,
    preimage: { utf8: before, sha256: action.expectedContentHash },
    afterSha256: sha256(input.content),
    impact: isLowImpactTextPath(relativeResourcePath(root.rootReal, absolutePath))
      ? ("low" as const)
      : ("other" as const),
    reversible: false as const,
  };
}

/** Called inside the ordinary serialized core write route, after hook rewrites. */
export async function prepareMiniMeWorkspaceMutation(input: {
  root: Root;
  absolutePath: string;
  content: string;
}): Promise<(() => void) | undefined> {
  const scope = captureMiniMeEffectPreparation("workspace.edit");
  if (!scope) {
    return undefined;
  }
  scope.assertCurrent();
  if (Buffer.byteLength(input.content) > MINI_ME_MAX_WORKSPACE_TEXT_BYTES) {
    throw new Error("Mini Me workspace edits are limited to small existing text files.");
  }
  const original = await input.root.read(input.absolutePath, {
    maxBytes: MINI_ME_MAX_WORKSPACE_TEXT_BYTES,
    hardlinks: "reject",
    symlinks: "reject",
  });
  decodeUtf8File(original.buffer, input.absolutePath);
  const metadata = syncFs.lstatSync(input.absolutePath, { bigint: true });
  if (!metadata.isFile() || metadata.nlink !== 1n || (metadata.mode & 0o111n) !== 0n) {
    throw new Error("Mini Me requires an existing regular, non-executable text file.");
  }
  const originalHash = sha256(original.buffer);
  const assertPreimageCurrent = () => {
    if (hashFileMutationSnapshotSync(input.absolutePath, metadata) !== originalHash) {
      throw new Error("Mini Me workspace preimage changed before mutation.");
    }
  };
  assertPreimageCurrent();
  await scope.beforeDispatch({
    effect: "workspace.edit",
    resource: miniMeWorkspaceResource(
      input.root.rootReal,
      relativeResourcePath(input.root.rootReal, input.absolutePath),
    ),
    expectedContentHash: originalHash,
    content: input.content,
  });
  return () => {
    scope.assertCurrent();
    assertPreimageCurrent();
  };
}

/**
 * Invoke the host's already-filtered, approval-wrapped core tool. The caller must
 * obtain it from this admitted run's final tool surface, never construct a bypass.
 * Final file/message owners retain custody of normalization and dispatch.
 */
export async function executeMiniMeHostTool(input: {
  fence: MiniMeDelegationFence;
  tool: AnyAgentTool;
  toolCallId: string;
  args: unknown;
  signal?: AbortSignal;
}): Promise<MiniMeEffectResult<Awaited<ReturnType<AnyAgentTool["execute"]>>>> {
  const expectedTool = input.fence.action.effect === "workspace.edit" ? "write" : "message";
  if (input.tool.name !== expectedTool) {
    throw new Error("Mini Me delegated effects require the matching admitted core tool.");
  }
  const value = await withMiniMeEffectScope(input.fence, () =>
    input.tool.execute(input.toolCallId, input.args, input.signal),
  );
  return { state: "succeeded", value };
}
