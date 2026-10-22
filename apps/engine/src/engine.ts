// Keep this import first and on its own: importing the loader applies the
// environment file before the conventional composition root reads it.
import "./env.js";

import { createEngine } from "@invokta/core";

import { createActivityCapabilities } from "./capabilities/activities.js";
import { createBrainAskCapabilities } from "./capabilities/brain-ask.js";
import { createBrainPackCapabilities } from "./capabilities/brain-pack.js";
import { createBrainSearchCapabilities } from "./capabilities/brain-search.js";
import { createIngestionCapabilities } from "./capabilities/ingestion.js";
import { createContextCapabilities } from "./capabilities/context.js";
import { createDecisionCapabilities } from "./capabilities/decisions.js";
import { createDreamingReportCapabilities } from "./capabilities/dreaming-report.js";
import { createGoalCapabilities } from "./capabilities/goals.js";
import { createKnowledgeCapabilities } from "./capabilities/knowledge.js";
import { createMemoryCapabilities } from "./capabilities/memories.js";
import { createPeopleCapabilities } from "./capabilities/people.js";
import { createPriorityCapabilities } from "./capabilities/priorities.js";
import { createProjectCapabilities } from "./capabilities/projects.js";
import { createReminderCapabilities } from "./capabilities/reminders.js";
import { createTaskCapabilities } from "./capabilities/tasks.js";
import { createDatabase, createDatabasePool } from "./database/client.js";
import type {
  AnswerProvider,
  AutomationStore,
  EmbeddingProvider,
  IngestionProvider,
  SecondBrainDependencies,
} from "./domain.js";
import { SECOND_BRAIN_VERSION } from "./version.js";
import { createDrizzleEngineDependencies } from "./engine-dependencies.js";
import type { EnvironmentRecord } from "./env.js";
import { createModelProvider } from "./runtime-config.js";

/** The one model object serving every provider-shaped engine dependency. */
export type SecondBrainModelProvider = EmbeddingProvider &
  AnswerProvider &
  IngestionProvider;

export type SecondBrainEngineDependencies = Pick<
  SecondBrainDependencies,
  | "access"
  | "projects"
  | "people"
  | "tasks"
  | "reminders"
  | "memories"
  | "decisions"
  | "knowledge"
  | "search"
  | "evidence"
  | "embeddingSpaces"
  | "goals"
  | "priorities"
  | "activities"
  | "ingestion"
  | "ingestionCommitter"
  | "dreaming"
  | "contexts"
  | "embeddings"
  | "answers"
  | "ingestionProvider"
  | "brainPacks"
  | "brainPackArtifacts"
  | "brainPackCodec"
> & {
  /** Cancelling a Brain Pack run stops its job; the server passes its full automation store here. */
  readonly automation: Pick<AutomationStore, "requestCancel">;
};

/**
 * Pure engine composition. Database connections, model clients, workers, and
 * their lifecycle belong to the runtime composition root in runtime.ts.
 */
export function createSecondBrainEngine(
  dependencies: SecondBrainEngineDependencies,
) {
  const tasks = createTaskCapabilities(dependencies.access, dependencies.tasks);
  const memories = createMemoryCapabilities(
    dependencies.access,
    dependencies.memories,
    dependencies.embeddingSpaces,
    dependencies.embeddings,
  );
  const reminders = createReminderCapabilities(
    dependencies.access,
    dependencies.reminders,
  );
  const knowledge = createKnowledgeCapabilities(
    dependencies.access,
    dependencies.knowledge,
    dependencies.embeddingSpaces,
    dependencies.embeddings,
    dependencies.answers,
  );
  const projects = createProjectCapabilities(
    dependencies.access,
    dependencies.projects,
  );
  const people = createPeopleCapabilities(dependencies.access, dependencies.people);
  const decisions = createDecisionCapabilities(
    dependencies.access,
    dependencies.decisions,
    dependencies.embeddingSpaces,
    dependencies.embeddings,
  );
  const brainAsk = createBrainAskCapabilities(
    dependencies.access,
    dependencies.evidence,
    dependencies.embeddingSpaces,
    dependencies.embeddings,
    dependencies.answers,
  );
  const brainSearch = createBrainSearchCapabilities(
    dependencies.access,
    dependencies.search,
    dependencies.embeddingSpaces,
    dependencies.embeddings,
  );
  const ingestion = createIngestionCapabilities(
    dependencies.access,
    dependencies.ingestion,
    dependencies.ingestionCommitter,
    dependencies.ingestionProvider,
  );
  const goals = createGoalCapabilities(dependencies.access, dependencies.goals);
  const priorities = createPriorityCapabilities(
    dependencies.access,
    dependencies.priorities,
  );
  const activities = createActivityCapabilities(
    dependencies.access,
    dependencies.activities,
  );
  const context = createContextCapabilities(
    dependencies.access,
    dependencies.contexts,
  );
  const dreamingReport = createDreamingReportCapabilities(
    dependencies.access,
    dependencies.dreaming,
  );
  const brainPacks = createBrainPackCapabilities({
    access: dependencies.access,
    packs: dependencies.brainPacks,
    artifacts: dependencies.brainPackArtifacts,
    codec: dependencies.brainPackCodec,
    automation: dependencies.automation,
  });

  return createEngine({
    name: "second-brain",
    version: SECOND_BRAIN_VERSION,
    capabilities: {
      task_lists_create: tasks.task_lists_create,
      task_lists_list: tasks.task_lists_list,
      tasks_create: tasks.tasks_create,
      tasks_list: tasks.tasks_list,
      tasks_update: tasks.tasks_update,
      tasks_delete: tasks.tasks_delete,
      tasks_history_list: tasks.tasks_history_list,
      task_relations_create: tasks.task_relations_create,
      memories_create: memories.memories_create,
      memories_update: memories.memories_update,
      memories_search: memories.memories_search,
      memories_list: memories.memories_list,
      memories_delete: memories.memories_delete,
      reminders_create: reminders.reminders_create,
      reminders_list: reminders.reminders_list,
      reminders_update: reminders.reminders_update,
      reminders_delete: reminders.reminders_delete,
      reminders_history_list: reminders.reminders_history_list,
      knowledge_bases_create: knowledge.knowledge_bases_create,
      knowledge_bases_list: knowledge.knowledge_bases_list,
      knowledge_documents_list: knowledge.knowledge_documents_list,
      knowledge_documents_get: knowledge.knowledge_documents_get,
      knowledge_document_revisions_create:
        knowledge.knowledge_document_revisions_create,
      knowledge_document_revisions_list:
        knowledge.knowledge_document_revisions_list,
      knowledge_ask: knowledge.knowledge_ask,
      knowledge_packs_export: brainPacks.knowledge_packs_export,
      knowledge_packs_export_get: brainPacks.knowledge_packs_export_get,
      knowledge_packs_import: brainPacks.knowledge_packs_import,
      knowledge_packs_import_get: brainPacks.knowledge_packs_import_get,
      knowledge_packs_import_review: brainPacks.knowledge_packs_import_review,
      knowledge_packs_import_publish: brainPacks.knowledge_packs_import_publish,
      knowledge_packs_runs_list: brainPacks.knowledge_packs_runs_list,
      knowledge_packs_runs_cancel: brainPacks.knowledge_packs_runs_cancel,
      knowledge_packs_runs_retry: brainPacks.knowledge_packs_runs_retry,
      projects_create: projects.projects_create,
      projects_list: projects.projects_list,
      projects_update: projects.projects_update,
      people_create: people.people_create,
      people_list: people.people_list,
      people_update: people.people_update,
      decisions_create: decisions.decisions_create,
      decisions_list: decisions.decisions_list,
      decisions_revoke: decisions.decisions_revoke,
      goals_create: goals.goals_create,
      goals_update: goals.goals_update,
      goals_list: goals.goals_list,
      goals_history: goals.goals_history,
      priorities_create: priorities.priorities_create,
      priorities_update: priorities.priorities_update,
      priorities_list: priorities.priorities_list,
      activities_record: activities.activities_record,
      activities_list: activities.activities_list,
      activities_retract: activities.activities_retract,
      activities_summary: activities.activities_summary,
      brain_ask: brainAsk.brain_ask,
      brain_search: brainSearch.brain_search,
      ingestion_propose: ingestion.ingestion_propose,
      ingestion_review: ingestion.ingestion_review,
      ingestion_commit: ingestion.ingestion_commit,
      ingestion_status: ingestion.ingestion_status,
      context_get: context.context_get,
      handoffs_create: context.handoffs_create,
      handoffs_list: context.handoffs_list,
      dreaming_report_get: dreamingReport.dreaming_report_get,
    },
  });
}

/** Real environment composition used by Invokta devtools and direct loading. */
export function createDefaultSecondBrainEngine(
  environment: EnvironmentRecord = process.env,
) {
  const models = createModelProvider(environment);
  const database = createDatabase(createDatabasePool(environment));
  return createSecondBrainEngine(
    createDrizzleEngineDependencies(database, models.provider),
  );
}

/** The conventional composition-root export required by Invokta tooling. */
export const engine = createDefaultSecondBrainEngine();
