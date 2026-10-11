import type { MiniMeProfile } from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { miniMeResourceLabel } from "./permissions-view.ts";

// Captures the connection, owner, and profile generation a page-issued read belongs to.
// `current` rereads both live sources, so a late result from a replaced connection,
// owner, or profile generation is never published.
export function captureMiniMeProfileRead(
  gateway: () => ApplicationGatewaySnapshot,
  profile: () => Pick<MiniMeProfile, "id" | "generation"> | null | undefined,
) {
  const client = gateway().client,
    owner = gateway().selfUser?.id,
    captured = profile();
  if (!client || !owner || !captured) {
    return null;
  }
  return {
    client,
    current: () => {
      const snapshot = gateway(),
        live = profile();
      return (
        snapshot.client === client &&
        snapshot.selfUser?.id === owner &&
        snapshot.phase === "connected" &&
        live?.id === captured.id &&
        live.generation === captured.generation
      );
    },
  };
}

export function downloadMiniMeFile(content: string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function miniMeBeforeFilename(resource: string): string {
  const basename = miniMeResourceLabel(resource).split(/[\\/]/).at(-1) ?? "file.txt";
  return `before-${basename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}
