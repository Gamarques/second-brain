import type {
  SecondBrainEngineDependencies,
  SecondBrainModelProvider,
} from "./engine.js";

import type { SecondBrainDatabase } from "./database/client.js";
import { DrizzleBrainAccessStore } from "./database/stores/access-store.js";
import { DrizzleActivityStore } from "./database/stores/activity-store.js";
import { DrizzleAutomationJobControl } from "./database/stores/automation-job-control.js";
import { DrizzleBrainPackArtifactStore } from "./database/stores/brain-pack-artifact-store.js";
import { DrizzleBrainPackStore } from "./database/stores/brain-pack-store.js";
import { DrizzleContextStore } from "./database/stores/context-store.js";
import { DrizzleDecisionStore } from "./database/stores/decision-store.js";
import { DrizzleDreamingStore } from "./database/stores/dreaming-store.js";
import { DrizzleEmbeddingSpaceStore } from "./database/stores/embedding-space-store.js";
import { DrizzleBrainEvidenceStore } from "./database/stores/evidence-store.js";
import { DrizzleGoalStore } from "./database/stores/goal-store.js";
import {
  DrizzleIngestionStore,
  DrizzleReviewedIngestionCommitter,
} from "./database/stores/ingestion-store.js";
import { DrizzleKnowledgeStore } from "./database/stores/knowledge-store.js";
import { DrizzleMemoryStore } from "./database/stores/memory-store.js";
import { DrizzlePersonStore } from "./database/stores/person-store.js";
import { DrizzlePriorityPlanStore } from "./database/stores/priority-store.js";
import { DrizzleProjectStore } from "./database/stores/project-store.js";
import { DrizzleReminderStore } from "./database/stores/reminder-store.js";
import { DrizzleBrainSearchStore } from "./database/stores/search-store.js";
import { DrizzleTaskStore } from "./database/stores/task-store.js";
import { brainPackCodec } from "./domain/brain-pack-codec.js";

/**
 * Engine-owned infrastructure adapters over the application database. The
 * server may hand in its automation store so run cancellation and the worker
 * share one implementation; on its own the engine uses a job control that
 * only knows how to ask a job to stop.
 */
export function createDrizzleEngineDependencies(
  database: SecondBrainDatabase,
  models: SecondBrainModelProvider,
  options: { readonly automation?: SecondBrainEngineDependencies["automation"] } = {},
): SecondBrainEngineDependencies {
  const embeddingSpaces = new DrizzleEmbeddingSpaceStore(database);

  return {
    access: new DrizzleBrainAccessStore(database),
    projects: new DrizzleProjectStore(database),
    people: new DrizzlePersonStore(database),
    tasks: new DrizzleTaskStore(database),
    reminders: new DrizzleReminderStore(database),
    memories: new DrizzleMemoryStore(database),
    decisions: new DrizzleDecisionStore(database),
    knowledge: new DrizzleKnowledgeStore(database),
    search: new DrizzleBrainSearchStore(database),
    evidence: new DrizzleBrainEvidenceStore(database),
    embeddingSpaces,
    goals: new DrizzleGoalStore(database),
    priorities: new DrizzlePriorityPlanStore(database),
    activities: new DrizzleActivityStore(database),
    ingestion: new DrizzleIngestionStore(database),
    ingestionCommitter: new DrizzleReviewedIngestionCommitter(
      database,
      embeddingSpaces,
      models,
    ),
    dreaming: new DrizzleDreamingStore(database),
    contexts: new DrizzleContextStore(database),
    embeddings: models,
    answers: models,
    ingestionProvider: models,
    brainPacks: new DrizzleBrainPackStore(database),
    brainPackArtifacts: new DrizzleBrainPackArtifactStore(database),
    brainPackCodec,
    automation: options.automation ?? new DrizzleAutomationJobControl(database),
  };
}
