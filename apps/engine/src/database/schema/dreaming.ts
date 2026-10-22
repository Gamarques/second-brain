import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  createdAtColumn,
  dreamingModeEnum,
  idColumn,
  instantColumn,
  requiredInstantColumn,
  updatedAtColumn,
} from "./common.js";
import { automationJobKindEnum, automationJobs } from "./automation.js";
import { memories } from "./content.js";
import { activityEvents } from "./temporal.js";

export const dreamingRunStatusEnum = pgEnum("dreaming_run_status", [
  "pending",
  "collecting",
  "analyzing",
  "verifying",
  "applying",
  "completed",
  "completed_with_skips",
  "retryable_failed",
  "failed",
  "canceled",
]);
export const dreamingEvidenceRoleEnum = pgEnum("dreaming_evidence_role", [
  "primary",
  "comparison",
  "memory_target",
]);
export const dreamingEvidenceTypeEnum = pgEnum("dreaming_evidence_type", [
  "memory",
  "decision",
  "task",
  "reminder",
  "goal",
  "priority_plan",
  "activity",
  "activity_summary",
]);
export const dreamingChangeOperationEnum = pgEnum("dreaming_change_operation", [
  "create",
  "update",
]);
export const dreamingChangeStatusEnum = pgEnum("dreaming_change_status", [
  "proposed",
  "eligible",
  "applied",
  "skipped",
  "failed",
]);

export const dreamingRuns = pgTable(
  "dreaming_runs",
  {
    id: idColumn(),
    automationJobId: uuid("automation_job_id").notNull(),
    automationJobKind: automationJobKindEnum("automation_job_kind")
      .notNull()
      .default("daily_dreaming"),
    replayOfRunId: uuid("replay_of_run_id"),
    canonical: boolean("canonical").notNull().default(true),
    localDate: date("local_date", { mode: "string" }).notNull(),
    timeZone: text("time_zone").notNull(),
    windowStart: requiredInstantColumn("window_start"),
    windowEnd: requiredInstantColumn("window_end"),
    mode: dreamingModeEnum("mode").notNull(),
    status: dreamingRunStatusEnum("status").notNull().default("pending"),
    settingsRevision: integer("settings_revision").notNull(),
    pipelineVersion: text("pipeline_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    snapshotHash: text("snapshot_hash"),
    snapshotTruncated: boolean("snapshot_truncated").notNull().default(false),
    coverageWarnings: text("coverage_warnings").array().notNull().default([]),
    planSummary: text("plan_summary"),
    planInsights: jsonb("plan_insights"),
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    sanitizedError: text("sanitized_error"),
    createdAt: createdAtColumn(),
    startedAt: instantColumn("started_at"),
    completedAt: instantColumn("completed_at"),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique("dreaming_runs_job_key").on(table.automationJobId),
    unique("dreaming_runs_id_replay_key").on(table.id, table.replayOfRunId),
    uniqueIndex("dreaming_runs_canonical_date_key")
      .on(table.localDate)
      .where(sql`${table.canonical}`),
    foreignKey({
      name: "dreaming_runs_job_fkey",
      columns: [table.automationJobId, table.automationJobKind],
      foreignColumns: [automationJobs.id, automationJobs.kind],
    }).onDelete("cascade"),
    foreignKey({
      name: "dreaming_runs_replay_fkey",
      columns: [table.replayOfRunId],
      foreignColumns: [table.id],
    }).onDelete("restrict"),
    index("dreaming_runs_status_idx").on(
      table.status,
      table.localDate,
      table.id,
    ),
    check("dreaming_runs_window_check", sql`${table.windowEnd} > ${table.windowStart}`),
    check("dreaming_runs_job_kind_check", sql`${table.automationJobKind} = 'daily_dreaming'`),
    check(
      "dreaming_runs_replay_check",
      sql`${table.replayOfRunId} is null or (${table.replayOfRunId} <> ${table.id} and not ${table.canonical})`,
    ),
    check("dreaming_runs_settings_revision_check", sql`${table.settingsRevision} > 0`),
    check(
      "dreaming_runs_snapshot_hash_check",
      sql`${table.snapshotHash} is null or ${table.snapshotHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "dreaming_runs_usage_check",
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.attemptCount} >= 0`,
    ),
    check(
      "dreaming_runs_plan_check",
      sql`(${table.planSummary} is null and ${table.planInsights} is null)
        or (length(${table.planSummary}) between 1 and 2000 and jsonb_typeof(${table.planInsights}) = 'array')`,
    ),
  ],
);

export const dreamingEvidence = pgTable(
  "dreaming_evidence",
  {
    id: idColumn(),
    runId: uuid("run_id").notNull(),
    evidenceIndex: integer("evidence_index").notNull(),
    role: dreamingEvidenceRoleEnum("role").notNull(),
    type: dreamingEvidenceTypeEnum("type").notNull(),
    entityId: uuid("entity_id").notNull(),
    versionId: uuid("version_id"),
    observedAt: requiredInstantColumn("observed_at"),
    effectiveAt: requiredInstantColumn("effective_at"),
    excerpt: text("excerpt").notNull(),
    contentHash: text("content_hash").notNull(),
    redactedAt: instantColumn("redacted_at"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("dreaming_evidence_run_id_key").on(table.runId, table.id),
    unique("dreaming_evidence_run_index_key").on(
      table.runId,
      table.evidenceIndex,
    ),
    foreignKey({
      name: "dreaming_evidence_run_fkey",
      columns: [table.runId],
      foreignColumns: [dreamingRuns.id],
    }).onDelete("cascade"),
    check("dreaming_evidence_index_check", sql`${table.evidenceIndex} >= 0`),
    check(
      "dreaming_evidence_excerpt_check",
      sql`length(${table.excerpt}) between 1 and 2000`,
    ),
    check(
      "dreaming_evidence_content_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const dreamingChanges = pgTable(
  "dreaming_changes",
  {
    id: idColumn(),
    runId: uuid("run_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    operation: dreamingChangeOperationEnum("operation").notNull(),
    proposal: jsonb("proposal").notNull(),
    fingerprint: text("fingerprint").notNull(),
    expectedTargetMemoryId: uuid("expected_target_memory_id"),
    expectedTargetHash: text("expected_target_hash"),
    expectedTargetVersion: integer("expected_target_version"),
    verification: jsonb("verification"),
    status: dreamingChangeStatusEnum("status").notNull().default("proposed"),
    resultMemoryId: uuid("result_memory_id"),
    previousMemoryId: uuid("previous_memory_id"),
    skipReason: text("skip_reason"),
    activityEventId: uuid("activity_event_id"),
    appliedAt: instantColumn("applied_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique("dreaming_changes_run_id_key").on(table.runId, table.id),
    unique("dreaming_changes_run_ordinal_key").on(
      table.runId,
      table.ordinal,
    ),
    unique("dreaming_changes_fingerprint_key").on(table.fingerprint),
    foreignKey({
      name: "dreaming_changes_run_fkey",
      columns: [table.runId],
      foreignColumns: [dreamingRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "dreaming_changes_target_memory_fkey",
      columns: [table.expectedTargetMemoryId],
      foreignColumns: [memories.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "dreaming_changes_result_memory_fkey",
      columns: [table.resultMemoryId],
      foreignColumns: [memories.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "dreaming_changes_previous_memory_fkey",
      columns: [table.previousMemoryId],
      foreignColumns: [memories.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "dreaming_changes_event_fkey",
      columns: [table.activityEventId],
      foreignColumns: [activityEvents.id],
    }).onDelete("restrict"),
    check("dreaming_changes_ordinal_check", sql`${table.ordinal} >= 0`),
    check(
      "dreaming_changes_fingerprint_check",
      sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "dreaming_changes_target_check",
      sql`(${table.operation} = 'create' and ${table.expectedTargetMemoryId} is null and ${table.expectedTargetHash} is null and ${table.expectedTargetVersion} is null)
        or (${table.operation} = 'update' and ${table.expectedTargetMemoryId} is not null and ${table.expectedTargetHash} ~ '^[0-9a-f]{64}$' and ${table.expectedTargetVersion} > 0)`,
    ),
    check(
      "dreaming_changes_applied_check",
      sql`(${table.status} = 'applied' and ${table.resultMemoryId} is not null and ${table.appliedAt} is not null and ${table.activityEventId} is not null and ${table.skipReason} is null
            and ((${table.operation} = 'create' and ${table.previousMemoryId} is null) or (${table.operation} = 'update' and ${table.previousMemoryId} = ${table.expectedTargetMemoryId})))
        or (${table.status} = 'skipped' and ${table.resultMemoryId} is null and ${table.appliedAt} is null and ${table.activityEventId} is null and nullif(btrim(${table.skipReason}), '') is not null)
        or (${table.status} not in ('applied', 'skipped') and ${table.resultMemoryId} is null and ${table.appliedAt} is null and ${table.activityEventId} is null and ${table.skipReason} is null)`,
    ),
  ],
);

export const dreamingChangeEvidence = pgTable(
  "dreaming_change_evidence",
  {
    changeId: uuid("change_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    runId: uuid("run_id").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("dreaming_change_evidence_key").on(
      table.changeId,
      table.evidenceId,
    ),
    foreignKey({
      name: "dreaming_change_evidence_change_fkey",
      columns: [table.runId, table.changeId],
      foreignColumns: [dreamingChanges.runId, dreamingChanges.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "dreaming_change_evidence_evidence_fkey",
      columns: [table.runId, table.evidenceId],
      foreignColumns: [dreamingEvidence.runId, dreamingEvidence.id],
    }).onDelete("cascade"),
  ],
);

export const dreamingReports = pgTable(
  "dreaming_reports",
  {
    id: idColumn(),
    runId: uuid("run_id").notNull(),
    localDate: date("local_date", { mode: "string" }).notNull(),
    mode: dreamingModeEnum("mode").notNull(),
    status: dreamingRunStatusEnum("status").notNull(),
    summary: text("summary").notNull(),
    insights: jsonb("insights").notNull().default([]),
    memoriesCreated: jsonb("memories_created").notNull().default([]),
    memoriesUpdated: jsonb("memories_updated").notNull().default([]),
    skipped: jsonb("skipped").notNull().default([]),
    coverageWarnings: text("coverage_warnings").array().notNull().default([]),
    generatedAt: requiredInstantColumn("generated_at").defaultNow(),
  },
  (table) => [
    unique("dreaming_reports_run_key").on(table.runId),
    foreignKey({
      name: "dreaming_reports_run_fkey",
      columns: [table.runId],
      foreignColumns: [dreamingRuns.id],
    }).onDelete("cascade"),
    index("dreaming_reports_date_idx").on(
      table.localDate,
      table.generatedAt,
      table.id,
    ),
    check(
      "dreaming_reports_status_check",
      sql`${table.status} in ('completed', 'completed_with_skips')`,
    ),
    check(
      "dreaming_reports_summary_check",
      sql`length(${table.summary}) between 1 and 2000`,
    ),
    check(
      "dreaming_reports_json_check",
      sql`jsonb_typeof(${table.insights}) = 'array'
        and jsonb_typeof(${table.memoriesCreated}) = 'array'
        and jsonb_typeof(${table.memoriesUpdated}) = 'array'
        and jsonb_typeof(${table.skipped}) = 'array'`,
    ),
    check(
      "dreaming_reports_bounds_check",
      sql`jsonb_array_length(${table.insights}) <= 10
        and jsonb_array_length(${table.memoriesCreated}) + jsonb_array_length(${table.memoriesUpdated}) <= 20
        and jsonb_array_length(${table.skipped}) <= 20`,
    ),
  ],
);

export type DreamingRunRow = typeof dreamingRuns.$inferSelect;
export type DreamingEvidenceRow = typeof dreamingEvidence.$inferSelect;
export type DreamingChangeRow = typeof dreamingChanges.$inferSelect;
export type DreamingReportRow = typeof dreamingReports.$inferSelect;
