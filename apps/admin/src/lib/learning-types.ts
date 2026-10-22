import type { MemoryRecord } from "./api-types";
export type ReviewDecision = "accept" | "reject";
export interface LearningItem {
  id: string;
  kind: "ingestion" | "dreaming";
  title: string;
  status: string;
  count: number;
  createdAt: string;
}
export interface LearningReceipt {
  changeId: string;
  decision: ReviewDecision;
  resultMemoryId: string | null;
  reviewedAt: string;
}
export interface LearningDreaming {
  changeId: string;
  runId: string;
  localDate: string;
  fingerprint: string;
  proposal: {
    operation: "create" | "update";
    content: string;
    category: string | null;
    tags: string[];
    sourceQuotes: string[];
  };
  target: MemoryRecord | null;
  evidence: {
    id: string;
    type: string;
    entityId: string;
    excerpt: string;
    effectiveAt: string;
    redacted: boolean;
  }[];
  blockedReason: string | null;
  receipt: LearningReceipt | null;
}
export type IngestPayload =
  | {
      kind: "memory";
      content: string;
      category: string | null;
      tags: string[];
      projectId: string | null;
      personIds: string[];
    }
  | {
      kind: "decision";
      statement: string;
      rationale: string;
      rejectedAlternatives: { option: string; reason: string | null }[];
      projectId: string | null;
      personIds: string[];
      decidedAt: string | null;
    }
  | {
      kind: "task";
      listId: string | null;
      title: string;
      description: string | null;
      priority: string;
      dueAt: string | null;
      projectId: string | null;
      goalIds: string[];
    }
  | { kind: "reminder"; message: string; remindAt: string }
  | { kind: "person"; name: string; aliases: string[]; notes: string | null };
export interface IngestionStatus {
  run: {
    id: string;
    status: string;
    proposalDigest: string | null;
    reviewedDigest: string | null;
    proposalModel: string;
  };
  proposals: {
    id: string;
    payload: IngestPayload;
    confidence: number;
    sourceQuote: string;
  }[];
  review: {
    reviewDigest: string;
    items: { proposalId: string; decision: ReviewDecision }[];
  } | null;
  receipts: {
    proposalId: string;
    entityType: string;
    entityId: string | null;
    status: "committed" | "skipped";
    reason: string | null;
  }[];
}
