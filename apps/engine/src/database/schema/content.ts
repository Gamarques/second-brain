import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  actorKindEnum,
  actorAttributionCheck,
  createdAtColumn,
  idColumn,
  instantColumn,
  mutationSourceEnum,
  projectStatusEnum,
  requiredInstantColumn,
  sha256Check,
  taskPriorityEnum,
  taskStatusEnum,
  tsvector,
  updatedAtColumn,
} from "./common.js";
import { accounts } from "./identity.js";

const actorColumns = () => ({
  actorKind: actorKindEnum("actor_kind").notNull(),
  actorAccountId: uuid("actor_account_id").references(() => accounts.id, {
    onDelete: "set null",
  }),
  actorClientId: text("actor_client_id"),
  actorSource: mutationSourceEnum("actor_source").notNull(),
});

export const projects = pgTable(
  "projects",
  {
    id: idColumn(),
    name: text("name").notNull(),
    description: text("description"),
    status: projectStatusEnum("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    ...actorColumns(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("projects_name_key").on(sql`lower(${table.name})`),
    index("projects_created_idx").on(table.createdAt, table.id),
    check(
      "projects_name_length_check",
      sql`length(btrim(${table.name})) between 1 and 300`,
    ),
    check("projects_version_check", sql`${table.version} > 0`),
    actorAttributionCheck("projects_actor_check", table),
  ],
);

export const people = pgTable(
  "people",
  {
    id: idColumn(),
    name: text("name").notNull(),
    aliases: text("aliases").array().notNull().default([]),
    notes: text("notes"),
    summary: text("summary"),
    tags: text("tags").array().notNull().default([]),
    version: integer("version").notNull().default(1),
    ...actorColumns(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("people_name_key").on(sql`lower(${table.name})`),
    index("people_created_idx").on(table.createdAt, table.id),
    index("people_tags_gin_idx").using("gin", table.tags),
    check(
      "people_name_length_check",
      sql`length(btrim(${table.name})) between 1 and 300`,
    ),
    check(
      "people_summary_length_check",
      sql`${table.summary} is null or length(btrim(${table.summary})) between 1 and 1000`,
    ),
    check("people_version_check", sql`${table.version} > 0`),
    actorAttributionCheck("people_actor_check", table),
  ],
);

export const personProjects = pgTable(
  "person_projects",
  {
    personId: uuid("person_id").notNull(),
    projectId: uuid("project_id").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    primaryKey({
      name: "person_projects_pkey",
      columns: [table.personId, table.projectId],
    }),
    foreignKey({
      name: "person_projects_person_fkey",
      columns: [table.personId],
      foreignColumns: [people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_projects_project_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    index("person_projects_project_idx").on(table.projectId, table.personId),
  ],
);

export const taskLists = pgTable(
  "task_lists",
  {
    id: idColumn(),
    name: text("name").notNull(),
    description: text("description"),
    ...actorColumns(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("task_lists_created_idx").on(table.createdAt, table.id),
    check(
      "task_lists_name_length_check",
      sql`length(btrim(${table.name})) between 1 and 300`,
    ),
    actorAttributionCheck("task_lists_actor_check", table),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: idColumn(),
    listId: uuid("list_id").notNull(),
    projectId: uuid("project_id"),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatusEnum("status").notNull().default("todo"),
    priority: taskPriorityEnum("priority").notNull().default("normal"),
    dueAt: instantColumn("due_at"),
    completedAt: instantColumn("completed_at"),
    historyVersion: integer("history_version").notNull().default(1),
    historyCompleteFrom: requiredInstantColumn("history_complete_from").defaultNow(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', "title" || ' ' || coalesce("description", ''))`,
    ),
    ...actorColumns(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: "tasks_list_fkey",
      columns: [table.listId],
      foreignColumns: [taskLists.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "tasks_project_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    index("tasks_list_status_idx").on(table.listId, table.status, table.id),
    index("tasks_due_idx").on(table.dueAt, table.id),
    index("tasks_project_idx").on(table.projectId, table.id),
    index("tasks_search_vector_idx").using("gin", table.searchVector),
    check(
      "tasks_title_length_check",
      sql`length(btrim(${table.title})) between 1 and 500`,
    ),
    check("tasks_history_version_check", sql`${table.historyVersion} > 0`),
    check(
      "tasks_completion_check",
      sql`(${table.status} = 'done' and ${table.completedAt} is not null) or (${table.status} <> 'done' and ${table.completedAt} is null)`,
    ),
    actorAttributionCheck("tasks_actor_check", table),
  ],
);

export const reminders = pgTable(
  "reminders",
  {
    id: idColumn(),
    message: text("message").notNull(),
    remindAt: requiredInstantColumn("remind_at"),
    completedAt: instantColumn("completed_at"),
    historyVersion: integer("history_version").notNull().default(1),
    historyCompleteFrom: requiredInstantColumn("history_complete_from").defaultNow(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', "message")`,
    ),
    ...actorColumns(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("reminders_due_idx").on(table.remindAt, table.id),
    index("reminders_search_vector_idx").using("gin", table.searchVector),
    check(
      "reminders_message_length_check",
      sql`length(btrim(${table.message})) between 1 and 2000`,
    ),
    check("reminders_history_version_check", sql`${table.historyVersion} > 0`),
    actorAttributionCheck("reminders_actor_check", table),
  ],
);

export const memories = pgTable(
  "memories",
  {
    id: idColumn(),
    lineageId: uuid("lineage_id").notNull(),
    versionNumber: integer("version_number").notNull().default(1),
    supersedesId: uuid("supersedes_id"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    category: text("category"),
    tags: text("tags").array().notNull().default([]),
    projectId: uuid("project_id"),
    sourceExcerpt: text("source_excerpt"),
    effectiveAt: requiredInstantColumn("effective_at").defaultNow(),
    capturedAt: instantColumn("captured_at"),
    ...actorColumns(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("memories_id_lineage_key").on(table.id, table.lineageId),
    unique("memories_lineage_version_key").on(
      table.lineageId,
      table.versionNumber,
    ),
    unique("memories_supersedes_key").on(table.supersedesId),
    foreignKey({
      name: "memories_supersedes_fkey",
      columns: [table.supersedesId, table.lineageId],
      foreignColumns: [table.id, table.lineageId],
    }).onDelete("restrict"),
    foreignKey({
      name: "memories_project_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    index("memories_effective_idx").on(table.effectiveAt, table.id),
    index("memories_category_idx").on(table.category, table.id),
    index("memories_tags_gin_idx").using("gin", table.tags),
    check(
      "memories_content_length_check",
      sql`length(btrim(${table.content})) between 1 and 10000`,
    ),
    check("memories_version_number_check", sql`${table.versionNumber} > 0`),
    check(
      "memories_lineage_check",
      sql`(${table.versionNumber} = 1 and ${table.supersedesId} is null and ${table.lineageId} = ${table.id}) or (${table.versionNumber} > 1 and ${table.supersedesId} is not null)`,
    ),
    sha256Check("memories_content_hash_check", table.contentHash),
    actorAttributionCheck("memories_actor_check", table),
  ],
);

export const memoryPeople = pgTable(
  "memory_people",
  {
    memoryId: uuid("memory_id").notNull(),
    personId: uuid("person_id").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    primaryKey({
      name: "memory_people_pkey",
      columns: [table.memoryId, table.personId],
    }),
    foreignKey({
      name: "memory_people_memory_fkey",
      columns: [table.memoryId],
      foreignColumns: [memories.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "memory_people_person_fkey",
      columns: [table.personId],
      foreignColumns: [people.id],
    }).onDelete("cascade"),
    index("memory_people_person_idx").on(table.personId, table.memoryId),
  ],
);

export const decisions = pgTable(
  "decisions",
  {
    id: idColumn(),
    lineageId: uuid("lineage_id").notNull(),
    versionNumber: integer("version_number").notNull().default(1),
    supersedesId: uuid("supersedes_id"),
    statement: text("statement").notNull(),
    rationale: text("rationale").notNull(),
    rejectedAlternatives: jsonb("rejected_alternatives")
      .$type<readonly { option: string; reason: string | null }[]>()
      .notNull()
      .default([]),
    projectId: uuid("project_id"),
    decidedAt: requiredInstantColumn("decided_at").defaultNow(),
    revokedAt: instantColumn("revoked_at"),
    contentHash: text("content_hash").notNull(),
    sourceExcerpt: text("source_excerpt"),
    ...actorColumns(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique("decisions_id_lineage_key").on(table.id, table.lineageId),
    unique("decisions_lineage_version_key").on(
      table.lineageId,
      table.versionNumber,
    ),
    unique("decisions_supersedes_key").on(table.supersedesId),
    foreignKey({
      name: "decisions_supersedes_fkey",
      columns: [table.supersedesId, table.lineageId],
      foreignColumns: [table.id, table.lineageId],
    }).onDelete("restrict"),
    foreignKey({
      name: "decisions_project_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    index("decisions_decided_idx").on(table.decidedAt, table.id),
    check(
      "decisions_statement_length_check",
      sql`length(btrim(${table.statement})) between 1 and 2000`,
    ),
    check(
      "decisions_rationale_length_check",
      sql`length(btrim(${table.rationale})) between 1 and 10000`,
    ),
    check(
      "decisions_rejected_alternatives_check",
      sql`jsonb_typeof(${table.rejectedAlternatives}) = 'array'`,
    ),
    check("decisions_version_number_check", sql`${table.versionNumber} > 0`),
    check(
      "decisions_lineage_check",
      sql`(${table.versionNumber} = 1 and ${table.supersedesId} is null and ${table.lineageId} = ${table.id}) or (${table.versionNumber} > 1 and ${table.supersedesId} is not null)`,
    ),
    sha256Check("decisions_content_hash_check", table.contentHash),
    actorAttributionCheck("decisions_actor_check", table),
  ],
);

export const decisionPeople = pgTable(
  "decision_people",
  {
    decisionId: uuid("decision_id").notNull(),
    personId: uuid("person_id").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    primaryKey({
      name: "decision_people_pkey",
      columns: [table.decisionId, table.personId],
    }),
    foreignKey({
      name: "decision_people_decision_fkey",
      columns: [table.decisionId],
      foreignColumns: [decisions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "decision_people_person_fkey",
      columns: [table.personId],
      foreignColumns: [people.id],
    }).onDelete("cascade"),
    index("decision_people_person_idx").on(table.personId, table.decisionId),
  ],
);

export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: idColumn(),
    name: text("name").notNull(),
    description: text("description"),
    ...actorColumns(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("knowledge_bases_created_idx").on(table.createdAt, table.id),
    check(
      "knowledge_bases_name_length_check",
      sql`length(btrim(${table.name})) between 1 and 200`,
    ),
    actorAttributionCheck("knowledge_bases_actor_check", table),
  ],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: idColumn(),
    knowledgeBaseId: uuid("knowledge_base_id").notNull(),
    title: text("title").notNull(),
    sourceUri: text("source_uri"),
    tags: text("tags").array().notNull().default([]),
    projectId: uuid("project_id"),
    currentRevisionNumber: integer("current_revision_number").notNull().default(1),
    ...actorColumns(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: "knowledge_documents_base_fkey",
      columns: [table.knowledgeBaseId],
      foreignColumns: [knowledgeBases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_documents_project_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    index("knowledge_documents_base_idx").on(
      table.knowledgeBaseId,
      table.createdAt,
      table.id,
    ),
    index("knowledge_documents_project_idx").on(table.projectId, table.id),
    index("knowledge_documents_tags_gin_idx").using("gin", table.tags),
    check(
      "knowledge_documents_title_length_check",
      sql`length(btrim(${table.title})) between 1 and 500`,
    ),
    actorAttributionCheck("knowledge_documents_actor_check", table),
    check(
      "knowledge_documents_current_revision_check",
      sql`${table.currentRevisionNumber} > 0`,
    ),
  ],
);

export const personKnowledgeBases = pgTable(
  "person_knowledge_bases",
  {
    personId: uuid("person_id").notNull(),
    knowledgeBaseId: uuid("knowledge_base_id").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    primaryKey({
      name: "person_knowledge_bases_pkey",
      columns: [table.personId, table.knowledgeBaseId],
    }),
    foreignKey({
      name: "person_knowledge_bases_person_fkey",
      columns: [table.personId],
      foreignColumns: [people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_knowledge_bases_base_fkey",
      columns: [table.knowledgeBaseId],
      foreignColumns: [knowledgeBases.id],
    }).onDelete("cascade"),
    index("person_knowledge_bases_base_idx").on(
      table.knowledgeBaseId,
      table.personId,
    ),
  ],
);

export const knowledgeDocumentPeople = pgTable(
  "knowledge_document_people",
  {
    documentId: uuid("document_id").notNull(),
    personId: uuid("person_id").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    primaryKey({
      name: "knowledge_document_people_pkey",
      columns: [table.documentId, table.personId],
    }),
    foreignKey({
      name: "knowledge_document_people_document_fkey",
      columns: [table.documentId],
      foreignColumns: [knowledgeDocuments.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_document_people_person_fkey",
      columns: [table.personId],
      foreignColumns: [people.id],
    }).onDelete("cascade"),
    index("knowledge_document_people_person_idx").on(
      table.personId,
      table.documentId,
    ),
  ],
);

export const knowledgeDocumentRevisions = pgTable(
  "knowledge_document_revisions",
  {
    id: idColumn(),
    documentId: uuid("document_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    contentHash: text("content_hash").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    ...actorColumns(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("knowledge_document_revisions_number_key").on(
      table.documentId,
      table.revisionNumber,
    ),
    foreignKey({
      name: "knowledge_document_revisions_document_fkey",
      columns: [table.documentId],
      foreignColumns: [knowledgeDocuments.id],
    }).onDelete("cascade"),
    check(
      "knowledge_document_revisions_number_check",
      sql`${table.revisionNumber} > 0`,
    ),
    check("knowledge_document_revisions_chunks_check", sql`${table.chunkCount} >= 0`),
    sha256Check(
      "knowledge_document_revisions_content_hash_check",
      table.contentHash,
    ),
    actorAttributionCheck("knowledge_document_revisions_actor_check", table),
  ],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: idColumn(),
    revisionId: uuid("revision_id").notNull(),
    position: integer("position").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple', "content")`,
    ),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("knowledge_chunks_revision_position_key").on(
      table.revisionId,
      table.position,
    ),
    foreignKey({
      name: "knowledge_chunks_revision_fkey",
      columns: [table.revisionId],
      foreignColumns: [knowledgeDocumentRevisions.id],
    }).onDelete("cascade"),
    index("knowledge_chunks_revision_idx").on(table.revisionId, table.position),
    index("knowledge_chunks_search_vector_idx").using("gin", table.searchVector),
    check("knowledge_chunks_position_check", sql`${table.position} >= 0`),
    check("knowledge_chunks_content_length_check", sql`length(${table.content}) > 0`),
    sha256Check("knowledge_chunks_content_hash_check", table.contentHash),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type PersonRow = typeof people.$inferSelect;
export type TaskListRow = typeof taskLists.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ReminderRow = typeof reminders.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type KnowledgeBaseRow = typeof knowledgeBases.$inferSelect;
export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;
export type KnowledgeChunkRow = typeof knowledgeChunks.$inferSelect;
