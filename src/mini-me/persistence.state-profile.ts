import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type {
  MiniMeAttachment,
  MiniMeGrant,
  MiniMeProfile,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { selectResolvedUserProfileMetadataById } from "../state/user-profiles-internal.js";
import {
  MiniMePersistenceError,
  type MiniMeOwnerScope,
  type MiniMeStateWorkerOperations,
  type MiniMeDataChange,
} from "./persistence.types.js";

type ProfileRow = Selectable<DB["mini_me_profiles"]>;
type MiniMeProfileMutationOperations = Pick<
  MiniMeStateWorkerOperations,
  | "miniMe.advanceGeneration"
  | "miniMe.completeDataChange"
  | "miniMe.activate"
  | "miniMe.configure"
  | "miniMe.closeLifecycle"
  | "miniMe.finalizeLifecycle"
  | "miniMe.setAttachment"
  | "miniMe.detachAttachment"
>;

export function profileFromRow(row: ProfileRow): MiniMeProfile {
  return {
    id: row.mini_me_id,
    agentId: row.agent_id,
    name: row.name,
    // SAFETY: The typed shared-state writer owns this profile, attachment, grant or data-change field; generated SQLite types erase its literal or JSON shape.
    lifecycle: row.lifecycle as MiniMeProfile["lifecycle"],
    learningPaused: row.learning_paused === 1,
    generation: row.generation,
    revision: row.revision,
    // SAFETY: The typed shared-state writer owns this profile, attachment, grant or data-change field; generated SQLite types erase its literal or JSON shape.
    models: JSON.parse(row.models_json) as MiniMeProfile["models"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function getProfile(db: DatabaseSync, scope: MiniMeOwnerScope): ProfileRow {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("mini_me_profiles")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId),
  );
  if (!row) {
    throw new MiniMePersistenceError("not-found", "Mini Me profile is unavailable for this owner");
  }
  return row;
}
export function assertCanonicalOwner(db: DatabaseSync, ownerId: string): void {
  const owner = selectResolvedUserProfileMetadataById(db, ownerId);
  if (!owner || owner.id !== ownerId) {
    throw new MiniMePersistenceError(
      "conflict",
      "Owner identity changed; resolve the current authenticated profile",
    );
  }
}
export function readAttachments(db: DatabaseSync, scope: MiniMeOwnerScope): MiniMeAttachment[] {
  const k = getNodeSqliteKysely<DB>(db);
  return executeSqliteQuerySync(
    db,
    k
      .selectFrom("mini_me_attachments")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId)
      .where("detached", "=", 0),
  ).rows.map((row) => {
    const grants = executeSqliteQuerySync(
      db,
      k
        .selectFrom("mini_me_grants")
        .selectAll()
        .where("owner_id", "=", scope.ownerId)
        .where("mini_me_id", "=", scope.miniMeId)
        .where("target_agent_id", "=", row.target_agent_id)
        .where("attachment_revision", "=", row.revision),
    ).rows;
    return {
      agentId: row.target_agent_id,
      // SAFETY: The typed shared-state writer owns this profile, attachment, grant or data-change field; generated SQLite types erase its literal or JSON shape.
      mode: row.mode as MiniMeAttachment["mode"],
      revision: row.revision,
      grants: grants.map((g) => ({
        id: g.grant_id,
        // SAFETY: The typed shared-state writer owns this profile, attachment, grant or data-change field; generated SQLite types erase its literal or JSON shape.
        effect: g.effect as MiniMeGrant["effect"],
        // SAFETY: The typed shared-state writer owns this profile, attachment, grant or data-change field; generated SQLite types erase its literal or JSON shape.
        resources: JSON.parse(g.resources_json) as string[],
        maxActions: g.max_actions,
        ...(g.max_bytes === null ? {} : { maxBytes: g.max_bytes }),
        expiresAt: g.expires_at,
      })),
      usage: grants.map((g) => ({
        grantId: g.grant_id,
        reserved: g.reserved_count,
        consumed: g.consumed_count,
      })),
    };
  });
}
function updateProfile(
  db: DatabaseSync,
  row: ProfileRow,
  patch: Partial<ProfileRow>,
): MiniMeProfile {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db)
      .updateTable("mini_me_profiles")
      .set({ ...patch, revision: row.revision + 1, updated_at: Date.now() })
      .where("owner_id", "=", row.owner_id)
      .where("mini_me_id", "=", row.mini_me_id)
      .where("revision", "=", row.revision),
  );
  return profileFromRow(getProfile(db, { ownerId: row.owner_id, miniMeId: row.mini_me_id }));
}
export function pendingChanges(db: DatabaseSync, scope: MiniMeOwnerScope): MiniMeDataChange[] {
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("mini_me_data_changes")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("mini_me_id", "=", scope.miniMeId),
  ).rows.map((row) => ({
    id: row.change_id,
    generation: row.generation,
    // SAFETY: The typed shared-state writer owns this profile, attachment, grant or data-change field; generated SQLite types erase its literal or JSON shape.
    change: JSON.parse(row.change_json) as MiniMeDataChange["change"],
  }));
}
/** Profile lifecycle, generation and attachment changes; the caller owns receipts and identity. */
export function executeProfileMutation(
  db: DatabaseSync,
  command: SqliteWorkerCommand<MiniMeProfileMutationOperations>,
): unknown {
  const k = getNodeSqliteKysely<DB>(db);
  const { ownerId, miniMeId } = command.input.scope;
  const row = getProfile(db, command.input.scope);
  if (
    "expectedRevision" in command.input &&
    row.revision !== command.input.expectedRevision &&
    command.type !== "miniMe.setAttachment"
  ) {
    throw new MiniMePersistenceError("conflict", "Mini Me changed; inspect its current revision");
  }
  switch (command.type) {
    case "miniMe.advanceGeneration": {
      if (row.lifecycle !== "active" && row.lifecycle !== "disabled") {
        throw new MiniMePersistenceError("lifecycle", "Mini Me lifecycle is closed");
      }
      const result = updateProfile(db, row, { generation: row.generation + 1 });
      if (command.input.change) {
        executeSqliteQuerySync(
          db,
          k.insertInto("mini_me_data_changes").values({
            owner_id: ownerId,
            mini_me_id: miniMeId,
            change_id: command.input.operationId,
            generation: row.generation + 1,
            change_json: JSON.stringify(command.input.change),
          }),
        );
      }
      return result;
    }
    case "miniMe.completeDataChange":
      executeSqliteQuerySync(
        db,
        k
          .deleteFrom("mini_me_data_changes")
          .where("owner_id", "=", ownerId)
          .where("mini_me_id", "=", miniMeId)
          .where("change_id", "=", command.input.dataChangeId),
      );
      return null;
    case "miniMe.activate":
      if (row.lifecycle !== "preparing") {
        throw new MiniMePersistenceError("lifecycle", "Mini Me is not preparing");
      }
      return updateProfile(db, row, { lifecycle: "active" });
    case "miniMe.configure": {
      if (row.lifecycle !== "active" && row.lifecycle !== "disabled") {
        throw new MiniMePersistenceError("lifecycle", "Mini Me lifecycle is closed");
      }
      if (command.input.patch.enabled === false) {
        throw new MiniMePersistenceError(
          "lifecycle",
          "Disable through the coordinated lifecycle close",
        );
      }
      const patch = command.input.patch;
      return updateProfile(db, row, {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.models === undefined ? {} : { models_json: JSON.stringify(patch.models) }),
        ...(patch.learningPaused === undefined
          ? {}
          : { learning_paused: Number(patch.learningPaused) }),
        ...(patch.enabled === true ? { lifecycle: "active" as const } : {}),
        generation: row.generation + 1,
      });
    }
    case "miniMe.closeLifecycle":
      if (
        row.lifecycle === "deleted" ||
        (command.input.lifecycle === "disabling" && row.lifecycle !== "active")
      ) {
        throw new MiniMePersistenceError("lifecycle", "Mini Me cannot enter that lifecycle");
      }
      return updateProfile(db, row, {
        lifecycle: command.input.lifecycle,
        generation: row.generation + 1,
      });
    case "miniMe.finalizeLifecycle": {
      if (row.lifecycle !== (command.input.lifecycle === "disabled" ? "disabling" : "deleting")) {
        throw new MiniMePersistenceError("lifecycle", "Mini Me cleanup is not pending");
      }
      const result = updateProfile(db, row, { lifecycle: command.input.lifecycle });
      if (command.input.lifecycle === "deleted") {
        executeSqliteQuerySync(
          db,
          k
            .deleteFrom("mini_me_data_changes")
            .where("owner_id", "=", ownerId)
            .where("mini_me_id", "=", miniMeId),
        );
        executeSqliteQuerySync(
          db,
          k
            .deleteFrom("mini_me_reservations")
            .where("owner_id", "=", ownerId)
            .where("mini_me_id", "=", miniMeId),
        );
        executeSqliteQuerySync(
          db,
          k
            .deleteFrom("mini_me_grants")
            .where("owner_id", "=", ownerId)
            .where("mini_me_id", "=", miniMeId),
        );
        executeSqliteQuerySync(
          db,
          k
            .deleteFrom("mini_me_attachments")
            .where("owner_id", "=", ownerId)
            .where("mini_me_id", "=", miniMeId),
        );
      }
      return result;
    }
    case "miniMe.setAttachment": {
      if (
        row.lifecycle !== "active" &&
        row.lifecycle !== "preparing" &&
        row.lifecycle !== "disabled"
      ) {
        throw new MiniMePersistenceError("lifecycle", "Mini Me lifecycle is closed");
      }
      const input = command.input;
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        k
          .selectFrom("mini_me_attachments")
          .selectAll()
          .where("owner_id", "=", ownerId)
          .where("mini_me_id", "=", miniMeId)
          .where("target_agent_id", "=", input.agentId),
      );
      if (
        (existing && existing.detached === 0 ? existing.revision : 0) !== input.expectedRevision
      ) {
        throw new MiniMePersistenceError(
          "conflict",
          "Attachment changed; inspect its current revision",
        );
      }
      const revision = (existing?.revision ?? 0) + 1;
      const budgetEpoch = existing && existing.detached === 0 ? existing.budget_epoch : revision;
      executeSqliteQuerySync(
        db,
        k
          .insertInto("mini_me_attachments")
          .values({
            owner_id: ownerId,
            mini_me_id: miniMeId,
            target_agent_id: input.agentId,
            mode: input.mode,
            revision,
            budget_epoch: budgetEpoch,
            detached: 0,
          })
          .onConflict((c) =>
            c.columns(["owner_id", "mini_me_id", "target_agent_id"]).doUpdateSet({
              mode: input.mode,
              revision,
              budget_epoch: budgetEpoch,
              detached: 0,
            }),
          ),
      );
      for (const grant of input.grants) {
        const usage =
          existing && existing.detached === 0
            ? executeSqliteQueryTakeFirstSync(
                db,
                k
                  .selectFrom("mini_me_grants")
                  .select(["reserved_count", "consumed_count", "charged_bytes", "budget_epoch"])
                  .where("owner_id", "=", ownerId)
                  .where("mini_me_id", "=", miniMeId)
                  .where("target_agent_id", "=", input.agentId)
                  .where("grant_id", "=", grant.id)
                  .where("budget_epoch", "=", budgetEpoch)
                  .orderBy("attachment_revision", "desc")
                  .limit(1),
              )
            : undefined;
        executeSqliteQuerySync(
          db,
          k.insertInto("mini_me_grants").values({
            owner_id: ownerId,
            mini_me_id: miniMeId,
            target_agent_id: input.agentId,
            attachment_revision: revision,
            budget_epoch: budgetEpoch,
            grant_id: grant.id,
            effect: grant.effect,
            resources_json: JSON.stringify(grant.resources),
            max_actions: grant.maxActions,
            max_bytes: grant.maxBytes ?? null,
            expires_at: grant.expiresAt,
            reserved_count: usage?.reserved_count ?? 0,
            consumed_count: usage?.consumed_count ?? 0,
            charged_bytes: usage?.charged_bytes ?? 0,
          }),
        );
      }
      updateProfile(db, row, { generation: row.generation + 1 });
      return (
        readAttachments(db, command.input.scope).find((a) => a.agentId === input.agentId) ?? null
      );
    }
    case "miniMe.detachAttachment": {
      const attachment = executeSqliteQueryTakeFirstSync(
        db,
        k
          .selectFrom("mini_me_attachments")
          .selectAll()
          .where("owner_id", "=", ownerId)
          .where("mini_me_id", "=", miniMeId)
          .where("target_agent_id", "=", command.input.agentId),
      );
      if (attachment) {
        executeSqliteQuerySync(
          db,
          k
            .updateTable("mini_me_attachments")
            .set({ revision: attachment.revision + 1, detached: 1 })
            .where("owner_id", "=", ownerId)
            .where("mini_me_id", "=", miniMeId)
            .where("target_agent_id", "=", command.input.agentId),
        );
      }
      updateProfile(db, row, { generation: row.generation + 1 });
      return null;
    }
    default:
      throw new Error("Unsupported Mini Me profile mutation");
  }
}
