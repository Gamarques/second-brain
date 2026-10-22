import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { automationJobs } from "./automation.js";
import {
  bytea,
  createdAtColumn,
  idColumn,
  instantColumn,
  requiredInstantColumn,
  sha256Check,
  updatedAtColumn,
} from "./common.js";
import { knowledgeBases, knowledgeDocumentRevisions, knowledgeDocuments } from "./content.js";
import { embeddingSpaces } from "./embeddings.js";
import { accounts } from "./identity.js";

/*
 * Brain Pack persistence: archives at rest, the packs and revisions this
 * brain has seen, the mapping from foreign items to local documents, the
 * origin of every imported revision, exact text where it is known, and the
 * import/export runs with their per-item decisions and results.
 */

export const brainPackArtifactKindEnum = pgEnum("brain_pack_artifact_kind", ["upload", "export"]);
export const brainPackRunKindEnum = pgEnum("brain_pack_run_kind", ["import", "export"]);
export const brainPackRunStatusEnum = pgEnum("brain_pack_run_status", [
  "uploaded",
  "validating",
  "awaiting_review",
  "reviewed",
  "indexing",
  "publishing",
  "queued",
  "snapshotting",
  "encoding",
  "completed",
  "failed",
  "canceled",
]);
export const brainPackItemKindEnum = pgEnum("brain_pack_item_kind", ["collection", "document"]);
export const brainPackItemClassificationEnum = pgEnum("brain_pack_item_classification", [
  "new",
  "updated",
  "unchanged",
  "conflicting",
  "invalid",
]);
export const brainPackItemDecisionEnum = pgEnum("brain_pack_item_decision", [
  "create",
  "update",
  "skip",
  "separate_copy",
  "keep_local",
]);
export const brainPackRunItemResultEnum = pgEnum("brain_pack_run_item_result", [
  "created",
  "updated",
  "skipped",
  "excluded",
  "failed",
]);
export const knowledgeContentRepresentationEnum = pgEnum("knowledge_content_representation", [
  "canonical",
  "reconstructed",
]);

const itemKeyCheck = (name: string, column: Parameters<typeof sha256Check>[1]) =>
  check(name, sql`${column} ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$'`);
const namespaceCheck = (name: string, column: Parameters<typeof sha256Check>[1]) =>
  check(name, sql`${column} ~ '^[a-z0-9]+(?:[.-][a-z0-9]+)*$' and length(${column}) <= 200`);

/** Archives at rest, in PostgreSQL: the one durable, backed-up store every service can reach. */
export const knowledgePackArtifacts = pgTable(
  "knowledge_pack_artifacts",
  {
    id: idColumn(),
    kind: brainPackArtifactKindEnum("kind").notNull(),
    ownerAccountId: uuid("owner_account_id").notNull(),
    contentType: text("content_type").notNull().default("application/zip"),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: createdAtColumn(),
    expiresAt: requiredInstantColumn("expires_at"),
  },
  (table) => [
    foreignKey({
      name: "knowledge_pack_artifacts_owner_fkey",
      columns: [table.ownerAccountId],
      foreignColumns: [accounts.id],
    }).onDelete("cascade"),
    index("knowledge_pack_artifacts_owner_idx").on(table.ownerAccountId, table.createdAt),
    index("knowledge_pack_artifacts_expires_idx").on(table.expiresAt),
    check("knowledge_pack_artifacts_content_type_check", sql`${table.contentType} = 'application/zip'`),
    check("knowledge_pack_artifacts_byte_size_check", sql`${table.byteSize} between 1 and 67108864`),
    sha256Check("knowledge_pack_artifacts_sha256_check", table.sha256),
  ],
);

/** A pack this brain published or received, identified by its publisher and foreign ID, never by a local UUID alone. */
export const knowledgePacks = pgTable(
  "knowledge_packs",
  {
    id: idColumn(),
    publisherNamespace: text("publisher_namespace").notNull(),
    externalPackId: uuid("external_pack_id").notNull(),
    /** True when this brain is the publisher and can re-export with stable keys. */
    owned: boolean("owned").notNull().default(false),
    title: text("title").notNull(),
    description: text("description"),
    language: text("language"),
    latestRevision: integer("latest_revision").notNull().default(0),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique("knowledge_packs_identity_key").on(table.publisherNamespace, table.externalPackId),
    namespaceCheck("knowledge_packs_namespace_check", table.publisherNamespace),
    check("knowledge_packs_title_check", sql`length(btrim(${table.title})) between 1 and 500`),
    check("knowledge_packs_latest_revision_check", sql`${table.latestRevision} >= 0`),
  ],
);

/** One validated manifest per pack revision; rows are never updated. */
export const knowledgePackRevisions = pgTable(
  "knowledge_pack_revisions",
  {
    id: idColumn(),
    packId: uuid("pack_id").notNull(),
    packRevision: integer("pack_revision").notNull(),
    formatVersion: integer("format_version").notNull(),
    manifest: jsonb("manifest").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    publisherDisplayName: text("publisher_display_name").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("knowledge_pack_revisions_number_key").on(table.packId, table.packRevision),
    foreignKey({
      name: "knowledge_pack_revisions_pack_fkey",
      columns: [table.packId],
      foreignColumns: [knowledgePacks.id],
    }).onDelete("cascade"),
    check("knowledge_pack_revisions_number_check", sql`${table.packRevision} > 0`),
    check("knowledge_pack_revisions_format_check", sql`${table.formatVersion} > 0`),
    sha256Check("knowledge_pack_revisions_manifest_sha256_check", table.manifestSha256),
  ],
);

/** Validated collection and document metadata of one pack revision, with the exact text hash of each document. */
export const knowledgePackItems = pgTable(
  "knowledge_pack_items",
  {
    id: idColumn(),
    packRevisionId: uuid("pack_revision_id").notNull(),
    kind: brainPackItemKindEnum("kind").notNull(),
    itemKey: text("item_key").notNull(),
    collectionKey: text("collection_key"),
    title: text("title").notNull(),
    representation: knowledgeContentRepresentationEnum("representation"),
    contentSha256: text("content_sha256"),
    byteSize: integer("byte_size"),
    characterCount: integer("character_count"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("knowledge_pack_items_key").on(table.packRevisionId, table.kind, table.itemKey),
    foreignKey({
      name: "knowledge_pack_items_revision_fkey",
      columns: [table.packRevisionId],
      foreignColumns: [knowledgePackRevisions.id],
    }).onDelete("cascade"),
    index("knowledge_pack_items_collection_idx").on(table.packRevisionId, table.collectionKey),
    itemKeyCheck("knowledge_pack_items_item_key_check", table.itemKey),
    check(
      "knowledge_pack_items_document_check",
      sql`(${table.kind} = 'document' and ${table.collectionKey} is not null and ${table.representation} is not null and ${table.contentSha256} ~ '^[0-9a-f]{64}$' and ${table.byteSize} >= 0 and ${table.characterCount} between 1 and 1000000)
        or (${table.kind} = 'collection' and ${table.collectionKey} is null and ${table.representation} is null and ${table.contentSha256} is null and ${table.byteSize} is null and ${table.characterCount} is null)`,
    ),
    check("knowledge_pack_items_title_check", sql`length(btrim(${table.title})) between 1 and 500`),
  ],
);

/** The explicit link from a foreign item to the local document it became; one per item, one per document. */
export const knowledgePackMappings = pgTable(
  "knowledge_pack_mappings",
  {
    id: idColumn(),
    packId: uuid("pack_id").notNull(),
    itemKey: text("item_key").notNull(),
    documentId: uuid("document_id").notNull(),
    importedPackRevision: integer("imported_pack_revision").notNull(),
    importedContentSha256: text("imported_content_sha256").notNull(),
    localRevisionId: uuid("local_revision_id"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique("knowledge_pack_mappings_identity_key").on(table.packId, table.itemKey),
    unique("knowledge_pack_mappings_document_key").on(table.documentId),
    foreignKey({
      name: "knowledge_pack_mappings_pack_fkey",
      columns: [table.packId],
      foreignColumns: [knowledgePacks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_pack_mappings_document_fkey",
      columns: [table.documentId],
      foreignColumns: [knowledgeDocuments.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_pack_mappings_local_revision_fkey",
      columns: [table.localRevisionId],
      foreignColumns: [knowledgeDocumentRevisions.id],
    }).onDelete("set null"),
    itemKeyCheck("knowledge_pack_mappings_item_key_check", table.itemKey),
    check("knowledge_pack_mappings_revision_check", sql`${table.importedPackRevision} > 0`),
    sha256Check("knowledge_pack_mappings_content_sha256_check", table.importedContentSha256),
  ],
);

/** Where a local revision came from: immutable, one per revision, kept apart from the importing account. */
export const knowledgeRevisionOrigins = pgTable(
  "knowledge_revision_origins",
  {
    id: idColumn(),
    revisionId: uuid("revision_id").notNull(),
    packRevisionId: uuid("pack_revision_id").notNull(),
    packItemId: uuid("pack_item_id").notNull(),
    attribution: jsonb("attribution").notNull().default({}),
    importedByAccountId: uuid("imported_by_account_id"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("knowledge_revision_origins_revision_key").on(table.revisionId),
    foreignKey({
      name: "knowledge_revision_origins_revision_fkey",
      columns: [table.revisionId],
      foreignColumns: [knowledgeDocumentRevisions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_revision_origins_pack_revision_fkey",
      columns: [table.packRevisionId],
      foreignColumns: [knowledgePackRevisions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "knowledge_revision_origins_pack_item_fkey",
      columns: [table.packItemId],
      foreignColumns: [knowledgePackItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "knowledge_revision_origins_importer_fkey",
      columns: [table.importedByAccountId],
      foreignColumns: [accounts.id],
    }).onDelete("set null"),
    index("knowledge_revision_origins_pack_item_idx").on(table.packItemId),
  ],
);

/** Exact revision text where it is known, so re-exports carry canonical bytes; historical revisions stay valid without it. */
export const knowledgeRevisionContents = pgTable(
  "knowledge_revision_contents",
  {
    revisionId: uuid("revision_id").primaryKey(),
    content: text("content").notNull(),
    representation: knowledgeContentRepresentationEnum("representation").notNull(),
    contentSha256: text("content_sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    foreignKey({
      name: "knowledge_revision_contents_revision_fkey",
      columns: [table.revisionId],
      foreignColumns: [knowledgeDocumentRevisions.id],
    }).onDelete("cascade"),
    check("knowledge_revision_contents_length_check", sql`length(${table.content}) between 1 and 1000000`),
    check("knowledge_revision_contents_byte_size_check", sql`${table.byteSize} >= 1`),
    sha256Check("knowledge_revision_contents_sha256_check", table.contentSha256),
  ],
);

/** An import or export run: who started it, where it is, what was frozen, and how it ended. */
export const knowledgePackRuns = pgTable(
  "knowledge_pack_runs",
  {
    id: idColumn(),
    kind: brainPackRunKindEnum("kind").notNull(),
    status: brainPackRunStatusEnum("status").notNull(),
    ownerAccountId: uuid("owner_account_id").notNull(),
    packId: uuid("pack_id"),
    packRevisionId: uuid("pack_revision_id"),
    artifactId: uuid("artifact_id"),
    jobId: uuid("job_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    reviewVersion: integer("review_version").notNull().default(0),
    reviewDigest: text("review_digest"),
    frozenSelection: jsonb("frozen_selection").notNull().default({}),
    progress: jsonb("progress").notNull().default({}),
    receipt: jsonb("receipt"),
    sanitizedError: text("sanitized_error"),
    cancelRequestedAt: instantColumn("cancel_requested_at"),
    completedAt: instantColumn("completed_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique("knowledge_pack_runs_idempotency_key").on(table.kind, table.idempotencyKey),
    foreignKey({
      name: "knowledge_pack_runs_owner_fkey",
      columns: [table.ownerAccountId],
      foreignColumns: [accounts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_pack_runs_pack_fkey",
      columns: [table.packId],
      foreignColumns: [knowledgePacks.id],
    }).onDelete("set null"),
    foreignKey({
      name: "knowledge_pack_runs_pack_revision_fkey",
      columns: [table.packRevisionId],
      foreignColumns: [knowledgePackRevisions.id],
    }).onDelete("set null"),
    foreignKey({
      name: "knowledge_pack_runs_artifact_fkey",
      columns: [table.artifactId],
      foreignColumns: [knowledgePackArtifacts.id],
    }).onDelete("set null"),
    foreignKey({
      name: "knowledge_pack_runs_job_fkey",
      columns: [table.jobId],
      foreignColumns: [automationJobs.id],
    }).onDelete("set null"),
    index("knowledge_pack_runs_owner_idx").on(table.ownerAccountId, table.createdAt, table.id),
    index("knowledge_pack_runs_status_idx").on(table.kind, table.status, table.updatedAt),
    check(
      "knowledge_pack_runs_status_kind_check",
      sql`(${table.kind} = 'import' and ${table.status} in ('uploaded', 'validating', 'awaiting_review', 'reviewed', 'indexing', 'publishing', 'completed', 'failed', 'canceled'))
        or (${table.kind} = 'export' and ${table.status} in ('queued', 'snapshotting', 'encoding', 'completed', 'failed', 'canceled'))`,
    ),
    check("knowledge_pack_runs_review_version_check", sql`${table.reviewVersion} >= 0`),
    check(
      "knowledge_pack_runs_review_digest_check",
      sql`${table.reviewDigest} is null or ${table.reviewDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    sha256Check("knowledge_pack_runs_request_digest_check", table.requestDigest),
    check(
      "knowledge_pack_runs_idempotency_key_check",
      sql`length(btrim(${table.idempotencyKey})) between 1 and 200`,
    ),
  ],
);

/** One row per pack item in a run: how it compared, what the reviewer decided, the checkpoint, and what happened. */
export const knowledgePackRunItems = pgTable(
  "knowledge_pack_run_items",
  {
    id: idColumn(),
    runId: uuid("run_id").notNull(),
    packItemId: uuid("pack_item_id"),
    itemKey: text("item_key").notNull(),
    collectionKey: text("collection_key").notNull(),
    title: text("title").notNull(),
    classification: brainPackItemClassificationEnum("classification").notNull(),
    decision: brainPackItemDecisionEnum("decision"),
    expectedLocalRevision: integer("expected_local_revision"),
    localDocumentId: uuid("local_document_id"),
    localRevision: integer("local_revision"),
    destinationKnowledgeBaseId: uuid("destination_knowledge_base_id"),
    result: brainPackRunItemResultEnum("result"),
    resultDocumentId: uuid("result_document_id"),
    resultRevisionId: uuid("result_revision_id"),
    checkpoint: jsonb("checkpoint").notNull().default({}),
    sanitizedError: text("sanitized_error"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique("knowledge_pack_run_items_key").on(table.runId, table.itemKey),
    foreignKey({
      name: "knowledge_pack_run_items_run_fkey",
      columns: [table.runId],
      foreignColumns: [knowledgePackRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_pack_run_items_pack_item_fkey",
      columns: [table.packItemId],
      foreignColumns: [knowledgePackItems.id],
    }).onDelete("set null"),
    foreignKey({
      name: "knowledge_pack_run_items_local_document_fkey",
      columns: [table.localDocumentId],
      foreignColumns: [knowledgeDocuments.id],
    }).onDelete("set null"),
    foreignKey({
      name: "knowledge_pack_run_items_destination_fkey",
      columns: [table.destinationKnowledgeBaseId],
      foreignColumns: [knowledgeBases.id],
    }).onDelete("set null"),
    foreignKey({
      name: "knowledge_pack_run_items_result_document_fkey",
      columns: [table.resultDocumentId],
      foreignColumns: [knowledgeDocuments.id],
    }).onDelete("set null"),
    foreignKey({
      name: "knowledge_pack_run_items_result_revision_fkey",
      columns: [table.resultRevisionId],
      foreignColumns: [knowledgeDocumentRevisions.id],
    }).onDelete("set null"),
    index("knowledge_pack_run_items_run_idx").on(table.runId, table.classification),
    itemKeyCheck("knowledge_pack_run_items_item_key_check", table.itemKey),
    itemKeyCheck("knowledge_pack_run_items_collection_key_check", table.collectionKey),
    check(
      "knowledge_pack_run_items_expected_revision_check",
      sql`${table.expectedLocalRevision} is null or ${table.expectedLocalRevision} > 0`,
    ),
    check(
      "knowledge_pack_run_items_local_revision_check",
      sql`${table.localRevision} is null or ${table.localRevision} > 0`,
    ),
  ],
);

/**
 * Chunks and vectors an import produced for one run item, kept apart from the
 * live tables until the run publishes. A retry resumes from what is here.
 */
export const knowledgePackRunChunks = pgTable(
  "knowledge_pack_run_chunks",
  {
    id: idColumn(),
    runItemId: uuid("run_item_id").notNull(),
    position: integer("position").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    spaceId: uuid("space_id").notNull(),
    recipeVersion: text("recipe_version").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("knowledge_pack_run_chunks_position_key").on(table.runItemId, table.position),
    foreignKey({
      name: "knowledge_pack_run_chunks_run_item_fkey",
      columns: [table.runItemId],
      foreignColumns: [knowledgePackRunItems.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_pack_run_chunks_recipe_fkey",
      columns: [table.spaceId, table.recipeVersion],
      foreignColumns: [embeddingSpaces.id, embeddingSpaces.recipeVersion],
    }).onDelete("cascade"),
    index("knowledge_pack_run_chunks_run_item_idx").on(table.runItemId, table.position),
    check("knowledge_pack_run_chunks_position_check", sql`${table.position} >= 0`),
    check("knowledge_pack_run_chunks_content_check", sql`length(${table.content}) between 1 and 1000000`),
    sha256Check("knowledge_pack_run_chunks_content_hash_check", table.contentHash),
  ],
);
