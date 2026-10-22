import { createHash, randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  dreamingChangeStatuses,
  dreamingInsightKinds,
  dreamingRunStatuses,
  dreamingSkipReasons,
  evidenceTypes,
  insightConfidences,
  memoryEmbeddingRecipe,
  mutationSources,
} from "../../domain.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  ClaimedDreamingRun,
  ContentEmbedding,
  DreamingChange,
  DreamingMemoryProposal,
  DreamingPlan,
  DreamingReport,
  DreamingReportSelector,
  DreamingRun,
  DreamingSettings,
  DreamingSkipReason,
  DreamingSnapshot,
  DreamingStore,
  Memory,
  PersistedDreamingRunState,
} from "../../domain.js";
import { automationJobs, automationSettings } from "../schema/automation.js";
import {
  decisionPeople,
  decisions,
  memories,
  memoryPeople,
} from "../schema/content.js";
import { embeddingSpaces, memoryEmbeddings } from "../schema/embeddings.js";
import {
  dreamingChangeEvidence,
  dreamingChanges,
  dreamingEvidence,
  dreamingReports,
  dreamingRuns,
} from "../schema/dreaming.js";
import {
  activities,
  activityEvents,
  goalVersions,
  priorityPlanVersionItems,
  priorityPlanVersions,
  reminderVersions,
  taskVersions,
} from "../schema/temporal.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const evidenceIndexesSchema = z
  .array(z.number().int().nonnegative())
  .min(1)
  .max(5)
  .refine((indexes) => new Set(indexes).size === indexes.length);
const insightProposalSchema = z
  .object({
    kind: z.enum(dreamingInsightKinds),
    statement: z.string().trim().min(1).max(2_000),
    confidence: z.enum(insightConfidences),
    evidenceIndexes: evidenceIndexesSchema,
  })
  .strict();
const memoryCreateProposalSchema = z
  .object({
    operation: z.literal("create"),
    content: z.string().trim().min(1).max(10_000),
    category: z.string().trim().min(1).max(100).nullable(),
    tags: z.array(z.string().trim().min(1).max(100)).max(20),
    sourceQuotes: z.array(z.string().min(1).max(1_000)).min(1).max(5),
    evidenceIndexes: evidenceIndexesSchema,
  })
  .strict();
const memoryUpdateProposalSchema = memoryCreateProposalSchema.omit({ operation: true }).extend({
  operation: z.literal("update"),
  targetMemoryIndex: z.number().int().nonnegative(),
});
const memoryProposalSchema = z.discriminatedUnion("operation", [
  memoryCreateProposalSchema,
  memoryUpdateProposalSchema,
]);
const reportCitationSchema = z.object({
  type: z.enum(evidenceTypes),
  id: z.uuid(),
  versionId: z.uuid().nullable(),
  excerpt: z.string().max(300),
});
const reportInsightSchema = z.object({
  kind: z.enum(dreamingInsightKinds),
  statement: z.string().min(1).max(2_000),
  confidence: z.enum(insightConfidences),
  evidence: z.array(reportCitationSchema).max(5),
});
const createdMemorySchema = z.object({ id: z.uuid(), content: z.string().max(10_000) });
const updatedMemorySchema = createdMemorySchema.extend({ previousMemoryId: z.uuid() });
const skippedSchema = z.object({ reason: z.enum(dreamingSkipReasons) });
const mutationSourceSchema = z.enum(mutationSources);

export interface DreamingStoreVersions {
  readonly pipelineVersion: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly policyVersion: string;
}

const DEFAULT_VERSIONS: DreamingStoreVersions = {
  pipelineVersion: "dreaming-pipeline-v1",
  promptVersion: "dreaming-prompt-v1",
  schemaVersion: "dreaming-plan-v1",
  policyVersion: "dreaming-policy-v1",
};

class DreamingLeaseLostError extends Error {
  constructor() {
    super("The dreaming run lease was lost.");
    this.name = "DreamingLeaseLostError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new Error(`${field} must be a UUID.`);
}

function requireInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) {
    throw new Error(`${field} must be a valid ISO timestamp.`);
  }
  return parsed;
}

function requirePositiveInteger(value: number, field: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}.`);
  }
}

function mapRun(row: typeof dreamingRuns.$inferSelect): DreamingRun {
  if (
    !LOCAL_DATE.test(row.localDate) ||
    !dreamingRunStatuses.includes(row.status) ||
    !Number.isInteger(row.inputTokens) ||
    !Number.isInteger(row.outputTokens) ||
    !Number.isInteger(row.attemptCount)
  ) {
    throw new Error("Stored dreaming run data is invalid.");
  }
  return {
    id: row.id,
    replayOfRunId: row.replayOfRunId,
    localDate: row.localDate,
    timeZone: row.timeZone,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    mode: row.mode,
    status: row.status,
    pipelineVersion: row.pipelineVersion,
    promptVersion: row.promptVersion,
    schemaVersion: row.schemaVersion,
    policyVersion: row.policyVersion,
    snapshotHash: row.snapshotHash,
    snapshotTruncated: row.snapshotTruncated,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function mapEvidence(row: typeof dreamingEvidence.$inferSelect) {
  if (!SHA256.test(row.contentHash) || !evidenceTypes.includes(row.type)) {
    throw new Error("Stored dreaming evidence data is invalid.");
  }
  return {
    id: row.id,
    runId: row.runId,
    index: row.evidenceIndex,
    role: row.role,
    type: row.type,
    entityId: row.entityId,
    versionId: row.versionId,
    observedAt: row.observedAt.toISOString(),
    effectiveAt: row.effectiveAt.toISOString(),
    excerpt: row.excerpt,
    contentHash: row.contentHash,
    redactedAt: row.redactedAt?.toISOString() ?? null,
  } as const;
}

export function decodeProposal(value: unknown): DreamingMemoryProposal {
  const result = memoryProposalSchema.safeParse(value);
  if (!result.success) throw new Error("Stored dreaming proposal data is invalid.");
  return result.data;
}

function mapChange(row: typeof dreamingChanges.$inferSelect): DreamingChange {
  if (
    !SHA256.test(row.fingerprint) ||
    !dreamingChangeStatuses.includes(row.status) ||
    (row.skipReason !== null && !dreamingSkipReasons.includes(row.skipReason as DreamingSkipReason))
  ) {
    throw new Error("Stored dreaming change data is invalid.");
  }
  return {
    id: row.id,
    runId: row.runId,
    ordinal: row.ordinal,
    proposal: decodeProposal(row.proposal),
    fingerprint: row.fingerprint,
    expectedTargetHash: row.expectedTargetHash,
    status: row.status,
    resultMemoryId: row.resultMemoryId,
    previousMemoryId: row.previousMemoryId,
    skipReason: row.skipReason as DreamingSkipReason | null,
    appliedAt: row.appliedAt?.toISOString() ?? null,
  };
}

export function mapReport(row: typeof dreamingReports.$inferSelect): DreamingReport {
  const insights = z.array(reportInsightSchema).max(10).safeParse(row.insights);
  const created = z.array(createdMemorySchema).max(20).safeParse(row.memoriesCreated);
  const updated = z.array(updatedMemorySchema).max(20).safeParse(row.memoriesUpdated);
  const skipped = z.array(skippedSchema).max(20).safeParse(row.skipped);
  if (
    !insights.success ||
    !created.success ||
    !updated.success ||
    !skipped.success ||
    created.data.length + updated.data.length > 20 ||
    (row.status !== "completed" && row.status !== "completed_with_skips")
  ) {
    throw new Error("Stored dreaming report data is invalid.");
  }
  return {
    id: row.id,
    runId: row.runId,
    localDate: row.localDate,
    generatedAt: row.generatedAt.toISOString(),
    mode: row.mode,
    status: row.status,
    summary: row.summary,
    insights: insights.data,
    memoriesCreated: created.data,
    memoriesUpdated: updated.data,
    skipped: skipped.data,
    coverageWarnings: row.coverageWarnings,
  };
}

function localParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
  };
}

function utcAtLocalMidnight(localDate: string, timeZone: string): Date {
  if (!LOCAL_DATE.test(localDate)) throw new Error("localDate is invalid.");
  const [yearText, monthText, dayText] = localDate.split("-");
  const desired = Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText));
  const candidates = new Map<number, Date>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = new Date(desired + hours * 3_600_000);
    const local = localParts(sample, timeZone);
    const offset =
      Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) -
      sample.valueOf();
    const candidate = new Date(desired - offset);
    candidates.set(candidate.valueOf(), candidate);
  }
  const exact = [...candidates.values()]
    .filter((candidate) => {
      const local = localParts(candidate, timeZone);
      return (
        local.year === Number(yearText) &&
        local.month === Number(monthText) &&
        local.day === Number(dayText) &&
        local.hour === 0 &&
        local.minute === 0
      );
    })
    .sort((left, right) => left.valueOf() - right.valueOf());
  if (exact[0] === undefined) {
    throw new Error(`Unable to resolve local midnight in time zone ${timeZone}.`);
  }
  return exact[0];
}

function followingLocalDate(localDate: string): string {
  const [yearText, monthText, dayText] = localDate.split("-");
  const day = new Date(
    Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + 1),
  );
  return [
    day.getUTCFullYear().toString().padStart(4, "0"),
    (day.getUTCMonth() + 1).toString().padStart(2, "0"),
    day.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

function actorAttribution(row: {
  actorKind: "account" | "oauth_client" | "import" | "dreaming" | "system";
  actorAccountId: string | null;
  actorClientId: string | null;
  actorSource: string;
}): ActorAttribution {
  const source = mutationSourceSchema.safeParse(row.actorSource);
  if (!source.success) throw new Error("Stored actor attribution is invalid.");
  if (row.actorKind === "account" && row.actorClientId === null) {
    return {
      kind: "account",
      accountId: row.actorAccountId,
      clientId: null,
      source: source.data,
    };
  }
  if (row.actorKind === "oauth_client") {
    if (row.actorAccountId !== null && row.actorClientId !== null) {
      return {
        kind: "oauth_client",
        accountId: row.actorAccountId,
        clientId: row.actorClientId,
        source: source.data,
      };
    }
    if (row.actorAccountId === null && row.actorClientId === null) {
      return {
        kind: "oauth_client",
        accountId: null,
        clientId: null,
        source: source.data,
      };
    }
  }
  if (row.actorKind === "import" && row.actorClientId === null) {
    return {
      kind: "import",
      accountId: row.actorAccountId,
      clientId: null,
      source: source.data,
    };
  }
  if (
    (row.actorKind === "dreaming" || row.actorKind === "system") &&
    row.actorAccountId === null &&
    row.actorClientId === null
  ) {
    return {
      kind: row.actorKind,
      accountId: null,
      clientId: null,
      source: source.data,
    };
  }
  throw new Error("Stored actor attribution is invalid.");
}

const memorySuccessor = alias(memories, "dreaming_memory_successor");

export async function loadMemories(
  transaction: SecondBrainTransaction,
  ids: readonly string[],
): Promise<readonly Memory[]> {
  if (ids.length === 0) return [];
  const rows = await transaction
    .select({
      memory: memories,
      successorId: memorySuccessor.id,
      successorEffectiveAt: memorySuccessor.effectiveAt,
    })
    .from(memories)
    .leftJoin(
      memorySuccessor,
      and(
        eq(memorySuccessor.supersedesId, memories.id),
      ),
    )
    .where(inArray(memories.id, [...ids]));
  const peopleRows = await transaction
    .select({ memoryId: memoryPeople.memoryId, personId: memoryPeople.personId })
    .from(memoryPeople)
    .where(inArray(memoryPeople.memoryId, [...ids]));
  const peopleByMemory = new Map<string, string[]>();
  for (const person of peopleRows) {
    const current = peopleByMemory.get(person.memoryId) ?? [];
    current.push(person.personId);
    peopleByMemory.set(person.memoryId, current);
  }
  const byId = new Map(
    rows.map(({ memory, successorId, successorEffectiveAt }) => [
      memory.id,
      {
        id: memory.id,
        lineageId: memory.lineageId,
        version: memory.versionNumber,
        supersedesId: memory.supersedesId,
        content: memory.content,
        category: memory.category,
        tags: memory.tags,
        projectId: memory.projectId,
        personIds: peopleByMemory.get(memory.id) ?? [],
        effectiveAt: memory.effectiveAt.toISOString(),
        capturedAt: memory.capturedAt?.toISOString() ?? null,
        supersededBy: successorId,
        supersededAt: successorEffectiveAt?.toISOString() ?? null,
        provenance: actorAttribution(memory),
        sourceExcerpt: memory.sourceExcerpt,
        contentHash: memory.contentHash,
        createdAt: memory.createdAt.toISOString(),
      } satisfies Memory,
    ]),
  );
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

function liveClaimPredicate(
  database: SecondBrainTransaction,
  claim: ClaimedDreamingRun,
  _now: Date,
) {
  return exists(
    database
      .select({ id: dreamingRuns.id })
      .from(dreamingRuns)
      .innerJoin(
        automationJobs,
        and(
          eq(automationJobs.id, dreamingRuns.automationJobId),
          eq(automationJobs.kind, "daily_dreaming"),
        ),
      )
      .where(
        and(
          eq(dreamingRuns.id, claim.run.id),
          eq(automationJobs.status, "running"),
          eq(automationJobs.fencingToken, claim.fencingToken),
          isNull(automationJobs.cancelRequestedAt),
          gt(automationJobs.leaseExpiresAt, sql<Date>`clock_timestamp()`),
        ),
      ),
  );
}

/**
 * Locks the automation job that is the authority for a dreaming run.
 *
 * The lock must be acquired before any durable effect and held until commit.
 * A predicate-only fencing check is insufficient because a takeover can update
 * the job after the check but before the surrounding transaction commits.
 */
async function lockLiveClaim(
  transaction: SecondBrainTransaction,
  claim: ClaimedDreamingRun,
): Promise<typeof automationJobs.$inferSelect> {
  if (
    claim.provenance.kind !== "dreaming" ||
    claim.provenance.dreamingRunId !== claim.run.id ||
    claim.provenance.causationId === null
  ) {
    throw new DreamingLeaseLostError();
  }
  const rows = await transaction
    .select({ job: automationJobs })
    .from(dreamingRuns)
    .innerJoin(
      automationJobs,
      and(
        eq(automationJobs.id, dreamingRuns.automationJobId),
        eq(automationJobs.id, claim.provenance.causationId),
        eq(automationJobs.kind, "daily_dreaming"),
      ),
    )
    .where(
      and(
        eq(dreamingRuns.id, claim.run.id),
        eq(automationJobs.status, "running"),
        eq(automationJobs.fencingToken, claim.fencingToken),
        isNull(automationJobs.cancelRequestedAt),
        gt(automationJobs.leaseExpiresAt, sql<Date>`clock_timestamp()`),
      ),
    )
    .for("update", { of: automationJobs })
    .limit(1);
  const authority = rows[0]?.job;
  if (authority === undefined) throw new DreamingLeaseLostError();
  return authority;
}

function claimFrom(
  run: DreamingRun,
  fencingToken: string,
  leaseExpiresAt: Date,
  automationJobId: string,
): ClaimedDreamingRun {
  return {
    run,
    fencingToken,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    provenance: {
      kind: "dreaming",
      accountId: null,
      clientId: null,
      source: "automation",
      requestId: `dreaming:${run.id}`,
      correlationId: run.id,
      causationId: automationJobId,
      dreamingRunId: run.id,
    },
  };
}

export class DrizzleDreamingStore implements DreamingStore {
  private readonly versions: DreamingStoreVersions;

  constructor(
    private readonly database: SecondBrainDatabase,
    versions: Partial<DreamingStoreVersions> = {},
  ) {
    this.versions = { ...DEFAULT_VERSIONS, ...versions };
  }

  async getSettings(signal: AbortSignal): Promise<DreamingSettings | null> {
    signal.throwIfAborted();
    const rows = await this.database
      .select()
      .from(automationSettings)
      .where(eq(automationSettings.id, 1))
      .limit(1);
    signal.throwIfAborted();
    const row = rows[0];
    if (row === undefined) return null;
    return {
        enabled: row.dreamingEnabled,
      timeZone: row.timeZone,
      runAtLocal: row.dreamLocalTime.slice(0, 5),
      mode: row.dreamingMode,
      dailyInputTokenLimit: row.dailyInputTokenLimit,
      dailyOutputTokenLimit: row.dailyOutputTokenLimit,
      revision: row.revision,
      nextRunAt: row.nextDreamAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async claimRun(
    workerId: string,
    input: {
      readonly automationJobId: string;
      readonly now: string;
      readonly leaseSeconds: number;
    },
    signal: AbortSignal,
  ): Promise<ClaimedDreamingRun | null> {
    if (workerId.trim() === "" || workerId.length > 500) {
      throw new Error("workerId must contain between 1 and 500 characters.");
    }
    requireUuid(input.automationJobId, "automationJobId");
    requirePositiveInteger(input.leaseSeconds, "leaseSeconds", 86_400);
    const now = requireInstant(input.now, "now");
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const jobRows = await transaction
        .select({ job: automationJobs, settings: automationSettings })
        .from(automationJobs)
        .innerJoin(
          automationSettings,
          eq(automationSettings.id, 1),
        )
        .where(
          and(
            eq(automationJobs.id, input.automationJobId),
            eq(automationJobs.kind, "daily_dreaming"),
            eq(automationJobs.status, "running"),
            eq(automationJobs.leaseOwner, workerId),
            isNull(automationJobs.cancelRequestedAt),
            gt(automationJobs.leaseExpiresAt, now),
          ),
        )
        .for("update", { of: automationJobs })
        .limit(1);
      const row = jobRows[0];
      if (
        row === undefined ||
        row.job.fencingToken === null ||
        row.job.leaseExpiresAt === null ||
        !row.settings.dreamingEnabled
      ) {
        return null;
      }
      const payload = row.job.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return null;
      }
      const localDateValue = (payload as Record<string, unknown>).localDate;
      if (typeof localDateValue !== "string" || !LOCAL_DATE.test(localDateValue)) {
        return null;
      }
      const localDate = localDateValue;
      const replayOfJobId = (payload as Record<string, unknown>).replayOfJobId;
      let parentRun: typeof dreamingRuns.$inferSelect | undefined;
      if (replayOfJobId !== undefined) {
        if (typeof replayOfJobId !== "string" || !UUID.test(replayOfJobId) || replayOfJobId === row.job.id) return null;
        const [parentJob] = await transaction.select().from(automationJobs).where(and(eq(automationJobs.id, replayOfJobId), eq(automationJobs.kind, "daily_dreaming"), eq(automationJobs.status, "failed"))).limit(1);
        if (!parentJob || (parentJob.payload as Record<string, unknown>)?.localDate !== localDate || row.job.canonicalKey !== `daily_dreaming:retry:${replayOfJobId}`) return null;
        [parentRun] = await transaction.select().from(dreamingRuns).where(eq(dreamingRuns.automationJobId, replayOfJobId)).limit(1);
        const inheritedRunId = (parentJob.payload as Record<string, unknown>)?.replayOfRunId;
        if (!parentRun && typeof inheritedRunId === "string" && UUID.test(inheritedRunId)) {
          [parentRun] = await transaction.select().from(dreamingRuns).where(eq(dreamingRuns.id, inheritedRunId)).limit(1);
        }
        if (parentRun && parentRun.localDate !== localDate) return null;
      }
      const timeZone = parentRun?.timeZone ?? row.settings.timeZone;
      const windowStart = parentRun?.windowStart ?? utcAtLocalMidnight(localDate, timeZone);
      const windowEnd = parentRun?.windowEnd ?? utcAtLocalMidnight(followingLocalDate(localDate), timeZone);
      const inserted = await transaction
        .insert(dreamingRuns)
        .values({
          automationJobId: input.automationJobId,
          localDate,
          replayOfRunId: parentRun?.id ?? null,
          canonical: parentRun === undefined,
          timeZone,
          windowStart,
          windowEnd,
          mode: replayOfJobId === undefined ? row.settings.dreamingMode : "preview",
          settingsRevision: row.settings.revision,
          ...this.versions,
        })
        .onConflictDoNothing()
        .returning();
      const existing =
        inserted.length > 0
          ? inserted
          : await transaction
              .select()
              .from(dreamingRuns)
              .where(
                and(
                  eq(dreamingRuns.automationJobId, input.automationJobId),
                ),
              )
              .limit(1);
      const runRow = existing[0];
      if (runRow === undefined || runRow.status === "failed" || runRow.status === "canceled") {
        return null;
      }
      const nextStatus =
        runRow.status === "pending" || runRow.status === "retryable_failed"
          ? "collecting"
          : runRow.status;
      const updated = await transaction
        .update(dreamingRuns)
        .set({
          status: nextStatus,
          attemptCount: sql`${dreamingRuns.attemptCount} + 1`,
          startedAt: sql`coalesce(${dreamingRuns.startedAt}, ${now})`,
          sanitizedError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(dreamingRuns.id, runRow.id),
          ),
        )
        .returning();
      signal.throwIfAborted();
      return updated[0] === undefined
        ? null
        : claimFrom(
            mapRun(updated[0]),
            row.job.fencingToken,
            row.job.leaseExpiresAt,
            input.automationJobId,
          );
    });
  }

  async renewRunLease(
    claim: ClaimedDreamingRun,
    input: { readonly now: string; readonly leaseSeconds: number },
    signal: AbortSignal,
  ): Promise<ClaimedDreamingRun | null> {
    requireInstant(input.now, "now");
    requirePositiveInteger(input.leaseSeconds, "leaseSeconds", 86_400);
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      let authority: typeof automationJobs.$inferSelect;
      try {
        authority = await lockLiveClaim(transaction, claim);
      } catch (error) {
        if (!(error instanceof DreamingLeaseLostError)) throw error;
        return null;
      }
      const renewed = await transaction
        .update(automationJobs)
        .set({
          leaseExpiresAt: sql<Date>`clock_timestamp() + (${input.leaseSeconds} * interval '1 second')`,
          updatedAt: sql<Date>`clock_timestamp()`,
        })
        .where(
          and(
            eq(automationJobs.id, authority.id),
            eq(automationJobs.kind, "daily_dreaming"),
            eq(automationJobs.status, "running"),
            eq(automationJobs.fencingToken, claim.fencingToken),
            isNull(automationJobs.cancelRequestedAt),
            gt(automationJobs.leaseExpiresAt, sql<Date>`clock_timestamp()`),
          ),
        )
        .returning({ id: automationJobs.id, leaseExpiresAt: automationJobs.leaseExpiresAt });
      signal.throwIfAborted();
      const row = renewed[0];
      return row?.leaseExpiresAt === null || row === undefined
        ? null
        : claimFrom(claim.run, claim.fencingToken, row.leaseExpiresAt, authority.id);
    });
  }

  async captureSnapshot(
    claim: ClaimedDreamingRun,
    input: {
      readonly maximumEvents: number;
      readonly maximumPrimaryRecords: number;
      readonly maximumTargetMemories: number;
      readonly maximumComparisonRecords: number;
      readonly maximumCharacters: number;
    },
    signal: AbortSignal,
  ): Promise<DreamingSnapshot> {
    requirePositiveInteger(input.maximumEvents, "maximumEvents", 1_000);
    requirePositiveInteger(input.maximumPrimaryRecords, "maximumPrimaryRecords", 500);
    requirePositiveInteger(input.maximumTargetMemories, "maximumTargetMemories", 100);
    requirePositiveInteger(input.maximumComparisonRecords, "maximumComparisonRecords", 100);
    requirePositiveInteger(input.maximumCharacters, "maximumCharacters", 200_000);
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      await lockLiveClaim(transaction, claim);
      const runRows = await transaction
        .select()
        .from(dreamingRuns)
        .where(
          and(
            eq(dreamingRuns.id, claim.run.id),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .for("update")
        .limit(1);
      const runRow = runRows[0];
      if (runRow === undefined) throw new Error("The dreaming run lease was lost.");
      const existing = await transaction
        .select()
        .from(dreamingEvidence)
        .where(
          and(
            eq(dreamingEvidence.runId, claim.run.id),
          ),
        )
        .orderBy(asc(dreamingEvidence.evidenceIndex));
      if (existing.length > 0) {
        return this.snapshotFromRows(transaction, runRow, existing);
      }

      const eventRows = await transaction
        .select()
        .from(activityEvents)
        .where(
          and(
            gte(activityEvents.occurredAt, runRow.windowStart),
            lt(activityEvents.occurredAt, runRow.windowEnd),
            eq(activityEvents.analysisAllowed, true),
            isNull(activityEvents.redactedAt),
            ne(activityEvents.actorKind, "dreaming"),
            isNull(activityEvents.dreamingRunId),
          ),
        )
        .orderBy(asc(activityEvents.occurredAt), asc(activityEvents.id))
        .limit(input.maximumEvents + 1);
      const consideredEvents = eventRows.slice(0, input.maximumEvents);
      const versionIds = consideredEvents.flatMap((event) =>
        event.afterVersionId === null ? [] : [event.afterVersionId],
      );
      const entityIds = consideredEvents.map((event) => event.entityId);
      const [memoryRows, decisionRows, taskRows, reminderRows, goalRows, planRows, activityRows] =
        await Promise.all([
          entityIds.length === 0
            ? []
            : transaction
                .select()
                .from(memories)
                .where(
                  and(
                            inArray(memories.id, entityIds),
                    ne(memories.actorKind, "dreaming"),
                  ),
                ),
          entityIds.length === 0
            ? []
            : transaction
                .select()
                .from(decisions)
                .where(
                  and(
                    inArray(decisions.id, entityIds),
                    ne(decisions.actorKind, "dreaming"),
                  ),
                ),
          versionIds.length === 0
            ? []
            : transaction
                .select()
                .from(taskVersions)
                .where(
                  and(
                    inArray(taskVersions.id, versionIds),
                  ),
                ),
          versionIds.length === 0
            ? []
            : transaction
                .select()
                .from(reminderVersions)
                .where(
                  and(
                    inArray(reminderVersions.id, versionIds),
                  ),
                ),
          versionIds.length === 0
            ? []
            : transaction
                .select()
                .from(goalVersions)
                .where(
                  and(
                    inArray(goalVersions.id, versionIds),
                  ),
                ),
          versionIds.length === 0
            ? []
            : transaction
                .select()
                .from(priorityPlanVersions)
                .where(
                  and(
                    inArray(priorityPlanVersions.id, versionIds),
                  ),
                ),
          entityIds.length === 0
            ? []
            : transaction
                .select()
                .from(activities)
                .where(
                  and(
                    inArray(activities.id, entityIds),
                    eq(activities.analysisAllowed, true),
                    isNull(activities.retractedAt),
                    ne(activities.actorKind, "dreaming"),
                  ),
                ),
        ]);
      const byId = <T extends { id: string }>(rows: readonly T[]) =>
        new Map(rows.map((row) => [row.id, row]));
      const memoryMap = byId(memoryRows);
      const decisionMap = byId(decisionRows);
      const taskMap = byId(taskRows);
      const reminderMap = byId(reminderRows);
      const goalMap = byId(goalRows);
      const planMap = byId(planRows);
      const activityMap = byId(activityRows);
      type EvidenceInsert = typeof dreamingEvidence.$inferInsert;
      const evidence: EvidenceInsert[] = [];
      let serializedCharacters = 0;
      let truncated = eventRows.length > input.maximumEvents;
      let unsupportedEvents = 0;
      const append = (candidate: Omit<EvidenceInsert, "runId" | "evidenceIndex">) => {
        if (candidate.excerpt.length > 2_000) candidate.excerpt = candidate.excerpt.slice(0, 2_000);
        const serialized = JSON.stringify({
          ...candidate,
          id: "00000000-0000-4000-8000-000000000000",
            runId: claim.run.id,
          index: evidence.length,
          observedAt: (candidate.observedAt as Date).toISOString(),
          effectiveAt: (candidate.effectiveAt as Date).toISOString(),
          redactedAt: null,
        }).length;
        if (serializedCharacters + serialized + 256 > input.maximumCharacters) {
          truncated = true;
          return false;
        }
        evidence.push({
          ...candidate,
            runId: claim.run.id,
          evidenceIndex: evidence.length,
        });
        serializedCharacters += serialized;
        return true;
      };
      for (const event of consideredEvents) {
        if (evidence.filter((item) => item.role === "primary").length >= input.maximumPrimaryRecords) {
          truncated = true;
          break;
        }
        const versionId = event.afterVersionId;
        let excerpt: string | null = null;
        let type: typeof dreamingEvidence.$inferInsert.type | null = null;
        let effectiveAt = event.effectiveAt;
        if (event.entityType === "memory") {
          const row = memoryMap.get(event.entityId);
          if (row) {
            type = "memory";
            excerpt = row.content;
            effectiveAt = row.effectiveAt;
          }
        } else if (event.entityType === "decision") {
          const row = decisionMap.get(event.entityId);
          if (row) {
            type = "decision";
            excerpt = `Decision: ${row.statement}\nRationale: ${row.rationale}`;
            effectiveAt = row.decidedAt;
          }
        } else if (event.entityType === "task" && versionId !== null) {
          const row = taskMap.get(versionId);
          if (row) {
            type = "task";
            excerpt = `Task: ${row.title}\nStatus: ${row.status}\nPriority: ${row.priority}${row.description ? `\nDescription: ${row.description}` : ""}`;
            effectiveAt = row.effectiveAt;
          }
        } else if (event.entityType === "reminder" && versionId !== null) {
          const row = reminderMap.get(versionId);
          if (row) {
            type = "reminder";
            excerpt = `Reminder: ${row.message}\nRemind at: ${row.remindAt.toISOString()}\nCompleted: ${row.completedAt !== null}`;
            effectiveAt = row.effectiveAt;
          }
        } else if (event.entityType === "goal" && versionId !== null) {
          const row = goalMap.get(versionId);
          if (row) {
            type = "goal";
            excerpt = `Goal: ${row.title}\nStatus: ${row.status}${row.description ? `\nDescription: ${row.description}` : ""}`;
            effectiveAt = row.effectiveAt;
          }
        } else if (event.entityType === "priority_plan" && versionId !== null) {
          const row = planMap.get(versionId);
          if (row) {
            type = "priority_plan";
            excerpt = `Priority plan ${row.periodStart.toISOString()} to ${row.periodEnd.toISOString()}${row.note ? `\nNote: ${row.note}` : ""}`;
            effectiveAt = row.effectiveAt;
          }
        } else if (event.entityType === "activity") {
          const row = activityMap.get(event.entityId);
          if (row) {
            type = "activity";
            excerpt = `Activity: ${row.kind}${row.summary ? `\nSummary: ${row.summary}` : ""}`;
            effectiveAt = row.occurredAt;
          }
        }
        if (type === null || excerpt === null || excerpt.trim() === "") {
          unsupportedEvents += 1;
          continue;
        }
        if (
          !append({
            role: "primary",
            type,
            entityId: event.entityId,
            versionId,
            observedAt: event.occurredAt,
            effectiveAt,
            excerpt,
            contentHash: sha256(excerpt),
          })
        ) {
          break;
        }
      }
      const comparisonRows = await transaction
        .select()
        .from(memories)
        .where(
          and(
            lt(memories.effectiveAt, runRow.windowStart),
            ne(memories.actorKind, "dreaming"),
          ),
        )
        .orderBy(desc(memories.effectiveAt), desc(memories.id))
        .limit(input.maximumComparisonRecords + 1);
      if (comparisonRows.length > input.maximumComparisonRecords) truncated = true;
      for (const memory of comparisonRows.slice(0, input.maximumComparisonRecords)) {
        if (
          !append({
            role: "comparison",
            type: "memory",
            entityId: memory.id,
            versionId: memory.id,
            observedAt: memory.createdAt,
            effectiveAt: memory.effectiveAt,
            excerpt: memory.content,
            contentHash: memory.contentHash,
          })
        ) {
          break;
        }
      }
      const currentTargetRows = await transaction
        .select()
        .from(memories)
        .where(
          and(
            ne(memories.actorKind, "dreaming"),
            notExists(
              transaction
                .select({ id: memorySuccessor.id })
                .from(memorySuccessor)
                .where(
                  and(
                                eq(memorySuccessor.supersedesId, memories.id),
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(memories.effectiveAt), desc(memories.id))
        .limit(input.maximumTargetMemories + 1);
      if (currentTargetRows.length > input.maximumTargetMemories) truncated = true;
      const targetIds: string[] = [];
      for (const memory of currentTargetRows.slice(0, input.maximumTargetMemories)) {
        if (
          !append({
            role: "memory_target",
            type: "memory",
            entityId: memory.id,
            versionId: memory.id,
            observedAt: memory.createdAt,
            effectiveAt: memory.effectiveAt,
            excerpt: memory.content,
            contentHash: memory.contentHash,
          })
        ) {
          break;
        }
        targetIds.push(memory.id);
      }
      let targetMemories = await loadMemories(transaction, targetIds);
      while (
        targetIds.length > 0 &&
        serializedCharacters + JSON.stringify(targetMemories).length > input.maximumCharacters
      ) {
        truncated = true;
        targetIds.pop();
        const removed = evidence.pop();
        if (removed?.role !== "memory_target") {
          throw new Error("The dreaming target evidence order is invalid.");
        }
        serializedCharacters -= JSON.stringify({
          ...removed,
          id: "00000000-0000-4000-8000-000000000000",
          index: evidence.length,
          observedAt: (removed.observedAt as Date).toISOString(),
          effectiveAt: (removed.effectiveAt as Date).toISOString(),
          redactedAt: null,
        }).length;
        targetMemories = await loadMemories(transaction, targetIds);
      }
      serializedCharacters += JSON.stringify(targetMemories).length;
      if (evidence.length > 0) await transaction.insert(dreamingEvidence).values(evidence);
      const snapshotHash = sha256(
        JSON.stringify(
          evidence.map((item) => ({
            index: item.evidenceIndex,
            role: item.role,
            type: item.type,
            entityId: item.entityId,
            versionId: item.versionId ?? null,
            observedAt: (item.observedAt as Date).toISOString(),
            effectiveAt: (item.effectiveAt as Date).toISOString(),
            contentHash: item.contentHash,
          })),
        ),
      );
      const warnings = [
        ...(truncated ? ["The daily evidence snapshot was truncated by configured limits."] : []),
        ...(unsupportedEvents > 0
          ? [`${unsupportedEvents} activity events had no supported immutable record.`]
          : []),
      ];
      const updatedRuns = await transaction
        .update(dreamingRuns)
        .set({
          status: "analyzing",
          snapshotHash,
          snapshotTruncated: truncated,
          coverageWarnings: warnings,
          updatedAt: now,
        })
        .where(
          and(
            eq(dreamingRuns.id, claim.run.id),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .returning();
      if (updatedRuns[0] === undefined) throw new Error("The dreaming run lease was lost.");
      const persistedRows = await transaction
        .select()
        .from(dreamingEvidence)
        .where(
          and(
            eq(dreamingEvidence.runId, claim.run.id),
          ),
        )
        .orderBy(asc(dreamingEvidence.evidenceIndex));
      signal.throwIfAborted();
      const snapshot = await this.snapshotFromRows(transaction, updatedRuns[0], persistedRows);
      if (snapshot.targetMemories.map((memory) => memory.id).join() !== targetIds.join()) {
        throw new Error("The persisted dreaming target order is invalid.");
      }
      return snapshot;
    });
  }

  private async snapshotFromRows(
    transaction: SecondBrainTransaction,
    runRow: typeof dreamingRuns.$inferSelect,
    rows: readonly (typeof dreamingEvidence.$inferSelect)[],
  ): Promise<DreamingSnapshot> {
    const evidence = rows.map(mapEvidence);
    const targetIds = rows
      .filter((row) => row.role === "memory_target" && row.redactedAt === null)
      .map((row) => row.entityId);
    const targetMemories = await loadMemories(transaction, targetIds);
    return {
      run: mapRun(runRow),
      evidence,
      targetMemories,
      serializedCharacters: JSON.stringify({ evidence, targetMemories }).length,
      truncated: runRow.snapshotTruncated,
      coverageWarnings: runRow.coverageWarnings,
    };
  }

  async savePlan(
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
  ): Promise<readonly DreamingChange[]> {
    const planResult = z
      .object({
        summary: z.string().trim().min(1).max(2_000),
        insights: z.array(insightProposalSchema).max(10),
        memories: z.array(memoryProposalSchema).max(20),
      })
      .strict()
      .safeParse(input.plan);
    if (!planResult.success) throw new Error("The dreaming plan is invalid.");
    if (!SHA256.test(input.responseDigest)) {
      throw new Error("responseDigest must be a lowercase SHA-256 digest.");
    }
    if (input.provider.trim() === "" || input.provider.length > 200) {
      throw new Error("provider must contain between 1 and 200 characters.");
    }
    if (input.model.trim() === "" || input.model.length > 500) {
      throw new Error("model must contain between 1 and 500 characters.");
    }
    requirePositiveInteger(input.inputTokens + 1, "inputTokens plus one", 10_000_001);
    requirePositiveInteger(input.outputTokens + 1, "outputTokens plus one", 1_000_001);
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      await lockLiveClaim(transaction, claim);
      const runRows = await transaction
        .select()
        .from(dreamingRuns)
        .where(
          and(
            eq(dreamingRuns.id, claim.run.id),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .for("update")
        .limit(1);
      const run = runRows[0];
      if (run === undefined || run.snapshotHash === null) {
        throw new Error("The dreaming snapshot is not persisted or the lease was lost.");
      }
      const existing = await transaction
        .select()
        .from(dreamingChanges)
        .where(
          and(
            eq(dreamingChanges.runId, claim.run.id),
          ),
        )
        .orderBy(asc(dreamingChanges.ordinal));
      if (existing.length > 0) {
        if (
          run.provider !== input.provider ||
          run.model !== input.model ||
          run.inputTokens !== input.inputTokens ||
          run.outputTokens !== input.outputTokens ||
          run.planSummary !== planResult.data.summary ||
          JSON.stringify(run.planInsights) !== JSON.stringify(planResult.data.insights) ||
          existing.length !== planResult.data.memories.length ||
          existing.some(
            (row, index) =>
              JSON.stringify(row.proposal) !==
              JSON.stringify(planResult.data.memories[index]),
          )
        ) {
          throw new Error("A different dreaming plan is already persisted for this run.");
        }
        return existing.map(mapChange);
      }
      const evidenceRows = await transaction
        .select()
        .from(dreamingEvidence)
        .where(
          and(
            eq(dreamingEvidence.runId, claim.run.id),
            isNull(dreamingEvidence.redactedAt),
          ),
        )
        .orderBy(asc(dreamingEvidence.evidenceIndex));
      const evidenceByIndex = new Map(evidenceRows.map((row) => [row.evidenceIndex, row]));
      const targetRows = evidenceRows.filter((row) => row.role === "memory_target");
      const insertedChanges: (typeof dreamingChanges.$inferSelect)[] = [];
      for (const [ordinal, proposal] of planResult.data.memories.entries()) {
        const cited = proposal.evidenceIndexes.map((index) => evidenceByIndex.get(index));
        const allCitationsValid = cited.every((row) => row !== undefined);
        const target =
          proposal.operation === "update"
            ? targetRows[proposal.targetMemoryIndex]
            : undefined;
        let status: "eligible" | "skipped" = "eligible";
        let skipReason: DreamingSkipReason | null = null;
        if (!allCitationsValid) {
          status = "skipped";
          skipReason = "invalid_evidence";
        } else if (proposal.operation === "update" && target === undefined) {
          status = "skipped";
          skipReason = "target_missing";
        } else if (proposal.operation === "create") {
          const duplicates = await transaction
            .select({ id: memories.id })
            .from(memories)
            .where(
              and(
                    eq(memories.contentHash, memoryEmbeddingRecipe(proposal.content).contentHash),
                notExists(
                  transaction
                    .select({ id: memorySuccessor.id })
                    .from(memorySuccessor)
                    .where(
                      and(
                                        eq(memorySuccessor.supersedesId, memories.id),
                      ),
                    ),
                ),
              ),
            )
            .limit(1);
          if (duplicates.length > 0) {
            status = "skipped";
            skipReason = "duplicate_memory";
          }
        }
        const targetMemory =
          target === undefined
            ? undefined
            : (
                await transaction
                  .select({
                    id: memories.id,
                    contentHash: memories.contentHash,
                    version: memories.versionNumber,
                  })
                  .from(memories)
                  .where(
                    and(
                                eq(memories.id, target.entityId),
                    ),
                  )
                  .limit(1)
              )[0];
        if (proposal.operation === "update" && targetMemory === undefined) {
          status = "skipped";
          skipReason = "target_missing";
        }
        const fingerprint = sha256(
          JSON.stringify({
            runId: claim.run.id,
            ordinal,
            responseDigest: input.responseDigest,
            proposal,
          }),
        );
        const created = await transaction
          .insert(dreamingChanges)
          .values({
                runId: claim.run.id,
            ordinal,
            operation: proposal.operation,
            proposal,
            fingerprint,
            expectedTargetMemoryId: targetMemory?.id ?? null,
            expectedTargetHash: targetMemory?.contentHash ?? null,
            expectedTargetVersion: targetMemory?.version ?? null,
            status,
            skipReason,
          })
          .returning();
        const createdRow = created[0];
        if (createdRow === undefined) throw new Error("The dreaming change was not stored.");
        insertedChanges.push(createdRow);
        const validEvidence = cited.filter((row) => row !== undefined);
        if (validEvidence.length > 0) {
          await transaction.insert(dreamingChangeEvidence).values(
            validEvidence.map((row) => ({
                    runId: claim.run.id,
              changeId: createdRow.id,
              evidenceId: row.id,
            })),
          );
        }
      }
      const updated = await transaction
        .update(dreamingRuns)
        .set({
          status: "verifying",
          planSummary: planResult.data.summary,
          planInsights: planResult.data.insights,
          provider: input.provider,
          model: input.model,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          updatedAt: now,
        })
        .where(
          and(
            eq(dreamingRuns.id, claim.run.id),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .returning({ id: dreamingRuns.id });
      if (updated.length !== 1) throw new Error("The dreaming run lease was lost.");
      signal.throwIfAborted();
      return insertedChanges.map(mapChange);
    });
  }

  async loadPersistedRun(
    claim: ClaimedDreamingRun,
    signal: AbortSignal,
  ): Promise<PersistedDreamingRunState | null> {
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      const runRows = await transaction
        .select()
        .from(dreamingRuns)
        .where(
          and(
            eq(dreamingRuns.id, claim.run.id),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .limit(1);
      const run = runRows[0];
      if (run === undefined || run.snapshotHash === null) return null;
      const [evidenceRows, changeRows] = await Promise.all([
        transaction
          .select()
          .from(dreamingEvidence)
          .where(
            and(
                eq(dreamingEvidence.runId, claim.run.id),
            ),
          )
          .orderBy(asc(dreamingEvidence.evidenceIndex)),
        transaction
          .select()
          .from(dreamingChanges)
          .where(
            and(
                eq(dreamingChanges.runId, claim.run.id),
            ),
          )
          .orderBy(asc(dreamingChanges.ordinal)),
      ]);
      signal.throwIfAborted();
      return {
        run: mapRun(run),
        snapshot: await this.snapshotFromRows(transaction, run, evidenceRows),
        changes: changeRows.map(mapChange),
      };
    });
  }

  async skipChange(
    claim: ClaimedDreamingRun,
    changeId: string,
    reason: DreamingSkipReason,
    signal: AbortSignal,
  ): Promise<DreamingChange | null> {
    requireUuid(changeId, "changeId");
    if (!dreamingSkipReasons.includes(reason)) throw new Error("Invalid dreaming skip reason.");
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      await lockLiveClaim(transaction, claim);
      const rows = await transaction
        .update(dreamingChanges)
        .set({ status: "skipped", skipReason: reason, updatedAt: now })
        .where(
          and(
            eq(dreamingChanges.runId, claim.run.id),
            eq(dreamingChanges.id, changeId),
            inArray(dreamingChanges.status, ["proposed", "eligible"]),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .returning();
      if (rows[0] !== undefined) return mapChange(rows[0]);
      const existing = await transaction
        .select()
        .from(dreamingChanges)
        .where(
          and(
            eq(dreamingChanges.runId, claim.run.id),
            eq(dreamingChanges.id, changeId),
            eq(dreamingChanges.status, "skipped"),
            eq(dreamingChanges.skipReason, reason),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      return existing[0] === undefined ? null : mapChange(existing[0]);
    });
  }

  async applyEligibleChange(
    claim: ClaimedDreamingRun,
    changeId: string,
    input: { readonly embedding: ContentEmbedding; readonly verified: boolean },
    signal: AbortSignal,
  ): Promise<DreamingChange> {
    requireUuid(changeId, "changeId");
    requireUuid(input.embedding.spaceId, "embedding.spaceId");
    if (!SHA256.test(input.embedding.contentHash)) {
      throw new Error("embedding.contentHash must be a lowercase SHA-256 digest.");
    }
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      await lockLiveClaim(transaction, claim);
      const settingsRows = await transaction
        .select()
        .from(automationSettings)
        .where(eq(automationSettings.id, 1))
        .for("update")
        .limit(1);
      const settings = settingsRows[0];
      if (settings === undefined) throw new Error("The dreaming settings are unavailable.");
      const changeRows = await transaction
        .select({ change: dreamingChanges, run: dreamingRuns })
        .from(dreamingChanges)
        .innerJoin(
          dreamingRuns,
          and(
            eq(dreamingRuns.id, dreamingChanges.runId),
          ),
        )
        .where(
          and(
            eq(dreamingChanges.runId, claim.run.id),
            eq(dreamingChanges.id, changeId),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .for("update", { of: dreamingChanges })
        .limit(1);
      const joined = changeRows[0];
      if (joined === undefined) throw new Error("The dreaming run lease was lost.");
      if (joined.change.status === "applied") return mapChange(joined.change);
      if (joined.change.status === "skipped" || joined.change.status === "failed") {
        return mapChange(joined.change);
      }
      const skip = async (reason: DreamingSkipReason) => {
        const rows = await transaction
          .update(dreamingChanges)
          .set({ status: "skipped", skipReason: reason, updatedAt: now })
          .where(
            and(
                eq(dreamingChanges.runId, claim.run.id),
              eq(dreamingChanges.id, changeId),
              inArray(dreamingChanges.status, ["proposed", "eligible"]),
              liveClaimPredicate(transaction, claim, now),
            ),
          )
          .returning();
        if (rows[0] === undefined) throw new Error("The dreaming change was not skipped.");
        return mapChange(rows[0]);
      };
      if (
        !input.verified ||
        joined.run.mode !== "apply" ||
        joined.run.snapshotTruncated ||
        !settings.dreamingEnabled ||
        settings.dreamingMode !== "apply" ||
        settings.revision < joined.run.settingsRevision ||
        joined.run.inputTokens > settings.dailyInputTokenLimit ||
        joined.run.outputTokens > settings.dailyOutputTokenLimit
      ) {
        return skip(input.verified ? "policy_denied" : "verification_failed");
      }
      if (joined.change.status !== "eligible") return skip("policy_denied");
      const proposal = decodeProposal(joined.change.proposal);
      const recipe = memoryEmbeddingRecipe(proposal.content);
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dreaming-content:${recipe.contentHash}`}, 0))`);
      if (input.embedding.contentHash !== recipe.contentHash) {
        throw new Error("The embedding content hash does not match the proposal.");
      }
      const spaces = await transaction
        .select()
        .from(embeddingSpaces)
        .where(
          and(
            eq(embeddingSpaces.id, input.embedding.spaceId),
            eq(embeddingSpaces.entityType, "memory"),
            eq(embeddingSpaces.status, "active"),
            eq(embeddingSpaces.recipeVersion, recipe.recipeVersion),
          ),
        )
        .limit(1);
      const space = spaces[0];
      if (
        space === undefined ||
        input.embedding.vector.length !== space.dimensions ||
        input.embedding.vector.some((value) => !Number.isFinite(value)) ||
        Math.hypot(...input.embedding.vector) === 0
      ) {
        throw new Error("The memory embedding is invalid for the active space.");
      }
      if (proposal.operation === "create") {
        const duplicates = await transaction
          .select({ id: memories.id })
          .from(memories)
          .where(
            and(
                eq(memories.contentHash, recipe.contentHash),
              notExists(
                transaction
                  .select({ id: memorySuccessor.id })
                  .from(memorySuccessor)
                  .where(
                    and(
                                    eq(memorySuccessor.supersedesId, memories.id),
                    ),
                  ),
              ),
            ),
          )
          .for("update")
          .limit(1);
        if (duplicates.length > 0) return skip("duplicate_memory");
      }
      let previousMemoryId: string | null = null;
      let lineageId: string = randomUUID();
      let versionNumber = 1;
      let projectId: string | null = null;
      let personIds: string[] = [];
      let effectiveAt = joined.run.windowEnd;
      if (proposal.operation === "update") {
        const targetRows = await transaction
          .select()
          .from(memories)
          .where(
            and(
                eq(memories.id, joined.change.expectedTargetMemoryId!),
              eq(memories.contentHash, joined.change.expectedTargetHash!),
              eq(memories.versionNumber, joined.change.expectedTargetVersion!),
              notExists(
                transaction
                  .select({ id: memorySuccessor.id })
                  .from(memorySuccessor)
                  .where(
                    and(
                                    eq(memorySuccessor.supersedesId, memories.id),
                    ),
                  ),
              ),
            ),
          )
          .for("update")
          .limit(1);
        const target = targetRows[0];
        if (target === undefined) return skip("target_stale");
        const citedRows = await transaction
          .select({ evidence: dreamingEvidence })
          .from(dreamingChangeEvidence)
          .innerJoin(
            dreamingEvidence,
            and(
              eq(dreamingEvidence.runId, dreamingChangeEvidence.runId),
              eq(dreamingEvidence.id, dreamingChangeEvidence.evidenceId),
            ),
          )
          .where(
            and(
              eq(dreamingChangeEvidence.runId, claim.run.id),
              eq(dreamingChangeEvidence.changeId, changeId),
              eq(dreamingEvidence.role, "primary"),
              isNull(dreamingEvidence.redactedAt),
            ),
          );
        if (!citedRows.some((row) => row.evidence.effectiveAt > target.effectiveAt)) {
          return skip("target_newer_than_evidence");
        }
        const targetPeople = await transaction
          .select({ personId: memoryPeople.personId })
          .from(memoryPeople)
          .where(
            and(
              eq(memoryPeople.memoryId, target.id),
            ),
          );
        previousMemoryId = target.id;
        lineageId = target.lineageId;
        versionNumber = target.versionNumber + 1;
        projectId = target.projectId;
        personIds = targetPeople.map((row) => row.personId);
        effectiveAt = new Date(
          Math.max(joined.run.windowEnd.valueOf(), target.effectiveAt.valueOf() + 1),
        );
      }
      const memoryId = randomUUID();
      await transaction.insert(memories).values({
        id: memoryId,
        lineageId: proposal.operation === "create" ? memoryId : lineageId,
        versionNumber,
        supersedesId: previousMemoryId,
        content: proposal.content,
        contentHash: recipe.contentHash,
        category: proposal.category,
        tags: [...proposal.tags],
        projectId,
        sourceExcerpt: proposal.sourceQuotes.join("\n").slice(0, 2_000),
        effectiveAt,
        capturedAt: joined.run.windowEnd,
        actorKind: "dreaming",
        actorAccountId: null,
        actorClientId: null,
        actorSource: "automation",
      });
      if (personIds.length > 0) {
        await transaction.insert(memoryPeople).values(
          personIds.map((personId) => ({
                memoryId,
            personId,
          })),
        );
      }
      await transaction.insert(memoryEmbeddings).values({
        memoryId,
        spaceId: space.id,
        contentHash: recipe.contentHash,
        recipeVersion: recipe.recipeVersion,
        embedding: [...input.embedding.vector],
      });
      const eventId = randomUUID();
      await transaction.insert(activityEvents).values({
        id: eventId,
        entityType: "memory",
        entityId: memoryId,
        action: previousMemoryId === null ? "created" : "superseded",
        occurredAt: now,
        effectiveAt,
        changedFields: previousMemoryId === null ? ["content"] : ["content", "version"],
        afterVersionId: memoryId,
        contentHash: recipe.contentHash,
        requestDigest: sha256(
          JSON.stringify({ changeId, fingerprint: joined.change.fingerprint }),
        ),
        analysisAllowed: false,
        idempotencyKey: `dreaming-change:${joined.change.fingerprint}`,
        actorKind: "dreaming",
        actorAccountId: null,
        actorClientId: null,
        actorSource: "automation",
        requestId: claim.provenance.requestId,
        correlationId: claim.provenance.correlationId,
        causationId: claim.provenance.causationId,
        dreamingRunId: claim.run.id,
      });
      const applied = await transaction
        .update(dreamingChanges)
        .set({
          status: "applied",
          resultMemoryId: memoryId,
          previousMemoryId,
          activityEventId: eventId,
          appliedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(dreamingChanges.runId, claim.run.id),
            eq(dreamingChanges.id, changeId),
            eq(dreamingChanges.status, "eligible"),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .returning();
      if (applied[0] === undefined) throw new Error("The dreaming run lease was lost.");
      signal.throwIfAborted();
      return mapChange(applied[0]);
    });
  }

  async finalizeRun(
    claim: ClaimedDreamingRun,
    input: { readonly coverageWarnings: readonly string[] },
    signal: AbortSignal,
  ): Promise<DreamingReport> {
    if (
      input.coverageWarnings.length > 20 ||
      input.coverageWarnings.some((warning) => warning.length > 500)
    ) {
      throw new Error("coverageWarnings exceeds the report bounds.");
    }
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      await lockLiveClaim(transaction, claim);
      const existingReports = await transaction
        .select()
        .from(dreamingReports)
        .where(
          and(
            eq(dreamingReports.runId, claim.run.id),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .limit(1);
      if (existingReports[0] !== undefined) return mapReport(existingReports[0]);
      const runRows = await transaction
        .select()
        .from(dreamingRuns)
        .where(
          and(
            eq(dreamingRuns.id, claim.run.id),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .for("update")
        .limit(1);
      const run = runRows[0];
      if (run === undefined || run.planSummary === null || run.planInsights === null) {
        throw new Error("The dreaming run cannot be finalized without a stored plan.");
      }
      const insightResult = z.array(insightProposalSchema).max(10).safeParse(run.planInsights);
      if (!insightResult.success) throw new Error("The stored dreaming insights are invalid.");
      const evidenceRows = await transaction
        .select()
        .from(dreamingEvidence)
        .where(
          and(
            eq(dreamingEvidence.runId, claim.run.id),
          ),
        );
      const evidenceByIndex = new Map(
        evidenceRows
          .filter((row) => row.redactedAt === null)
          .map((row) => [row.evidenceIndex, row]),
      );
      const insights = insightResult.data.flatMap((insight) => {
        const cited = insight.evidenceIndexes.map((index) => evidenceByIndex.get(index));
        if (cited.some((row) => row === undefined)) return [];
        return [
          {
            kind: insight.kind,
            statement: insight.statement,
            confidence: insight.confidence,
            evidence: cited.map((row) => ({
              type: row!.type,
              id: row!.entityId,
              versionId: row!.versionId,
              excerpt: row!.excerpt.slice(0, 300),
            })),
          },
        ];
      });
      await transaction
        .update(dreamingChanges)
        .set({ status: "skipped", skipReason: "policy_denied", updatedAt: now })
        .where(
          and(
            eq(dreamingChanges.runId, claim.run.id),
            inArray(dreamingChanges.status, ["proposed", "eligible"]),
          ),
        );
      const changeRows = await transaction
        .select()
        .from(dreamingChanges)
        .where(
          and(
            eq(dreamingChanges.runId, claim.run.id),
          ),
        )
        .orderBy(asc(dreamingChanges.ordinal));
      const appliedIds = changeRows.flatMap((row) =>
        row.status === "applied" && row.resultMemoryId !== null ? [row.resultMemoryId] : [],
      );
      const appliedMemoryRows =
        appliedIds.length === 0
          ? []
          : await transaction
              .select({ id: memories.id, content: memories.content })
              .from(memories)
              .where(
                and(
                        inArray(memories.id, appliedIds),
                ),
              );
      const memoryById = new Map(appliedMemoryRows.map((row) => [row.id, row]));
      const memoriesCreated = changeRows.flatMap((change) => {
        if (
          change.status !== "applied" ||
          change.operation !== "create" ||
          change.resultMemoryId === null
        ) {
          return [];
        }
        const memory = memoryById.get(change.resultMemoryId);
        return memory === undefined ? [] : [memory];
      });
      const memoriesUpdated = changeRows.flatMap((change) => {
        if (
          change.status !== "applied" ||
          change.operation !== "update" ||
          change.resultMemoryId === null ||
          change.previousMemoryId === null
        ) {
          return [];
        }
        const memory = memoryById.get(change.resultMemoryId);
        return memory === undefined
          ? []
          : [
              {
                id: memory.id,
                previousMemoryId: change.previousMemoryId,
                content: memory.content,
              },
            ];
      });
      const skipped = changeRows
        .filter((change) => change.status === "skipped" && change.skipReason !== null)
        .slice(0, 20)
        .map((change) => ({ reason: change.skipReason as DreamingSkipReason }));
      const coverageWarnings = [
        ...new Set([
          ...run.coverageWarnings,
          ...input.coverageWarnings,
          ...(insights.length < insightResult.data.length
            ? ["Some insights were omitted because cited evidence was redacted."]
            : []),
        ]),
      ].slice(0, 20);
      const status = skipped.length > 0 ? "completed_with_skips" : "completed";
      const reports = await transaction
        .insert(dreamingReports)
        .values({
            runId: claim.run.id,
          localDate: run.localDate,
          mode: run.mode,
          status,
          summary: run.planSummary,
          insights,
          memoriesCreated: memoriesCreated.slice(0, 20),
          memoriesUpdated: memoriesUpdated.slice(0, 20 - memoriesCreated.length),
          skipped,
          coverageWarnings,
          generatedAt: now,
        })
        .returning();
      const report = reports[0];
      if (report === undefined) throw new Error("The dreaming report was not stored.");
      const updated = await transaction
        .update(dreamingRuns)
        .set({ status, coverageWarnings, completedAt: now, updatedAt: now })
        .where(
          and(
            eq(dreamingRuns.id, claim.run.id),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .returning({ id: dreamingRuns.id });
      if (updated.length !== 1) throw new Error("The dreaming run lease was lost.");
      signal.throwIfAborted();
      return mapReport(report);
    });
  }

  async failRun(
    claim: ClaimedDreamingRun,
    input: { readonly retryable: boolean; readonly sanitizedError: string },
    signal: AbortSignal,
  ): Promise<DreamingRun> {
    if (input.sanitizedError.trim() === "" || input.sanitizedError.length > 2_000) {
      throw new Error("sanitizedError must contain between 1 and 2000 characters.");
    }
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      await lockLiveClaim(transaction, claim);
      const rows = await transaction
        .update(dreamingRuns)
        .set({
          status: input.retryable ? "retryable_failed" : "failed",
          sanitizedError: input.sanitizedError,
          completedAt: input.retryable ? null : now,
          updatedAt: now,
        })
        .where(
          and(
            eq(dreamingRuns.id, claim.run.id),
            inArray(dreamingRuns.status, [
              "pending",
              "collecting",
              "analyzing",
              "verifying",
              "applying",
              "retryable_failed",
            ]),
            liveClaimPredicate(transaction, claim, now),
          ),
        )
        .returning();
      if (rows[0] === undefined) throw new Error("The dreaming run lease was lost.");
      signal.throwIfAborted();
      return mapRun(rows[0]);
    });
  }

  async getReport(
    access: BrainAccessContext,
    selector: DreamingReportSelector,
    signal: AbortSignal,
  ): Promise<DreamingReport | null> {
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "viewer", signal);
      const condition =
        selector.kind === "run_id"
          ? eq(dreamingReports.runId, selector.runId)
          : selector.kind === "local_date"
            ? eq(dreamingReports.localDate, selector.localDate)
            : undefined;
      const rows = await transaction
        .select()
        .from(dreamingReports)
        .where(condition)
        .orderBy(
          desc(dreamingReports.localDate),
          desc(dreamingReports.generatedAt),
          desc(dreamingReports.id),
        )
        .limit(1);
      signal.throwIfAborted();
      return rows[0] === undefined ? null : mapReport(rows[0]);
    });
  }

}
