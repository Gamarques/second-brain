import type { BrainPackOriginAttribution } from "./brain-pack-store.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  ContentEmbedding,
  CursorPosition,
  Page,
  TemporalCoverage,
} from "./core.js";

export const taskStatuses = ["todo", "in_progress", "done", "canceled"] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const taskPriorities = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof taskPriorities)[number];

export const projectStatuses = ["active", "paused", "completed", "archived"] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const decisionStatuses = ["active", "superseded", "revoked"] as const;
export type DecisionStatus = (typeof decisionStatuses)[number];

export const taskRelationKinds = ["blocks", "depends_on", "duplicate_of"] as const;
export type TaskRelationKind = (typeof taskRelationKinds)[number];

export const evidenceTypes = [
  "memory",
  "decision",
  "task",
  "reminder",
  "goal",
  "priority_plan",
  "activity",
  "activity_summary",
] as const;
export type EvidenceType = (typeof evidenceTypes)[number];

export interface TaskList {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskGoalLink {
  readonly goalId: string;
  readonly basis: "explicit" | "reviewed_inference" | "model_inference";
  readonly confidence: number | null;
}

export interface Task {
  readonly id: string;
  readonly listId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueAt: string | null;
  readonly completedAt: string | null;
  readonly projectId: string | null;
  readonly goalLinks: readonly TaskGoalLink[];
  readonly version: number;
  readonly historyCompleteFrom: string;
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskRelation {
  readonly id: string;
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly kind: TaskRelationKind;
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
  readonly retractedAt: string | null;
}

export interface Memory {
  readonly id: string;
  readonly lineageId: string;
  readonly version: number;
  readonly supersedesId: string | null;
  readonly content: string;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly projectId: string | null;
  readonly personIds: readonly string[];
  readonly effectiveAt: string;
  readonly capturedAt: string | null;
  readonly supersededBy: string | null;
  readonly supersededAt: string | null;
  readonly provenance: ActorAttribution;
  readonly sourceExcerpt: string | null;
  readonly contentHash: string;
  /** Canonical time at which this version was recorded. */
  readonly createdAt: string;
}

export interface MemoryMatch {
  readonly memory: Memory;
  readonly score: number;
  readonly spaceId: string;
}

export interface Reminder {
  readonly id: string;
  readonly message: string;
  readonly remindAt: string;
  readonly completedAt: string | null;
  readonly version: number;
  readonly historyCompleteFrom: string;
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly version: number;
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly notes: string | null;
  readonly summary: string | null;
  readonly tags: readonly string[];
  readonly projectIds: readonly string[];
  readonly knowledgeBaseIds: readonly string[];
  readonly version: number;
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RejectedAlternative {
  readonly option: string;
  readonly reason: string | null;
}

export interface Decision {
  readonly id: string;
  readonly lineageId: string;
  readonly version: number;
  readonly supersedesId: string | null;
  readonly statement: string;
  readonly rationale: string;
  readonly rejectedAlternatives: readonly RejectedAlternative[];
  readonly status: DecisionStatus;
  readonly projectId: string | null;
  readonly personIds: readonly string[];
  readonly decidedAt: string;
  readonly revokedAt: string | null;
  readonly provenance: ActorAttribution;
  readonly sourceExcerpt: string | null;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KnowledgeBase {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KnowledgeDocument {
  readonly id: string;
  readonly knowledgeBaseId: string;
  readonly currentRevision: number;
  readonly title: string;
  readonly sourceUri: string | null;
  readonly tags: readonly string[];
  readonly projectId: string | null;
  readonly personIds: readonly string[];
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KnowledgeDocumentRevision {
  readonly id: string;
  readonly documentId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly chunkCount: number;
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
}

export interface KnowledgeChunkMatch {
  readonly chunkId: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly documentTitle: string;
  readonly content: string;
  readonly score: number;
  readonly spaceId: string;
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseName: string;
  /** Set when a Brain Pack published the cited revision: publisher, pack, revision and authors. */
  readonly origin?: BrainPackOriginAttribution | null;
}

export interface EvidenceItem {
  readonly type: EvidenceType;
  readonly id: string;
  readonly versionId: string | null;
  readonly content: string;
  readonly score: number;
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly supersededAt: string | null;
  readonly sourceIds: readonly string[];
}

export interface EvidenceSearchResult {
  readonly evidence: readonly EvidenceItem[];
  readonly coverage: TemporalCoverage;
}

export interface ReasonedAnswer {
  readonly answer: string;
  readonly answerable: boolean;
  /** One-based positions in the evidence array supplied to the provider. */
  readonly citationIndexes: readonly number[];
}

export interface AnswerProvider {
  answer(
    input: {
      readonly question: string;
      readonly contexts: readonly KnowledgeChunkMatch[];
    },
    signal: AbortSignal,
  ): Promise<string>;
  reason(
    input: {
      readonly question: string;
      readonly evidence: readonly EvidenceItem[];
      readonly coverage: TemporalCoverage;
      readonly referenceTime: string;
      readonly asOf: string | null;
      readonly confidence: "low" | "high";
    },
    signal: AbortSignal,
  ): Promise<ReasonedAnswer>;
}

export type SupersessionPrecondition =
  | {
      readonly supersedesId: null;
      readonly expectedSupersededHash: null;
      readonly expectedSupersededVersion: null;
    }
  | {
      readonly supersedesId: string;
      readonly expectedSupersededHash: string;
      readonly expectedSupersededVersion: number;
    };

export type MemoryWriteInput = {
  readonly content: string;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly projectId: string | null;
  readonly personIds: readonly string[];
  readonly effectiveAt: string;
  readonly capturedAt: string | null;
  readonly sourceExcerpt: string | null;
  readonly idempotencyKey: string;
  readonly embedding: ContentEmbedding;
} & SupersessionPrecondition;

export type DecisionWriteInput = {
  readonly statement: string;
  readonly rationale: string;
  readonly rejectedAlternatives: readonly RejectedAlternative[];
  readonly projectId: string | null;
  readonly personIds: readonly string[];
  readonly decidedAt: string;
  readonly sourceExcerpt: string | null;
  readonly embedding: ContentEmbedding;
  readonly idempotencyKey: string;
} & SupersessionPrecondition;

export interface MemoryWriteResult {
  readonly memory: Memory;
  readonly created: boolean;
  readonly supersededMemoryId: string | null;
  readonly similarity: number | null;
}

export interface EntityListInput {
  readonly cursor: CursorPosition | null;
  readonly limit: number;
}

export interface MemoryListResult extends Page<Memory> {}

export interface BrainQuery {
  readonly access: BrainAccessContext;
}
