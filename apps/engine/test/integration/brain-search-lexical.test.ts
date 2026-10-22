import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSecondBrainEngine } from "../../src/engine.js";
import { runMigrations } from "../../src/database/migrate.js";
import * as schema from "../../src/database/schema/index.js";
import { DrizzleBrainAccessStore } from "../../src/database/stores/access-store.js";
import { DrizzleBrainSearchStore } from "../../src/database/stores/search-store.js";
import { DrizzleKnowledgeStore } from "../../src/database/stores/knowledge-store.js";
import {
  KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  knowledgeChunkEmbeddingRecipe,
  memoryEmbeddingRecipe,
  sha256Hex,
  type BrainAccessContext,
} from "../../src/domain.js";
import { boundaryDependencies } from "../support/engine-dependencies.js";
import { provisionTestDatabase, type DisposableTestDatabase } from "./support/database.js";

const accountId = randomUUID();
const spaceId = randomUUID();
const access: BrainAccessContext = {
  accountId, role: "owner",
  actor: {
    kind: "account", accountId, clientId: null, source: "direct",
    requestId: "lexical-search-test", correlationId: null,
    causationId: null, dreamingRunId: null,
  },
};

describe("brain search lexical metadata matches", () => {
  let resource: DisposableTestDatabase;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let engine: ReturnType<typeof createSecondBrainEngine>;

  beforeAll(async () => {
    resource = await provisionTestDatabase("search_lexical");
    await runMigrations(resource.pool);
    database = drizzle(resource.pool, { schema });
    await database.insert(schema.accounts).values({
      id: accountId, email: "lexical-search@example.test", passwordHash: "unused", role: "owner",
    });
    await database.insert(schema.embeddingSpaces).values({
      id: spaceId, entityType: "knowledge_chunk", provider: "test", model: "test",
      modelRevision: "1", recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
      dimensions: 1536, metric: "cosine", status: "active", promotedAt: new Date(),
    });
    const dependencies = boundaryDependencies();
    engine = createSecondBrainEngine({
      ...dependencies,
      access: new DrizzleBrainAccessStore(database),
      search: new DrizzleBrainSearchStore(database),
      embeddingSpaces: {
        ...dependencies.embeddingSpaces,
        async getActiveSpace() { return null; },
      },
    });
  });

  afterAll(async () => { await resource?.destroy(); });

  it("returns a memory found only through its tags without semantic embeddings", async () => {
    const id = randomUUID();
    const content = "Keep mornings free for building.";
    const recipe = memoryEmbeddingRecipe(content);
    await database.insert(schema.memories).values({
      id, lineageId: id, content, tags: ["focus-time"], contentHash: recipe.contentHash,
      actorKind: "account", actorAccountId: accountId, actorClientId: null, actorSource: "direct",
    });

    const result = await engine.invoke("brain_search", { query: "focus-time" }, {
      principal: { id: accountId },
    });

    expect(result.hits).toEqual([expect.objectContaining({
      id, sourceType: "memory", excerpt: content, tags: ["focus-time"], score: 1,
    })]);
  });

  it("returns document chunks found only through their knowledge-base description", async () => {
    const knowledge = new DrizzleKnowledgeStore(database);
    const base = await knowledge.createKnowledgeBase(access, {
      name: "Operations", description: "Incident response and alerting playbooks.",
      idempotencyKey: "operations-base",
    }, new AbortController().signal);
    const content = "Send critical events to the on-call engineer.";
    await knowledge.createDocumentRevision(access, {
      knowledgeBaseId: base.id, documentId: null, expectedRevision: null,
      title: "Escalation", sourceUri: null, tags: [], projectId: null, personIds: [],
      contentHash: sha256Hex(content), idempotencyKey: "escalation-document",
      chunks: [{ content, position: 0, embedding: {
        spaceId, contentHash: knowledgeChunkEmbeddingRecipe(content).contentHash,
        vector: [1, ...Array<number>(1535).fill(0)],
      } }],
    }, new AbortController().signal);

    const result = await engine.invoke("brain_search", { query: "alerting" }, {
      principal: { id: accountId },
    });

    expect(result.hits).toEqual(expect.arrayContaining([expect.objectContaining({
      sourceType: "knowledge_chunk", title: "Escalation", excerpt: content,
      knowledgeBaseId: base.id, score: 0.92,
    })]));
    expect(result.suggestedKnowledgeBases).toEqual([expect.objectContaining({ id: base.id })]);
  });
});
