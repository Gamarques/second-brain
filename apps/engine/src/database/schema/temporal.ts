import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  activityTimeBasisEnum,
  actorAttributionCheck,
  actorKindEnum,
  createdAtColumn,
  goalStatusEnum,
  idColumn,
  instantColumn,
  linkBasisEnum,
  mutationSourceEnum,
  requiredInstantColumn,
  taskPriorityEnum,
  taskRelationKindEnum,
  taskStatusEnum,
  updatedAtColumn,
  versionOperationEnum,
  versionOriginEnum,
} from "./common.js";
import { projects, reminders, taskLists, tasks } from "./content.js";
import { accounts } from "./identity.js";

export const activityEventEntityTypeEnum = pgEnum("activity_event_entity_type", [
  "task_list",
  "task",
  "task_relation",
  "reminder",
  "memory",
  "decision",
  "project",
  "person",
  "goal",
  "priority_plan",
  "knowledge_document",
  "knowledge_base",
  "activity",
  "automation_settings",
]);
export const activityEventActionEnum = pgEnum("activity_event_action", [
  "created",
  "updated",
  "started",
  "completed",
  "reopened",
  "canceled",
  "deleted",
  "superseded",
  "revoked",
  "linked",
  "retracted",
]);
export const activityKindEnum = pgEnum("activity_kind", [
  "work_session",
  "progress_note",
  "meeting",
  "communication",
]);

export const activityEvents = pgTable(
  "activity_events",
  {
    id: idColumn(),
    entityType: activityEventEntityTypeEnum("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: activityEventActionEnum("action").notNull(),
    occurredAt: requiredInstantColumn("occurred_at"),
    effectiveAt: requiredInstantColumn("effective_at"),
    changedFields: text("changed_fields").array().notNull().default([]),
    afterVersionId: uuid("after_version_id"),
    contentHash: text("content_hash"),
    requestDigest: text("request_digest").notNull(),
    analysisAllowed: boolean("analysis_allowed").notNull().default(true),
    idempotencyKey: text("idempotency_key").notNull(),
    actorKind: actorKindEnum("actor_kind").notNull(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    actorClientId: text("actor_client_id"),
    actorSource: mutationSourceEnum("actor_source").notNull(),
    requestId: text("request_id").notNull(),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    dreamingRunId: uuid("dreaming_run_id"),
    recordedAt: requiredInstantColumn("recorded_at").defaultNow(),
    redactedAt: instantColumn("redacted_at"),
  },
  (table) => [
    unique("activity_events_idempotency_key").on(table.idempotencyKey),
    unique("activity_events_request_entity_action_key").on(
      table.requestId,
      table.entityType,
      table.entityId,
      table.action,
    ),
    index("activity_events_occurred_idx").on(table.occurredAt, table.id),
    index("activity_events_entity_idx").on(
      table.entityType,
      table.entityId,
      table.recordedAt,
    ),
    check(
      "activity_events_hash_check",
      sql`${table.contentHash} is null or ${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "activity_events_request_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "activity_events_provenance_length_check",
      sql`length(btrim(${table.requestId})) between 1 and 500
        and (${table.correlationId} is null or length(btrim(${table.correlationId})) between 1 and 500)
        and (${table.causationId} is null or length(btrim(${table.causationId})) between 1 and 500)`,
    ),
    check(
      "activity_events_actor_check",
      sql`(
        (${table.actorKind} = 'account' and ((${table.actorAccountId} is not null and ${table.actorClientId} is null) or (${table.actorAccountId} is null and ${table.actorClientId} is null)))
        or (${table.actorKind} = 'oauth_client' and ((${table.actorAccountId} is not null and nullif(btrim(${table.actorClientId}), '') is not null) or (${table.actorAccountId} is null and ${table.actorClientId} is null)))
        or (${table.actorKind} = 'import' and ((${table.actorAccountId} is not null and ${table.actorClientId} is null) or (${table.actorAccountId} is null and ${table.actorClientId} is null)))
        or (${table.actorKind} in ('dreaming', 'system') and ${table.actorAccountId} is null and ${table.actorClientId} is null)
      )`,
    ),
  ],
);

export const mutationReceipts = pgTable(
  "mutation_receipts",
  {
    id: idColumn(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultEntityType: text("result_entity_type"),
    resultEntityId: uuid("result_entity_id"),
    resultVersionId: uuid("result_version_id"),
    result: jsonb("result").notNull().default({}),
    activityEventId: uuid("activity_event_id"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("mutation_receipts_operation_key").on(
      table.operation,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "mutation_receipts_event_fkey",
      columns: [table.activityEventId],
      foreignColumns: [activityEvents.id],
    }).onDelete("restrict"),
    index("mutation_receipts_created_idx").on(table.createdAt, table.id),
    check(
      "mutation_receipts_operation_check",
      sql`length(btrim(${table.operation})) between 1 and 100`,
    ),
    check(
      "mutation_receipts_request_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const taskVersions = pgTable(
  "task_versions",
  {
    id: idColumn(),
    taskId: uuid("task_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    operation: versionOperationEnum("operation").notNull(),
    origin: versionOriginEnum("origin").notNull().default("native"),
    listId: uuid("list_id").notNull(),
    projectId: uuid("project_id"),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatusEnum("status").notNull(),
    priority: taskPriorityEnum("priority").notNull(),
    dueAt: instantColumn("due_at"),
    completedAt: instantColumn("completed_at"),
    effectiveAt: requiredInstantColumn("effective_at"),
    recordedAt: requiredInstantColumn("recorded_at").defaultNow(),
    changedFields: text("changed_fields").array().notNull().default([]),
    activityEventId: uuid("activity_event_id").notNull(),
  },
  (table) => [
    unique("task_versions_task_version_key").on(
      table.taskId,
      table.versionNumber,
    ),
    foreignKey({
      name: "task_versions_task_fkey",
      columns: [table.taskId],
      foreignColumns: [tasks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "task_versions_list_fkey",
      columns: [table.listId],
      foreignColumns: [taskLists.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_versions_project_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_versions_event_fkey",
      columns: [table.activityEventId],
      foreignColumns: [activityEvents.id],
    }).onDelete("restrict"),
    index("task_versions_task_effective_idx").on(
      table.taskId,
      table.effectiveAt,
      table.versionNumber,
    ),
    check("task_versions_number_check", sql`${table.versionNumber} > 0`),
    check(
      "task_versions_title_check",
      sql`length(btrim(${table.title})) between 1 and 500`,
    ),
  ],
);

export const reminderVersions = pgTable(
  "reminder_versions",
  {
    id: idColumn(),
    reminderId: uuid("reminder_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    operation: versionOperationEnum("operation").notNull(),
    origin: versionOriginEnum("origin").notNull().default("native"),
    message: text("message").notNull(),
    remindAt: requiredInstantColumn("remind_at"),
    completedAt: instantColumn("completed_at"),
    effectiveAt: requiredInstantColumn("effective_at"),
    recordedAt: requiredInstantColumn("recorded_at").defaultNow(),
    changedFields: text("changed_fields").array().notNull().default([]),
    activityEventId: uuid("activity_event_id").notNull(),
  },
  (table) => [
    unique("reminder_versions_reminder_version_key").on(
      table.reminderId,
      table.versionNumber,
    ),
    foreignKey({
      name: "reminder_versions_reminder_fkey",
      columns: [table.reminderId],
      foreignColumns: [reminders.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "reminder_versions_event_fkey",
      columns: [table.activityEventId],
      foreignColumns: [activityEvents.id],
    }).onDelete("restrict"),
    index("reminder_versions_reminder_effective_idx").on(
      table.reminderId,
      table.effectiveAt,
      table.versionNumber,
    ),
    check("reminder_versions_number_check", sql`${table.versionNumber} > 0`),
    check(
      "reminder_versions_message_check",
      sql`length(btrim(${table.message})) between 1 and 2000`,
    ),
  ],
);

export const goals = pgTable(
  "goals",
  {
    id: idColumn(),
    title: text("title").notNull(),
    description: text("description"),
    successCriteria: text("success_criteria"),
    status: goalStatusEnum("status").notNull().default("active"),
    targetAt: instantColumn("target_at"),
    projectId: uuid("project_id"),
    version: integer("version").notNull().default(1),
    historyCompleteFrom: requiredInstantColumn("history_complete_from").defaultNow(),
    actorKind: actorKindEnum("actor_kind").notNull(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    actorClientId: text("actor_client_id"),
    actorSource: mutationSourceEnum("actor_source").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: "goals_project_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    index("goals_status_idx").on(table.status, table.id),
    check("goals_title_check", sql`length(btrim(${table.title})) between 1 and 500`),
    check("goals_version_check", sql`${table.version} > 0`),
    actorAttributionCheck("goals_actor_check", table),
  ],
);

export const goalVersions = pgTable(
  "goal_versions",
  {
    id: idColumn(),
    goalId: uuid("goal_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    operation: versionOperationEnum("operation").notNull(),
    origin: versionOriginEnum("origin").notNull().default("native"),
    title: text("title").notNull(),
    description: text("description"),
    successCriteria: text("success_criteria"),
    status: goalStatusEnum("status").notNull(),
    targetAt: instantColumn("target_at"),
    projectId: uuid("project_id"),
    effectiveAt: requiredInstantColumn("effective_at"),
    recordedAt: requiredInstantColumn("recorded_at").defaultNow(),
    changedFields: text("changed_fields").array().notNull().default([]),
    activityEventId: uuid("activity_event_id").notNull(),
  },
  (table) => [
    unique("goal_versions_goal_version_key").on(
      table.goalId,
      table.versionNumber,
    ),
    foreignKey({
      name: "goal_versions_goal_fkey",
      columns: [table.goalId],
      foreignColumns: [goals.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "goal_versions_project_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "goal_versions_event_fkey",
      columns: [table.activityEventId],
      foreignColumns: [activityEvents.id],
    }).onDelete("restrict"),
    check("goal_versions_number_check", sql`${table.versionNumber} > 0`),
  ],
);

export const taskGoalLinks = pgTable(
  "task_goal_links",
  {
    taskId: uuid("task_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    basis: linkBasisEnum("basis").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3, mode: "number" }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    primaryKey({
      name: "task_goal_links_pkey",
      columns: [table.taskId, table.goalId],
    }),
    foreignKey({
      name: "task_goal_links_task_fkey",
      columns: [table.taskId],
      foreignColumns: [tasks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "task_goal_links_goal_fkey",
      columns: [table.goalId],
      foreignColumns: [goals.id],
    }).onDelete("cascade"),
    check(
      "task_goal_links_confidence_check",
      sql`(${table.basis} = 'explicit' and ${table.confidence} is null)
        or (${table.basis} <> 'explicit' and ${table.confidence} between 0 and 1)`,
    ),
  ],
);

export const taskVersionGoalLinks = pgTable(
  "task_version_goal_links",
  {
    taskVersionId: uuid("task_version_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    basis: linkBasisEnum("basis").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3, mode: "number" }),
  },
  (table) => [
    primaryKey({
      name: "task_version_goal_links_pkey",
      columns: [table.taskVersionId, table.goalId],
    }),
    foreignKey({
      name: "task_version_goal_links_version_fkey",
      columns: [table.taskVersionId],
      foreignColumns: [taskVersions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "task_version_goal_links_goal_fkey",
      columns: [table.goalId],
      foreignColumns: [goals.id],
    }).onDelete("restrict"),
    check(
      "task_version_goal_links_confidence_check",
      sql`(${table.basis} = 'explicit' and ${table.confidence} is null)
        or (${table.basis} <> 'explicit' and ${table.confidence} between 0 and 1)`,
    ),
  ],
);

export const taskRelations = pgTable(
  "task_relations",
  {
    id: idColumn(),
    fromTaskId: uuid("from_task_id").notNull(),
    toTaskId: uuid("to_task_id").notNull(),
    kind: taskRelationKindEnum("kind").notNull(),
    actorKind: actorKindEnum("actor_kind").notNull(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    actorClientId: text("actor_client_id"),
    actorSource: mutationSourceEnum("actor_source").notNull(),
    createdAt: createdAtColumn(),
    retractedAt: instantColumn("retracted_at"),
  },
  (table) => [
    uniqueIndex("task_relations_active_key")
      .on(table.fromTaskId, table.toTaskId, table.kind)
      .where(sql`${table.retractedAt} is null`),
    foreignKey({
      name: "task_relations_from_fkey",
      columns: [table.fromTaskId],
      foreignColumns: [tasks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "task_relations_to_fkey",
      columns: [table.toTaskId],
      foreignColumns: [tasks.id],
    }).onDelete("cascade"),
    check("task_relations_distinct_check", sql`${table.fromTaskId} <> ${table.toTaskId}`),
    actorAttributionCheck("task_relations_actor_check", table),
  ],
);

export const activities = pgTable(
  "activities",
  {
    id: idColumn(),
    kind: activityKindEnum("kind").notNull(),
    occurredAt: requiredInstantColumn("occurred_at"),
    endedAt: instantColumn("ended_at"),
    timeBasis: activityTimeBasisEnum("time_basis").notNull(),
    taskId: uuid("task_id"),
    projectId: uuid("project_id"),
    summary: text("summary"),
    analysisAllowed: boolean("analysis_allowed").notNull().default(true),
    idempotencyKey: text("idempotency_key").notNull(),
    actorKind: actorKindEnum("actor_kind").notNull(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    actorClientId: text("actor_client_id"),
    actorSource: mutationSourceEnum("actor_source").notNull(),
    recordedAt: requiredInstantColumn("recorded_at").defaultNow(),
    retractedAt: instantColumn("retracted_at"),
    retractionReason: text("retraction_reason"),
  },
  (table) => [
    unique("activities_idempotency_key").on(table.idempotencyKey),
    foreignKey({
      name: "activities_task_fkey",
      columns: [table.taskId],
      foreignColumns: [tasks.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "activities_project_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    index("activities_occurred_idx").on(table.occurredAt, table.id),
    check(
      "activities_time_basis_check",
      sql`(${table.timeBasis} = 'instant' and ${table.endedAt} is null) or (${table.timeBasis} = 'explicit_interval' and ${table.endedAt} > ${table.occurredAt})`,
    ),
    check(
      "activities_retraction_check",
      sql`(${table.retractedAt} is null and ${table.retractionReason} is null) or (${table.retractedAt} is not null and nullif(btrim(${table.retractionReason}), '') is not null)`,
    ),
    actorAttributionCheck("activities_actor_check", table),
  ],
);

export const activityGoalAllocations = pgTable(
  "activity_goal_allocations",
  {
    activityId: uuid("activity_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    allocationPercent: numeric("allocation_percent", {
      precision: 5,
      scale: 2,
      mode: "number",
    }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "activity_goal_allocations_pkey",
      columns: [table.activityId, table.goalId],
    }),
    foreignKey({
      name: "activity_goal_allocations_activity_fkey",
      columns: [table.activityId],
      foreignColumns: [activities.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "activity_goal_allocations_goal_fkey",
      columns: [table.goalId],
      foreignColumns: [goals.id],
    }).onDelete("restrict"),
    check(
      "activity_goal_allocations_percent_check",
      sql`${table.allocationPercent} > 0 and ${table.allocationPercent} <= 100`,
    ),
  ],
);

export const priorityPlans = pgTable(
  "priority_plans",
  {
    id: idColumn(),
    projectId: uuid("project_id"),
    periodStart: requiredInstantColumn("period_start"),
    periodEnd: requiredInstantColumn("period_end"),
    version: integer("version").notNull().default(1),
    currentVersionId: uuid("current_version_id").notNull(),
    actorKind: actorKindEnum("actor_kind").notNull(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    actorClientId: text("actor_client_id"),
    actorSource: mutationSourceEnum("actor_source").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: "priority_plans_project_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    index("priority_plans_period_idx").on(
      table.periodStart,
      table.periodEnd,
      table.id,
    ),
    check("priority_plans_period_check", sql`${table.periodEnd} > ${table.periodStart}`),
    check("priority_plans_version_check", sql`${table.version} > 0`),
    actorAttributionCheck("priority_plans_actor_check", table),
  ],
);

export const priorityPlanVersions = pgTable(
  "priority_plan_versions",
  {
    id: idColumn(),
    priorityPlanId: uuid("priority_plan_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    projectId: uuid("project_id"),
    periodStart: requiredInstantColumn("period_start"),
    periodEnd: requiredInstantColumn("period_end"),
    note: text("note"),
    effectiveAt: requiredInstantColumn("effective_at"),
    recordedAt: requiredInstantColumn("recorded_at").defaultNow(),
    actorKind: actorKindEnum("actor_kind").notNull(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    actorClientId: text("actor_client_id"),
    actorSource: mutationSourceEnum("actor_source").notNull(),
    activityEventId: uuid("activity_event_id").notNull(),
  },
  (table) => [
    unique("priority_plan_versions_plan_id_key").on(
      table.priorityPlanId,
      table.id,
    ),
    unique("priority_plan_versions_plan_version_key").on(
      table.priorityPlanId,
      table.versionNumber,
    ),
    foreignKey({
      name: "priority_plan_versions_plan_fkey",
      columns: [table.priorityPlanId],
      foreignColumns: [priorityPlans.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "priority_plan_versions_project_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "priority_plan_versions_event_fkey",
      columns: [table.activityEventId],
      foreignColumns: [activityEvents.id],
    }).onDelete("restrict"),
    check("priority_plan_versions_number_check", sql`${table.versionNumber} > 0`),
    check(
      "priority_plan_versions_period_check",
      sql`${table.periodEnd} > ${table.periodStart}`,
    ),
    actorAttributionCheck("priority_plan_versions_actor_check", table),
  ],
);

export const priorityPlanVersionItems = pgTable(
  "priority_plan_version_items",
  {
    priorityPlanVersionId: uuid("priority_plan_version_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    rank: integer("rank").notNull(),
    intendedSharePercent: numeric("intended_share_percent", {
      precision: 5,
      scale: 2,
      mode: "number",
    }),
  },
  (table) => [
    primaryKey({
      name: "priority_plan_version_items_pkey",
      columns: [table.priorityPlanVersionId, table.goalId],
    }),
    unique("priority_plan_version_items_rank_key").on(
      table.priorityPlanVersionId,
      table.rank,
    ),
    foreignKey({
      name: "priority_plan_version_items_version_fkey",
      columns: [table.priorityPlanVersionId],
      foreignColumns: [priorityPlanVersions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "priority_plan_version_items_goal_fkey",
      columns: [table.goalId],
      foreignColumns: [goals.id],
    }).onDelete("restrict"),
    check("priority_plan_version_items_rank_check", sql`${table.rank} > 0`),
    check(
      "priority_plan_version_items_share_check",
      sql`${table.intendedSharePercent} is null or (${table.intendedSharePercent} > 0 and ${table.intendedSharePercent} <= 100)`,
    ),
  ],
);

export type ActivityEventRow = typeof activityEvents.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;
export type TaskVersionRow = typeof taskVersions.$inferSelect;
export type ReminderVersionRow = typeof reminderVersions.$inferSelect;
export type GoalRow = typeof goals.$inferSelect;
export type GoalVersionRow = typeof goalVersions.$inferSelect;
export type PriorityPlanRow = typeof priorityPlans.$inferSelect;
export type PriorityPlanVersionRow = typeof priorityPlanVersions.$inferSelect;
