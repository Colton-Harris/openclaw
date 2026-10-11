import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "../infra/fs-safe.js";
import { prepareMiniMeWorkspaceMutation } from "../mini-me/effect-execution.js";
import { captureMiniMeEffectPreparation } from "../mini-me/effect-scope.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { toRelativeWorkspacePath } from "./path-policy.js";

type FileEffectOperations = {
  mkdir: (dir: string) => Promise<unknown>;
  writeFile: (absolutePath: string, content: string) => Promise<unknown>;
};

/** Host-mode routing that sends delegated writes through the workspace root. */
type MiniMeHostWriteRoute = {
  resolvePath: (filePath: string) => string;
  abortSignal?: AbortSignal;
};

/** Writes inside the workspace root; a delegated Mini Me edit also binds its file preimage. */
export async function writeWorkspaceFile(
  root: string,
  getRoot: () => ReturnType<typeof fsRoot>,
  absolutePath: string,
  content: string,
  abortSignal?: AbortSignal,
) {
  const assertCurrent = captureAgentToolSourceExecutionGuard(abortSignal);
  // Reject lexical escapes before opening the lazily created workspace root.
  const relative = toRelativeWorkspacePath(root, absolutePath);
  const rootHandle = await getRoot();
  const canonicalPath = path.resolve(rootHandle.rootReal, relative);
  const assertMiniMeMutation = await prepareMiniMeWorkspaceMutation({
    root: rootHandle,
    absolutePath: canonicalPath,
    content,
  });
  // Absolute admitted paths preserve literal "~" workspace directories.
  await rootHandle.write(canonicalPath, content, {
    mkdir: true,
    mutationSymlinks: "follow-parents-within-root",
    assertBeforeMutation: () => {
      assertCurrent();
      assertMiniMeMutation?.();
    },
  });
}

/** Sandbox bridges do not expose the granted host root, so delegated effects fail closed. */
export function withMiniMeSandboxFileEffects<T extends FileEffectOperations>(operations: T): T {
  return {
    ...operations,
    mkdir: async (dir: string) => {
      if (captureMiniMeEffectPreparation("workspace.edit")) {
        throw new Error("Mini Me delegation is unavailable for sandbox file effects.");
      }
      await operations.mkdir(dir);
    },
    writeFile: async (absolutePath: string, content: string) => {
      if (captureMiniMeEffectPreparation("workspace.edit")) {
        throw new Error("Mini Me delegation is unavailable for sandbox file effects.");
      }
      await operations.writeFile(absolutePath, content);
    },
  };
}

/**
 * A delegated text-file grant may only reuse existing workspace directories. With a host
 * route, delegated writes also leave unrestricted host writes for the workspace-root writer.
 */
export function withMiniMeHostFileEffects<T extends FileEffectOperations>(
  root: string,
  route: MiniMeHostWriteRoute | undefined,
  operations: T,
): T {
  return {
    ...operations,
    mkdir: async (dir: string) => {
      const directory = route ? route.resolvePath(dir) : dir;
      const scope = captureMiniMeEffectPreparation("workspace.edit");
      if (!scope) {
        await operations.mkdir(dir);
        return;
      }
      scope.assertCurrent();
      const [rootReal, directoryReal] = await Promise.all([
        fs.realpath(root),
        fs.realpath(directory),
      ]);
      toRelativeWorkspacePath(rootReal, directoryReal, { allowRoot: true });
      if (!(await fs.stat(directoryReal)).isDirectory()) {
        throw new Error("Mini Me cannot create directories through a text-file grant.");
      }
      scope.assertCurrent();
    },
    writeFile: (absolutePath: string, content: string) =>
      route && captureMiniMeEffectPreparation("workspace.edit")
        ? writeWorkspaceFile(
            root,
            () => fsRoot(root),
            route.resolvePath(absolutePath),
            content,
            route.abortSignal,
          )
        : operations.writeFile(absolutePath, content),
  };
}
