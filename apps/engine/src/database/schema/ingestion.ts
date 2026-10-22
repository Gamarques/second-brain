import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  actorAttributionCheck,
  actorKindEnum,
  createdAtColumn,
  idColumn,
  instantColumn,
  mutationSourceEnum,
  updatedAtColumn,
} from "./common.js";
import { accounts } from "./identity.js";
import { activityEvents } from "./temporal.js";

export const ingestRunStatusEnum = pgEnum("ingest_run_status", [
  "proposing",
  "awaiting_review",
  "reviewed",
  "committing",
  "completed",
  "completed_with_skips",
  "failed",
]);
export const ingestProposalKindEnum = pgEnum("ingest_proposal_kind", [
  "memory",
  "decision",
  "task",
  "reminder",
  "person",
]);
export const ingestReviewDecisionEnum = pgEnum("ingest_review_decision", [
  "accept",
  "reject",
]);
export const ingestReceiptStatusEnum = pgEnum("ingest_receipt_status", [
  "committed",
  "skipped",
]);

const fullProvenanceColumns = () => ({
  actorKind: actorKindEnum("actor_kind").notNull(),
  actorAccountId: uuid("actor_account_id").references(() => accounts.id, {
    onDelete: "set null",
  }),
  actorClientId: text("actor_client_id"),
  actorSource: mutationSourceEnum("actor_source").notNull(),
  requestId: text("request_id").notNull(),
  correlationId: text("correlation_id"),
  causationId: text("causation_id"),
  dreamingRunId: uuid("dreaming_run_id"),
});

export const ingestSources = pgTable(
  "ingest_sources",
  {
    id: idColumn(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    excerpt: text("excerpt").notNull(),
    capturedAt: instantColumn("captured_at"),
    ...fullProvenanceColumns(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("ingest_sources_idempotency_key").on(table.idempotencyKey),
    index("ingest_sources_created_idx").on(table.createdAt, table.id),
    check(
      "ingest_sources_request_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check("ingest_sources_excerpt_check", sql`length(${table.excerpt}) between 1 and 100000`),
    actorAttributionCheck("ingest_sources_actor_check", table),
  ],
);

export const ingestRuns = pgTable(
  "ingest_runs",
  {
    id: idColumn(),
    sourceId: uuid("source_id").notNull(),
    status: ingestRunStatusEnum("status").notNull().default("proposing"),
    proposalProvider: text("proposal_provider").notNull(),
    proposalModel: text("proposal_model").notNull(),
    schemaVersion: text("schema_version").notNull(),
    proposalCount: integer("proposal_count").notNull().default(0),
    proposalDigest: text("proposal_digest"),
    responseDigest: text("response_digest"),
    reviewedDigest: text("reviewed_digest"),
    commitIdempotencyKey: text("commit_idempotency_key"),
    commitRequestDigest: text("commit_request_digest"),
    sanitizedError: text("sanitized_error"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique("ingest_runs_source_key").on(table.sourceId),
    unique("ingest_runs_commit_idempotency_key").on(table.commitIdempotencyKey),
    foreignKey({
      name: "ingest_runs_source_fkey",
      columns: [table.sourceId],
      foreignColumns: [ingestSources.id],
    }).onDelete("cascade"),
    index("ingest_runs_status_idx").on(
      table.status,
      table.updatedAt,
      table.id,
    ),
    check("ingest_runs_proposal_count_check", sql`${table.proposalCount} >= 0`),
    check(
      "ingest_runs_reviewed_digest_check",
      sql`${table.reviewedDigest} is null or ${table.reviewedDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "ingest_runs_proposal_digest_check",
      sql`${table.proposalDigest} is null or ${table.proposalDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "ingest_runs_response_digest_check",
      sql`${table.responseDigest} is null or ${table.responseDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "ingest_runs_commit_digest_check",
      sql`(${table.commitIdempotencyKey} is null and ${table.commitRequestDigest} is null) or (nullif(btrim(${table.commitIdempotencyKey}), '') is not null and ${table.commitRequestDigest} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

export const ingestProposals = pgTable(
  "ingest_proposals",
  {
    id: idColumn(),
    runId: uuid("run_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    kind: ingestProposalKindEnum("kind").notNull(),
    payload: jsonb("payload").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3, mode: "number" })
      .notNull(),
    sourceQuote: text("source_quote").notNull(),
    sourceStart: integer("source_start").notNull(),
    sourceEnd: integer("source_end").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("ingest_proposals_run_id_key").on(table.runId, table.id),
    unique("ingest_proposals_run_ordinal_key").on(
      table.runId,
      table.ordinal,
    ),
    foreignKey({
      name: "ingest_proposals_run_fkey",
      columns: [table.runId],
      foreignColumns: [ingestRuns.id],
    }).onDelete("cascade"),
    check("ingest_proposals_ordinal_check", sql`${table.ordinal} >= 0`),
    check(
      "ingest_proposals_source_span_check",
      sql`${table.sourceStart} >= 0 and ${table.sourceEnd} > ${table.sourceStart}`,
    ),
    check(
      "ingest_proposals_source_quote_check",
      sql`length(${table.sourceQuote}) between 1 and 4000`,
    ),
    check(
      "ingest_proposals_confidence_check",
      sql`${table.confidence} between 0 and 1`,
    ),
    check(
      "ingest_proposals_payload_digest_check",
      sql`${table.payloadDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const ingestReviews = pgTable(
  "ingest_reviews",
  {
    id: idColumn(),
    runId: uuid("run_id").notNull(),
    reviewDigest: text("review_digest").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    ...fullProvenanceColumns(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("ingest_reviews_run_id_key").on(table.runId, table.id),
    unique("ingest_reviews_run_key").on(table.runId),
    unique("ingest_reviews_idempotency_key").on(table.idempotencyKey),
    foreignKey({
      name: "ingest_reviews_run_fkey",
      columns: [table.runId],
      foreignColumns: [ingestRuns.id],
    }).onDelete("cascade"),
    check(
      "ingest_reviews_digest_check",
      sql`${table.reviewDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    actorAttributionCheck("ingest_reviews_actor_check", table),
  ],
);

export const ingestReviewItems = pgTable(
  "ingest_review_items",
  {
    id: idColumn(),
    reviewId: uuid("review_id").notNull(),
    runId: uuid("run_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    decision: ingestReviewDecisionEnum("decision").notNull(),
    replacementPayload: jsonb("replacement_payload"),
    replacementDigest: text("replacement_digest"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("ingest_review_items_review_proposal_key").on(
      table.reviewId,
      table.proposalId,
    ),
    foreignKey({
      name: "ingest_review_items_review_fkey",
      columns: [table.runId, table.reviewId],
      foreignColumns: [ingestReviews.runId, ingestReviews.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "ingest_review_items_proposal_fkey",
      columns: [table.runId, table.proposalId],
      foreignColumns: [ingestProposals.runId, ingestProposals.id],
    }).onDelete("cascade"),
    check(
      "ingest_review_items_replacement_check",
      sql`(${table.replacementPayload} is null and ${table.replacementDigest} is null) or (${table.replacementPayload} is not null and ${table.replacementDigest} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

export const ingestReceipts = pgTable(
  "ingest_receipts",
  {
    id: idColumn(),
    runId: uuid("run_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    entityType: ingestProposalKindEnum("entity_type").notNull(),
    entityId: uuid("entity_id"),
    status: ingestReceiptStatusEnum("status").notNull(),
    reason: text("reason"),
    effectDigest: text("effect_digest").notNull(),
    activityEventId: uuid("activity_event_id"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("ingest_receipts_proposal_key").on(table.proposalId),
    unique("ingest_receipts_effect_key").on(table.effectDigest),
    foreignKey({
      name: "ingest_receipts_run_fkey",
      columns: [table.runId],
      foreignColumns: [ingestRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "ingest_receipts_proposal_fkey",
      columns: [table.runId, table.proposalId],
      foreignColumns: [ingestProposals.runId, ingestProposals.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "ingest_receipts_event_fkey",
      columns: [table.activityEventId],
      foreignColumns: [activityEvents.id],
    }).onDelete("restrict"),
    check(
      "ingest_receipts_effect_digest_check",
      sql`${table.effectDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "ingest_receipts_status_check",
      sql`(${table.status} = 'committed' and ${table.entityId} is not null and ${table.activityEventId} is not null and ${table.reason} is null)
        or (${table.status} = 'skipped' and ${table.entityId} is null and ${table.activityEventId} is null and nullif(btrim(${table.reason}), '') is not null)`,
    ),
  ],
);

export type IngestSourceRow = typeof ingestSources.$inferSelect;
export type IngestRunRow = typeof ingestRuns.$inferSelect;
export type IngestProposalRow = typeof ingestProposals.$inferSelect;
export type IngestReviewRow = typeof ingestReviews.$inferSelect;
export type IngestReceiptRow = typeof ingestReceipts.$inferSelect;
