import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import {
  createdAtColumn,
  embeddingEntityTypeEnum,
  embeddingMetricEnum,
  embeddingSpaceStatusEnum,
  idColumn,
  instantColumn,
} from "./common.js";
import { decisions, knowledgeChunks, memories } from "./content.js";

export const embeddingSpaces = pgTable(
  "embedding_spaces",
  {
    id: idColumn(),
    entityType: embeddingEntityTypeEnum("entity_type").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    modelRevision: text("model_revision").notNull(),
    recipeVersion: text("recipe_version").notNull(),
    dimensions: integer("dimensions").notNull(),
    metric: embeddingMetricEnum("metric").notNull().default("cosine"),
    status: embeddingSpaceStatusEnum("status").notNull().default("preparing"),
    promotedAt: instantColumn("promoted_at"),
    retiredAt: instantColumn("retired_at"),
    failureCode: text("failure_code"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("embedding_spaces_id_type_key").on(table.id, table.entityType),
    unique("embedding_spaces_id_recipe_key").on(table.id, table.recipeVersion),
    unique("embedding_spaces_recipe_identity_key").on(
      table.entityType,
      table.provider,
      table.model,
      table.modelRevision,
      table.recipeVersion,
    ),
    uniqueIndex("embedding_spaces_one_active_key")
      .on(table.entityType)
      .where(sql`${table.status} = 'active'`),
    index("embedding_spaces_status_idx").on(
      table.entityType,
      table.status,
      table.id,
    ),
    check("embedding_spaces_dimensions_check", sql`${table.dimensions} = 1536`),
    check(
      "embedding_spaces_state_check",
      sql`(${table.status} = 'preparing' and ${table.promotedAt} is null and ${table.retiredAt} is null)
        or (${table.status} = 'active' and ${table.promotedAt} is not null and ${table.retiredAt} is null)
        or (${table.status} = 'retired' and ${table.promotedAt} is not null and ${table.retiredAt} is not null)
        or (${table.status} = 'failed' and nullif(btrim(${table.failureCode}), '') is not null)`,
    ),
  ],
);

export const memoryEmbeddings = pgTable(
  "memory_embeddings",
  {
    id: idColumn(),
    memoryId: uuid("memory_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    spaceEntityType: embeddingEntityTypeEnum("space_entity_type")
      .notNull()
      .default("memory"),
    contentHash: text("content_hash").notNull(),
    recipeVersion: text("recipe_version").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("memory_embeddings_entity_space_key").on(
      table.memoryId,
      table.spaceId,
    ),
    foreignKey({
      name: "memory_embeddings_memory_fkey",
      columns: [table.memoryId],
      foreignColumns: [memories.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "memory_embeddings_space_fkey",
      columns: [table.spaceId, table.spaceEntityType],
      foreignColumns: [embeddingSpaces.id, embeddingSpaces.entityType],
    }).onDelete("cascade"),
    foreignKey({
      name: "memory_embeddings_recipe_fkey",
      columns: [table.spaceId, table.recipeVersion],
      foreignColumns: [embeddingSpaces.id, embeddingSpaces.recipeVersion],
    }).onDelete("cascade"),
    index("memory_embeddings_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    check(
      "memory_embeddings_content_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("memory_embeddings_space_type_check", sql`${table.spaceEntityType} = 'memory'`),
  ],
);

export const decisionEmbeddings = pgTable(
  "decision_embeddings",
  {
    id: idColumn(),
    decisionId: uuid("decision_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    spaceEntityType: embeddingEntityTypeEnum("space_entity_type")
      .notNull()
      .default("decision"),
    contentHash: text("content_hash").notNull(),
    recipeVersion: text("recipe_version").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("decision_embeddings_entity_space_key").on(
      table.decisionId,
      table.spaceId,
    ),
    foreignKey({
      name: "decision_embeddings_decision_fkey",
      columns: [table.decisionId],
      foreignColumns: [decisions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "decision_embeddings_space_fkey",
      columns: [table.spaceId, table.spaceEntityType],
      foreignColumns: [embeddingSpaces.id, embeddingSpaces.entityType],
    }).onDelete("cascade"),
    foreignKey({
      name: "decision_embeddings_recipe_fkey",
      columns: [table.spaceId, table.recipeVersion],
      foreignColumns: [embeddingSpaces.id, embeddingSpaces.recipeVersion],
    }).onDelete("cascade"),
    index("decision_embeddings_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    check(
      "decision_embeddings_content_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "decision_embeddings_space_type_check",
      sql`${table.spaceEntityType} = 'decision'`,
    ),
  ],
);

export const knowledgeChunkEmbeddings = pgTable(
  "knowledge_chunk_embeddings",
  {
    id: idColumn(),
    chunkId: uuid("chunk_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    spaceEntityType: embeddingEntityTypeEnum("space_entity_type")
      .notNull()
      .default("knowledge_chunk"),
    contentHash: text("content_hash").notNull(),
    recipeVersion: text("recipe_version").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("knowledge_chunk_embeddings_entity_space_key").on(
      table.chunkId,
      table.spaceId,
    ),
    foreignKey({
      name: "knowledge_chunk_embeddings_chunk_fkey",
      columns: [table.chunkId],
      foreignColumns: [knowledgeChunks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_chunk_embeddings_space_fkey",
      columns: [table.spaceId, table.spaceEntityType],
      foreignColumns: [embeddingSpaces.id, embeddingSpaces.entityType],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_chunk_embeddings_recipe_fkey",
      columns: [table.spaceId, table.recipeVersion],
      foreignColumns: [embeddingSpaces.id, embeddingSpaces.recipeVersion],
    }).onDelete("cascade"),
    index("knowledge_chunk_embeddings_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    check(
      "knowledge_chunk_embeddings_content_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "knowledge_chunk_embeddings_space_type_check",
      sql`${table.spaceEntityType} = 'knowledge_chunk'`,
    ),
  ],
);

export type EmbeddingSpaceRow = typeof embeddingSpaces.$inferSelect;
