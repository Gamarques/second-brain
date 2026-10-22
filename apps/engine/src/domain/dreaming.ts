import type { ActorProvenance } from "./core.js";
import type { EvidenceType, Memory } from "./entities.js";

export const dreamingModes = ["preview", "apply"] as const;
export type DreamingMode = (typeof dreamingModes)[number];

export const dreamingRunStatuses = [
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
] as const;
export type DreamingRunStatus = (typeof dreamingRunStatuses)[number];

export const dreamingInsightKinds = [
  "observation",
  "contradiction",
  "open_loop",
  "pattern_hypothesis",
] as const;
export type DreamingInsightKind = (typeof dreamingInsightKinds)[number];

export const insightConfidences = ["low", "medium", "high"] as const;
export type InsightConfidence = (typeof insightConfidences)[number];

export interface DreamingSettings {
  readonly enabled: boolean;
  readonly timeZone: string;
  readonly runAtLocal: string;
  readonly mode: DreamingMode;
  readonly dailyInputTokenLimit: number;
  readonly dailyOutputTokenLimit: number;
  readonly revision: number;
  readonly nextRunAt: string | null;
  readonly updatedAt: string;
}

export interface DreamingRun {
  readonly id: string;
  readonly replayOfRunId?: string | null;
  readonly localDate: string;
  readonly timeZone: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly mode: DreamingMode;
  readonly status: DreamingRunStatus;
  readonly pipelineVersion: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly policyVersion: string;
  readonly snapshotHash: string | null;
  readonly snapshotTruncated: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface DreamingEvidence {
  readonly id: string;
  readonly runId: string;
  readonly index: number;
  readonly role: "primary" | "comparison" | "memory_target";
  readonly type: EvidenceType;
  readonly entityId: string;
  readonly versionId: string | null;
  readonly observedAt: string;
  readonly effectiveAt: string;
  readonly excerpt: string;
  readonly contentHash: string;
  readonly redactedAt: string | null;
}

export interface DreamingSnapshot {
  readonly run: DreamingRun;
  readonly evidence: readonly DreamingEvidence[];
  readonly targetMemories: readonly Memory[];
  readonly serializedCharacters: number;
  readonly truncated: boolean;
  readonly coverageWarnings: readonly string[];
}

export interface DreamingInsightProposal {
  readonly kind: DreamingInsightKind;
  readonly statement: string;
  readonly confidence: InsightConfidence;
  readonly evidenceIndexes: readonly number[];
}

export interface DreamingMemoryCreateProposal {
  readonly operation: "create";
  readonly content: string;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly sourceQuotes: readonly string[];
  readonly evidenceIndexes: readonly number[];
}

export interface DreamingMemoryUpdateProposal {
  readonly operation: "update";
  readonly targetMemoryIndex: number;
  readonly content: string;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly sourceQuotes: readonly string[];
  readonly evidenceIndexes: readonly number[];
}

export type DreamingMemoryProposal =
  | DreamingMemoryCreateProposal
  | DreamingMemoryUpdateProposal;

export interface DreamingPlan {
  readonly summary: string;
  readonly insights: readonly DreamingInsightProposal[];
  readonly memories: readonly DreamingMemoryProposal[];
}

export interface DreamingModelResult {
  readonly payload: unknown;
  readonly provider: string;
  readonly model: string;
  readonly finishReason: "stop";
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface DreamingProvider {
  createPlan(
    snapshot: DreamingSnapshot,
    limits: {
      readonly maxOutputTokens: number;
      readonly timeoutMs: number;
    },
    signal: AbortSignal,
  ): Promise<DreamingModelResult>;
}

export interface DreamingVerificationResult {
  readonly supported: boolean;
  readonly sameFact: boolean;
  readonly contradictionResolved: boolean;
  readonly quoteIndexes: readonly number[];
}

export interface DreamingVerificationProvider {
  verifyUpdates(
    changes: readonly {
      readonly target: Memory;
      readonly proposal: DreamingMemoryUpdateProposal;
      readonly citedQuotes: readonly string[];
    }[],
    signal: AbortSignal,
  ): Promise<readonly DreamingVerificationResult[]>;
}

export const dreamingChangeStatuses = [
  "proposed",
  "eligible",
  "applied",
  "skipped",
  "failed",
] as const;
export type DreamingChangeStatus = (typeof dreamingChangeStatuses)[number];

export const dreamingSkipReasons = [
  "snapshot_truncated",
  "invalid_evidence",
  "unsupported_memory",
  "duplicate_memory",
  "target_missing",
  "target_stale",
  "target_context_mismatch",
  "target_newer_than_evidence",
  "verification_failed",
  "policy_denied",
  "token_limit_exceeded",
] as const;
export type DreamingSkipReason = (typeof dreamingSkipReasons)[number];

export interface DreamingChange {
  readonly id: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly proposal: DreamingMemoryProposal;
  readonly fingerprint: string;
  readonly expectedTargetHash: string | null;
  readonly status: DreamingChangeStatus;
  readonly resultMemoryId: string | null;
  readonly previousMemoryId: string | null;
  readonly skipReason: DreamingSkipReason | null;
  readonly appliedAt: string | null;
}

export interface DreamingReportCitation {
  readonly type: EvidenceType;
  readonly id: string;
  readonly versionId: string | null;
  readonly excerpt: string;
}

export interface DreamingReportInsight {
  readonly kind: DreamingInsightKind;
  readonly statement: string;
  readonly confidence: InsightConfidence;
  readonly evidence: readonly DreamingReportCitation[];
}

export interface DreamingReport {
  readonly id: string;
  readonly runId: string;
  readonly localDate: string;
  readonly generatedAt: string;
  readonly mode: DreamingMode;
  readonly status: "completed" | "completed_with_skips";
  readonly summary: string;
  readonly insights: readonly DreamingReportInsight[];
  readonly memoriesCreated: readonly {
    readonly id: string;
    readonly content: string;
  }[];
  readonly memoriesUpdated: readonly {
    readonly id: string;
    readonly previousMemoryId: string;
    readonly content: string;
  }[];
  readonly skipped: readonly { readonly reason: string }[];
  readonly coverageWarnings: readonly string[];
}

export type DreamingReportSelector =
  | { readonly kind: "latest" }
  | { readonly kind: "local_date"; readonly localDate: string }
  | { readonly kind: "run_id"; readonly runId: string };

export interface ClaimedDreamingRun {
  readonly run: DreamingRun;
  readonly fencingToken: string;
  readonly leaseExpiresAt: string;
  readonly provenance: ActorProvenance;
}

export interface PersistedDreamingRunState {
  readonly run: DreamingRun;
  readonly snapshot: DreamingSnapshot;
  readonly changes: readonly DreamingChange[];
}

export interface DreamingRunner {
  runDaily(claim: ClaimedDreamingRun, signal: AbortSignal): Promise<DreamingReport>;
}
