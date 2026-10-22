import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  createdAtColumn,
  idColumn,
  membershipRoleEnum,
  sha256Check,
  updatedAtColumn,
} from "./common.js";
import { accounts } from "./identity.js";

export const adminAuditCategoryEnum = pgEnum("admin_audit_category", [
  "domain",
  "administration",
  "authentication",
  "automation",
]);

export const adminAuditOutcomeEnum = pgEnum("admin_audit_outcome", [
  "succeeded",
  "denied",
  "failed",
]);

/** Stable pseudonym that can be unlinked without rewriting immutable events. */
export const adminAuditActorAliases = pgTable(
  "admin_audit_actor_aliases",
  {
    id: idColumn(),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("admin_audit_actor_aliases_account_key").on(table.accountId),
  ],
);

/**
 * One deployment owns one encrypted environment configuration snapshot. An
 * absent row represents revision zero and an empty configuration.
 */
export const environmentConfiguration = pgTable(
  "environment_configuration",
  {
    id: smallint("id").primaryKey().default(1),
    revision: integer("revision").notNull(),
    entries: jsonb("entries")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    restartRequired: boolean("restart_required").notNull().default(false),
    restartRequestedRevision: integer("restart_requested_revision")
      .notNull()
      .default(0),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check("environment_configuration_singleton_check", sql`${table.id} = 1`),
    check("environment_configuration_revision_check", sql`${table.revision} > 0`),
    check(
      "environment_configuration_restart_revision_check",
      sql`${table.restartRequestedRevision} >= 0 and ${table.restartRequestedRevision} <= ${table.revision}`,
    ),
    check(
      "environment_configuration_entries_check",
      sql`jsonb_typeof(${table.entries}) = 'object'`,
    ),
  ],
);

/** Immutable owner requests that ask supervised runtimes to reload a revision. */
export const environmentConfigurationRestartRequests = pgTable(
  "environment_configuration_restart_requests",
  {
    id: idColumn(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    configurationRevision: integer("configuration_revision").notNull(),
    actorAliasId: uuid("actor_alias_id")
      .notNull()
      .references(() => adminAuditActorAliases.id, { onDelete: "restrict" }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("environment_configuration_restart_requests_idempotency_key").on(
      table.idempotencyKey,
    ),
    index("environment_configuration_restart_requests_created_id_idx").on(
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check(
      "environment_configuration_restart_requests_idempotency_key_check",
      sql`length(btrim(${table.idempotencyKey})) between 1 and 200`,
    ),
    sha256Check(
      "environment_configuration_restart_requests_request_digest_check",
      table.requestDigest,
    ),
    check(
      "environment_configuration_restart_requests_revision_check",
      sql`${table.configurationRevision} > 0`,
    ),
  ],
);

/** Immutable receipts contain names and digests, never configuration values. */
export const environmentConfigurationChanges = pgTable(
  "environment_configuration_changes",
  {
    id: idColumn(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    resultRevision: integer("result_revision").notNull(),
    changedNames: text("changed_names").array().notNull(),
    restartRequired: boolean("restart_required").notNull(),
    actorAliasId: uuid("actor_alias_id")
      .notNull()
      .references(() => adminAuditActorAliases.id, { onDelete: "restrict" }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("environment_configuration_changes_idempotency_key").on(
      table.idempotencyKey,
    ),
    index("environment_configuration_changes_created_id_idx").on(
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check(
      "environment_configuration_changes_idempotency_key_check",
      sql`length(btrim(${table.idempotencyKey})) between 1 and 200`,
    ),
    sha256Check(
      "environment_configuration_changes_request_digest_check",
      table.requestDigest,
    ),
    check(
      "environment_configuration_changes_revisions_check",
      sql`${table.expectedRevision} >= 0 and ${table.resultRevision} = ${table.expectedRevision} + 1`,
    ),
    check(
      "environment_configuration_changes_names_check",
      sql`cardinality(${table.changedNames}) between 1 and 100`,
    ),
  ],
);

/**
 * Security-sensitive history. Application code only exposes INSERT and SELECT;
 * the migration layer additionally prevents UPDATE and DELETE at the database
 * boundary.
 */
export const adminAuditEvents = pgTable(
  "admin_audit_events",
  {
    id: idColumn(),
    category: adminAuditCategoryEnum("category").notNull(),
    action: text("action").notNull(),
    outcome: adminAuditOutcomeEnum("outcome").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    actorAliasId: uuid("actor_alias_id").references(
      () => adminAuditActorAliases.id,
      { onDelete: "restrict" },
    ),
    actorRole: membershipRoleEnum("actor_role"),
    requestId: text("request_id").notNull(),
    errorCode: text("error_code"),
    metadata: jsonb("metadata")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull()
      .default({}),
    changedNames: text("changed_names").array().notNull().default([]),
    occurredAt: createdAtColumn(),
  },
  (table) => [
    index("admin_audit_events_occurred_id_idx").on(
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    index("admin_audit_events_category_occurred_idx").on(
      table.category,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    index("admin_audit_events_action_occurred_idx").on(
      table.action,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    index("admin_audit_events_outcome_occurred_idx").on(
      table.outcome,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    index("admin_audit_events_actor_occurred_idx").on(
      table.actorAliasId,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    index("admin_audit_events_target_occurred_idx").on(
      table.targetType,
      table.targetId,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    check(
      "admin_audit_events_action_check",
      sql`length(btrim(${table.action})) between 1 and 200`,
    ),
    check(
      "admin_audit_events_target_check",
      sql`(${table.targetType} is null and ${table.targetId} is null)
        or (length(btrim(${table.targetType})) between 1 and 200
          and (${table.targetId} is null or length(btrim(${table.targetId})) between 1 and 500))`,
    ),
    check(
      "admin_audit_events_request_id_check",
      sql`length(btrim(${table.requestId})) between 1 and 500`,
    ),
    check(
      "admin_audit_events_error_code_check",
      sql`${table.errorCode} is null or length(btrim(${table.errorCode})) between 1 and 200`,
    ),
    check(
      "admin_audit_events_metadata_check",
      sql`jsonb_typeof(${table.metadata}) = 'object' and pg_column_size(${table.metadata}) <= 16384`,
    ),
    check(
      "admin_audit_events_changed_names_check",
      sql`cardinality(${table.changedNames}) between 0 and 100`,
    ),
    check(
      "admin_audit_events_configuration_metadata_check",
      sql`(${table.targetType} = 'environment_configuration'
          and ${table.changedNames} <> '{}'::text[]
          and ${table.metadata} = jsonb_build_object('changedNames', to_jsonb(${table.changedNames})))
        or (${table.targetType} is distinct from 'environment_configuration'
          and ${table.changedNames} = '{}'::text[])`,
    ),
  ],
);
