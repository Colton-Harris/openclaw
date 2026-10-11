import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { resolveDatabasePath } from "../state/openclaw-state-db.paths.js";
import { prepareOpenClawStateReadSource } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { readResidentUserProfileId } from "../state/user-profile-list.js";
import type { MiniMePrivateMetadata } from "./persistence.types.js";

type Projection = {
  revision: number;
  ready: boolean;
  metadata?: MiniMePrivateMetadata;
  assertCurrent?: () => void;
  preparing?: Promise<void>;
  mutationPending?: boolean;
  options?: OpenClawStateDatabaseOptions;
};
const projections = resolveGlobalSingleton(Symbol.for("openclaw.miniMePrivateAgents"), () => {
  const maps = new Map<string, Projection>();
  registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind !== "opened" && event.kind !== "closed") {
      const current = maps.get(event.path);
      if (current) {
        current.ready = false;
        current.mutationPending = false;
        current.revision++;
      }
    }
    if (event.kind === "opened" || event.kind === "failure-cleared") {
      const current = maps.get(event.kind === "opened" ? event.database.path : event.path);
      if (current && !current.ready) {
        queueMicrotask(() => {
          void prepareMiniMePrivateAgentProjection(current.options).catch(() => {});
        });
      }
    }
  });
  return maps;
});
function projection(options: OpenClawStateDatabaseOptions) {
  const pathname = resolveDatabasePath(options);
  let current = projections.get(pathname);
  if (!current) {
    current = { revision: 0, ready: false, options };
    projections.set(pathname, current);
  }
  return current;
}
/** Retire before dispatch, so an uncertain commit cannot leave stale ownership or attachment facts. */
export function invalidateMiniMePrivateAgentProjection(
  options: OpenClawStateDatabaseOptions = {},
  mutationPending = false,
): void {
  const current = projection(options);
  current.ready = false;
  current.mutationPending = mutationPending;
  current.revision++;
}
/** Metadata only; an absent first-use feature stays absent. Existing startup owners hydrate once. */
export async function prepareMiniMePrivateAgentProjection(
  options: OpenClawStateDatabaseOptions = {},
): Promise<void> {
  const current = projection(options);
  if (current.ready) {
    current.assertCurrent?.();
    return;
  }
  if (current.preparing) {
    await current.preparing;
    if (!current.ready) {
      await prepareMiniMePrivateAgentProjection(options);
    }
    return;
  }
  const revision = current.revision;
  const source = prepareOpenClawStateReadSource({
    path: resolveDatabasePath(options),
    env: options.env,
  });
  const context = source.workerContext();
  const assertCurrent = () => source.current().admission.assertCurrent();
  const preparing = runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "miniMe.privateMetadata", input: {} }),
    { assertCurrent },
  ).then((metadata) => {
    assertCurrent();
    if (current.revision !== revision) {
      return;
    }
    current.metadata = metadata;
    current.assertCurrent = assertCurrent;
    current.ready = true;
    current.mutationPending = false;
  });
  current.preparing = preparing;
  try {
    await preparing;
  } finally {
    if (current.preparing === preparing) {
      current.preparing = undefined;
    }
  }
  if (!current.ready) {
    await prepareMiniMePrivateAgentProjection(options);
  }
}
function read(options: OpenClawStateDatabaseOptions) {
  const current = projection(options);
  if (!current.ready || !current.metadata || !current.assertCurrent) {
    throw new Error("Private agent ownership is not ready");
  }
  current.assertCurrent();
  return current.metadata;
}
/** Configuration markers only restrict; this resident durable mapping remains after deletion. */
export function hasPrivateMiniMeAgents(options: OpenClawStateDatabaseOptions = {}): boolean {
  return read(options).profiles.length > 0;
}
export function readMiniMePrivateAgentMetadata(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  const current = projection(options);
  if (
    !current.ready &&
    current.mutationPending &&
    current.metadata &&
    current.assertCurrent &&
    !current.metadata.profiles.some((profile) => profile.agentId === agentId)
  ) {
    // A Mini Me mutation cannot turn an existing ordinary agent into a private
    // agent: provisioning uses a new UUID and config markers restrict immediately.
    current.assertCurrent();
    return undefined;
  }
  return read(options).profiles.find((profile) => profile.agentId === agentId);
}
export function readActiveMiniMeOwner(ownerId: string, options: OpenClawStateDatabaseOptions = {}) {
  if (readResidentUserProfileId(ownerId, options) !== ownerId) {
    return undefined;
  }
  return read(options).profiles.find(
    (profile) => profile.ownerId === ownerId && profile.lifecycle === "active",
  );
}
/** The Mini Me agent itself cannot outlive the profile consent used to admit its run. */
export function capturePrivateMiniMeRunAssertion(input: {
  agentId: string;
  marker: { ownerProfileId: string; profileId: string };
  ownerId: string | undefined;
}) {
  const original = readMiniMePrivateAgentMetadata(input.agentId);
  if (
    !original ||
    original.lifecycle !== "active" ||
    original.ownerId !== input.ownerId ||
    original.ownerId !== input.marker.ownerProfileId ||
    original.miniMeId !== input.marker.profileId
  ) {
    throw new Error("Mini Me execution requires its active original owner");
  }
  return () => {
    const current = readMiniMePrivateAgentMetadata(input.agentId);
    if (
      !current ||
      current.lifecycle !== "active" ||
      current.ownerId !== original.ownerId ||
      current.miniMeId !== original.miniMeId ||
      current.generation !== original.generation ||
      readResidentUserProfileId(original.ownerId) !== original.ownerId
    ) {
      throw new Error("Mini Me execution consent changed");
    }
  };
}
export function readActiveMiniMeAttachment(
  ownerId: string,
  targetAgentId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  if (readResidentUserProfileId(ownerId, options) !== ownerId) {
    throw new Error("Mini Me owner identity changed");
  }
  return read(options).attachments.find(
    (attachment) => attachment.ownerId === ownerId && attachment.targetAgentId === targetAgentId,
  );
}
export function hasActiveMiniMeAttachment(
  ownerId: string,
  targetAgentId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  try {
    return readActiveMiniMeAttachment(ownerId, targetAgentId, options) !== undefined;
  } catch {
    return false;
  }
}
