import path from "node:path";
import { allowsProcessHomeSessionScan } from "../config/paths.js";
import {
  readStoredDeviceIdentityReadOnly,
  resolveDeviceIdentityStore,
  type DeviceIdentityStoreOptions,
} from "../infra/device-identity-store.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";

const localNodeIdsByStore = new Map<string, string>();

// Successful reads remain process-stable; misses retry after native/CLI startup.
function readLocalNodeIdentity(
  options: DeviceIdentityStoreOptions,
  readIdentity: typeof loadDeviceIdentityIfPresent = readStoredDeviceIdentityReadOnly,
): string | null {
  const { databasePath, identityKey } = resolveDeviceIdentityStore(options);
  const key = `${databasePath}\0${identityKey}`;
  const cached = localNodeIdsByStore.get(key);
  if (cached) {
    return cached;
  }
  const nodeId = readIdentity(options)?.deviceId ?? null;
  if (nodeId) {
    localNodeIdsByStore.set(key, nodeId);
  }
  return nodeId;
}

// The CLI version handshake deliberately recognizes only its own primary profile.
export async function resolveLocalNodeId(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return readLocalNodeIdentity({ env }, loadDeviceIdentityIfPresent);
}

/** Native Mac nodes keep their identity in the app's own canonical SQLite store. */
export async function resolveLocalCatalogNodeIds(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<Set<string>> {
  const primary = await resolveLocalNodeId(env);
  const ids = new Set(primary ? [primary] : []);
  const roots: Array<string | undefined> = [undefined];
  if (platform === "darwin" && allowsProcessHomeSessionScan(env)) {
    // OpenClawKit DeviceIdentityPaths: the shipped unentitled Mac app has its own store.
    roots.push(
      path.join(
        resolveRequiredHomeDir(env),
        "Library/Application Support/OpenClaw/state/openclaw.sqlite",
      ),
    );
  }
  for (const databasePath of roots) {
    for (const identityKey of ["primary", "node"]) {
      const id = readLocalNodeIdentity({ env, path: databasePath, identityKey });
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}
