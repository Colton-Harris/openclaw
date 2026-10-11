import type { DatabaseSync } from "node:sqlite";
import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";

export const MINI_ME_STATE_TABLES = [
  "mini_me_profiles",
  "mini_me_attachments",
  "mini_me_grants",
  "mini_me_reservations",
  "mini_me_state_operations",
  "mini_me_data_changes",
  "mini_me_root_operations",
] as const;
export const MINI_ME_AGENT_TABLES = [
  "mini_me_content",
  "mini_me_sources",
  "mini_me_beliefs",
  "mini_me_documents",
  "mini_me_suppressions",
  "mini_me_predictions",
  "mini_me_outcomes",
  "mini_me_content_operations",
  "mini_me_learning_keys",
  "mini_me_action_restores",
] as const;
function miniMeSchema(sql: string): string {
  const marker = sql.indexOf("CREATE TABLE IF NOT EXISTS mini_me_");
  if (marker < 0) {
    throw new Error("Mini Me canonical schema block is missing");
  }
  const endMarker = "-- END MINI ME FEATURE SCHEMA";
  const end = sql.indexOf(endMarker, marker);
  if (end < 0) {
    throw new Error("Mini Me canonical schema end marker is missing");
  }
  return sql.slice(marker, end + endMarker.length);
}
export function withoutMiniMeAgentSchema(sql: string): string {
  return sql.replace(miniMeSchema(sql), "");
}
const ensureState = createSqliteSchemaEnsurer(() => miniMeSchema(OPENCLAW_STATE_SCHEMA_SQL));
const ensureAgent = createSqliteSchemaEnsurer(() => miniMeSchema(OPENCLAW_AGENT_SCHEMA_SQL));
export function ensureMiniMeStateSchema(database: DatabaseSync): void {
  ensureState.ensure(database);
}
export function ensureMiniMeAgentSchema(database: DatabaseSync): void {
  ensureAgent.ensure(database);
}
