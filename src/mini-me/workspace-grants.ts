import path from "node:path";
import { Value } from "typebox/value";
import {
  MiniMeGrantSchema,
  type MiniMeGrant,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { toRelativeWorkspacePath } from "../agents/path-policy.js";
import { decodeUtf8File } from "../agents/utf8-file.js";
import { FsSafeError, root as fsRoot } from "../infra/fs-safe.js";
import { MINI_ME_MAX_WORKSPACE_TEXT_BYTES } from "./effect-execution.js";
import { miniMeWorkspaceResource } from "./effect-scope.js";

const WORKSPACE_RESOURCE_PREFIX = "workspace:";
const MAX_GRANTS = 32;
const MAX_RESOURCE_LENGTH = 512;

/**
 * Inverse of miniMeWorkspaceResource for display and restore. Only the exact
 * serialization round-trips, so equivalent JSON spellings never alias a grant.
 */
export function parseMiniMeWorkspaceResource(
  resource: string,
): { rootReal: string; relativePath: string } | undefined {
  if (!resource.startsWith(WORKSPACE_RESOURCE_PREFIX)) {
    return undefined;
  }
  let tuple: unknown;
  try {
    tuple = JSON.parse(resource.slice(WORKSPACE_RESOURCE_PREFIX.length));
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 2 ||
    typeof tuple[0] !== "string" ||
    typeof tuple[1] !== "string"
  ) {
    return undefined;
  }
  const rootReal = tuple[0],
    relativePath = tuple[1];
  return miniMeWorkspaceResource(rootReal, relativePath) === resource
    ? { rootReal, relativePath }
    : undefined;
}

/** Mirrors effect-execution's private derivation of the edit resource path. */
function relativeResourcePath(rootReal: string, absolutePath: string): string {
  return toRelativeWorkspacePath(rootReal, absolutePath).split(path.sep).join("/");
}

function resourceError(grantId: string, resource: string, reason: string): Error {
  return new Error(`Mini Me grant "${grantId}" cannot use "${resource}": ${reason}`);
}

/** Syntax only; the filesystem owner still proves the file below. */
function explicitRelativePathProblem(relative: string): string | undefined {
  if (!relative) {
    return "enter a workspace-relative file path such as docs/notes.md.";
  }
  for (let i = 0; i < relative.length; i++) {
    const code = relative.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) {
      return "enter a workspace-relative file path such as docs/notes.md.";
    }
  }
  if (/[*?[\]{}]/.test(relative) || relative.startsWith("!")) {
    return "wildcards and patterns are not allowed; list each file path exactly.";
  }
  if (
    relative.startsWith("/") ||
    relative.startsWith("~") ||
    path.win32.isAbsolute(relative) ||
    /^[a-z]:/i.test(relative) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(relative)
  ) {
    return "absolute paths are not allowed; enter the path relative to the agent workspace.";
  }
  if (relative.includes("\\")) {
    return "use forward slashes (docs/notes.md) for workspace paths.";
  }
  const parts = relative.split("/");
  if (parts.includes("..")) {
    return "paths may not use .. to leave or traverse the workspace.";
  }
  if (parts.some((part) => part === "" || part === ".")) {
    return "write the plain path without ./, empty segments, or a trailing slash.";
  }
  return undefined;
}

const NOT_REGULAR_FILE =
  "only regular files can be granted; list each file instead of a directory.";
const HARD_LINKED = "the file has multiple hard links; grant a file with a single link.";

function readFailureReason(error: unknown): string {
  if (!(error instanceof FsSafeError)) {
    return `the file could not be read safely (${String(error)}).`;
  }
  switch (error.code) {
    case "not-found":
      return "the file does not exist; Mini Me only grants existing files, so create it first.";
    case "symlink":
    case "path-alias":
      return "the path is or passes through a symbolic link; grant the real file path instead.";
    case "hardlink":
      return HARD_LINKED;
    case "too-large":
      return (
        `the file is larger than ${MINI_ME_MAX_WORKSPACE_TEXT_BYTES.toLocaleString("en-US")} ` +
        "bytes; Mini Me only edits small text files."
      );
    case "not-file":
      return NOT_REGULAR_FILE;
    case "outside-workspace":
    case "invalid-path":
    case "path-mismatch":
      return "the path is outside the agent workspace.";
    default:
      return `the file could not be read safely (${error.message}).`;
  }
}

function assertGrantShape(grant: MiniMeGrant, now: number): void {
  // Callers pass operator input, so the static type is only a claim until the schema check.
  const label = typeof grant.id === "string" ? grant.id : "(missing id)";
  if (!Value.Check(MiniMeGrantSchema, grant)) {
    throw new Error(
      `Mini Me grant "${label}" is invalid: it needs an id, effect, 1-32 unique resources, ` +
        "maxActions from 1 to 10,000, optional maxBytes from 1 to 10,485,760, " +
        "and an expiresAt timestamp.",
    );
  }
  if (grant.effect !== "workspace.edit") {
    throw new Error(
      `Mini Me grant "${label}" uses ${grant.effect}, which Mini Me cannot qualify yet; ` +
        "remove it or use workspace.edit.",
    );
  }
  if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now) {
    throw new Error(`Mini Me grant "${label}" has already expired; choose a later expiry.`);
  }
}

/**
 * Qualifies operator-entered workspace.edit grants into the exact resources the
 * edit path matches. This narrows what admitted runtime may later dispatch; it
 * does not construct run authority or permit any tool.
 */
export async function prepareMiniMeWorkspaceGrants(input: {
  workspaceDir: string;
  grants: MiniMeGrant[];
  assertCurrent(this: void): void;
}): Promise<MiniMeGrant[]> {
  input.assertCurrent();
  if (input.grants.length > MAX_GRANTS) {
    throw new Error(`Mini Me allows at most ${MAX_GRANTS} grants; remove some and try again.`);
  }
  if (!input.grants.length) {
    return [];
  }
  const seenIds = new Set<string>();
  for (const grant of input.grants) {
    assertGrantShape(grant, Date.now());
    if (seenIds.has(grant.id)) {
      throw new Error(
        `Mini Me grant "${grant.id}" appears more than once; give each grant a unique id.`,
      );
    }
    seenIds.add(grant.id);
  }

  const root = await fsRoot(input.workspaceDir);
  input.assertCurrent();

  const prepared: MiniMeGrant[] = [];
  for (const grant of input.grants) {
    const resources = new Set<string>();
    for (const resource of grant.resources) {
      let relative = resource;
      if (resource.startsWith(WORKSPACE_RESOURCE_PREFIX)) {
        const parsed = parseMiniMeWorkspaceResource(resource);
        if (!parsed) {
          throw resourceError(
            grant.id,
            resource,
            "this is not a canonical workspace resource; enter a workspace-relative file path instead.",
          );
        }
        if (parsed.rootReal !== root.rootReal) {
          throw resourceError(
            grant.id,
            resource,
            "it belongs to a different workspace root; re-enter the file path for this agent's workspace.",
          );
        }
        relative = parsed.relativePath;
      }
      const problem = explicitRelativePathProblem(relative);
      if (problem) {
        throw resourceError(grant.id, resource, problem);
      }
      const absolutePath = path.resolve(root.rootReal, ...relative.split("/"));
      // The edit owner derives its resource through this policy; a rewrite would never match.
      if (relativeResourcePath(root.rootReal, absolutePath) !== relative) {
        throw resourceError(
          grant.id,
          resource,
          "the path is not in exact workspace form; enter the file path exactly as it appears.",
        );
      }

      let file: Awaited<ReturnType<typeof root.read>>;
      try {
        // Same read policy as effect execution, so a qualified grant can match a later edit.
        file = await root.read(absolutePath, {
          maxBytes: MINI_ME_MAX_WORKSPACE_TEXT_BYTES,
          hardlinks: "reject",
          symlinks: "reject",
        });
      } catch (error) {
        input.assertCurrent();
        throw resourceError(grant.id, resource, readFailureReason(error));
      }
      input.assertCurrent();

      if (!file.stat.isFile()) {
        throw resourceError(grant.id, resource, NOT_REGULAR_FILE);
      }
      if (file.stat.nlink !== 1) {
        throw resourceError(grant.id, resource, HARD_LINKED);
      }
      if ((file.stat.mode & 0o111) !== 0) {
        throw resourceError(
          grant.id,
          resource,
          "executable files are outside Mini Me's text-edit qualification.",
        );
      }
      try {
        decodeUtf8File(file.buffer, relative);
      } catch {
        throw resourceError(
          grant.id,
          resource,
          "the file is not valid UTF-8 text; Mini Me only edits text files.",
        );
      }
      // Case-folding filesystems or linked folders can open a file under another spelling.
      if (relativeResourcePath(root.rootReal, file.realPath) !== relative) {
        throw resourceError(
          grant.id,
          resource,
          "the path resolves to a different file name; check letter case and symbolic link " +
            "folders, then enter the real path.",
        );
      }

      const canonical = miniMeWorkspaceResource(root.rootReal, relative);
      if (canonical.length > MAX_RESOURCE_LENGTH) {
        throw resourceError(
          grant.id,
          resource,
          `the workspace path is too long to store (limit ${MAX_RESOURCE_LENGTH} characters including the workspace root).`,
        );
      }
      resources.add(canonical);
    }
    prepared.push({
      id: grant.id,
      effect: grant.effect,
      resources: [...resources],
      maxActions: grant.maxActions,
      ...(grant.maxBytes === undefined ? {} : { maxBytes: grant.maxBytes }),
      expiresAt: grant.expiresAt,
    });
  }

  // File reads take time; recheck expiry against the clock the delegation owner uses.
  const now = Date.now();
  for (const grant of prepared) {
    if (grant.expiresAt <= now) {
      throw new Error(
        `Mini Me grant "${grant.id}" expired while it was being checked; choose a later expiry.`,
      );
    }
  }
  return prepared;
}
