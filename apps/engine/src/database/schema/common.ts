import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { check, customType, pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";

export const accountStatusEnum = pgEnum("account_status", [
  "active",
  "disabled",
  "deleting",
]);
export const membershipRoleEnum = pgEnum("membership_role", [
  "viewer",
  "editor",
  "admin",
  "owner",
]);
export const actorKindEnum = pgEnum("actor_kind", [
  "account",
  "oauth_client",
  "import",
  "dreaming",
  "system",
]);
export const mutationSourceEnum = pgEnum("mutation_source", [
  "direct",
  "mcp_http",
  "automation",
  "import",
]);
export const taskStatusEnum = pgEnum("task_status", [
  "todo",
  "in_progress",
  "done",
  "canceled",
]);
export const taskPriorityEnum = pgEnum("task_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);
export const projectStatusEnum = pgEnum("project_status", [
  "active",
  "paused",
  "completed",
  "archived",
]);
export const goalStatusEnum = pgEnum("goal_status", [
  "active",
  "paused",
  "achieved",
  "abandoned",
]);
export const versionOperationEnum = pgEnum("version_operation", [
  "created",
  "updated",
  "started",
  "completed",
  "reopened",
  "canceled",
]);
export const versionOriginEnum = pgEnum("version_origin", ["native", "import"]);
export const linkBasisEnum = pgEnum("link_basis", [
  "explicit",
  "reviewed_inference",
  "model_inference",
]);
export const taskRelationKindEnum = pgEnum("task_relation_kind", [
  "blocks",
  "depends_on",
  "duplicate_of",
]);
export const activityTimeBasisEnum = pgEnum("activity_time_basis", [
  "instant",
  "explicit_interval",
]);
export const embeddingEntityTypeEnum = pgEnum("embedding_entity_type", [
  "memory",
  "decision",
  "knowledge_chunk",
  "insight",
]);
export const embeddingMetricEnum = pgEnum("embedding_metric", ["cosine"]);
export const embeddingSpaceStatusEnum = pgEnum("embedding_space_status", [
  "preparing",
  "active",
  "retired",
  "failed",
]);
export const dreamingModeEnum = pgEnum("dreaming_mode", ["preview", "apply"]);

export const idColumn = () => uuid("id").defaultRandom().primaryKey();
export const instantColumn = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });
export const requiredInstantColumn = (name: string) => instantColumn(name).notNull();
export const createdAtColumn = () => requiredInstantColumn("created_at").defaultNow();
export const updatedAtColumn = () => requiredInstantColumn("updated_at").defaultNow();

export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/** Raw bytes, for archives that must survive every service being read-only. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export function actorAttributionCheck(
  name: string,
  table: {
    actorKind: AnyPgColumn;
    actorAccountId: AnyPgColumn;
    actorClientId: AnyPgColumn;
  },
) {
  return check(
    name,
    sql`(
      (${table.actorKind} = 'account' and ((${table.actorAccountId} is not null and ${table.actorClientId} is null) or (${table.actorAccountId} is null and ${table.actorClientId} is null)))
      or (${table.actorKind} = 'oauth_client' and ((${table.actorAccountId} is not null and nullif(btrim(${table.actorClientId}), '') is not null) or (${table.actorAccountId} is null and ${table.actorClientId} is null)))
      or (${table.actorKind} = 'import' and ((${table.actorAccountId} is not null and ${table.actorClientId} is null) or (${table.actorAccountId} is null and ${table.actorClientId} is null)))
      or (${table.actorKind} in ('dreaming', 'system') and ${table.actorAccountId} is null and ${table.actorClientId} is null)
    )`,
  );
}

export function sha256Check(name: string, column: AnyPgColumn) {
  return check(name, sql`${column} ~ '^[0-9a-f]{64}$'`);
}

export function provenanceLengthCheck(
  name: string,
  table: {
    requestId: AnyPgColumn;
    correlationId: AnyPgColumn;
    causationId: AnyPgColumn;
  },
) {
  return check(
    name,
    sql`length(btrim(${table.requestId})) between 1 and 500
      and (${table.correlationId} is null or length(btrim(${table.correlationId})) between 1 and 500)
      and (${table.causationId} is null or length(btrim(${table.causationId})) between 1 and 500)`,
  );
}
