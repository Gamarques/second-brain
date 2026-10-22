import type { ActorAttribution, BrainAccessContext } from "./core.js";
import type { RejectedAlternative, TaskPriority } from "./entities.js";

export const maximumIngestExcerptCharacters = 100_000;
export const maximumIngestSourceQuoteCharacters = 4_000;

export function isValidIngestSourceSpan(
  excerpt: string,
  span: {
    readonly sourceStart: number;
    readonly sourceEnd: number;
    readonly sourceQuote: string;
  },
): boolean {
  return (
    Number.isInteger(span.sourceStart) &&
    Number.isInteger(span.sourceEnd) &&
    span.sourceStart >= 0 &&
    span.sourceEnd > span.sourceStart &&
    span.sourceEnd <= excerpt.length &&
    span.sourceQuote.length <= maximumIngestSourceQuoteCharacters &&
    excerpt.slice(span.sourceStart, span.sourceEnd) === span.sourceQuote
  );
}

export const ingestRunStatuses = [
  "proposing",
  "awaiting_review",
  "reviewed",
  "committing",
  "completed",
  "completed_with_skips",
  "failed",
] as const;
export type IngestRunStatus = (typeof ingestRunStatuses)[number];

export const ingestProposalKinds = [
  "memory",
  "decision",
  "task",
  "reminder",
  "person",
] as const;
export type IngestProposalKind = (typeof ingestProposalKinds)[number];

export interface IngestSource {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly excerpt: string;
  readonly capturedAt: string | null;
  /** Historical attribution remains decodable after account pseudonymization. */
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
}

export interface ProposedMemory {
  readonly kind: "memory";
  readonly content: string;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly projectId: string | null;
  readonly personIds: readonly string[];
}

export interface ProposedDecision {
  readonly kind: "decision";
  readonly statement: string;
  readonly rationale: string;
  readonly rejectedAlternatives: readonly RejectedAlternative[];
  readonly projectId: string | null;
  readonly personIds: readonly string[];
  readonly decidedAt: string | null;
}

export interface ProposedTask {
  readonly kind: "task";
  /** Null when the excerpt does not state an exact task-list ID; committing
   * an accepted task requires a resolvable list, so review must reject
   * list-less tasks the brain cannot place. */
  readonly listId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly priority: TaskPriority;
  readonly dueAt: string | null;
  readonly projectId: string | null;
  readonly goalIds: readonly string[];
}

export interface ProposedReminder {
  readonly kind: "reminder";
  readonly message: string;
  readonly remindAt: string;
}

export interface ProposedPerson {
  readonly kind: "person";
  readonly name: string;
  readonly aliases: readonly string[];
  readonly notes: string | null;
}

export type IngestProposalPayload =
  | ProposedMemory
  | ProposedDecision
  | ProposedTask
  | ProposedReminder
  | ProposedPerson;

export interface IngestProposal {
  readonly id: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly payload: IngestProposalPayload;
  readonly confidence: number;
  /** Inclusive JavaScript UTF-16 code-unit offset into the immutable source excerpt. */
  readonly sourceStart: number;
  /** Exclusive JavaScript UTF-16 code-unit offset into the immutable source excerpt. */
  readonly sourceEnd: number;
  readonly sourceQuote: string;
  readonly payloadDigest: string;
  readonly createdAt: string;
}

export interface IngestRun {
  readonly id: string;
  readonly sourceId: string;
  readonly status: IngestRunStatus;
  readonly proposalProvider: string;
  readonly proposalModel: string;
  readonly schemaVersion: string;
  readonly proposalCount: number;
  readonly proposalDigest: string | null;
  readonly responseDigest: string | null;
  readonly reviewedDigest: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IngestReviewItem {
  readonly proposalId: string;
  readonly decision: "accept" | "reject";
  readonly replacement: IngestProposalPayload | null;
}

export interface IngestReview {
  readonly id: string;
  readonly runId: string;
  readonly reviewDigest: string;
  readonly items: readonly IngestReviewItem[];
  /** Historical attribution remains decodable after account pseudonymization. */
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
}

export interface IngestReceipt {
  readonly id: string;
  readonly runId: string;
  readonly proposalId: string;
  readonly entityType: IngestProposalKind;
  readonly entityId: string | null;
  readonly status: "committed" | "skipped";
  readonly reason: string | null;
  readonly effectDigest: string;
  readonly createdAt: string;
}

export interface IngestionCommitResult {
  readonly run: IngestRun;
  readonly receipts: readonly IngestReceipt[];
}

/**
 * Applies a reviewed set and its receipts in the same database transaction.
 * The implementation owns explicit per-entity writes; it is not a generic
 * transaction callback and never invokes capabilities.
 */
export interface ReviewedIngestionCommitter {
  commitReviewedRun(
    access: BrainAccessContext,
    runId: string,
    input: {
      readonly reviewedDigest: string;
      readonly idempotencyKey: string;
      readonly mode: "atomic" | "durable_partial";
    },
    signal: AbortSignal,
  ): Promise<IngestionCommitResult | null>;
}

export interface IngestionModelResult {
  readonly payload: unknown;
  readonly provider: string;
  readonly model: string;
  readonly finishReason: "stop";
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface IngestionProvider {
  /** Configured identity persisted before any model request is made. */
  readonly ingestionProvider: string;
  readonly ingestionModel: string;
  /** The result provider/model must exactly match the configured ingestion identity. */
  propose(
    input: {
      readonly excerpt: string;
      readonly capturedAt: string | null;
      readonly referenceTime: string;
      readonly schemaVersion: string;
    },
    signal: AbortSignal,
  ): Promise<IngestionModelResult>;
}
