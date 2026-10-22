import { z } from "zod";

import {
  canonicalDigest,
  ingestProposalKinds,
  ingestRunStatuses,
  ingestionProposalPayloadDigest,
  ingestionRequestDigest,
  ingestionReviewDigest,
  maximumIngestExcerptCharacters,
  maximumIngestSourceQuoteCharacters,
  taskPriorities,
} from "../domain.js";
import type {
  IngestProposal,
  IngestProposalPayload,
  IngestReviewItem,
  IngestionProvider,
  IngestionStore,
  BrainAccessStore,
  ReviewedIngestionCommitter,
} from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  actorAttributionSchema,
  idempotencyKeySchema,
  idSchema,
  rejectedAlternativeSchema,
  timestampSchema,
} from "./schemas.js";

const ingestionSchemaVersion = "ingestion-proposal/v1";
const maximumProposals = 100;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const canonicalTimestampSchema = timestampSchema;

const lowercaseLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => value === value.toLowerCase(), {
    message: "must be lowercase",
  });

// The propose prompt instructs the model to send null or empty when a value
// is not stated in the excerpt, so empty nullable strings normalize to null
// instead of rejecting the whole proposal set.
const emptyAsNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

function nullableModelField<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(emptyAsNull, schema.nullable());
}

const proposedMemorySchema = z.strictObject({
  kind: z.literal("memory"),
  content: z.string().trim().min(1).max(10_000),
  category: nullableModelField(lowercaseLabelSchema),
  tags: z.array(lowercaseLabelSchema).max(20),
  projectId: nullableModelField(idSchema),
  personIds: z.array(idSchema).max(20),
});

const proposedDecisionSchema = z.strictObject({
  kind: z.literal("decision"),
  statement: z.string().trim().min(1).max(2_000),
  rationale: z.string().trim().min(1).max(10_000),
  rejectedAlternatives: z.array(rejectedAlternativeSchema.strict()).max(20),
  projectId: nullableModelField(idSchema),
  personIds: z.array(idSchema).max(20),
  decidedAt: nullableModelField(canonicalTimestampSchema),
});

const proposedTaskSchema = z.strictObject({
  kind: z.literal("task"),
  listId: nullableModelField(idSchema),
  title: z.string().trim().min(1).max(500),
  description: nullableModelField(z.string().trim().min(1).max(10_000)),
  priority: z.enum(taskPriorities),
  dueAt: nullableModelField(canonicalTimestampSchema),
  projectId: nullableModelField(idSchema),
  goalIds: z.array(idSchema).max(20),
});

const proposedReminderSchema = z.strictObject({
  kind: z.literal("reminder"),
  message: z.string().trim().min(1).max(2_000),
  remindAt: canonicalTimestampSchema,
});

const proposedPersonSchema = z.strictObject({
  kind: z.literal("person"),
  name: z.string().trim().min(1).max(300),
  aliases: z.array(z.string().trim().min(1).max(300)).max(50),
  notes: nullableModelField(z.string().trim().min(1).max(10_000)),
});

export const ingestProposalPayloadSchema = z.discriminatedUnion("kind", [
  proposedMemorySchema,
  proposedDecisionSchema,
  proposedTaskSchema,
  proposedReminderSchema,
  proposedPersonSchema,
]);

const modelProposalSchema = z.strictObject({
  payload: ingestProposalPayloadSchema,
  confidence: z.number().min(0).max(1).refine(
    (value) => {
      const rounded = Math.round(value * 1_000) / 1_000;
      return Math.abs(value - rounded) <= Number.EPSILON * 4;
    },
    { message: "Confidence must have at most three decimal places." },
  ),
  sourceSpan: z.strictObject({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1).max(maximumIngestSourceQuoteCharacters),
  }),
});

const modelPayloadSchema = z.strictObject({
  proposals: z.array(modelProposalSchema).max(maximumProposals),
});

const modelResultSchema = z.strictObject({
  payload: z.unknown(),
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(500),
  finishReason: z.literal("stop"),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
});

const ingestRunSchema = z.strictObject({
  id: idSchema,
  sourceId: idSchema,
  status: z.enum(ingestRunStatuses),
  proposalProvider: z.string().min(1).max(200),
  proposalModel: z.string().min(1).max(500),
  schemaVersion: z.string().min(1).max(100),
  proposalCount: z.number().int().nonnegative().max(maximumProposals),
  proposalDigest: digestSchema.nullable(),
  responseDigest: digestSchema.nullable(),
  reviewedDigest: digestSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const ingestProposalSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  ordinal: z.number().int().nonnegative(),
  payload: ingestProposalPayloadSchema,
  confidence: z.number().min(0).max(1),
  sourceStart: z.number().int().nonnegative(),
  sourceEnd: z.number().int().positive(),
  sourceQuote: z.string().min(1).max(maximumIngestSourceQuoteCharacters),
  payloadDigest: digestSchema,
  createdAt: timestampSchema,
});

const ingestReviewItemSchema = z.strictObject({
  proposalId: idSchema,
  decision: z.enum(["accept", "reject"]),
  replacement: z.null(),
});

const ingestReviewSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  reviewDigest: digestSchema,
  items: z.array(ingestReviewItemSchema).max(maximumProposals),
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
});

const ingestReceiptSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  proposalId: idSchema,
  entityType: z.enum(ingestProposalKinds),
  entityId: idSchema.nullable(),
  status: z.enum(["committed", "skipped"]),
  reason: z.string().trim().min(1).max(500).nullable(),
  effectDigest: digestSchema,
  createdAt: timestampSchema,
});

const receiptsSchema = z.array(ingestReceiptSchema).max(maximumProposals).superRefine(
  (receipts, context) => {
    const proposalIds = new Set<string>();
    const receiptIds = new Set<string>();
    for (const receipt of receipts) {
      if (proposalIds.has(receipt.proposalId)) {
        context.addIssue({
          code: "custom",
          message: "Receipts must contain at most one effect for each proposal.",
        });
      }
      if (receiptIds.has(receipt.id)) {
        context.addIssue({
          code: "custom",
          message: "Receipt identifiers must be unique.",
        });
      }
      proposalIds.add(receipt.proposalId);
      receiptIds.add(receipt.id);
    }
  },
);

function canonicalInstant(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function canonicalPayload(payload: IngestProposalPayload): IngestProposalPayload {
  if (payload.kind === "decision") {
    return { ...payload, decidedAt: canonicalInstant(payload.decidedAt) };
  }
  if (payload.kind === "task") {
    return { ...payload, dueAt: canonicalInstant(payload.dueAt) };
  }
  if (payload.kind === "reminder") {
    return { ...payload, remindAt: canonicalInstant(payload.remindAt)! };
  }
  return structuredClone(payload);
}

function sourceQuoteAtOffset(
  excerpt: string,
  span: { readonly start: number; readonly end: number; readonly quote: string },
): boolean {
  return span.start < span.end &&
    span.end <= excerpt.length &&
    excerpt.slice(span.start, span.end) === span.quote;
}

/**
 * Models cite the quote verbatim far more reliably than they count UTF-16
 * offsets, so a span whose quote appears in the excerpt is re-anchored at the
 * occurrence nearest the claimed start. A quote absent from the excerpt stays
 * an error: the citation itself is ungrounded, not merely miscounted.
 */
function groundedSourceSpan(
  excerpt: string,
  span: { readonly start: number; readonly end: number; readonly quote: string },
): { readonly start: number; readonly end: number; readonly quote: string } | null {
  if (sourceQuoteAtOffset(excerpt, span)) return span;
  if (span.quote.length === 0) return null;
  let nearest: number | null = null;
  for (
    let index = excerpt.indexOf(span.quote);
    index !== -1;
    index = excerpt.indexOf(span.quote, index + 1)
  ) {
    if (nearest === null || Math.abs(index - span.start) < Math.abs(nearest - span.start)) {
      nearest = index;
    }
  }
  if (nearest === null) return null;
  return { start: nearest, end: nearest + span.quote.length, quote: span.quote };
}

function parseProviderResult(
  raw: unknown,
  excerpt: string,
): {
  readonly provider: string;
  readonly model: string;
  readonly finishReason: "stop";
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly proposals: readonly {
    readonly payload: IngestProposalPayload;
    readonly confidence: number;
    readonly sourceStart: number;
    readonly sourceEnd: number;
    readonly sourceQuote: string;
  }[];
  readonly responseDigest: string;
} {
  const result = modelResultSchema.parse(raw);
  const payload = modelPayloadSchema.parse(result.payload);
  const proposals = payload.proposals.map((proposal) => {
    const span = groundedSourceSpan(excerpt, proposal.sourceSpan);
    if (span === null) {
      throw new Error("The ingestion model returned an invalid source span.");
    }
    return {
      payload: canonicalPayload(proposal.payload),
      confidence: proposal.confidence,
      sourceStart: span.start,
      sourceEnd: span.end,
      sourceQuote: span.quote,
    };
  });
  return {
    provider: result.provider,
    model: result.model,
    finishReason: result.finishReason,
    usage: result.usage,
    proposals,
    responseDigest: canonicalDigest({
      provider: result.provider,
      model: result.model,
      finishReason: result.finishReason,
      usage: result.usage,
      proposals,
    }),
  };
}

function writableProposal(proposal: IngestProposal) {
  return {
    ...proposal,
    payload: writableProposalPayload(proposal.payload),
  };
}

function writableProposalPayload(payload: IngestProposalPayload) {
  switch (payload.kind) {
    case "memory":
      return { ...payload, tags: [...payload.tags], personIds: [...payload.personIds] };
    case "decision":
      return {
        ...payload,
        rejectedAlternatives: payload.rejectedAlternatives.map((item) => ({ ...item })),
        personIds: [...payload.personIds],
      };
    case "task":
      return { ...payload, goalIds: [...payload.goalIds] };
    case "person":
      return { ...payload, aliases: [...payload.aliases] };
    case "reminder":
      return { ...payload };
  }
}

function assertCompleteProposalRun(
  run: z.infer<typeof ingestRunSchema>,
): asserts run is z.infer<typeof ingestRunSchema> & {
  readonly proposalDigest: string;
  readonly responseDigest: string;
} {
  if (run.proposalDigest === null || run.responseDigest === null) {
    throw new Error("The ingestion proposal is not ready for review.");
  }
}

function sanitizedFailure(message: string): Error {
  return new Error(message);
}

export function createIngestionCapabilities(
  accessStore: BrainAccessStore,
  ingestionStore: IngestionStore,
  ingestionCommitter: ReviewedIngestionCommitter,
  provider: IngestionProvider,
) {
  const propose = defineCapability({
    title: "Propose records from a conversation",
    description:
      "Extracts cited candidate records from a conversation, persists a reviewable proposal set, and never commits brain content.",
    input: z.strictObject({
      excerpt: z.string().min(1).max(maximumIngestExcerptCharacters).refine(
        (value) => value.trim().length > 0,
        { message: "The excerpt must contain non-whitespace text." },
      ),
      capturedAt: canonicalTimestampSchema.nullable().default(null),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: z.strictObject({
      run: ingestRunSchema,
      proposals: z.array(ingestProposalSchema).max(maximumProposals),
      proposalDigest: digestSchema,
      replayed: z.boolean(),
    }),
    access: "authenticated",
    timeoutMs: 120_000,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const capturedAt = canonicalInstant(input.capturedAt);
      const requestDigest = ingestionRequestDigest({
        schemaVersion: ingestionSchemaVersion,
        excerpt: input.excerpt,
        capturedAt,
      });

      let reservation: Awaited<ReturnType<IngestionStore["createSourceAndRun"]>>;
      try {
        reservation = await ingestionStore.createSourceAndRun(
          access,
          {
            idempotencyKey: input.idempotencyKey,
            requestDigest,
            excerpt: input.excerpt,
            capturedAt,
            proposalProvider: provider.ingestionProvider,
            proposalModel: provider.ingestionModel,
            schemaVersion: ingestionSchemaVersion,
          },
          context.signal,
        );
      } catch {
        context.signal.throwIfAborted();
        throw sanitizedFailure("The ingestion proposal could not be persisted.");
      }

      if (
        reservation.created &&
        (
          reservation.run.proposalProvider !== provider.ingestionProvider ||
          reservation.run.proposalModel !== provider.ingestionModel
        )
      ) {
        throw sanitizedFailure("The ingestion proposal could not be persisted.");
      }

      if (!reservation.created) {
        try {
          const existing = await ingestionStore.getRunStatus(
            access,
            reservation.run.id,
            context.signal,
          );
          if (existing === null) {
            throw new Error("Persisted ingestion run disappeared.");
          }
          if (
            existing.run.proposalDigest !== null &&
            existing.run.responseDigest !== null
          ) {
            assertCompleteProposalRun(existing.run);
            return {
              run: existing.run,
              proposals: existing.proposals.map(writableProposal),
              proposalDigest: existing.run.proposalDigest,
              replayed: true,
            };
          }
          if (
            existing.run.status !== "proposing" ||
            existing.proposals.length !== 0 ||
            existing.run.proposalProvider !== provider.ingestionProvider ||
            existing.run.proposalModel !== provider.ingestionModel
          ) {
            throw new Error("Persisted ingestion proposal state conflicts with the retry.");
          }
        } catch {
          context.signal.throwIfAborted();
          throw sanitizedFailure("The ingestion proposal could not be persisted.");
        }
      }

      const referenceTime = new Date().toISOString();
      // The model step has no side effects, so transient provider failures
      // (timeouts, malformed responses, invalid payloads) get a bounded
      // number of fresh attempts inside the capability's time budget.
      let modelResult: ReturnType<typeof parseProviderResult> | undefined;
      for (let attempt = 0; attempt < 3 && modelResult === undefined; attempt += 1) {
        context.signal.throwIfAborted();
        try {
          const raw = await provider.propose(
            {
              excerpt: input.excerpt,
              capturedAt,
              referenceTime,
              schemaVersion: ingestionSchemaVersion,
            },
            context.signal,
          );
          modelResult = parseProviderResult(raw, input.excerpt);
        } catch {
          context.signal.throwIfAborted();
        }
      }
      if (
        modelResult === undefined ||
        // A mismatched identity is configuration drift, not a transient.
        modelResult.provider !== provider.ingestionProvider ||
        modelResult.model !== provider.ingestionModel
      ) {
        throw sanitizedFailure("The ingestion model could not produce a valid proposal set.");
      }

      try {
        const saved = await ingestionStore.saveProposals(
          access,
          reservation.run.id,
          {
            proposals: modelResult.proposals.map((proposal, ordinal) => ({
              ordinal,
              payload: structuredClone(proposal.payload),
              confidence: proposal.confidence,
              sourceStart: proposal.sourceStart,
              sourceEnd: proposal.sourceEnd,
              sourceQuote: proposal.sourceQuote,
              payloadDigest: ingestionProposalPayloadDigest(proposal.payload),
            })),
            responseDigest: modelResult.responseDigest,
          },
          context.signal,
        );
        assertCompleteProposalRun(saved.run);
        return {
          run: saved.run,
          proposals: saved.proposals.map(writableProposal),
          proposalDigest: saved.run.proposalDigest,
          replayed: !reservation.created,
        };
      } catch {
        context.signal.throwIfAborted();
        throw sanitizedFailure("The ingestion proposal could not be persisted.");
      }
    },
  });

  const review = defineCapability({
    title: "Review an ingestion proposal",
    description:
      "Accepts or rejects persisted proposal IDs against the exact proposal digest. Review cannot inject replacement records.",
    input: z.strictObject({
      runId: idSchema,
      proposalDigest: digestSchema,
      items: z.array(z.strictObject({
        proposalId: idSchema,
        decision: z.enum(["accept", "reject"]),
      })).max(maximumProposals).superRefine((items, context) => {
        const seen = new Set<string>();
        for (const item of items) {
          if (seen.has(item.proposalId)) {
            context.addIssue({
              code: "custom",
              message: "Each proposal may be reviewed only once.",
            });
          }
          seen.add(item.proposalId);
        }
      }),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: ingestReviewSchema,
    access: "authenticated",
    timeoutMs: 30_000,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const items: IngestReviewItem[] = [...input.items]
        .sort((left, right) => left.proposalId.localeCompare(right.proposalId))
        .map((item) => ({ ...item, replacement: null }));
      const reviewDigest = ingestionReviewDigest({
        runId: input.runId,
        proposalDigest: input.proposalDigest,
        items,
      });
      try {
        const saved = await ingestionStore.saveReview(
          access,
          input.runId,
          {
            expectedProposalDigest: input.proposalDigest,
            reviewDigest,
            items,
            idempotencyKey: input.idempotencyKey,
          },
          context.signal,
        );
        if (saved === null) {
          throw new Error("Review precondition failed.");
        }
        return {
          ...saved,
          items: saved.items.map((item) => ({
            proposalId: item.proposalId,
            decision: item.decision,
            replacement: null,
          })),
          provenance: { ...saved.provenance },
        };
      } catch {
        context.signal.throwIfAborted();
        throw sanitizedFailure("The ingestion review could not be saved.");
      }
    },
  });

  const commit = defineCapability({
    title: "Commit a reviewed ingestion run",
    description:
      "Commits only the accepted records in a persisted reviewed set and returns one durable receipt per handled proposal.",
    input: z.strictObject({
      runId: idSchema,
      reviewedDigest: digestSchema,
      mode: z.enum(["atomic", "durable_partial"]).default("atomic"),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: z.strictObject({
      run: ingestRunSchema,
      receipts: receiptsSchema,
    }),
    access: "authenticated",
    timeoutMs: 120_000,
    annotations: {
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: true,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      try {
        const committed = await ingestionCommitter.commitReviewedRun(
          access,
          input.runId,
          {
            reviewedDigest: input.reviewedDigest,
            idempotencyKey: input.idempotencyKey,
            mode: input.mode,
          },
          context.signal,
        );
        if (committed === null) {
          throw new Error("Commit precondition failed.");
        }
        return {
          run: committed.run,
          receipts: committed.receipts.map((receipt) => ({ ...receipt })),
        };
      } catch {
        context.signal.throwIfAborted();
        throw sanitizedFailure("The reviewed ingestion run could not be committed.");
      }
    },
  });

  const status = defineCapability({
    title: "Read ingestion run status",
    description:
      "Returns the persisted proposal, review, and exact-once receipts for one ingestion run without invoking a model or committing data.",
    input: z.strictObject({
      runId: idSchema,
    }),
    output: z.strictObject({
      result: z.strictObject({
        run: ingestRunSchema,
        proposals: z.array(ingestProposalSchema).max(maximumProposals),
        review: ingestReviewSchema.nullable(),
        receipts: receiptsSchema,
      }).nullable(),
    }),
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      try {
        const result = await ingestionStore.getRunStatus(
          access,
          input.runId,
          context.signal,
        );
        if (result === null) return { result: null };
        return {
          result: {
            run: result.run,
            proposals: result.proposals.map(writableProposal),
            review: result.review === null
              ? null
              : {
                  ...result.review,
                  items: result.review.items.map((item) => ({
                    proposalId: item.proposalId,
                    decision: item.decision,
                    replacement: null,
                  })),
                  provenance: { ...result.review.provenance },
                },
            receipts: result.receipts.map((receipt) => ({ ...receipt })),
          },
        };
      } catch {
        context.signal.throwIfAborted();
        throw sanitizedFailure("The ingestion run status could not be read.");
      }
    },
  });

  return {
    ingestion_propose: propose,
    ingestion_review: review,
    ingestion_commit: commit,
    ingestion_status: status,
  } as const;
}
