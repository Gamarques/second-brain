import { z } from "zod";

import type {
  ClaimedDreamingRun,
  ContentEmbedding,
  DreamingChange,
  DreamingMemoryProposal,
  DreamingPlan,
  DreamingProvider,
  DreamingReport,
  DreamingRunner,
  DreamingSnapshot,
  DreamingStore,
  DreamingSkipReason,
  DreamingVerificationProvider,
  DreamingVerificationResult,
  EmbeddingRecipeContent,
  PersistedDreamingRunState,
} from "@second-brain/engine/domain";
import {
  canonicalDigest,
  canonicalMemoryEmbeddingText,
  memoryEmbeddingRecipe,
} from "@second-brain/engine/domain";

const SNAPSHOT_LIMITS = {
  maximumEvents: 200,
  maximumPrimaryRecords: 100,
  maximumTargetMemories: 20,
  maximumComparisonRecords: 20,
  maximumCharacters: 40_000,
} as const;

const DEFAULT_LIMITS = {
  maximumEvidence: 140,
  maximumInputTokens: 20_000,
  maximumOutputTokens: 2_000,
  providerTimeoutMs: 180_000,
} as const;

const uniqueIndexesSchema = z
  .array(z.number().int().nonnegative())
  .min(1)
  .max(5)
  .refine((indexes) => new Set(indexes).size === indexes.length);

const insightSchema = z
  .object({
    kind: z.enum(["observation", "contradiction", "open_loop", "pattern_hypothesis"]),
    statement: z.string().trim().min(1).max(2_000),
    confidence: z.enum(["low", "medium", "high"]),
    evidenceIndexes: uniqueIndexesSchema,
  })
  .strict();

const memoryFields = {
  content: z.string().trim().min(1).max(10_000),
  category: z.string().trim().min(1).max(100).nullable(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20),
  sourceQuotes: z.array(z.string().min(1).max(1_000)).min(1).max(5),
  evidenceIndexes: uniqueIndexesSchema,
};

const memoryCreateSchema = z
  .object({ operation: z.literal("create"), ...memoryFields })
  .strict();
const memoryUpdateSchema = z
  .object({
    operation: z.literal("update"),
    targetMemoryIndex: z.number().int().nonnegative(),
    ...memoryFields,
  })
  .strict();

const planSchema = z
  .object({
    summary: z.string().trim().min(1).max(2_000),
    insights: z.array(insightSchema).max(10),
    memories: z.array(z.discriminatedUnion("operation", [memoryCreateSchema, memoryUpdateSchema])).max(20),
  })
  .strict();

export type DreamingFailureCode =
  | "DREAMING_ABORTED"
  | "DREAMING_ALREADY_TERMINAL"
  | "DREAMING_TOKEN_LIMIT_EXCEEDED"
  | "DREAMING_DISABLED"
  | "DREAMING_EMBEDDING_FAILED"
  | "DREAMING_INTERNAL_FAILED"
  | "DREAMING_LEASE_LOST"
  | "DREAMING_PLAN_INVALID"
  | "DREAMING_PLAN_UNGROUNDED"
  | "DREAMING_PROVIDER_FAILED"
  | "DREAMING_SETTINGS_INVALID"
  | "DREAMING_SNAPSHOT_INVALID"
  | "DREAMING_STORE_INTEGRITY_FAILED"
  | "DREAMING_VERIFICATION_FAILED";

export class DreamingExecutionError extends Error {
  readonly code: DreamingFailureCode;
  readonly retryable: boolean;

  constructor(code: DreamingFailureCode, retryable: boolean, options?: ErrorOptions) {
    super(code, options);
    this.name = "DreamingExecutionError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface DreamingMemoryEmbedder {
  embed(
    recipe: EmbeddingRecipeContent<"memory-v1">,
    signal: AbortSignal,
  ): Promise<ContentEmbedding>;
}

export interface DreamingRunnerDependencies {
  readonly store: DreamingStore;
  readonly provider: DreamingProvider;
  readonly verifier: DreamingVerificationProvider;
  readonly embedder: DreamingMemoryEmbedder;
  readonly limits?: {
    readonly maximumInputTokens?: number;
    readonly maximumOutputTokens?: number;
    readonly providerTimeoutMs?: number;
    readonly runLeaseSeconds?: number;
    readonly runLeaseRenewalIntervalMs?: number;
  };
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function executionError(
  code: DreamingFailureCode,
  retryable: boolean,
  cause?: unknown,
): DreamingExecutionError {
  return new DreamingExecutionError(code, retryable, cause === undefined ? undefined : { cause });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw executionError("DREAMING_ABORTED", true, signal.reason);
  }
}

function validateSnapshot(claim: ClaimedDreamingRun, snapshot: DreamingSnapshot): void {
  const windowStart = Date.parse(snapshot.run.windowStart);
  const windowEnd = Date.parse(snapshot.run.windowEnd);
  if (
    snapshot.run.id !== claim.run.id ||
    snapshot.run.localDate !== claim.run.localDate ||
    !Number.isInteger(snapshot.serializedCharacters) ||
    snapshot.serializedCharacters < 0 ||
    snapshot.serializedCharacters > SNAPSHOT_LIMITS.maximumCharacters ||
    snapshot.evidence.length > DEFAULT_LIMITS.maximumEvidence ||
    snapshot.targetMemories.length > SNAPSHOT_LIMITS.maximumTargetMemories ||
    !Number.isFinite(windowStart) ||
    !Number.isFinite(windowEnd) ||
    windowStart >= windowEnd
  ) {
    throw executionError("DREAMING_SNAPSHOT_INVALID", false);
  }

  const indexes = new Set<number>();
  for (const evidence of snapshot.evidence) {
    if (
      evidence.runId !== claim.run.id ||
      evidence.redactedAt !== null ||
      !Number.isInteger(evidence.index) ||
      evidence.index < 0 ||
      indexes.has(evidence.index) ||
      !Number.isFinite(Date.parse(evidence.observedAt)) ||
      !Number.isFinite(Date.parse(evidence.effectiveAt)) ||
      !/^[0-9a-f]{64}$/u.test(evidence.contentHash)
    ) {
      throw executionError("DREAMING_SNAPSHOT_INVALID", false);
    }
    indexes.add(evidence.index);
  }
}

function localDateInTimeZone(instant: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instant));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    if (!year || !month || !day) throw new RangeError("date-parts-unavailable");
    return `${year}-${month}-${day}`;
  } catch (error) {
    throw executionError("DREAMING_SNAPSHOT_INVALID", false, error);
  }
}

function exactQuoteInEvidence(quote: string, excerpts: readonly string[]): boolean {
  const quoteBytes = Buffer.from(quote, "utf8");
  return excerpts.some((excerpt) => Buffer.from(excerpt, "utf8").includes(quoteBytes));
}

function citedEvidence(snapshot: DreamingSnapshot, indexes: readonly number[]) {
  const byIndex = new Map(snapshot.evidence.map((evidence) => [evidence.index, evidence]));
  const cited = indexes.map((index) => byIndex.get(index));
  if (cited.some((evidence) => evidence === undefined)) {
    throw executionError("DREAMING_PLAN_UNGROUNDED", false);
  }
  return cited.filter((evidence) => evidence !== undefined);
}

function validateAndGroundPlan(payload: unknown, snapshot: DreamingSnapshot): DreamingPlan {
  const parsed = planSchema.safeParse(payload);
  if (!parsed.success) {
    throw executionError("DREAMING_PLAN_INVALID", false, parsed.error);
  }

  const supportedInsights = parsed.data.insights.filter((insight) => {
    const evidence = citedEvidence(snapshot, insight.evidenceIndexes);
    if (insight.kind !== "pattern_hypothesis") return true;

    const originalRecords = evidence.filter((item) => item.role !== "memory_target");
    const entityIds = new Set(originalRecords.map((item) => `${item.type}:${item.entityId}`));
    const dates = new Set(
      originalRecords.map((item) =>
        localDateInTimeZone(item.observedAt, snapshot.run.timeZone),
      ),
    );
    return entityIds.size >= 3 && dates.size >= 2;
  });

  for (const proposal of parsed.data.memories) {
    const evidence = citedEvidence(snapshot, proposal.evidenceIndexes);
    const excerpts = evidence.map((item) => item.excerpt);
    if (proposal.sourceQuotes.some((quote) => !exactQuoteInEvidence(quote, excerpts))) {
      throw executionError("DREAMING_PLAN_UNGROUNDED", false);
    }
    if (
      proposal.operation === "update" &&
      proposal.targetMemoryIndex >= snapshot.targetMemories.length
    ) {
      throw executionError("DREAMING_PLAN_UNGROUNDED", false);
    }
  }

  return { ...parsed.data, insights: supportedInsights };
}

function normalizeExtractiveText(value: string): string {
  return canonicalMemoryEmbeddingText(value);
}

function looksLikeInstruction(value: string): boolean {
  return /(?:ignore|disregard)\s+(?:all\s+)?(?:prior|previous|above)\s+instructions|(?:call|invoke|run)\s+(?:a\s+)?tool|system\s+prompt/iu.test(
    value,
  );
}

function isExtractiveCreate(proposal: DreamingMemoryProposal): boolean {
  if (proposal.operation !== "create" || looksLikeInstruction(proposal.content)) return false;
  const content = normalizeExtractiveText(proposal.content);
  return (
    proposal.sourceQuotes.some((quote) => normalizeExtractiveText(quote) === content) ||
    normalizeExtractiveText(proposal.sourceQuotes.join(" ")) === content
  );
}

function hasPrimaryDailyEvidence(
  proposal: DreamingMemoryProposal,
  snapshot: DreamingSnapshot,
): boolean {
  const start = Date.parse(snapshot.run.windowStart);
  const end = Date.parse(snapshot.run.windowEnd);
  return citedEvidence(snapshot, proposal.evidenceIndexes).some((evidence) => {
    const observedAt = Date.parse(evidence.observedAt);
    return evidence.role === "primary" && observedAt >= start && observedAt < end;
  });
}

function isDeterministicallyEligibleUpdate(
  proposal: DreamingMemoryProposal,
  snapshot: DreamingSnapshot,
): boolean {
  if (proposal.operation !== "update") return false;
  const target = snapshot.targetMemories[proposal.targetMemoryIndex];
  if (!target || target.supersededBy !== null) return false;
  const targetEffectiveAt = Date.parse(target.effectiveAt);
  return citedEvidence(snapshot, proposal.evidenceIndexes).some(
    (evidence) =>
      evidence.role === "primary" &&
      Date.parse(evidence.effectiveAt) > targetEffectiveAt &&
      Date.parse(evidence.observedAt) >= Date.parse(snapshot.run.windowStart) &&
      Date.parse(evidence.observedAt) < Date.parse(snapshot.run.windowEnd),
  );
}

function deterministicSkipReason(
  proposal: DreamingMemoryProposal,
  snapshot: DreamingSnapshot,
): DreamingSkipReason | null {
  if (!hasPrimaryDailyEvidence(proposal, snapshot)) return "invalid_evidence";
  if (proposal.operation === "create") {
    return isExtractiveCreate(proposal) ? null : "unsupported_memory";
  }
  const target = snapshot.targetMemories[proposal.targetMemoryIndex];
  if (!target) return "target_missing";
  if (target.supersededBy !== null) return "target_stale";
  if (!isDeterministicallyEligibleUpdate(proposal, snapshot)) {
    return "target_newer_than_evidence";
  }
  return null;
}

function validateVerificationResult(
  result: DreamingVerificationResult | undefined,
  quoteCount: number,
): result is DreamingVerificationResult {
  if (!result || !Array.isArray(result.quoteIndexes) || result.quoteIndexes.length === 0) {
    return false;
  }
  const indexes = new Set<number>();
  for (const index of result.quoteIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= quoteCount || indexes.has(index)) {
      return false;
    }
    indexes.add(index);
  }
  return (
    typeof result.supported === "boolean" &&
    typeof result.sameFact === "boolean" &&
    typeof result.contradictionResolved === "boolean"
  );
}

function assertStoreChanges(
  claim: ClaimedDreamingRun,
  plan: DreamingPlan,
  changes: readonly DreamingChange[],
): void {
  if (changes.length !== plan.memories.length) {
    throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
  }
  for (let ordinal = 0; ordinal < changes.length; ordinal += 1) {
    const change = changes[ordinal];
    if (
      !change ||
      change.runId !== claim.run.id ||
      change.ordinal !== ordinal ||
      canonicalDigest(change.proposal) !== canonicalDigest(plan.memories[ordinal])
    ) {
      throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
    }
  }
}

function validatePersistedState(
  claim: ClaimedDreamingRun,
  state: PersistedDreamingRunState,
): { readonly snapshot: DreamingSnapshot; readonly changes: readonly DreamingChange[] } {
  if (
    state.run.id !== claim.run.id ||
    state.run.localDate !== claim.run.localDate ||
    state.run.provider === null ||
    state.run.model === null ||
    state.changes.length > 20
  ) {
    throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
  }
  validateSnapshot(claim, state.snapshot);
  const proposals = state.changes.map((change, ordinal) => {
    if (
      change.runId !== claim.run.id ||
      change.ordinal !== ordinal
    ) {
      throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
    }
    return change.proposal;
  });
  const validated = validateAndGroundPlan(
    { summary: "Persisted dreaming plan.", insights: [], memories: proposals },
    state.snapshot,
  );
  if (canonicalDigest(validated.memories) !== canonicalDigest(proposals)) {
    throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
  }
  return { snapshot: state.snapshot, changes: state.changes };
}

async function persistSkip(
  store: DreamingStore,
  claim: ClaimedDreamingRun,
  change: DreamingChange,
  reason: DreamingSkipReason,
  signal: AbortSignal,
): Promise<void> {
  if (change.status === "applied" || change.status === "skipped" || change.status === "failed") {
    return;
  }
  const skipped = await store.skipChange(claim, change.id, reason, signal);
  if (
    !skipped ||
    skipped.id !== change.id ||
    skipped.runId !== claim.run.id ||
    skipped.status !== "skipped" ||
    skipped.skipReason !== reason
  ) {
    throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
  }
}

function validateReport(
  claim: ClaimedDreamingRun,
  report: DreamingReport,
): DreamingReport {
  if (
    report.runId !== claim.run.id ||
    report.localDate !== claim.run.localDate ||
    report.mode !== claim.run.mode ||
    (report.status !== "completed" && report.status !== "completed_with_skips") ||
    report.summary.length > 2_000 ||
    report.insights.length > 10 ||
    report.memoriesCreated.length + report.memoriesUpdated.length > 20
  ) {
    throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
  }
  return report;
}

async function recordFailure(
  store: DreamingStore,
  claim: ClaimedDreamingRun,
  error: DreamingExecutionError,
): Promise<void> {
  try {
    await store.failRun(
      claim,
      { retryable: error.retryable, sanitizedError: error.code },
      new AbortController().signal,
    );
  } catch {
    // The original sanitized failure remains the worker-visible result.
  }
}

async function waitForLeaseRenewal(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

interface DreamingRunLeaseGuard {
  readonly signal: AbortSignal;
  readonly state: {
    currentClaim: ClaimedDreamingRun;
    lost: boolean;
  };
  stop(): Promise<void>;
}

function startRunLeaseGuard(
  initialClaim: ClaimedDreamingRun,
  store: DreamingStore,
  input: {
    readonly now: () => Date;
    readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    readonly leaseSeconds: number;
    readonly renewalIntervalMs: number;
    readonly parentSignal: AbortSignal;
  },
): DreamingRunLeaseGuard {
  const stopController = new AbortController();
  const lossController = new AbortController();
  const monitorSignal = AbortSignal.any([input.parentSignal, stopController.signal]);
  const workSignal = AbortSignal.any([input.parentSignal, lossController.signal]);
  const state = { currentClaim: initialClaim, lost: false };

  const task = (async () => {
    while (!monitorSignal.aborted) {
      try {
        await input.wait(input.renewalIntervalMs, monitorSignal);
      } catch {
        if (!monitorSignal.aborted) {
          state.lost = true;
          lossController.abort("dreaming-run-lease-monitor-failed");
        }
        return;
      }
      if (monitorSignal.aborted) return;
      try {
        const renewed = await store.renewRunLease(
          state.currentClaim,
          { now: input.now().toISOString(), leaseSeconds: input.leaseSeconds },
          monitorSignal,
        );
        if (
          !renewed ||
          renewed.run.id !== initialClaim.run.id ||
          renewed.fencingToken !== initialClaim.fencingToken
        ) {
          state.lost = true;
          lossController.abort("dreaming-run-lease-lost");
          return;
        }
        state.currentClaim = renewed;
      } catch {
        state.lost = true;
        lossController.abort("dreaming-run-lease-renewal-failed");
        return;
      }
    }
  })();

  return {
    signal: workSignal,
    state,
    async stop() {
      stopController.abort("dreaming-run-lease-monitor-stopped");
      await task;
    },
  };
}

export function createDreamingRunner(dependencies: DreamingRunnerDependencies): DreamingRunner {
  const limits = {
    maximumInputTokens:
      dependencies.limits?.maximumInputTokens ?? DEFAULT_LIMITS.maximumInputTokens,
    maximumOutputTokens:
      dependencies.limits?.maximumOutputTokens ?? DEFAULT_LIMITS.maximumOutputTokens,
    providerTimeoutMs:
      dependencies.limits?.providerTimeoutMs ?? DEFAULT_LIMITS.providerTimeoutMs,
    runLeaseSeconds: dependencies.limits?.runLeaseSeconds ?? 300,
    runLeaseRenewalIntervalMs:
      dependencies.limits?.runLeaseRenewalIntervalMs ?? 60_000,
  };
  if (
    !Number.isInteger(limits.maximumInputTokens) ||
    limits.maximumInputTokens <= 0 ||
    !Number.isInteger(limits.maximumOutputTokens) ||
    limits.maximumOutputTokens <= 0 ||
    !Number.isInteger(limits.providerTimeoutMs) ||
    limits.providerTimeoutMs <= 0 ||
    !Number.isInteger(limits.runLeaseSeconds) ||
    limits.runLeaseSeconds <= 0 ||
    !Number.isInteger(limits.runLeaseRenewalIntervalMs) ||
    limits.runLeaseRenewalIntervalMs <= 0 ||
    limits.runLeaseRenewalIntervalMs >= limits.runLeaseSeconds * 1_000
  ) {
    throw new TypeError("Dreaming runner limits are invalid.");
  }

  return {
    async runDaily(claim, signal): Promise<DreamingReport> {
      const leaseGuard = startRunLeaseGuard(claim, dependencies.store, {
        now: dependencies.now ?? (() => new Date()),
        wait: dependencies.wait ?? waitForLeaseRenewal,
        leaseSeconds: limits.runLeaseSeconds,
        renewalIntervalMs: limits.runLeaseRenewalIntervalMs,
        parentSignal: signal,
      });
      const workSignal = leaseGuard.signal;
      try {
        throwIfAborted(workSignal);

        if (claim.run.status === "completed" || claim.run.status === "completed_with_skips") {
          return validateReport(
            leaseGuard.state.currentClaim,
            await dependencies.store.finalizeRun(
              leaseGuard.state.currentClaim,
              { coverageWarnings: [] },
              workSignal,
            ),
          );
        }
        if (claim.run.status === "failed" || claim.run.status === "canceled") {
          throw executionError("DREAMING_ALREADY_TERMINAL", false);
        }

        const settings = await dependencies.store.getSettings(workSignal);
        throwIfAborted(workSignal);
        if (!settings || (settings.timeZone !== claim.run.timeZone && !(claim.run.mode === "preview" && claim.run.replayOfRunId))) {
          throw executionError("DREAMING_SETTINGS_INVALID", false);
        }
        if (!settings.enabled) {
          throw executionError("DREAMING_DISABLED", false);
        }

        const maximumOutputTokens = Math.min(
          settings.dailyOutputTokenLimit,
          limits.maximumOutputTokens,
        );
        if (
          !Number.isInteger(settings.dailyOutputTokenLimit) ||
          maximumOutputTokens <= 0 ||
          !Number.isInteger(settings.dailyInputTokenLimit) ||
          settings.dailyInputTokenLimit <= 0
        ) {
          throw executionError("DREAMING_SETTINGS_INVALID", false);
        }

        const persisted = await dependencies.store.loadPersistedRun(
          leaseGuard.state.currentClaim,
          workSignal,
        );
        throwIfAborted(workSignal);
        let snapshot: DreamingSnapshot;
        let changes: readonly DreamingChange[] | null = null;
        let accounting: {
          readonly inputTokens: number;
          readonly outputTokens: number;
        } | null = null;
        if (persisted && persisted.run.provider !== null && persisted.run.model !== null) {
          ({ snapshot, changes } = validatePersistedState(claim, persisted));
          accounting = {
            inputTokens: persisted.run.inputTokens,
            outputTokens: persisted.run.outputTokens,
          };
        } else if (persisted) {
          if (
            persisted.run.id !== claim.run.id ||
            persisted.run.localDate !== claim.run.localDate ||
            persisted.run.provider !== null ||
            persisted.run.model !== null ||
            claim.run.status === "verifying" ||
            claim.run.status === "applying"
          ) {
            throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
          }
          validateSnapshot(claim, persisted.snapshot);
          snapshot = persisted.snapshot;
          if (persisted.changes.length > 0) {
            throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
          }
        } else {
          if (claim.run.status === "verifying" || claim.run.status === "applying") {
            throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
          }
          snapshot = await dependencies.store.captureSnapshot(
            leaseGuard.state.currentClaim,
            SNAPSHOT_LIMITS,
            workSignal,
          );
          throwIfAborted(workSignal);
          validateSnapshot(claim, snapshot);
        }

        if (changes === null) {
          let modelResult;
          try {
            const providerSignal = AbortSignal.any([
              workSignal,
              AbortSignal.timeout(limits.providerTimeoutMs),
            ]);
            modelResult = await dependencies.provider.createPlan(
              snapshot,
              { maxOutputTokens: maximumOutputTokens, timeoutMs: limits.providerTimeoutMs },
              providerSignal,
            );
          } catch (error) {
            if (workSignal.aborted) throw executionError("DREAMING_ABORTED", true, error);
            throw executionError("DREAMING_PROVIDER_FAILED", true, error);
          }
          throwIfAborted(workSignal);

          if (
            modelResult.finishReason !== "stop" ||
            !Number.isInteger(modelResult.usage.inputTokens) ||
            !Number.isInteger(modelResult.usage.outputTokens) ||
            modelResult.usage.inputTokens < 0 ||
            modelResult.usage.outputTokens < 0 ||
            modelResult.usage.inputTokens >
              Math.min(settings.dailyInputTokenLimit, limits.maximumInputTokens) ||
            modelResult.usage.outputTokens > maximumOutputTokens
          ) {
            throw executionError("DREAMING_TOKEN_LIMIT_EXCEEDED", false);
          }

          const plan = validateAndGroundPlan(modelResult.payload, snapshot);
          changes = await dependencies.store.savePlan(
            leaseGuard.state.currentClaim,
            {
              plan,
              provider: modelResult.provider,
              model: modelResult.model,
              inputTokens: modelResult.usage.inputTokens,
              outputTokens: modelResult.usage.outputTokens,
              responseDigest: canonicalDigest(modelResult.payload),
            },
            workSignal,
          );
          throwIfAborted(workSignal);
          assertStoreChanges(claim, plan, changes);
          accounting = {
            inputTokens: modelResult.usage.inputTokens,
            outputTokens: modelResult.usage.outputTokens,
          };
        }

        if (accounting === null) {
          throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
        }
        const currentSettings = await dependencies.store.getSettings(workSignal);
        throwIfAborted(workSignal);
        const canApply =
          claim.run.mode === "apply" &&
          settings.mode === "apply" &&
          currentSettings?.enabled === true &&
          currentSettings.mode === "apply" &&
          currentSettings.timeZone === claim.run.timeZone &&
          accounting.inputTokens <=
            Math.min(currentSettings.dailyInputTokenLimit, limits.maximumInputTokens) &&
          accounting.outputTokens <=
            Math.min(currentSettings.dailyOutputTokenLimit, limits.maximumOutputTokens);
        const pendingChanges = changes.filter(
          (change) =>
            change.status !== "applied" &&
            change.status !== "skipped" &&
            change.status !== "failed",
        );
        const locallyEligible = new Set<number>();
        for (const change of pendingChanges) {
          const reason = snapshot.truncated
            ? "snapshot_truncated"
            : !canApply
              ? "policy_denied"
              : deterministicSkipReason(change.proposal, snapshot);
          if (reason !== null) {
            await persistSkip(
              dependencies.store,
              leaseGuard.state.currentClaim,
              change,
              reason,
              workSignal,
            );
          } else if (change.status === "eligible") {
            locallyEligible.add(change.ordinal);
          } else {
            await persistSkip(
              dependencies.store,
              leaseGuard.state.currentClaim,
              change,
              "policy_denied",
              workSignal,
            );
          }
        }

        if (canApply && !snapshot.truncated) {
          const updateOrdinals = changes.flatMap((change) =>
            locallyEligible.has(change.ordinal) && change.proposal.operation === "update"
              ? [change.ordinal]
              : [],
          );
          const updateInputs = updateOrdinals.map((ordinal) => {
            const proposal = changes[ordinal]?.proposal;
            if (!proposal || proposal.operation !== "update") {
              throw executionError("DREAMING_INTERNAL_FAILED", true);
            }
            const target = snapshot.targetMemories[proposal.targetMemoryIndex];
            if (!target) throw executionError("DREAMING_PLAN_UNGROUNDED", false);
            return { target, proposal, citedQuotes: proposal.sourceQuotes };
          });

          let verificationResults: readonly DreamingVerificationResult[] = [];
          if (updateInputs.length > 0) {
            try {
              const verificationSignal = AbortSignal.any([
                workSignal,
                AbortSignal.timeout(limits.providerTimeoutMs),
              ]);
              verificationResults = await dependencies.verifier.verifyUpdates(
                updateInputs,
                verificationSignal,
              );
            } catch (error) {
              if (workSignal.aborted) throw executionError("DREAMING_ABORTED", true, error);
              throw executionError("DREAMING_VERIFICATION_FAILED", true, error);
            }
            if (verificationResults.length !== updateInputs.length) {
              throw executionError("DREAMING_VERIFICATION_FAILED", true);
            }
          }

          const verifiedUpdates = new Set<number>();
          updateOrdinals.forEach((ordinal, resultIndex) => {
            const result = verificationResults[resultIndex];
            const proposal = changes[ordinal]?.proposal;
            if (
              proposal?.operation === "update" &&
              validateVerificationResult(result, proposal.sourceQuotes.length) &&
              result.supported &&
              result.sameFact &&
              result.contradictionResolved
            ) {
              verifiedUpdates.add(ordinal);
            }
          });

          for (const change of changes) {
            throwIfAborted(workSignal);
            if (change.status !== "eligible" || !locallyEligible.has(change.ordinal)) continue;
            const proposal = change.proposal;
            const verified =
              proposal.operation === "create"
                ? isExtractiveCreate(proposal)
                : verifiedUpdates.has(change.ordinal);
            if (!verified) {
              await persistSkip(
                dependencies.store,
                leaseGuard.state.currentClaim,
                change,
                proposal.operation === "update" ? "verification_failed" : "unsupported_memory",
                workSignal,
              );
              continue;
            }

            let embedding: ContentEmbedding;
            try {
              const recipe = memoryEmbeddingRecipe(proposal.content);
              embedding = await dependencies.embedder.embed(recipe, workSignal);
              if (embedding.contentHash !== recipe.contentHash) {
                throw executionError("DREAMING_EMBEDDING_FAILED", true);
              }
            } catch (error) {
              if (workSignal.aborted) throw executionError("DREAMING_ABORTED", true, error);
              throw executionError("DREAMING_EMBEDDING_FAILED", true, error);
            }
            if (
              !embedding.spaceId ||
              !/^[0-9a-f]{64}$/u.test(embedding.contentHash) ||
              embedding.vector.length !== 1_536 ||
              embedding.vector.some((value) => !Number.isFinite(value))
            ) {
              throw executionError("DREAMING_EMBEDDING_FAILED", true);
            }
            const applied = await dependencies.store.applyEligibleChange(
              leaseGuard.state.currentClaim,
              change.id,
              { embedding, verified: true },
              workSignal,
            );
            if (
              applied.id !== change.id ||
              applied.runId !== claim.run.id ||
              (applied.status !== "applied" && applied.status !== "skipped")
            ) {
              throw executionError("DREAMING_STORE_INTEGRITY_FAILED", true);
            }
          }
        }

        return validateReport(
          leaseGuard.state.currentClaim,
          await dependencies.store.finalizeRun(
            leaseGuard.state.currentClaim,
            { coverageWarnings: snapshot.coverageWarnings },
            workSignal,
          ),
        );
      } catch (error) {
        const failure = leaseGuard.state.lost
          ? executionError("DREAMING_LEASE_LOST", true, error)
          : error instanceof DreamingExecutionError
            ? error
            : executionError("DREAMING_INTERNAL_FAILED", true, error);
        if (!leaseGuard.state.lost) {
          await recordFailure(dependencies.store, leaseGuard.state.currentClaim, failure);
        }
        throw failure;
      } finally {
        await leaseGuard.stop();
      }
    },
  };
}
