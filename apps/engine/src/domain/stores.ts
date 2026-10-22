import type {
  BrainAccessContext,
  BrainAccessRequest,
  BrainRole,
  ContentEmbedding,
  CursorPosition,
  EmbeddingProvider,
  EmbeddingEntityType,
  EmbeddingSpace,
  Page,
  TemporalPage,
  VersionPrecondition,
} from "./core.js";
import type {
  ClaimedAutomationJob,
  AutomationJob,
  AutomationJobKind,
  AutomationSettings,
  AutomationWorkerHeartbeat,
} from "./automation.js";
import type { BrainPackArtifactStore } from "./brain-pack-artifacts.js";
import type { BrainPackCodec } from "./brain-pack-codec.js";
import type { BrainPackOriginAttribution, BrainPackStore } from "./brain-pack-store.js";
import type { ContextStore } from "./context.js";
import type {
  ClaimedDreamingRun,
  DreamingChange,
  DreamingPlan,
  DreamingReport,
  DreamingReportSelector,
  DreamingRun,
  DreamingSkipReason,
  DreamingSettings,
  DreamingSnapshot,
  PersistedDreamingRunState,
} from "./dreaming.js";
import type {
  Decision,
  DecisionStatus,
  DecisionWriteInput,
  EvidenceSearchResult,
  KnowledgeBase,
  KnowledgeChunkMatch,
  KnowledgeDocument,
  KnowledgeDocumentRevision,
  Memory,
  MemoryListResult,
  MemoryMatch,
  MemoryWriteResult,
  Person,
  Project,
  ProjectStatus,
  Reminder,
  Task,
  TaskList,
  TaskPriority,
  TaskGoalLink,
  TaskRelation,
  TaskRelationKind,
  TaskStatus,
} from "./entities.js";
import type { BrainSearchResult } from "./search.js";
import type {
  IngestProposal,
  IngestReceipt,
  IngestReview,
  IngestReviewItem,
  IngestRun,
  IngestSource,
  ReviewedIngestionCommitter,
} from "./ingestion.js";
import type {
  Activity,
  ActivityGoalAllocation,
  ActivityKind,
  ActivitySummary,
  Goal,
  GoalStatus,
  GoalVersion,
  PriorityPlan,
  PriorityPlanItem,
  ReminderVersion,
  TaskVersion,
} from "./temporal.js";
import type { AnswerProvider, MemoryWriteInput } from "./entities.js";
import type { DreamingProvider, DreamingRunner, DreamingVerificationProvider } from "./dreaming.js";
import type { IngestionProvider } from "./ingestion.js";

export interface BrainAccessStore {
  resolveAccess(request: BrainAccessRequest, signal: AbortSignal): Promise<BrainAccessContext>;
  revalidateAccess(
    access: BrainAccessContext,
    requiredRole: BrainRole,
    signal: AbortSignal,
  ): Promise<BrainAccessContext>;
  getTimeZone(access: BrainAccessContext, signal: AbortSignal): Promise<string>;
}

export interface ProjectStore {
  createProject(
    access: BrainAccessContext,
    input: {
      readonly name: string;
      readonly description: string | null;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<Project>;
  listProjects(
    access: BrainAccessContext,
    input: { readonly status: ProjectStatus | null; readonly cursor: CursorPosition | null; readonly limit: number },
    signal: AbortSignal,
  ): Promise<Page<Project>>;
  updateProject(
    access: BrainAccessContext,
    id: string,
    changes: {
      readonly name?: string | undefined;
      readonly description?: string | null | undefined;
      readonly status?: ProjectStatus | undefined;
      readonly precondition: VersionPrecondition;
    },
    signal: AbortSignal,
  ): Promise<Project | null>;
  findProjectByName(
    access: BrainAccessContext,
    name: string,
    signal: AbortSignal,
  ): Promise<Project | null>;
}

export interface PersonStore {
  createPerson(
    access: BrainAccessContext,
    input: {
      readonly name: string;
      readonly aliases: readonly string[];
      readonly notes: string | null;
      readonly summary: string | null;
      readonly tags: readonly string[];
      readonly projectIds: readonly string[];
      readonly knowledgeBaseIds: readonly string[];
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<Person>;
  listPeople(
    access: BrainAccessContext,
    input: { readonly query: string | null; readonly cursor: CursorPosition | null; readonly limit: number },
    signal: AbortSignal,
  ): Promise<Page<Person>>;
  updatePerson(
    access: BrainAccessContext,
    id: string,
    changes: {
      readonly name?: string | undefined;
      readonly aliases?: readonly string[] | undefined;
      readonly notes?: string | null | undefined;
      readonly summary?: string | null | undefined;
      readonly tags?: readonly string[] | undefined;
      readonly projectIds?: readonly string[] | undefined;
      readonly knowledgeBaseIds?: readonly string[] | undefined;
      readonly precondition: VersionPrecondition;
    },
    signal: AbortSignal,
  ): Promise<Person | null>;
  findPersonByName(
    access: BrainAccessContext,
    name: string,
    signal: AbortSignal,
  ): Promise<Person | null>;
}

export interface TaskStore {
  createTaskList(
    access: BrainAccessContext,
    input: {
      readonly name: string;
      readonly description: string | null;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<TaskList>;
  listTaskLists(access: BrainAccessContext, signal: AbortSignal): Promise<readonly TaskList[]>;
  createTask(
    access: BrainAccessContext,
    input: {
      readonly listId: string;
      readonly title: string;
      readonly description: string | null;
      readonly priority: TaskPriority;
      readonly dueAt: string | null;
      readonly projectId: string | null;
      readonly goalLinks: readonly TaskGoalLink[];
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<Task | null>;
  listTasks(
    access: BrainAccessContext,
    input: {
      readonly listId: string | null;
      readonly status: TaskStatus | null;
      readonly projectId: string | null;
      readonly goalId: string | null;
      readonly asOf: string | null;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<TemporalPage<Task>>;
  updateTask(
    access: BrainAccessContext,
    id: string,
    changes: {
      readonly title?: string | undefined;
      readonly description?: string | null | undefined;
      readonly status?: TaskStatus | undefined;
      readonly priority?: TaskPriority | undefined;
      readonly dueAt?: string | null | undefined;
      readonly projectId?: string | null | undefined;
      readonly goalLinks?: readonly TaskGoalLink[] | undefined;
      readonly precondition: VersionPrecondition;
    },
    signal: AbortSignal,
  ): Promise<Task | null>;
  deleteTask(
    access: BrainAccessContext,
    id: string,
    input: { readonly idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<boolean>;
  listTaskHistory(
    access: BrainAccessContext,
    input: {
      readonly taskId: string;
      readonly from: string | null;
      readonly to: string | null;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<TemporalPage<TaskVersion>>;
  createTaskRelation(
    access: BrainAccessContext,
    input: {
      readonly fromTaskId: string;
      readonly toTaskId: string;
      readonly kind: TaskRelationKind;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<TaskRelation | null>;
}

export interface ReminderStore {
  createReminder(
    access: BrainAccessContext,
    input: {
      readonly message: string;
      readonly remindAt: string;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<Reminder>;
  listReminders(
    access: BrainAccessContext,
    input: {
      readonly includeCompleted: boolean;
      readonly asOf: string | null;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<TemporalPage<Reminder>>;
  updateReminder(
    access: BrainAccessContext,
    id: string,
    changes: {
      readonly message?: string | undefined;
      readonly remindAt?: string | undefined;
      readonly completed?: boolean | undefined;
      readonly precondition: VersionPrecondition;
    },
    signal: AbortSignal,
  ): Promise<Reminder | null>;
  deleteReminder(
    access: BrainAccessContext,
    id: string,
    input: { readonly idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<boolean>;
  listReminderHistory(
    access: BrainAccessContext,
    input: {
      readonly reminderId: string;
      readonly from: string | null;
      readonly to: string | null;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<TemporalPage<ReminderVersion>>;
}

export interface MemoryStore {
  writeMemoryVersion(
    access: BrainAccessContext,
    input: MemoryWriteInput,
    signal: AbortSignal,
  ): Promise<MemoryWriteResult | null>;
  getMemory(access: BrainAccessContext, id: string, signal: AbortSignal): Promise<Memory | null>;
  searchMemories(
    access: BrainAccessContext,
    input: {
      readonly embedding: ContentEmbedding;
      readonly limit: number;
      readonly minimumScore: number;
      readonly category: string | null;
      readonly tags: readonly string[];
      readonly projectId: string | null;
      readonly personId: string | null;
      readonly createdAfter: string | null;
      readonly createdBefore: string | null;
      readonly asOf: string | null;
      readonly includeSuperseded: boolean;
    },
    signal: AbortSignal,
  ): Promise<readonly MemoryMatch[]>;
  listMemories(
    access: BrainAccessContext,
    input: {
      readonly category: string | null;
      readonly tags: readonly string[];
      readonly projectId: string | null;
      readonly personId: string | null;
      readonly createdAfter: string | null;
      readonly createdBefore: string | null;
      readonly asOf: string | null;
      readonly includeSuperseded: boolean;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<MemoryListResult>;
  deleteMemory(
    access: BrainAccessContext,
    id: string,
    input: { readonly idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<boolean>;
}

export interface DecisionStore {
  createDecision(
    access: BrainAccessContext,
    input: DecisionWriteInput,
    signal: AbortSignal,
  ): Promise<Decision | null>;
  listDecisions(
    access: BrainAccessContext,
    input: {
      readonly status: DecisionStatus | null;
      readonly projectId: string | null;
      readonly personId: string | null;
      readonly asOf: string | null;
      readonly includeSuperseded: boolean;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<Page<Decision>>;
  revokeDecision(
    access: BrainAccessContext,
    id: string,
    precondition: VersionPrecondition,
    signal: AbortSignal,
  ): Promise<Decision | null>;
}

/**
 * One revision's text as a reader gets it: the exact stored text when the
 * revision kept it, otherwise a reconstruction from its chunks, plus where
 * the revision came from when a Brain Pack published it.
 */
export interface KnowledgeRevisionContent {
  readonly document: KnowledgeDocument;
  readonly revision: KnowledgeDocumentRevision;
  readonly content: string;
  readonly representation: "canonical" | "reconstructed";
  readonly origin: BrainPackOriginAttribution | null;
}

export interface KnowledgeStore {
  createKnowledgeBase(
    access: BrainAccessContext,
    input: {
      readonly name: string;
      readonly description: string | null;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<KnowledgeBase>;
  listKnowledgeBases(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<readonly KnowledgeBase[]>;
  createDocumentRevision(
    access: BrainAccessContext,
    input: {
      readonly knowledgeBaseId: string;
      readonly documentId: string | null;
      readonly expectedRevision: number | null;
      readonly title: string;
      readonly sourceUri: string | null;
      readonly contentHash: string;
      readonly chunks: readonly {
        readonly content: string;
        readonly position: number;
        readonly embedding: ContentEmbedding;
      }[];
      readonly tags: readonly string[];
      readonly projectId: string | null;
      readonly personIds: readonly string[];
      readonly idempotencyKey: string;
      /** The exact text, kept beside the chunks so exports and reads need no reconstruction. */
      readonly content?: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly document: KnowledgeDocument;
    readonly revision: KnowledgeDocumentRevision;
  } | null>;
  listDocuments(
    access: BrainAccessContext,
    input: {
      readonly knowledgeBaseId: string | null;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<Page<KnowledgeDocument>>;
  getDocument(
    access: BrainAccessContext,
    input: {
      readonly documentId: string;
      readonly revision: number | null;
    },
    signal: AbortSignal,
  ): Promise<KnowledgeRevisionContent | null>;
  listDocumentRevisions(
    access: BrainAccessContext,
    input: {
      readonly documentId: string;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<Page<Omit<KnowledgeRevisionContent, "document">>>;
  searchKnowledge(
    access: BrainAccessContext,
    input: {
      readonly knowledgeBaseId: string | null;
      readonly embedding: ContentEmbedding;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<readonly KnowledgeChunkMatch[] | null>;
}

export interface BrainSearchStore {
  search(
    access: BrainAccessContext,
    input: {
      readonly query: string;
      readonly intent: BrainSearchResult["routing"]["intent"];
      readonly subject: string;
      readonly embeddings: {
        readonly memories: ContentEmbedding | null;
        readonly knowledge: ContentEmbedding | null;
      };
      readonly projectId: string | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<BrainSearchResult>;
}

export interface BrainEvidenceStore {
  searchEvidence(
    access: BrainAccessContext,
    input: {
      readonly embeddings: {
        readonly memories: ContentEmbedding | null;
        readonly decisions: ContentEmbedding | null;
      };
      readonly query: string;
      readonly asOf: string | null;
      readonly projectId: string | null;
      readonly limits: {
        readonly memories: number;
        readonly decisions: number;
        readonly tasks: number;
        readonly reminders: number;
        readonly goals: number;
        readonly priorities: number;
        readonly activities: number;
      };
    },
    signal: AbortSignal,
  ): Promise<EvidenceSearchResult>;
}

export interface EmbeddingSpaceStore {
  getActiveSpace(
    access: BrainAccessContext,
    entityType: EmbeddingEntityType,
    signal: AbortSignal,
  ): Promise<EmbeddingSpace | null>;
  createSpace(
    access: BrainAccessContext,
    input: Omit<
      EmbeddingSpace,
      "id" | "status" | "createdAt" | "promotedAt" | "retiredAt"
    >,
    signal: AbortSignal,
  ): Promise<EmbeddingSpace>;
  promoteSpace(
    access: BrainAccessContext,
    id: string,
    input: { readonly expectedStatus: "preparing"; readonly idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<EmbeddingSpace | null>;
}

export interface GoalStore {
  createGoal(
    access: BrainAccessContext,
    input: {
      readonly title: string;
      readonly description: string | null;
      readonly successCriteria: string | null;
      readonly targetAt: string | null;
      readonly projectId: string | null;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<Goal | null>;
  updateGoal(
    access: BrainAccessContext,
    id: string,
    changes: {
      readonly title?: string | undefined;
      readonly description?: string | null | undefined;
      readonly successCriteria?: string | null | undefined;
      readonly status?: GoalStatus | undefined;
      readonly targetAt?: string | null | undefined;
      readonly projectId?: string | null | undefined;
      readonly precondition: VersionPrecondition;
    },
    signal: AbortSignal,
  ): Promise<Goal | null>;
  listGoals(
    access: BrainAccessContext,
    input: {
      readonly status: GoalStatus | null;
      readonly projectId: string | null;
      readonly asOf: string | null;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<TemporalPage<Goal>>;
  listGoalHistory(
    access: BrainAccessContext,
    input: { readonly goalId: string; readonly cursor: CursorPosition | null; readonly limit: number },
    signal: AbortSignal,
  ): Promise<TemporalPage<GoalVersion>>;
}

export interface PriorityPlanStore {
  createPriorityPlan(
    access: BrainAccessContext,
    input: {
      readonly projectId: string | null;
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly items: readonly PriorityPlanItem[];
      readonly note: string | null;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<PriorityPlan | null>;
  updatePriorityPlan(
    access: BrainAccessContext,
    id: string,
    changes: {
      readonly periodStart?: string | undefined;
      readonly periodEnd?: string | undefined;
      readonly items?: readonly PriorityPlanItem[] | undefined;
      readonly note?: string | null | undefined;
      readonly precondition: VersionPrecondition;
    },
    signal: AbortSignal,
  ): Promise<PriorityPlan | null>;
  listPriorityPlans(
    access: BrainAccessContext,
    input: {
      readonly projectId: string | null;
      readonly activeAt: string | null;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<TemporalPage<PriorityPlan>>;
}

export interface ActivityStore {
  recordActivity(
    access: BrainAccessContext,
    input: {
      readonly kind: ActivityKind;
      readonly occurredAt: string;
      readonly endedAt: string | null;
      readonly taskId: string | null;
      readonly projectId: string | null;
      readonly summary: string | null;
      readonly analysisAllowed: boolean;
      readonly allocations: readonly ActivityGoalAllocation[];
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly activity: Activity; readonly created: boolean } | null>;
  retractActivity(
    access: BrainAccessContext,
    id: string,
    input: { readonly reason: string; readonly idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<Activity | null>;
  listActivities(
    access: BrainAccessContext,
    input: {
      readonly from: string;
      readonly to: string;
      readonly kinds: readonly ActivityKind[];
      readonly projectId: string | null;
      readonly goalId: string | null;
      readonly includeRetracted: boolean;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<TemporalPage<Activity>>;
  summarizeActivities(
    access: BrainAccessContext,
    input: { readonly from: string; readonly to: string; readonly timeZone: string },
    signal: AbortSignal,
  ): Promise<ActivitySummary>;
}

export interface IngestionStore {
  createSourceAndRun(
    access: BrainAccessContext,
    input: {
      readonly idempotencyKey: string;
      readonly requestDigest: string;
      readonly excerpt: string;
      readonly capturedAt: string | null;
      readonly proposalProvider: string;
      readonly proposalModel: string;
      readonly schemaVersion: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly source: IngestSource; readonly run: IngestRun; readonly created: boolean }>;
  saveProposals(
    access: BrainAccessContext,
    runId: string,
    input: {
      readonly proposals: readonly Omit<IngestProposal, "id" | "runId" | "createdAt">[];
      readonly responseDigest: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly run: IngestRun;
    readonly proposals: readonly IngestProposal[];
  }>;
  saveReview(
    access: BrainAccessContext,
    runId: string,
    input: {
      readonly expectedProposalDigest: string;
      readonly reviewDigest: string;
      readonly items: readonly IngestReviewItem[];
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<IngestReview | null>;
  getRunStatus(
    access: BrainAccessContext,
    runId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly run: IngestRun;
    readonly proposals: readonly IngestProposal[];
    readonly review: IngestReview | null;
    readonly receipts: readonly IngestReceipt[];
  } | null>;
}

export interface DreamingStore {
  getSettings(signal: AbortSignal): Promise<DreamingSettings | null>;
  claimRun(
    workerId: string,
    input: {
      readonly automationJobId: string;
      readonly now: string;
      readonly leaseSeconds: number;
    },
    signal: AbortSignal,
  ): Promise<ClaimedDreamingRun | null>;
  /** Renews the lease without changing its fencing token. */
  renewRunLease(
    claim: ClaimedDreamingRun,
    input: { readonly now: string; readonly leaseSeconds: number },
    signal: AbortSignal,
  ): Promise<ClaimedDreamingRun | null>;
  captureSnapshot(
    claim: ClaimedDreamingRun,
    input: {
      readonly maximumEvents: number;
      readonly maximumPrimaryRecords: number;
      readonly maximumTargetMemories: number;
      readonly maximumComparisonRecords: number;
      readonly maximumCharacters: number;
    },
    signal: AbortSignal,
  ): Promise<DreamingSnapshot>;
  savePlan(
    claim: ClaimedDreamingRun,
    input: {
      readonly plan: DreamingPlan;
      readonly provider: string;
      readonly model: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly responseDigest: string;
    },
    signal: AbortSignal,
  ): Promise<readonly DreamingChange[]>;
  loadPersistedRun(
    claim: ClaimedDreamingRun,
    signal: AbortSignal,
  ): Promise<PersistedDreamingRunState | null>;
  skipChange(
    claim: ClaimedDreamingRun,
    changeId: string,
    reason: DreamingSkipReason,
    signal: AbortSignal,
  ): Promise<DreamingChange | null>;
  applyEligibleChange(
    claim: ClaimedDreamingRun,
    changeId: string,
    input: {
      readonly embedding: ContentEmbedding;
      readonly verified: boolean;
    },
    signal: AbortSignal,
  ): Promise<DreamingChange>;
  finalizeRun(
    claim: ClaimedDreamingRun,
    input: { readonly coverageWarnings: readonly string[] },
    signal: AbortSignal,
  ): Promise<DreamingReport>;
  failRun(
    claim: ClaimedDreamingRun,
    input: { readonly retryable: boolean; readonly sanitizedError: string },
    signal: AbortSignal,
  ): Promise<DreamingRun>;
  getReport(
    access: BrainAccessContext,
    selector: DreamingReportSelector,
    signal: AbortSignal,
  ): Promise<DreamingReport | null>;
}

export interface AutomationStore {
  getSettings(access: BrainAccessContext, signal: AbortSignal): Promise<AutomationSettings>;
  updateSettings(
    access: BrainAccessContext,
    changes: {
      readonly timeZone?: string | undefined;
      readonly dreamingEnabled?: boolean | undefined;
      readonly dreamLocalTime?: string | undefined;
      readonly reminderDeliveryEnabled?: boolean | undefined;
      readonly expectedRevision: number;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationSettings | null>;
  materializeDueDreamingRuns(
    workerId: string,
    input: { readonly now: string; readonly catchUpLimit: number },
    signal: AbortSignal,
  ): Promise<readonly AutomationJob[]>;
  claimNextJob(
    workerId: string,
    input: {
      readonly now: string;
      readonly leaseSeconds: number;
      readonly kinds: readonly [AutomationJobKind, ...AutomationJobKind[]];
    },
    signal: AbortSignal,
  ): Promise<ClaimedAutomationJob | null>;
  renewLease(
    claim: ClaimedAutomationJob,
    input: { readonly now: string; readonly leaseSeconds: number },
    signal: AbortSignal,
  ): Promise<ClaimedAutomationJob | null>;
  completeJob(claim: ClaimedAutomationJob, signal: AbortSignal): Promise<boolean>;
  retryJob(
    claim: ClaimedAutomationJob,
    input: { readonly nextAttemptAt: string; readonly sanitizedError: string },
    signal: AbortSignal,
  ): Promise<boolean>;
  failJob(
    claim: ClaimedAutomationJob,
    input: { readonly sanitizedError: string },
    signal: AbortSignal,
  ): Promise<boolean>;
  /**
   * Asks a job to stop. A waiting job ends as `canceled` at once; a running job
   * is flagged for its worker, which stops at its next stage boundary. Terminal
   * jobs are returned unchanged; `null` means the job does not exist.
   */
  requestCancel(
    jobId: string,
    input: { readonly requestedBy: string; readonly now: string },
    signal: AbortSignal,
  ): Promise<AutomationJob | null>;
  /** Whether cancellation was requested for a claimed job; runners ask at stage boundaries. */
  cancelRequested(claim: ClaimedAutomationJob, signal: AbortSignal): Promise<boolean>;
  /** Ends a live claim as `canceled`; false when the claim is no longer live. */
  cancelJob(claim: ClaimedAutomationJob, signal: AbortSignal): Promise<boolean>;
  recordHeartbeat(
    workerId: string,
    input: {
      readonly version: string;
      readonly startedAt: string;
      readonly lastSeenAt: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationWorkerHeartbeat>;
}

export interface SecondBrainDependencies {
  readonly access: BrainAccessStore;
  readonly projects: ProjectStore;
  readonly people: PersonStore;
  readonly tasks: TaskStore;
  readonly reminders: ReminderStore;
  readonly memories: MemoryStore;
  readonly decisions: DecisionStore;
  readonly knowledge: KnowledgeStore;
  readonly search: BrainSearchStore;
  readonly evidence: BrainEvidenceStore;
  readonly embeddingSpaces: EmbeddingSpaceStore;
  readonly goals: GoalStore;
  readonly priorities: PriorityPlanStore;
  readonly activities: ActivityStore;
  readonly ingestion: IngestionStore;
  readonly ingestionCommitter: ReviewedIngestionCommitter;
  readonly dreaming: DreamingStore;
  readonly automation: AutomationStore;
  readonly brainPacks: BrainPackStore;
  readonly brainPackArtifacts: BrainPackArtifactStore;
  readonly brainPackCodec: BrainPackCodec;
  readonly contexts: ContextStore;
  readonly embeddings: EmbeddingProvider;
  readonly answers: AnswerProvider;
  readonly ingestionProvider: IngestionProvider;
  readonly dreamingProvider: DreamingProvider;
  readonly dreamingVerifier: DreamingVerificationProvider;
  readonly dreamingRunner: DreamingRunner;
}
