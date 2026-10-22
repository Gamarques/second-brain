import type { BrainAccessContext } from "./core.js";
import type { DreamingMemoryProposal } from "./dreaming.js";
import type { Memory } from "./entities.js";

export interface LearningReviewReceipt {
  changeId: string;
  decision: "accept" | "reject";
  resultMemoryId: string | null;
  reviewedAt: string;
}
export interface LearningReviewDetail {
  changeId: string;
  runId: string;
  localDate: string;
  fingerprint: string;
  proposal: DreamingMemoryProposal;
  target: Memory | null;
  evidence: {
    id: string;
    type: string;
    entityId: string;
    excerpt: string;
    effectiveAt: string;
    redacted: boolean;
  }[];
  blockedReason: string | null;
  receipt: LearningReviewReceipt | null;
}
export interface LearningReviewStore {
  list(
    access: BrainAccessContext,
    input: {
      kind: "ingestion" | "dreaming";
      status: "pending" | "history";
      cursor?: string | null | undefined;
      limit?: number;
    },
    signal: AbortSignal,
  ): Promise<{
    items: {
      id: string;
      kind: "ingestion" | "dreaming";
      title: string;
      status: string;
      count: number;
      createdAt: string;
    }[];
    nextCursor: string | null;
  }>;
  getDreaming(
    access: BrainAccessContext,
    changeId: string,
    signal: AbortSignal,
  ): Promise<LearningReviewDetail | null>;
  reviewDreaming(
    access: BrainAccessContext,
    input: {
      changeId: string;
      fingerprint: string;
      decision: "accept" | "reject";
      idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<LearningReviewReceipt>;
}
export class LearningReviewConflictError extends Error {
  readonly code = "LEARNING_REVIEW_CONFLICT";
  constructor() {
    super(
      "This suggestion has changed or cannot be applied. Refresh its evidence before reviewing it.",
    );
  }
}
