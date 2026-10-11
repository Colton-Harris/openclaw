import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { assertCanonicalOwner, getProfile, pendingChanges } from "./persistence.state-profile.js";
import {
  MiniMePersistenceError,
  type MiniMeStateWorkerOperations,
  type MiniMeActionScope,
  type MiniMeReservationState,
} from "./persistence.types.js";

type MiniMeActionOperations = Pick<
  MiniMeStateWorkerOperations,
  "miniMe.reserve" | "miniMe.consume" | "miniMe.settle"
>;

function currentActionGrant(db: DatabaseSync, scope: MiniMeActionScope, grantId: string) {
  const k = getNodeSqliteKysely<DB>(db);
  const profile = getProfile(db, scope);
  if (
    profile.lifecycle !== "active" ||
    profile.generation !== scope.profileGeneration ||
    pendingChanges(db, scope).length !== 0
  ) {
    return undefined;
  }
  const attachment = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_attachments")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("target_agent_id", "=", scope.targetAgentId),
  );
  if (
    !attachment ||
    attachment.detached ||
    attachment.mode === "dont-decide" ||
    attachment.revision !== scope.attachmentRevision
  ) {
    return undefined;
  }
  const grant = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_grants")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("target_agent_id", "=", scope.targetAgentId)
      .where("attachment_revision", "=", scope.attachmentRevision)
      .where("grant_id", "=", grantId),
  );
  return grant && grant.expires_at > Date.now() ? grant : undefined;
}
/** Delegated action budget custody: reserve, consume and settle against the current grant. */
export function executeMiniMeAction(
  db: DatabaseSync,
  command: SqliteWorkerCommand<MiniMeActionOperations>,
) {
  const k = getNodeSqliteKysely<DB>(db);
  const { scope, actionId } = command.input;
  if (command.type !== "miniMe.settle") {
    assertCanonicalOwner(db, scope.ownerId);
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("mini_me_reservations")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("action_id", "=", actionId),
  );
  if (command.type === "miniMe.reserve") {
    const { action, grant, predictionId, optionId } = command.input;
    if (row) {
      return row.fingerprint === action.fingerprint &&
        row.prediction_id === predictionId &&
        row.option_id === optionId &&
        row.target_agent_id === scope.targetAgentId &&
        row.profile_generation === scope.profileGeneration &&
        row.attachment_revision === scope.attachmentRevision &&
        row.effect === action.effect &&
        row.resource === action.resource &&
        row.bytes === action.bytes &&
        row.grant_id === grant.id
        ? {
            kind: "existing" as const,
            // SAFETY: The shared-state action writer persists only MiniMeReservationState values.
            state: row.state as MiniMeReservationState,
          }
        : { kind: "denied" as const, reason: "Action ID already belongs to another reservation" };
    }
    const stored = currentActionGrant(db, scope, grant.id);
    if (
      !stored ||
      stored.effect !== action.effect ||
      // SAFETY: The shared-state action writer owns reservation states and the typed grant resource array; currentActionGrant also checks live scope.
      !(JSON.parse(stored.resources_json) as string[]).includes(action.resource)
    ) {
      return {
        kind: "denied" as const,
        reason: "Current attachment does not grant this exact action",
      };
    }
    if (
      !Number.isSafeInteger(action.bytes) ||
      action.bytes < 0 ||
      !action.fingerprint ||
      !predictionId ||
      !optionId
    ) {
      return { kind: "denied" as const, reason: "Action facts are invalid" };
    }
    if (
      stored.reserved_count + stored.consumed_count >= stored.max_actions ||
      (stored.max_bytes !== null && stored.charged_bytes + action.bytes > stored.max_bytes)
    ) {
      return { kind: "denied" as const, reason: "Delegated action limit is reached" };
    }
    const reservationId = randomUUID();
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      k.insertInto("mini_me_reservations").values({
        owner_id: scope.ownerId,
        mini_me_id: scope.miniMeId,
        target_agent_id: scope.targetAgentId,
        action_id: actionId,
        reservation_id: reservationId,
        profile_generation: scope.profileGeneration,
        attachment_revision: scope.attachmentRevision,
        grant_id: stored.grant_id,
        prediction_id: predictionId,
        option_id: optionId,
        effect: action.effect,
        resource: action.resource,
        fingerprint: action.fingerprint,
        bytes: action.bytes,
        state: "reserved",
        created_at: now,
        updated_at: now,
      }),
    );
    executeSqliteQuerySync(
      db,
      k
        .updateTable("mini_me_grants")
        .set({
          reserved_count: stored.reserved_count + 1,
          charged_bytes: stored.charged_bytes + action.bytes,
        })
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("target_agent_id", "=", scope.targetAgentId)
        .where("attachment_revision", "=", scope.attachmentRevision)
        .where("grant_id", "=", stored.grant_id),
    );
    return { kind: "reserved" as const, reservationId };
  }
  if (
    !row ||
    row.reservation_id !== command.input.reservationId ||
    row.target_agent_id !== scope.targetAgentId ||
    row.profile_generation !== scope.profileGeneration ||
    row.attachment_revision !== scope.attachmentRevision
  ) {
    return command.type === "miniMe.consume"
      ? { kind: "denied" as const, reason: "Reservation binding is unavailable" }
      : null;
  }
  if (command.type === "miniMe.consume") {
    if (row.state !== "reserved") {
      return { kind: "existing" as const };
    }
    const grant = currentActionGrant(db, scope, row.grant_id);
    if (
      !grant ||
      grant.effect !== row.effect ||
      // SAFETY: The shared-state action writer owns reservation states and the typed grant resource array; currentActionGrant also checks live scope.
      !(JSON.parse(grant.resources_json) as string[]).includes(row.resource)
    ) {
      return { kind: "denied" as const, reason: "Reservation authority was revoked" };
    }
    executeSqliteQuerySync(
      db,
      k
        .updateTable("mini_me_grants")
        .set({ reserved_count: grant.reserved_count - 1, consumed_count: grant.consumed_count + 1 })
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("target_agent_id", "=", scope.targetAgentId)
        .where("attachment_revision", "=", scope.attachmentRevision)
        .where("grant_id", "=", row.grant_id),
    );
    executeSqliteQuerySync(
      db,
      k
        .updateTable("mini_me_reservations")
        .set({ state: "consumed", updated_at: Date.now() })
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("action_id", "=", actionId),
    );
    return { kind: "consumed" as const };
  }
  if (row.state !== "reserved" && row.state !== "consumed") {
    return null;
  }
  if (row.state === "consumed" && command.input.state === "not-dispatched") {
    throw new MiniMePersistenceError(
      "invalid",
      "A consumed dispatch cannot be reported as not dispatched",
    );
  }
  // Only a known pre-consumption refusal releases a reservation. Uncertain consumption never refunds.
  if (
    row.state === "reserved" &&
    command.input.state !== "not-dispatched" &&
    command.input.state !== "unknown"
  ) {
    throw new MiniMePersistenceError(
      "invalid",
      "An unconsumed reservation cannot report a dispatched result",
    );
  }
  if (row.state === "reserved" && command.input.state === "not-dispatched") {
    const original = executeSqliteQueryTakeFirstSync(
      db,
      k
        .selectFrom("mini_me_grants")
        .select("budget_epoch")
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("target_agent_id", "=", scope.targetAgentId)
        .where("attachment_revision", "=", scope.attachmentRevision)
        .where("grant_id", "=", row.grant_id),
    );
    if (!original) {
      throw new MiniMePersistenceError("conflict", "Reservation budget custody is unavailable");
    }
    const grants = executeSqliteQuerySync(
      db,
      k
        .selectFrom("mini_me_grants")
        .selectAll()
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("target_agent_id", "=", scope.targetAgentId)
        .where("attachment_revision", ">=", scope.attachmentRevision)
        .where("budget_epoch", "=", original.budget_epoch)
        .where("grant_id", "=", row.grant_id),
    ).rows;
    for (const grant of grants) {
      if (grant.reserved_count < 1 || grant.charged_bytes < row.bytes) {
        throw new MiniMePersistenceError("conflict", "Reservation budget custody is inconsistent");
      }
      executeSqliteQuerySync(
        db,
        k
          .updateTable("mini_me_grants")
          .set({
            reserved_count: grant.reserved_count - 1,
            charged_bytes: grant.charged_bytes - row.bytes,
          })
          .where("owner_id", "=", scope.ownerId)
          .where("mini_me_id", "=", scope.miniMeId)
          .where("target_agent_id", "=", scope.targetAgentId)
          .where("attachment_revision", "=", grant.attachment_revision)
          .where("grant_id", "=", row.grant_id),
      );
    }
  }
  executeSqliteQuerySync(
    db,
    k
      .updateTable("mini_me_reservations")
      .set({ state: command.input.state, updated_at: Date.now() })
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("action_id", "=", actionId),
  );
  return null;
}
