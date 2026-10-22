import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
  DECISION_EMBEDDING_RECIPE_VERSION,
  decisionEmbeddingRecipe,
  ingestionProposalPayloadDigest,
  ingestionProposalSetDigest,
  ingestionRequestDigest,
  ingestionReviewDigest,
  memoryEmbeddingRecipe,
  maximumIngestExcerptCharacters,
  maximumIngestSourceQuoteCharacters,
  MEMORY_EMBEDDING_RECIPE_VERSION,
  taskPriorities,
} from "../../domain.js";
import type {
  ActorProvenance,
  ActorAttribution,
  BrainAccessContext,
  ContentEmbedding,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
  IngestProposal,
  IngestProposalPayload,
  IngestReceipt,
  IngestReview,
  IngestReviewItem,
  IngestRun,
  IngestSource,
  IngestionStore,
  IngestionCommitResult,
  ReviewedIngestionCommitter,
} from "../../domain.js";
import { embeddingSpaces } from "../schema/embeddings.js";
import {
  ingestProposals,
  ingestReceipts,
  ingestReviewItems,
  ingestReviews,
  ingestRuns,
  ingestSources,
} from "../schema/ingestion.js";
import { activityEvents, mutationReceipts } from "../schema/temporal.js";
import {
  authorizeBrainTransaction,
  BrainAuthorizationError,
} from "./authorization.js";
import { createDecisionInTransaction } from "./decision-store.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";
import { writeMemoryVersionInTransaction } from "./memory-store.js";
import { createPersonInTransaction } from "./person-store.js";
import { createReminderInTransaction } from "./reminder-store.js";
import { createTaskInTransaction } from "./task-store.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const maximumProposals = 100;

const identifierSchema = z.string().uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const lowerLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => value === value.toLowerCase());
const rejectedAlternativeSchema = z.strictObject({
  option: z.string().trim().min(1).max(300),
  reason: z.string().trim().min(1).max(500).nullable(),
});
const proposalPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("memory"),
    content: z.string().trim().min(1).max(10_000),
    category: lowerLabelSchema.nullable(),
    tags: z.array(lowerLabelSchema).max(20),
    projectId: identifierSchema.nullable(),
    personIds: z.array(identifierSchema).max(20),
  }),
  z.strictObject({
    kind: z.literal("decision"),
    statement: z.string().trim().min(1).max(2_000),
    rationale: z.string().trim().min(1).max(10_000),
    rejectedAlternatives: z.array(rejectedAlternativeSchema).max(20),
    projectId: identifierSchema.nullable(),
    personIds: z.array(identifierSchema).max(20),
    decidedAt: timestampSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("task"),
    listId: identifierSchema.nullable(),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(10_000).nullable(),
    priority: z.enum(taskPriorities),
    dueAt: timestampSchema.nullable(),
    projectId: identifierSchema.nullable(),
    goalIds: z.array(identifierSchema).max(20),
  }),
  z.strictObject({
    kind: z.literal("reminder"),
    message: z.string().trim().min(1).max(2_000),
    remindAt: timestampSchema,
  }),
  z.strictObject({
    kind: z.literal("person"),
    name: z.string().trim().min(1).max(300),
    aliases: z.array(z.string().trim().min(1).max(300)).max(50),
    notes: z.string().trim().min(1).max(10_000).nullable(),
  }),
]);

export type IngestionPersistenceFailureCode =
  | "INGESTION_DIGEST_MISMATCH"
  | "INGESTION_EFFECT_FAILED"
  | "INGESTION_EMBEDDING_FAILED"
  | "INGESTION_IDEMPOTENCY_CONFLICT"
  | "INGESTION_INVALID_INPUT"
  | "INGESTION_MODE_UNSUPPORTED"
  | "INGESTION_PERSISTENCE_FAILED"
  | "INGESTION_STATE_CONFLICT";

const failureMessages: Readonly<Record<IngestionPersistenceFailureCode, string>> = {
  INGESTION_DIGEST_MISMATCH:
    "The ingestion digest did not match the immutable persisted input.",
  INGESTION_EFFECT_FAILED:
    "A reviewed ingestion effect could not be applied atomically.",
  INGESTION_EMBEDDING_FAILED:
    "A reviewed ingestion embedding could not be prepared safely.",
  INGESTION_IDEMPOTENCY_CONFLICT:
    "The ingestion idempotency key was already used for another request.",
  INGESTION_INVALID_INPUT: "The ingestion persistence input was invalid.",
  INGESTION_MODE_UNSUPPORTED:
    "Durable partial ingestion is not available; use atomic commit.",
  INGESTION_PERSISTENCE_FAILED: "The ingestion state could not be persisted.",
  INGESTION_STATE_CONFLICT:
    "The ingestion run changed and the requested transition was refused.",
};

export class IngestionPersistenceError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: IngestionPersistenceFailureCode,
    options: { readonly retryable?: boolean } = {},
  ) {
    super(failureMessages[code]);
    this.name = "IngestionPersistenceError";
    this.retryable = options.retryable ?? false;
  }
}

function fail(code: IngestionPersistenceFailureCode): never {
  throw new IngestionPersistenceError(code);
}

async function stableFailure<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    signal.throwIfAborted();
    const result = await operation();
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof IngestionPersistenceError) throw error;
    if (error instanceof BrainAuthorizationError) throw error;
    throw new IngestionPersistenceError("INGESTION_PERSISTENCE_FAILED", {
      retryable: true,
    });
  }
}

function requireDigest(value: string): void {
  if (!digestPattern.test(value)) fail("INGESTION_INVALID_INPUT");
}

function requireNonBlank(value: string, maximum: number): void {
  if (value.trim() === "" || value.length > maximum) {
    fail("INGESTION_INVALID_INPUT");
  }
}

function requireTimestamp(value: string | null): void {
  if (value !== null && !timestampSchema.safeParse(value).success) {
    fail("INGESTION_INVALID_INPUT");
  }
}

function parsePayload(value: unknown): IngestProposalPayload {
  const parsed = proposalPayloadSchema.safeParse(value);
  if (!parsed.success) fail("INGESTION_INVALID_INPUT");
  validatePayloadSets(parsed.data, "INGESTION_INVALID_INPUT");
  return parsed.data;
}

function parsePersistedPayload(value: unknown): IngestProposalPayload {
  const parsed = proposalPayloadSchema.safeParse(value);
  if (!parsed.success) fail("INGESTION_PERSISTENCE_FAILED");
  validatePayloadSets(parsed.data, "INGESTION_PERSISTENCE_FAILED");
  return parsed.data;
}

function validatePayloadSets(
  payload: IngestProposalPayload,
  failure: IngestionPersistenceFailureCode,
): void {
  const sets: readonly (readonly string[])[] =
    payload.kind === "memory"
      ? [payload.tags, payload.personIds]
      : payload.kind === "decision"
        ? [payload.personIds]
        : payload.kind === "task"
          ? [payload.goalIds]
          : payload.kind === "person"
            ? [payload.aliases]
            : [];
  if (sets.some((values) => new Set(values).size !== values.length)) {
    fail(failure);
  }
}

function provenanceColumns(provenance: ActorProvenance) {
  return {
    actorKind: provenance.kind,
    actorAccountId: provenance.accountId,
    actorClientId: provenance.clientId,
    actorSource: provenance.source,
    requestId: provenance.requestId,
    correlationId: provenance.correlationId,
    causationId: provenance.causationId,
    dreamingRunId: provenance.dreamingRunId,
  } as const;
}

function attributionFromRow(row: {
  readonly actorKind: ActorAttribution["kind"];
  readonly actorAccountId: string | null;
  readonly actorClientId: string | null;
  readonly actorSource: ActorAttribution["source"];
}): ActorAttribution {
  const common = { source: row.actorSource } as const;
  if (row.actorKind === "account") {
    if (row.actorClientId !== null) fail("INGESTION_PERSISTENCE_FAILED");
    return {
      ...common,
      kind: "account",
      accountId: row.actorAccountId,
      clientId: null,
    };
  }
  if (row.actorKind === "oauth_client") {
    if ((row.actorAccountId === null) !== (row.actorClientId === null)) {
      fail("INGESTION_PERSISTENCE_FAILED");
    }
    return row.actorAccountId === null
      ? { ...common, kind: "oauth_client", accountId: null, clientId: null }
      : {
          ...common,
          kind: "oauth_client",
          accountId: row.actorAccountId,
          clientId: row.actorClientId!,
        };
  }
  if (row.actorKind === "import") {
    if (row.actorClientId !== null) fail("INGESTION_PERSISTENCE_FAILED");
    return {
      ...common,
      kind: "import",
      accountId: row.actorAccountId,
      clientId: null,
    };
  }
  if (row.actorAccountId !== null || row.actorClientId !== null) {
    fail("INGESTION_PERSISTENCE_FAILED");
  }
  return {
    ...common,
    kind: row.actorKind,
    accountId: null,
    clientId: null,
  };
}

function sourceFromRow(row: typeof ingestSources.$inferSelect): IngestSource {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    requestDigest: row.requestDigest,
    excerpt: row.excerpt,
    capturedAt: row.capturedAt?.toISOString() ?? null,
    provenance: attributionFromRow(row),
    createdAt: row.createdAt.toISOString(),
  };
}

function runFromRow(row: typeof ingestRuns.$inferSelect): IngestRun {
  return {
    id: row.id,
    sourceId: row.sourceId,
    status: row.status,
    proposalProvider: row.proposalProvider,
    proposalModel: row.proposalModel,
    schemaVersion: row.schemaVersion,
    proposalCount: row.proposalCount,
    proposalDigest: row.proposalDigest,
    responseDigest: row.responseDigest,
    reviewedDigest: row.reviewedDigest,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function proposalFromRow(
  row: typeof ingestProposals.$inferSelect,
): IngestProposal {
  const payload = parsePersistedPayload(row.payload);
  if (payload.kind !== row.kind) fail("INGESTION_PERSISTENCE_FAILED");
  return {
    id: row.id,
    runId: row.runId,
    ordinal: row.ordinal,
    payload,
    confidence: row.confidence,
    sourceStart: row.sourceStart,
    sourceEnd: row.sourceEnd,
    sourceQuote: row.sourceQuote,
    payloadDigest: row.payloadDigest,
    createdAt: row.createdAt.toISOString(),
  };
}

function reviewFromRows(
  row: typeof ingestReviews.$inferSelect,
  items: readonly (typeof ingestReviewItems.$inferSelect)[],
): IngestReview {
  const decodedItems = items.map((item) => {
    if (item.replacementPayload === null) {
      if (item.replacementDigest !== null) {
        fail("INGESTION_PERSISTENCE_FAILED");
      }
      return {
        proposalId: item.proposalId,
        decision: item.decision,
        replacement: null,
      } as const;
    }
    const replacement = parsePersistedPayload(item.replacementPayload);
    if (
      item.decision === "reject" ||
      item.replacementDigest !== ingestionProposalPayloadDigest(replacement)
    ) {
      fail("INGESTION_PERSISTENCE_FAILED");
    }
    return {
      proposalId: item.proposalId,
      decision: item.decision,
      replacement,
    } as const;
  });
  return {
    id: row.id,
    runId: row.runId,
    reviewDigest: row.reviewDigest,
    items: decodedItems,
    provenance: attributionFromRow(row),
    createdAt: row.createdAt.toISOString(),
  };
}

function receiptFromRow(row: typeof ingestReceipts.$inferSelect): IngestReceipt {
  return {
    id: row.id,
    runId: row.runId,
    proposalId: row.proposalId,
    entityType: row.entityType,
    entityId: row.entityId,
    status: row.status,
    reason: row.reason,
    effectDigest: row.effectDigest,
    createdAt: row.createdAt.toISOString(),
  };
}

async function selectProposals(
  transaction: SecondBrainTransaction,
  runId: string,
): Promise<IngestProposal[]> {
  const rows = await transaction
    .select()
    .from(ingestProposals)
    .where(eq(ingestProposals.runId, runId))
    .orderBy(asc(ingestProposals.ordinal), asc(ingestProposals.id));
  return rows.map(proposalFromRow);
}

function sameProposalInput(
  persisted: readonly IngestProposal[],
  requested: readonly Omit<
    IngestProposal,
    "id" | "runId" | "createdAt"
  >[],
): boolean {
  if (persisted.length !== requested.length) return false;
  return persisted.every((proposal, index) => {
    const candidate = requested[index];
    return (
      candidate !== undefined &&
      proposal.ordinal === candidate.ordinal &&
      proposal.payloadDigest === candidate.payloadDigest &&
      proposal.confidence === candidate.confidence &&
      proposal.sourceStart === candidate.sourceStart &&
      proposal.sourceEnd === candidate.sourceEnd &&
      proposal.sourceQuote === candidate.sourceQuote &&
      canonicalJson(proposal.payload) === canonicalJson(candidate.payload)
    );
  });
}

function validateProposalInput(
  sourceExcerpt: string,
  proposals: readonly Omit<
    IngestProposal,
    "id" | "runId" | "createdAt"
  >[],
): readonly (Omit<
  IngestProposal,
  "id" | "runId" | "createdAt"
> & { readonly payload: IngestProposalPayload })[] {
  if (proposals.length > maximumProposals) fail("INGESTION_INVALID_INPUT");
  return proposals.map((proposal, index) => {
    const payload = parsePayload(proposal.payload);
    if (
      proposal.ordinal !== index ||
      !Number.isFinite(proposal.confidence) ||
      proposal.confidence < 0 ||
      proposal.confidence > 1 ||
      Number(proposal.confidence.toFixed(3)) !== proposal.confidence ||
      !Number.isInteger(proposal.sourceStart) ||
      !Number.isInteger(proposal.sourceEnd) ||
      proposal.sourceStart < 0 ||
      proposal.sourceEnd <= proposal.sourceStart ||
      proposal.sourceEnd > sourceExcerpt.length ||
      sourceExcerpt.slice(proposal.sourceStart, proposal.sourceEnd) !==
        proposal.sourceQuote ||
      proposal.sourceQuote.trim() === "" ||
      proposal.sourceQuote.length > maximumIngestSourceQuoteCharacters
    ) {
      fail("INGESTION_INVALID_INPUT");
    }
    requireDigest(proposal.payloadDigest);
    if (ingestionProposalPayloadDigest(payload) !== proposal.payloadDigest) {
      fail("INGESTION_DIGEST_MISMATCH");
    }
    return { ...proposal, payload };
  });
}

async function selectReview(
  transaction: SecondBrainTransaction,
  runId: string,
): Promise<IngestReview | null> {
  const [reviewRow] = await transaction
    .select()
    .from(ingestReviews)
    .where(eq(ingestReviews.runId, runId))
    .limit(1);
  if (reviewRow === undefined) return null;
  const itemRows = await transaction
    .select()
    .from(ingestReviewItems)
    .where(
      and(
        eq(ingestReviewItems.runId, runId),
        eq(ingestReviewItems.reviewId, reviewRow.id),
      ),
    )
    .orderBy(asc(ingestReviewItems.proposalId));
  return reviewFromRows(reviewRow, itemRows);
}

export class DrizzleIngestionStore implements IngestionStore {
  constructor(private readonly database: SecondBrainDatabase) {}

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
  ): Promise<{
    readonly source: IngestSource;
    readonly run: IngestRun;
    readonly created: boolean;
  }> {
    return stableFailure(signal, async () => {
      requireNonBlank(input.idempotencyKey, 200);
      requireNonBlank(input.excerpt, maximumIngestExcerptCharacters);
      requireNonBlank(input.proposalProvider, 200);
      requireNonBlank(input.proposalModel, 500);
      requireNonBlank(input.schemaVersion, 100);
      requireDigest(input.requestDigest);
      requireTimestamp(input.capturedAt);
      if (
        ingestionRequestDigest({
          schemaVersion: input.schemaVersion,
          excerpt: input.excerpt,
          capturedAt: input.capturedAt,
        }) !== input.requestDigest
      ) {
        fail("INGESTION_DIGEST_MISMATCH");
      }

      return this.database.transaction(async (transaction) => {
        await authorizeBrainTransaction(transaction, access, "editor", signal);
        signal.throwIfAborted();
        const insertedSources = await transaction
          .insert(ingestSources)
          .values({
            idempotencyKey: input.idempotencyKey,
            requestDigest: input.requestDigest,
            excerpt: input.excerpt,
            capturedAt:
              input.capturedAt === null ? null : new Date(input.capturedAt),
            ...provenanceColumns(access.actor),
          })
          .onConflictDoNothing({
            target: [ingestSources.idempotencyKey],
          })
          .returning();

        const insertedSource = insertedSources[0];
        if (insertedSource !== undefined) {
          const [runRow] = await transaction
            .insert(ingestRuns)
            .values({
              sourceId: insertedSource.id,
              proposalProvider: input.proposalProvider,
              proposalModel: input.proposalModel,
              schemaVersion: input.schemaVersion,
            })
            .returning();
          if (runRow === undefined) fail("INGESTION_PERSISTENCE_FAILED");
          return {
            source: sourceFromRow(insertedSource),
            run: runFromRow(runRow),
            created: true,
          };
        }

        const [sourceRow] = await transaction
          .select()
          .from(ingestSources)
          .where(eq(ingestSources.idempotencyKey, input.idempotencyKey))
          .limit(1);
        if (sourceRow === undefined) fail("INGESTION_PERSISTENCE_FAILED");
        if (sourceRow.requestDigest !== input.requestDigest) {
          fail("INGESTION_IDEMPOTENCY_CONFLICT");
        }
        const [runRow] = await transaction
          .select()
          .from(ingestRuns)
          .where(eq(ingestRuns.sourceId, sourceRow.id))
          .limit(1);
        if (runRow === undefined) fail("INGESTION_PERSISTENCE_FAILED");
        return {
          source: sourceFromRow(sourceRow),
          run: runFromRow(runRow),
          created: false,
        };
      });
    });
  }

  saveProposals(
    access: BrainAccessContext,
    runId: string,
    input: {
      readonly proposals: readonly Omit<
        IngestProposal,
        "id" | "runId" | "createdAt"
      >[];
      readonly responseDigest: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly run: IngestRun;
    readonly proposals: readonly IngestProposal[];
  }> {
    return stableFailure(signal, () =>
      this.database.transaction(async (transaction) => {
        requireDigest(input.responseDigest);
        await authorizeBrainTransaction(transaction, access, "editor", signal);
        const [runRow] = await transaction
          .select()
          .from(ingestRuns)
          .where(eq(ingestRuns.id, runId))
          .limit(1)
          .for("update");
        if (runRow === undefined) fail("INGESTION_STATE_CONFLICT");
        const [sourceRow] = await transaction
          .select()
          .from(ingestSources)
          .where(eq(ingestSources.id, runRow.sourceId))
          .limit(1);
        if (sourceRow === undefined) fail("INGESTION_PERSISTENCE_FAILED");
        const proposals = validateProposalInput(sourceRow.excerpt, input.proposals);

        if (runRow.status !== "proposing") {
          const existing = await selectProposals(transaction, runId);
          if (
            runRow.responseDigest !== input.responseDigest ||
            !sameProposalInput(existing, proposals)
          ) {
            fail("INGESTION_STATE_CONFLICT");
          }
          return { run: runFromRow(runRow), proposals: existing };
        }

        const inserted =
          proposals.length === 0
            ? []
            : await transaction
                .insert(ingestProposals)
                .values(
                  proposals.map((proposal) => ({
                    runId,
                    ordinal: proposal.ordinal,
                    kind: proposal.payload.kind,
                    payload: proposal.payload,
                    confidence: proposal.confidence,
                    sourceStart: proposal.sourceStart,
                    sourceEnd: proposal.sourceEnd,
                    sourceQuote: proposal.sourceQuote,
                    payloadDigest: proposal.payloadDigest,
                  })),
                )
                .returning();
        const persisted = inserted.map(proposalFromRow).sort((left, right) =>
          left.ordinal - right.ordinal || left.id.localeCompare(right.id),
        );
        const proposalDigest = ingestionProposalSetDigest(persisted);
        const [updatedRun] = await transaction
          .update(ingestRuns)
          .set({
            status: "awaiting_review",
            proposalCount: persisted.length,
            proposalDigest,
            responseDigest: input.responseDigest,
            updatedAt: new Date(),
          })
          .where(
            and(eq(ingestRuns.id, runId), eq(ingestRuns.status, "proposing")),
          )
          .returning();
        if (updatedRun === undefined) fail("INGESTION_STATE_CONFLICT");
        return { run: runFromRow(updatedRun), proposals: persisted };
      }),
    );
  }

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
  ): Promise<IngestReview | null> {
    return stableFailure(signal, () =>
      this.database.transaction(async (transaction) => {
        requireDigest(input.expectedProposalDigest);
        requireDigest(input.reviewDigest);
        requireNonBlank(input.idempotencyKey, 200);
        await authorizeBrainTransaction(transaction, access, "editor", signal);
        const [runRow] = await transaction
          .select()
          .from(ingestRuns)
          .where(eq(ingestRuns.id, runId))
          .limit(1)
          .for("update");
        if (runRow === undefined) return null;
        if (
          runRow.proposalDigest === null ||
          runRow.proposalDigest !== input.expectedProposalDigest
        ) {
          fail("INGESTION_DIGEST_MISMATCH");
        }
        const proposals = await selectProposals(transaction, runId);
        const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
        const itemIds = new Set<string>();
        const items = input.items.map((item) => {
          if (item.decision !== "accept" && item.decision !== "reject") {
            fail("INGESTION_INVALID_INPUT");
          }
          if (itemIds.has(item.proposalId)) fail("INGESTION_INVALID_INPUT");
          itemIds.add(item.proposalId);
          const proposal = proposalById.get(item.proposalId);
          if (proposal === undefined) fail("INGESTION_DIGEST_MISMATCH");
          const replacement =
            item.replacement === null ? null : parsePayload(item.replacement);
          if (
            (item.decision === "reject" && replacement !== null) ||
            (replacement !== null && replacement.kind !== proposal.payload.kind)
          ) {
            fail("INGESTION_INVALID_INPUT");
          }
          return { ...item, replacement };
        });
        if (
          items.length !== proposals.length ||
          proposals.some((proposal) => !itemIds.has(proposal.id))
        ) {
          fail("INGESTION_DIGEST_MISMATCH");
        }
        if (
          ingestionReviewDigest({
            runId,
            proposalDigest: input.expectedProposalDigest,
            items,
          }) !== input.reviewDigest
        ) {
          fail("INGESTION_DIGEST_MISMATCH");
        }

        const [reviewByKey] = await transaction
          .select()
          .from(ingestReviews)
          .where(eq(ingestReviews.idempotencyKey, input.idempotencyKey))
          .limit(1);
        if (reviewByKey !== undefined) {
          if (
            reviewByKey.runId !== runId ||
            reviewByKey.reviewDigest !== input.reviewDigest
          ) {
            fail("INGESTION_IDEMPOTENCY_CONFLICT");
          }
          const replay = await selectReview(transaction, runId);
          if (replay === null) fail("INGESTION_PERSISTENCE_FAILED");
          return replay;
        }
        if (runRow.status !== "awaiting_review") {
          fail("INGESTION_STATE_CONFLICT");
        }

        const insertedReviews = await transaction
          .insert(ingestReviews)
          .values({
            runId,
            reviewDigest: input.reviewDigest,
            idempotencyKey: input.idempotencyKey,
            ...provenanceColumns(access.actor),
          })
          .onConflictDoNothing({
            target: [ingestReviews.idempotencyKey],
          })
          .returning();
        const reviewRow = insertedReviews[0];
        if (reviewRow === undefined) {
          const [conflictingReview] = await transaction
            .select()
            .from(ingestReviews)
            .where(eq(ingestReviews.idempotencyKey, input.idempotencyKey))
            .limit(1);
          if (
            conflictingReview === undefined ||
            conflictingReview.runId !== runId ||
            conflictingReview.reviewDigest !== input.reviewDigest
          ) {
            fail("INGESTION_IDEMPOTENCY_CONFLICT");
          }
          const replay = await selectReview(transaction, runId);
          if (replay === null) fail("INGESTION_PERSISTENCE_FAILED");
          return replay;
        }
        if (items.length > 0) {
          await transaction.insert(ingestReviewItems).values(
            items.map((item) => ({
              runId,
              reviewId: reviewRow.id,
              proposalId: item.proposalId,
              decision: item.decision,
              replacementPayload: item.replacement,
              replacementDigest:
                item.replacement === null
                  ? null
                  : ingestionProposalPayloadDigest(item.replacement),
            })),
          );
        }
        const [updatedRun] = await transaction
          .update(ingestRuns)
          .set({
            status: "reviewed",
            reviewedDigest: input.reviewDigest,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(ingestRuns.id, runId),
              eq(ingestRuns.status, "awaiting_review"),
              eq(ingestRuns.proposalDigest, input.expectedProposalDigest),
            ),
          )
          .returning();
        if (updatedRun === undefined) fail("INGESTION_STATE_CONFLICT");
        return reviewFromRows(
          reviewRow,
          items.map((item) => ({
            id: "",
            runId,
            reviewId: reviewRow.id,
            proposalId: item.proposalId,
            decision: item.decision,
            replacementPayload: item.replacement,
            replacementDigest:
              item.replacement === null
                ? null
                : ingestionProposalPayloadDigest(item.replacement),
            createdAt: reviewRow.createdAt,
          })),
        );
      }),
    );
  }

  getRunStatus(
    access: BrainAccessContext,
    runId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly run: IngestRun;
    readonly proposals: readonly IngestProposal[];
    readonly review: IngestReview | null;
    readonly receipts: readonly IngestReceipt[];
  } | null> {
    return stableFailure(signal, () =>
      this.database.transaction(async (transaction) => {
        await authorizeBrainTransaction(transaction, access, "viewer", signal);
        const [runRow] = await transaction
          .select()
          .from(ingestRuns)
          .where(eq(ingestRuns.id, runId))
          .limit(1);
        if (runRow === undefined) return null;
        const proposals = await selectProposals(transaction, runId);
        const review = await selectReview(transaction, runId);
        const receiptRows = await transaction
          .select()
          .from(ingestReceipts)
          .where(eq(ingestReceipts.runId, runId))
          .orderBy(asc(ingestReceipts.createdAt), asc(ingestReceipts.id));
        return {
          run: runFromRow(runRow),
          proposals,
          review,
          receipts: receiptRows.map(receiptFromRow),
        };
      }),
    );
  }
}

interface CommitSnapshot {
  readonly runRow: typeof ingestRuns.$inferSelect;
  readonly run: IngestRun;
  readonly source: IngestSource;
  readonly proposals: readonly IngestProposal[];
  readonly review: IngestReview;
  readonly receiptRows: readonly (typeof ingestReceipts.$inferSelect)[];
  readonly receipts: readonly IngestReceipt[];
}

function validateCommitSnapshot(snapshot: CommitSnapshot): void {
  const { proposals, review, run, source } = snapshot;
  if (
    ingestionRequestDigest({
      schemaVersion: run.schemaVersion,
      excerpt: source.excerpt,
      capturedAt: source.capturedAt,
    }) !== source.requestDigest ||
    run.proposalCount !== proposals.length ||
    run.proposalDigest === null ||
    run.responseDigest === null ||
    ingestionProposalSetDigest(proposals) !== run.proposalDigest
  ) {
    fail("INGESTION_DIGEST_MISMATCH");
  }

  const proposalIds = new Set<string>();
  for (const proposal of proposals) {
    if (
      proposalIds.has(proposal.id) ||
      proposal.runId !== run.id ||
      ingestionProposalPayloadDigest(proposal.payload) !==
        proposal.payloadDigest ||
      proposal.sourceStart < 0 ||
      proposal.sourceEnd <= proposal.sourceStart ||
      proposal.sourceEnd > source.excerpt.length ||
      source.excerpt.slice(proposal.sourceStart, proposal.sourceEnd) !==
        proposal.sourceQuote
    ) {
      fail("INGESTION_DIGEST_MISMATCH");
    }
    proposalIds.add(proposal.id);
  }

  const reviewProposalIds = new Set<string>();
  for (const item of review.items) {
    const proposal = proposals.find((candidate) => candidate.id === item.proposalId);
    if (
      proposal === undefined ||
      reviewProposalIds.has(item.proposalId) ||
      (item.replacement !== null &&
        item.replacement.kind !== proposal.payload.kind)
    ) {
      fail("INGESTION_DIGEST_MISMATCH");
    }
    reviewProposalIds.add(item.proposalId);
  }
  if (
    review.runId !== run.id ||
    review.items.length !== proposals.length ||
    run.reviewedDigest !== review.reviewDigest ||
    ingestionReviewDigest({
      runId: run.id,
      proposalDigest: run.proposalDigest,
      items: review.items,
    }) !== review.reviewDigest
  ) {
    fail("INGESTION_DIGEST_MISMATCH");
  }

  const reviewByProposal = new Map(
    review.items.map((item) => [item.proposalId, item]),
  );
  const receiptProposalIds = new Set<string>();
  for (const receipt of snapshot.receiptRows) {
    const proposal = proposals.find(
      (candidate) => candidate.id === receipt.proposalId,
    );
    const item = reviewByProposal.get(receipt.proposalId);
    const payload = item?.replacement ?? proposal?.payload;
    if (
      proposal === undefined ||
      item === undefined ||
      payload === undefined ||
      receipt.runId !== run.id ||
      receipt.entityType !== payload.kind ||
      receipt.effectDigest !== effectDigest(run.id, review.reviewDigest, proposal, item) ||
      receiptProposalIds.has(receipt.proposalId)
    ) {
      fail("INGESTION_PERSISTENCE_FAILED");
    }
    receiptProposalIds.add(receipt.proposalId);
    if (item.decision === "reject") {
      if (
        receipt.status !== "skipped" ||
        receipt.entityId !== null ||
        receipt.activityEventId !== null ||
        receipt.reason !== "review_rejected"
      ) {
        fail("INGESTION_PERSISTENCE_FAILED");
      }
    } else if (
      receipt.status !== "committed" ||
      receipt.entityId === null ||
      receipt.activityEventId === null ||
      receipt.reason !== null
    ) {
      fail("INGESTION_PERSISTENCE_FAILED");
    }
  }
}

const mutationOperationByKind = {
  memory: "memory.write",
  decision: "decision.create",
  task: "task.create",
  reminder: "reminder.create",
  person: "person.create",
} as const;

function effectIdempotencyKey(
  runId: string,
  proposalId: string,
  commitIdempotencyKey: string,
): string {
  return `ingest-effect:${canonicalDigest({
    runId,
    proposalId,
    commitIdempotencyKey,
  })}`;
}

async function validateCommittedReceiptLinks(
  transaction: SecondBrainTransaction,
  snapshot: CommitSnapshot,
): Promise<void> {
  const commitIdempotencyKey = snapshot.runRow.commitIdempotencyKey;
  if (snapshot.receiptRows.length === 0) return;
  if (commitIdempotencyKey === null) fail("INGESTION_PERSISTENCE_FAILED");
  for (const receipt of snapshot.receiptRows) {
    if (receipt.status !== "committed") continue;
    if (receipt.entityId === null || receipt.activityEventId === null) {
      fail("INGESTION_PERSISTENCE_FAILED");
    }
    const rows = await transaction
      .select({
        receiptEntityType: mutationReceipts.resultEntityType,
        receiptEntityId: mutationReceipts.resultEntityId,
        receiptEventId: mutationReceipts.activityEventId,
        receiptRequestDigest: mutationReceipts.requestDigest,
        eventId: activityEvents.id,
        eventEntityType: activityEvents.entityType,
        eventEntityId: activityEvents.entityId,
        eventAction: activityEvents.action,
        eventRequestDigest: activityEvents.requestDigest,
      })
      .from(mutationReceipts)
      .innerJoin(
        activityEvents,
        eq(activityEvents.id, mutationReceipts.activityEventId),
      )
      .where(
        and(
          eq(mutationReceipts.operation, mutationOperationByKind[receipt.entityType]),
          eq(
            mutationReceipts.idempotencyKey,
            effectIdempotencyKey(
              snapshot.run.id,
              receipt.proposalId,
              commitIdempotencyKey,
            ),
          ),
          eq(mutationReceipts.resultEntityType, receipt.entityType),
          eq(mutationReceipts.resultEntityId, receipt.entityId),
          eq(mutationReceipts.activityEventId, receipt.activityEventId),
          eq(activityEvents.entityType, receipt.entityType),
          eq(activityEvents.entityId, receipt.entityId),
          eq(activityEvents.action, "created"),
        ),
      )
      .limit(2);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.receiptEntityType !== receipt.entityType ||
      row.receiptEntityId !== receipt.entityId ||
      row.receiptEventId !== receipt.activityEventId ||
      row.eventId !== receipt.activityEventId ||
      row.eventEntityType !== receipt.entityType ||
      row.eventEntityId !== receipt.entityId ||
      row.eventAction !== "created" ||
      row.eventRequestDigest !== row.receiptRequestDigest
    ) {
      fail("INGESTION_PERSISTENCE_FAILED");
    }
  }
}

async function loadCommitSnapshot(
  transaction: SecondBrainTransaction,
  access: BrainAccessContext,
  runId: string,
  signal: AbortSignal,
  lockRun: boolean,
): Promise<CommitSnapshot | null> {
  await authorizeBrainTransaction(transaction, access, "editor", signal);
  const runQuery = transaction
    .select()
    .from(ingestRuns)
    .where(eq(ingestRuns.id, runId))
    .limit(1);
  const runRows = lockRun ? await runQuery.for("update") : await runQuery;
  const runRow = runRows[0];
  if (runRow === undefined) return null;
  const [sourceRow] = await transaction
    .select()
    .from(ingestSources)
    .where(eq(ingestSources.id, runRow.sourceId))
    .limit(1);
  if (sourceRow === undefined) fail("INGESTION_PERSISTENCE_FAILED");
  const proposals = await selectProposals(transaction, runId);
  const review = await selectReview(transaction, runId);
  if (review === null) fail("INGESTION_STATE_CONFLICT");
  const receiptRows = await transaction
    .select()
    .from(ingestReceipts)
    .where(eq(ingestReceipts.runId, runId))
    .orderBy(asc(ingestReceipts.createdAt), asc(ingestReceipts.id));
  const snapshot = {
    runRow,
    run: runFromRow(runRow),
    source: sourceFromRow(sourceRow),
    proposals,
    review,
    receiptRows,
    receipts: receiptRows.map(receiptFromRow),
  } satisfies CommitSnapshot;
  validateCommitSnapshot(snapshot);
  await validateCommittedReceiptLinks(transaction, snapshot);
  return snapshot;
}

function replayCommit(
  snapshot: CommitSnapshot,
  idempotencyKey: string,
  requestDigest: string,
): IngestionCommitResult {
  if (
    snapshot.runRow.commitIdempotencyKey !== idempotencyKey ||
    snapshot.runRow.commitRequestDigest !== requestDigest
  ) {
    fail("INGESTION_IDEMPOTENCY_CONFLICT");
  }
  const proposalIds = new Set(snapshot.proposals.map((proposal) => proposal.id));
  const receiptProposalIds = new Set<string>();
  for (const receipt of snapshot.receipts) {
    if (
      receipt.runId !== snapshot.run.id ||
      !proposalIds.has(receipt.proposalId) ||
      receiptProposalIds.has(receipt.proposalId) ||
      !digestPattern.test(receipt.effectDigest)
    ) {
      fail("INGESTION_PERSISTENCE_FAILED");
    }
    receiptProposalIds.add(receipt.proposalId);
  }
  if (snapshot.receipts.length !== snapshot.proposals.length) {
    fail("INGESTION_PERSISTENCE_FAILED");
  }
  // Replays must return receipts in the same proposal order as the original
  // commit; the stored rows only guarantee (createdAt, id) order.
  const receipts = [...snapshot.receipts].sort(
    (left, right) =>
      snapshot.proposals.findIndex(
        (proposal) => proposal.id === left.proposalId,
      ) -
      snapshot.proposals.findIndex(
        (proposal) => proposal.id === right.proposalId,
      ),
  );
  return { run: snapshot.run, receipts };
}

function acceptedPayloads(snapshot: CommitSnapshot): readonly {
  readonly proposal: IngestProposal;
  readonly payload: IngestProposalPayload;
}[] {
  const reviewByProposal = new Map(
    snapshot.review.items.map((item) => [item.proposalId, item]),
  );
  return snapshot.proposals.flatMap((proposal) => {
    const item = reviewByProposal.get(proposal.id);
    if (item === undefined) fail("INGESTION_DIGEST_MISMATCH");
    if (item.decision === "reject") return [];
    return [{ proposal, payload: item.replacement ?? proposal.payload }];
  });
}

function requireCompatibleSpace(
  space: EmbeddingSpace | null,
  access: BrainAccessContext,
  entityType: "memory" | "decision",
  recipeVersion: string,
  provider: EmbeddingProvider,
): EmbeddingSpace {
  if (
    space === null ||
    space.entityType !== entityType ||
    space.provider !== provider.provider ||
    space.model !== provider.model ||
    space.modelRevision !== provider.modelRevision ||
    space.recipeVersion !== recipeVersion ||
    space.dimensions !== provider.dimensions ||
    space.metric !== "cosine" ||
    space.status !== "active"
  ) {
    fail("INGESTION_STATE_CONFLICT");
  }
  return space;
}

function requireVector(
  vector: readonly number[] | undefined,
  dimensions: number,
): readonly number[] {
  if (
    vector === undefined ||
    vector.length !== dimensions ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    fail("INGESTION_EMBEDDING_FAILED");
  }
  return [...vector];
}

async function prepareReviewedEmbeddings(
  snapshot: CommitSnapshot,
  access: BrainAccessContext,
  embeddingSpaceStore: EmbeddingSpaceStore,
  provider: EmbeddingProvider,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, ContentEmbedding>> {
  const accepted = acceptedPayloads(snapshot);
  const recipes: {
    readonly proposalId: string;
    readonly entityType: "memory" | "decision";
    readonly recipe: ReturnType<
      typeof memoryEmbeddingRecipe | typeof decisionEmbeddingRecipe
    >;
  }[] = [];
  for (const { proposal, payload } of accepted) {
    if (payload.kind === "memory") {
      recipes.push({
        proposalId: proposal.id,
        entityType: "memory",
        recipe: memoryEmbeddingRecipe(payload.content),
      });
      continue;
    }
    if (payload.kind === "decision") {
      recipes.push({
        proposalId: proposal.id,
        entityType: "decision",
        recipe: decisionEmbeddingRecipe(payload),
      });
    }
  }
  if (recipes.length === 0) return new Map();

  try {
    const needsMemory = recipes.some((item) => item.entityType === "memory");
    const needsDecision = recipes.some((item) => item.entityType === "decision");
    const [memorySpaceResult, decisionSpaceResult] = await Promise.all([
      needsMemory
        ? embeddingSpaceStore.getActiveSpace(access, "memory", signal)
        : Promise.resolve(null),
      needsDecision
        ? embeddingSpaceStore.getActiveSpace(access, "decision", signal)
        : Promise.resolve(null),
    ]);
    const memorySpace = needsMemory
      ? requireCompatibleSpace(
          memorySpaceResult,
          access,
          "memory",
          MEMORY_EMBEDDING_RECIPE_VERSION,
          provider,
        )
      : null;
    const decisionSpace = needsDecision
      ? requireCompatibleSpace(
          decisionSpaceResult,
          access,
          "decision",
          DECISION_EMBEDDING_RECIPE_VERSION,
          provider,
        )
      : null;
    const vectors = await provider.embed(
      recipes.map((item) => item.recipe.text),
      signal,
      "search_document",
    );
    if (vectors.length !== recipes.length) fail("INGESTION_EMBEDDING_FAILED");
    return new Map(
      recipes.map((item, index) => {
        const space = item.entityType === "memory" ? memorySpace : decisionSpace;
        if (space === null) fail("INGESTION_STATE_CONFLICT");
        return [
          item.proposalId,
          {
            spaceId: space.id,
            contentHash: item.recipe.contentHash,
            vector: requireVector(vectors[index], space.dimensions),
          },
        ] as const;
      }),
    );
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof IngestionPersistenceError) throw error;
    if (error instanceof BrainAuthorizationError) throw error;
    throw new IngestionPersistenceError("INGESTION_EMBEDDING_FAILED", {
      retryable: true,
    });
  }
}

async function revalidateEmbeddingSpaces(
  transaction: SecondBrainTransaction,
  access: BrainAccessContext,
  embeddings: ReadonlyMap<string, ContentEmbedding>,
  provider: EmbeddingProvider,
): Promise<void> {
  const ids = [...new Set([...embeddings.values()].map((value) => value.spaceId))];
  if (ids.length === 0) return;
  const rows = await transaction
    .select()
    .from(embeddingSpaces)
    .where(
      and(inArray(embeddingSpaces.id, ids), eq(embeddingSpaces.status, "active")),
    )
    .for("share");
  if (rows.length !== ids.length) fail("INGESTION_STATE_CONFLICT");
  for (const row of rows) {
    if (
      row.provider !== provider.provider ||
      row.model !== provider.model ||
      row.modelRevision !== provider.modelRevision ||
      row.dimensions !== provider.dimensions ||
      row.metric !== "cosine" ||
      (row.entityType === "memory" &&
        row.recipeVersion !== MEMORY_EMBEDDING_RECIPE_VERSION) ||
      (row.entityType === "decision" &&
        row.recipeVersion !== DECISION_EMBEDDING_RECIPE_VERSION) ||
      (row.entityType !== "memory" && row.entityType !== "decision")
    ) {
      fail("INGESTION_STATE_CONFLICT");
    }
  }
}

function effectDigest(
  runId: string,
  reviewedDigest: string,
  proposal: IngestProposal,
  item: IngestReviewItem,
): string {
  return canonicalDigest({
    runId,
    reviewedDigest,
    proposalId: proposal.id,
    decision: item.decision,
    payload: item.replacement ?? proposal.payload,
  });
}

export class DrizzleReviewedIngestionCommitter
  implements ReviewedIngestionCommitter
{
  constructor(
    private readonly database: SecondBrainDatabase,
    private readonly embeddingSpaces: EmbeddingSpaceStore,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  commitReviewedRun(
    access: BrainAccessContext,
    runId: string,
    input: {
      readonly reviewedDigest: string;
      readonly idempotencyKey: string;
      readonly mode: "atomic" | "durable_partial";
    },
    signal: AbortSignal,
  ): Promise<IngestionCommitResult | null> {
    return stableFailure(signal, async () => {
      requireDigest(input.reviewedDigest);
      requireNonBlank(input.idempotencyKey, 200);
      if (input.mode !== "atomic") fail("INGESTION_MODE_UNSUPPORTED");
      const requestDigest = canonicalDigest({
        runId,
        reviewedDigest: input.reviewedDigest,
        mode: input.mode,
      });
      const initial = await this.database.transaction((transaction) =>
        loadCommitSnapshot(transaction, access, runId, signal, false),
      );
      if (initial === null) return null;
      if (
        initial.run.status === "completed" ||
        initial.run.status === "completed_with_skips"
      ) {
        return replayCommit(initial, input.idempotencyKey, requestDigest);
      }
      if (
        initial.run.status !== "reviewed" ||
        initial.run.reviewedDigest !== input.reviewedDigest ||
        initial.receipts.length !== 0
      ) {
        fail("INGESTION_STATE_CONFLICT");
      }

      const preparedEmbeddings = await prepareReviewedEmbeddings(
        initial,
        access,
        this.embeddingSpaces,
        this.embeddings,
        signal,
      );

      return this.database.transaction(async (transaction) => {
        const current = await loadCommitSnapshot(
          transaction,
          access,
          runId,
          signal,
          true,
        );
        if (current === null) return null;
        if (
          current.run.status === "completed" ||
          current.run.status === "completed_with_skips"
        ) {
          return replayCommit(current, input.idempotencyKey, requestDigest);
        }
        if (
          current.run.status !== "reviewed" ||
          current.run.reviewedDigest !== input.reviewedDigest ||
          current.run.proposalDigest !== initial.run.proposalDigest ||
          current.run.responseDigest !== initial.run.responseDigest ||
          current.receipts.length !== 0
        ) {
          fail("INGESTION_STATE_CONFLICT");
        }
        await revalidateEmbeddingSpaces(
          transaction,
          access,
          preparedEmbeddings,
          this.embeddings,
        );
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`ingestion-commit:${input.idempotencyKey}`}, 0))`,
        );
        const [keyOwner] = await transaction
          .select({
            id: ingestRuns.id,
            commitRequestDigest: ingestRuns.commitRequestDigest,
          })
          .from(ingestRuns)
          .where(eq(ingestRuns.commitIdempotencyKey, input.idempotencyKey))
          .limit(1);
        if (
          keyOwner !== undefined &&
          (keyOwner.id !== runId || keyOwner.commitRequestDigest !== requestDigest)
        ) {
          fail("INGESTION_IDEMPOTENCY_CONFLICT");
        }
        const [committingRun] = await transaction
          .update(ingestRuns)
          .set({
            status: "committing",
            commitIdempotencyKey: input.idempotencyKey,
            commitRequestDigest: requestDigest,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(ingestRuns.id, runId),
              eq(ingestRuns.status, "reviewed"),
              eq(ingestRuns.reviewedDigest, input.reviewedDigest),
            ),
          )
          .returning();
        if (committingRun === undefined) fail("INGESTION_STATE_CONFLICT");

        const reviewByProposal = new Map(
          current.review.items.map((item) => [item.proposalId, item]),
        );
        const receiptValues: (typeof ingestReceipts.$inferInsert)[] = [];
        for (const proposal of current.proposals) {
          signal.throwIfAborted();
          const item = reviewByProposal.get(proposal.id);
          if (item === undefined) fail("INGESTION_DIGEST_MISMATCH");
          const payload = item.replacement ?? proposal.payload;
          const digest = effectDigest(runId, input.reviewedDigest, proposal, item);
          if (item.decision === "reject") {
            receiptValues.push({
              runId,
              proposalId: proposal.id,
              entityType: payload.kind,
              entityId: null,
              status: "skipped",
              reason: "review_rejected",
              effectDigest: digest,
              activityEventId: null,
            });
            continue;
          }

          const helperIdempotencyKey = effectIdempotencyKey(
            runId,
            proposal.id,
            input.idempotencyKey,
          );
          let entityId: string;
          let activityEventId: string;
          try {
            if (payload.kind === "memory") {
              const embedding = preparedEmbeddings.get(proposal.id);
              if (embedding === undefined) fail("INGESTION_EMBEDDING_FAILED");
              const result = await writeMemoryVersionInTransaction(
                transaction,
                access,
                {
                  content: payload.content,
                  category: payload.category,
                  tags: payload.tags,
                  projectId: payload.projectId,
                  personIds: payload.personIds,
                  effectiveAt:
                    current.source.capturedAt ?? current.source.createdAt,
                  capturedAt: current.source.capturedAt,
                  sourceExcerpt: proposal.sourceQuote,
                  idempotencyKey: helperIdempotencyKey,
                  embedding,
                  supersedesId: null,
                  expectedSupersededHash: null,
                  expectedSupersededVersion: null,
                },
                signal,
              );
              if (result === null) fail("INGESTION_EFFECT_FAILED");
              entityId = result.result.memory.id;
              activityEventId = result.activityEventId;
            } else if (payload.kind === "decision") {
              const embedding = preparedEmbeddings.get(proposal.id);
              if (embedding === undefined) fail("INGESTION_EMBEDDING_FAILED");
              const result = await createDecisionInTransaction(
                transaction,
                access,
                {
                  statement: payload.statement,
                  rationale: payload.rationale,
                  rejectedAlternatives: payload.rejectedAlternatives,
                  projectId: payload.projectId,
                  personIds: payload.personIds,
                  decidedAt:
                    payload.decidedAt ??
                    current.source.capturedAt ??
                    current.source.createdAt,
                  sourceExcerpt: proposal.sourceQuote,
                  embedding,
                  idempotencyKey: helperIdempotencyKey,
                  supersedesId: null,
                  expectedSupersededHash: null,
                  expectedSupersededVersion: null,
                },
                signal,
              );
              if (result === null) fail("INGESTION_EFFECT_FAILED");
              entityId = result.decision.id;
              activityEventId = result.activityEventId;
            } else if (payload.kind === "task") {
              // A proposal may cite no task list; committing one requires a
              // resolvable list, so acceptance without one fails the effect.
              if (payload.listId === null) fail("INGESTION_EFFECT_FAILED");
              const result = await createTaskInTransaction(
                transaction,
                access,
                {
                  listId: payload.listId,
                  title: payload.title,
                  description: payload.description,
                  priority: payload.priority,
                  dueAt: payload.dueAt,
                  projectId: payload.projectId,
                  goalLinks: payload.goalIds.map((goalId) => ({
                    goalId,
                    basis: "reviewed_inference" as const,
                    confidence: null,
                  })),
                  idempotencyKey: helperIdempotencyKey,
                },
                signal,
              );
              if (result === null) fail("INGESTION_EFFECT_FAILED");
              entityId = result.task.id;
              activityEventId = result.activityEventId;
            } else if (payload.kind === "reminder") {
              const result = await createReminderInTransaction(
                transaction,
                access,
                {
                  message: payload.message,
                  remindAt: payload.remindAt,
                  idempotencyKey: helperIdempotencyKey,
                },
                signal,
              );
              entityId = result.reminder.id;
              activityEventId = result.activityEventId;
            } else {
              const result = await createPersonInTransaction(
                transaction,
                access,
                {
                  name: payload.name,
                  aliases: payload.aliases,
                  notes: payload.notes,
                  summary: null,
                  tags: [],
                  projectIds: [],
                  knowledgeBaseIds: [],
                  idempotencyKey: helperIdempotencyKey,
                },
                signal,
              );
              entityId = result.person.id;
              activityEventId = result.activityEventId;
            }
          } catch (error) {
            if (signal.aborted) signal.throwIfAborted();
            if (error instanceof IngestionPersistenceError) throw error;
            if (error instanceof BrainAuthorizationError) throw error;
            fail("INGESTION_EFFECT_FAILED");
          }
          receiptValues.push({
            runId,
            proposalId: proposal.id,
            entityType: payload.kind,
            entityId,
            status: "committed",
            reason: null,
            effectDigest: digest,
            activityEventId,
          });
        }

        const insertedReceipts =
          receiptValues.length === 0
            ? []
            : await transaction
                .insert(ingestReceipts)
                .values(receiptValues)
                .returning();
        if (insertedReceipts.length !== receiptValues.length) {
          fail("INGESTION_PERSISTENCE_FAILED");
        }
        const hasSkips = receiptValues.some((receipt) => receipt.status === "skipped");
        const [completedRun] = await transaction
          .update(ingestRuns)
          .set({
            status: hasSkips ? "completed_with_skips" : "completed",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(ingestRuns.id, runId),
              eq(ingestRuns.status, "committing"),
              eq(ingestRuns.commitIdempotencyKey, input.idempotencyKey),
              eq(ingestRuns.commitRequestDigest, requestDigest),
            ),
          )
          .returning();
        if (completedRun === undefined) fail("INGESTION_STATE_CONFLICT");
        const receipts = insertedReceipts
          .map(receiptFromRow)
          .sort(
            (left, right) =>
              current.proposals.findIndex(
                (proposal) => proposal.id === left.proposalId,
              ) -
              current.proposals.findIndex(
                (proposal) => proposal.id === right.proposalId,
              ),
          );
        return { run: runFromRow(completedRun), receipts };
      });
    });
  }
}
