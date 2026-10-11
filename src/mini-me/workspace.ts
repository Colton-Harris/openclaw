import path from "node:path";
import type { MiniMeProfile } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { resolveStateDir } from "../config/paths.js";

/** Feature-owned projections must not fall back to another workspace during config publication. */
export function resolveMiniMeWorkspaceDir(profile: Pick<MiniMeProfile, "id">): string {
  return path.join(resolveStateDir(), "mini-me", profile.id, "workspace");
}
