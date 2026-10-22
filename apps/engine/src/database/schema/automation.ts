import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  createdAtColumn,
  dreamingModeEnum,
  idColumn,
  instantColumn,
  updatedAtColumn,
} from "./common.js";
import { reminders } from "./content.js";

export const automationJobKindEnum = pgEnum("automation_job_kind", [
  "daily_dreaming",
  "reminder_delivery",
  "brain_pack_export",
  "brain_pack_import",
]);
export const automationJobStatusEnum = pgEnum("automation_job_status", [
  "pending",
  "running",
  "retry_wait",
  "completed",
  "failed",
  "canceled",
]);
export const notificationChannelKindEnum = pgEnum("notification_channel_kind", [
  "inbox",
  "email",
  "webhook",
  "slack",
  "telegram",
]);
export const reminderDeliveryStatusEnum = pgEnum("reminder_delivery_status", [
  "uncertain",
  "pending",
  "running",
  "delivered",
  "retry_wait",
  "failed",
  "canceled",
]);

/** One brain per deployment: settings live in a single constant-keyed row. */
export const automationSettings = pgTable(
  "automation_settings",
  {
    id: smallint("id").primaryKey().default(1),
    timeZone: text("time_zone").notNull(),
    dreamingEnabled: boolean("dreaming_enabled").notNull().default(false),
    dreamLocalTime: time("dream_local_time", { withTimezone: false }).notNull().default("03:00"),
    nextDreamAt: instantColumn("next_dream_at"),
    dreamingMode: dreamingModeEnum("dreaming_mode").notNull().default("preview"),
    dailyInputTokenLimit: integer("daily_input_token_limit").notNull().default(20000),
    dailyOutputTokenLimit: integer("daily_output_token_limit").notNull().default(2000),
    reminderDeliveryEnabled: boolean("reminder_delivery_enabled")
      .notNull()
      .default(false),
    revision: integer("revision").notNull().default(1),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check("automation_settings_singleton_check", sql`${table.id} = 1`),
    check("automation_settings_revision_check", sql`${table.revision} > 0`),
    check(
      "automation_settings_token_limits_check",
      sql`${table.dailyInputTokenLimit} > 0 and ${table.dailyOutputTokenLimit} > 0`,
    ),
  ],
);

export const automationJobs = pgTable(
  "automation_jobs",
  {
    id: idColumn(),
    kind: automationJobKindEnum("kind").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    scheduledFor: instantColumn("scheduled_for").notNull(),
    status: automationJobStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: instantColumn("next_attempt_at"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: instantColumn("lease_expires_at"),
    fencingToken: uuid("fencing_token"),
    cancelRequestedAt: instantColumn("cancel_requested_at"),
    sanitizedError: text("sanitized_error"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique("automation_jobs_id_kind_key").on(table.id, table.kind),
    unique("automation_jobs_canonical_key").on(
      table.kind,
      table.canonicalKey,
    ),
    index("automation_jobs_claim_idx").on(
      table.status,
      table.nextAttemptAt,
      table.scheduledFor,
      table.id,
    ),
    index("automation_jobs_status_idx").on(
      table.status,
      table.createdAt,
      table.id,
    ),
    check("automation_jobs_attempt_check", sql`${table.attemptCount} >= 0`),
    check(
      "automation_jobs_lease_check",
      sql`(${table.status} = 'running' and ${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null and ${table.fencingToken} is not null)
        or (${table.status} <> 'running' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null and ${table.fencingToken} is null)`,
    ),
    check(
      "automation_jobs_retry_check",
      sql`(${table.status} = 'retry_wait' and ${table.nextAttemptAt} is not null) or (${table.status} <> 'retry_wait')`,
    ),
  ],
);

export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: idColumn(),
    kind: notificationChannelKindEnum("kind").notNull(),
    name: text("name").notNull(),
    encryptedConfig: text("encrypted_config"),
    revision: integer("revision").notNull().default(1),
    configDigest: text("config_digest"),
    enabled: boolean("enabled").notNull().default(false),
    verifiedAt: instantColumn("verified_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("notification_channels_kind_idx").on(table.kind, table.id),
    check(
      "notification_channels_name_check",
      sql`length(btrim(${table.name})) between 1 and 200`,
    ),
    check(
      "notification_channels_config_check",
      sql`(${table.kind} = 'inbox' and ${table.encryptedConfig} is null) or (${table.kind} <> 'inbox' and nullif(${table.encryptedConfig}, '') is not null)`,
    ),
  ],
);

export const reminderDeliveries = pgTable(
  "reminder_deliveries",
  {
    id: idColumn(),
    reminderId: uuid("reminder_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    automationJobId: uuid("automation_job_id").notNull(),
    automationJobKind: automationJobKindEnum("automation_job_kind")
      .notNull()
      .default("reminder_delivery"),
    reminderVersion: integer("reminder_version").notNull().default(1),
    channelRevision: integer("channel_revision").notNull().default(1),
    errorCode: text("error_code"),
    messageSnapshot: text("message_snapshot").notNull(),
    remindAtSnapshot: instantColumn("remind_at_snapshot").notNull(),
    status: reminderDeliveryStatusEnum("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    providerMessageId: text("provider_message_id"),
    deliveredAt: instantColumn("delivered_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique("reminder_deliveries_idempotency_key").on(table.idempotencyKey),
    unique("reminder_deliveries_job_key").on(table.automationJobId),
    unique("reminder_deliveries_occurrence_key").on(
      table.reminderId,
      table.channelId,
      table.reminderVersion,
    ),
    foreignKey({
      name: "reminder_deliveries_reminder_fkey",
      columns: [table.reminderId],
      foreignColumns: [reminders.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "reminder_deliveries_channel_fkey",
      columns: [table.channelId],
      foreignColumns: [notificationChannels.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "reminder_deliveries_job_fkey",
      columns: [table.automationJobId, table.automationJobKind],
      foreignColumns: [automationJobs.id, automationJobs.kind],
    }).onDelete("cascade"),
    check(
      "reminder_deliveries_job_kind_check",
      sql`${table.automationJobKind} = 'reminder_delivery'`,
    ),
    index("reminder_deliveries_status_idx").on(
      table.status,
      table.createdAt,
      table.id,
    ),
    check(
      "reminder_deliveries_delivered_check",
      sql`(${table.status} = 'delivered' and ${table.deliveredAt} is not null) or (${table.status} <> 'delivered' and ${table.deliveredAt} is null)`,
    ),
  ],
);

export const automationWorkerHeartbeats = pgTable("automation_worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  version: text("version").notNull(),
  startedAt: instantColumn("started_at").notNull(),
  lastSeenAt: instantColumn("last_seen_at").notNull(),
});

export type AutomationSettingsRow = typeof automationSettings.$inferSelect;
export type AutomationJobRow = typeof automationJobs.$inferSelect;
