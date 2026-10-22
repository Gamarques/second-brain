import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  isNotNull,
  lt,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  canonicalMemoryEmbeddingText,
  memoryEmbeddingRecipe,
} from "../../domain.js";
import type {
  BrainAccessContext,
  ContentEmbedding,
  DreamingVerificationProvider,
} from "../../domain.js";
import {
  LearningReviewConflictError,
  type LearningReviewDetail,
  type LearningReviewStore,
} from "../../domain/learning-review.js";
import {
  dreamingChanges,
  dreamingEvidence,
  dreamingRuns,
} from "../schema/dreaming.js";
import { dreamingReviews } from "../schema/learning-review.js";
import { ingestRuns, ingestSources } from "../schema/ingestion.js";
import { memories } from "../schema/content.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";
import { decodeProposal, loadMemories } from "./dreaming-store.js";
import { writeMemoryVersionInTransaction } from "./memory-store.js";

const finished = ["completed", "completed_with_skips"] as const;
const successor = alias(memories, "review_memory_successor");
const conflict = (): never => {
  throw new LearningReviewConflictError();
};
const receiptValue = (row: typeof dreamingReviews.$inferSelect) => ({
  changeId: row.changeId,
  decision: row.decision,
  resultMemoryId: row.resultMemoryId,
  reviewedAt: row.createdAt.toISOString(),
});

async function readDetail(
  tx: SecondBrainTransaction,
  id: string,
  lock: boolean,
) {
  const query = tx
    .select()
    .from(dreamingChanges)
    .where(eq(dreamingChanges.id, id))
    .limit(1);
  const [change] = await (lock ? query.for("update") : query);
  if (!change) return null;
  const [run] = await tx
    .select()
    .from(dreamingRuns)
    .where(eq(dreamingRuns.id, change.runId))
    .for("share")
    .limit(1);
  if (!run) return conflict();
  const proposal = decodeProposal(change.proposal);
  const evidence = await tx
    .select()
    .from(dreamingEvidence)
    .where(
      and(
        eq(dreamingEvidence.runId, run.id),
        inArray(dreamingEvidence.evidenceIndex, [...proposal.evidenceIndexes]),
      ),
    )
    .orderBy(dreamingEvidence.evidenceIndex)
    .for("share");
  const target = change.expectedTargetMemoryId
    ? ((await loadMemories(tx, [change.expectedTargetMemoryId]))[0] ?? null)
    : null;
  const [review] = await tx
    .select()
    .from(dreamingReviews)
    .where(eq(dreamingReviews.changeId, id))
    .limit(1);
  let blockedReason: string | null = null;
  const daily = evidence.filter(
    (item) =>
      item.role === "primary" &&
      item.observedAt >= run.windowStart &&
      item.observedAt < run.windowEnd &&
      item.redactedAt === null,
  );
  if (
    run.mode !== "preview" ||
    !finished.some((status) => status === run.status) ||
    change.status !== "skipped" ||
    change.skipReason !== "policy_denied"
  )
    blockedReason = "policy_denied";
  else if (run.snapshotTruncated) blockedReason = "snapshot_truncated";
  else if (
    evidence.length !== proposal.evidenceIndexes.length ||
    evidence.some((item) => item.redactedAt !== null) ||
    daily.length === 0 ||
    proposal.sourceQuotes.some(
      (quote) => !evidence.some((item) => item.excerpt.includes(quote)),
    )
  )
    blockedReason = "invalid_evidence";
  else if (proposal.operation === "create") {
    const text = canonicalMemoryEmbeddingText(proposal.content);
    if (
      !proposal.sourceQuotes.some(
        (quote) => canonicalMemoryEmbeddingText(quote) === text,
      ) &&
      canonicalMemoryEmbeddingText(proposal.sourceQuotes.join(" ")) !== text
    )
      blockedReason = "unsupported_memory";
    if (
      /(?:ignore|disregard)\s+(?:all\s+)?(?:prior|previous|above)\s+instructions|(?:call|invoke|run)\s+(?:a\s+)?tool|system\s+prompt/iu.test(
        proposal.content,
      )
    )
      blockedReason = "unsupported_memory";
  } else if (
    !target ||
    target.supersededBy !== null ||
    target.contentHash !== change.expectedTargetHash ||
    target.version !== change.expectedTargetVersion
  )
    blockedReason = "target_stale";
  else if (
    !daily.some((item) => item.effectiveAt > new Date(target.effectiveAt))
  )
    blockedReason = "target_newer_than_evidence";
  const redacted = evidence.some((item) => item.redactedAt !== null);
  const detail: LearningReviewDetail = {
    changeId: id,
    runId: run.id,
    localDate: run.localDate,
    fingerprint: change.fingerprint,
    proposal: redacted
      ? { ...proposal, content: "", category: null, tags: [], sourceQuotes: [] }
      : proposal,
    target: redacted ? null : target,
    evidence: evidence.map((item) => ({
      id: item.id,
      type: item.type,
      entityId: item.entityId,
      excerpt: item.redactedAt ? "" : item.excerpt,
      effectiveAt: item.effectiveAt.toISOString(),
      redacted: item.redactedAt !== null,
    })),
    blockedReason,
    receipt: review ? receiptValue(review) : null,
  };
  return { detail, change, run, review };
}

export class DrizzleLearningReviewStore implements LearningReviewStore {
  constructor(
    private readonly database: SecondBrainDatabase,
    private readonly models: {
      embed(
        recipe: ReturnType<typeof memoryEmbeddingRecipe>,
        signal: AbortSignal,
      ): Promise<ContentEmbedding>;
      verifier: DreamingVerificationProvider;
    },
  ) {}

  async list(
    access: BrainAccessContext,
    input: Parameters<LearningReviewStore["list"]>[1],
    signal: AbortSignal,
  ) {
    const limit = input.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return conflict();
    let cursor: {
      ts: string;
      id: string;
      kind: string;
      status: string;
    } | null = null;
    if (input.cursor) {
      try {
        cursor = JSON.parse(
          Buffer.from(input.cursor, "base64url").toString("utf8"),
        );
      } catch {
        return conflict();
      }
      if (
        !cursor ||
        cursor.kind !== input.kind ||
        cursor.status !== input.status ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.ts) ||
        !Number.isFinite(Date.parse(cursor.ts)) ||
        !/^[0-9a-f-]{36}$/i.test(cursor.id)
      )
        return conflict();
    }
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "admin", signal);
      const table = input.kind === "ingestion" ? ingestRuns : dreamingChanges;
      const cursorCondition = cursor
        ? or(
            lt(table.createdAt, sql`${cursor.ts}::timestamptz`),
            and(
              eq(table.createdAt, sql`${cursor.ts}::timestamptz`),
              lt(table.id, cursor.id),
            ),
          )
        : undefined;
      const preciseTime = sql<string>`to_char(${table.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
      const rows =
        input.kind === "ingestion"
          ? await tx
              .select({
                id: ingestRuns.id,
                title: sql<string>`left(${ingestSources.excerpt}, 160)`,
                status: ingestRuns.status,
                count: ingestRuns.proposalCount,
                createdAt: ingestRuns.createdAt,
                preciseTime,
              })
              .from(ingestRuns)
              .innerJoin(
                ingestSources,
                eq(ingestSources.id, ingestRuns.sourceId),
              )
              .where(
                and(
                  cursorCondition,
                  input.status === "pending"
                    ? inArray(ingestRuns.status, [
                        "awaiting_review",
                        "reviewed",
                        "committing",
                      ])
                    : inArray(ingestRuns.status, [
                        "completed",
                        "completed_with_skips",
                        "failed",
                      ]),
                ),
              )
              .orderBy(desc(ingestRuns.createdAt), desc(ingestRuns.id))
              .limit(limit + 1)
          : await tx
              .select({
                id: dreamingChanges.id,
                title: sql<string>`case when ${exists(
                  tx
                    .select({ id: dreamingEvidence.id })
                    .from(dreamingEvidence)
                    .where(
                      and(
                        eq(dreamingEvidence.runId, dreamingChanges.runId),
                        isNotNull(dreamingEvidence.redactedAt),
                      ),
                    ),
                )} then '' else left(${dreamingChanges.proposal}->>'content', 160) end`,
                status: sql<string>`coalesce(${dreamingReviews.decision}::text, ${dreamingChanges.skipReason}, ${dreamingChanges.status}::text)`,
                count: sql<number>`1`,
                createdAt: dreamingChanges.createdAt,
                preciseTime,
              })
              .from(dreamingChanges)
              .innerJoin(
                dreamingRuns,
                eq(dreamingRuns.id, dreamingChanges.runId),
              )
              .leftJoin(
                dreamingReviews,
                eq(dreamingReviews.changeId, dreamingChanges.id),
              )
              .where(
                and(
                  cursorCondition,
                  eq(dreamingRuns.mode, "preview"),
                  inArray(dreamingRuns.status, [...finished]),
                  input.status === "pending"
                    ? and(
                        isNull(dreamingReviews.changeId),
                        eq(dreamingChanges.status, "skipped"),
                        eq(dreamingChanges.skipReason, "policy_denied"),
                      )
                    : isNotNull(dreamingReviews.changeId),
                ),
              )
              .orderBy(
                desc(dreamingChanges.createdAt),
                desc(dreamingChanges.id),
              )
              .limit(limit + 1);
      signal.throwIfAborted();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(({ preciseTime: _, ...row }) => ({
          ...row,
          kind: input.kind,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  ts: last.preciseTime,
                  id: last.id,
                  kind: input.kind,
                  status: input.status,
                }),
              ).toString("base64url")
            : null,
      };
    });
  }

  async getDreaming(
    access: BrainAccessContext,
    changeId: string,
    signal: AbortSignal,
  ) {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "admin", signal);
      const result = await readDetail(tx, changeId, false);
      signal.throwIfAborted();
      return result?.detail ?? null;
    });
  }

  async reviewDreaming(
    access: BrainAccessContext,
    input: Parameters<LearningReviewStore["reviewDreaming"]>[1],
    signal: AbortSignal,
  ) {
    const initial = await this.getDreaming(access, input.changeId, signal);
    if (!initial || initial.fingerprint !== input.fingerprint)
      return conflict();
    let embedding: ContentEmbedding | null = null;
    if (!initial.receipt && input.decision === "accept") {
      if (initial.blockedReason) return conflict();
      if (initial.proposal.operation === "update") {
        if (!initial.target) return conflict();
        const results = await this.models.verifier.verifyUpdates(
          [
            {
              target: initial.target,
              proposal: initial.proposal,
              citedQuotes: initial.proposal.sourceQuotes,
            },
          ],
          signal,
        );
        const result = results[0];
        if (
          results.length !== 1 ||
          result?.supported !== true ||
          result.sameFact !== true ||
          result.contradictionResolved !== true ||
          result.quoteIndexes.length === 0 ||
          new Set(result.quoteIndexes).size !== result.quoteIndexes.length ||
          result.quoteIndexes.some(
            (index) =>
              !Number.isInteger(index) ||
              index < 0 ||
              index >= initial.proposal.sourceQuotes.length,
          )
        )
          return conflict();
      }
      embedding = await this.models.embed(
        memoryEmbeddingRecipe(initial.proposal.content),
        signal,
      );
    }
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "admin", signal);
      // Lock request keys before changes, then recheck after every external call.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`learning-review:${input.idempotencyKey}`}, 0))`,
      );
      const [keyReceipt] = await tx
        .select()
        .from(dreamingReviews)
        .where(eq(dreamingReviews.idempotencyKey, input.idempotencyKey));
      if (
        keyReceipt &&
        (keyReceipt.changeId !== input.changeId ||
          keyReceipt.decision !== input.decision ||
          keyReceipt.fingerprint !== input.fingerprint)
      )
        return conflict();
      const current = await readDetail(tx, input.changeId, true);
      if (!current || current.change.fingerprint !== input.fingerprint)
        return conflict();
      if (current.review) {
        if (current.review.decision !== input.decision) return conflict();
        return receiptValue(current.review);
      }
      let resultMemoryId: string | null = null;
      if (input.decision === "accept") {
        if (current.detail.blockedReason || !embedding) return conflict();
        const proposal = current.detail.proposal;
        const target = current.detail.target;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`dreaming-content:${embedding.contentHash}`}, 0))`,
        );
        if (proposal.operation === "create") {
          const [duplicate] = await tx
            .select({ id: memories.id })
            .from(memories)
            .where(
              and(
                eq(memories.contentHash, embedding.contentHash),
                notExists(
                  tx
                    .select({ id: successor.id })
                    .from(successor)
                    .where(eq(successor.supersedesId, memories.id)),
                ),
              ),
            )
            .limit(1);
          if (duplicate) return conflict();
        }
        const result = await writeMemoryVersionInTransaction(
          tx,
          { ...access, administrativeChannel: true },
          {
            content: proposal.content,
            category: proposal.category,
            tags: [...proposal.tags],
            projectId: target?.projectId ?? null,
            personIds: target?.personIds ?? [],
            sourceExcerpt: proposal.sourceQuotes.join("\n").slice(0, 2000),
            effectiveAt: current.run.windowEnd.toISOString(),
            capturedAt: current.run.windowEnd.toISOString(),
            ...(proposal.operation === "update" && target
              ? {
                  supersedesId: target.id,
                  expectedSupersededHash: target.contentHash,
                  expectedSupersededVersion: target.version,
                }
              : {
                  supersedesId: null,
                  expectedSupersededHash: null,
                  expectedSupersededVersion: null,
                }),
            idempotencyKey: `learning-review:${input.changeId}`,
            embedding,
          },
          signal,
          { analysisAllowed: false },
        );
        if (!result) return conflict();
        resultMemoryId = result.result.memory.id;
      }
      const [saved] = await tx
        .insert(dreamingReviews)
        .values({
          changeId: input.changeId,
          fingerprint: input.fingerprint,
          decision: input.decision,
          idempotencyKey: input.idempotencyKey,
          resultMemoryId,
          reviewerAccountId: access.accountId,
          requestId: access.actor.requestId,
        })
        .returning();
      signal.throwIfAborted();
      return receiptValue(saved!);
    });
  }
}
