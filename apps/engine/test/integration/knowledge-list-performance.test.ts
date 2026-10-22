import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSecondBrainEngine } from "../../src/engine.js";
import { runMigrations } from "../../src/database/migrate.js";
import * as schema from "../../src/database/schema/index.js";
import { DrizzleBrainAccessStore } from "../../src/database/stores/access-store.js";
import { DrizzleKnowledgeStore } from "../../src/database/stores/knowledge-store.js";
import {
  KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  knowledgeChunkEmbeddingRecipe,
  sha256Hex,
  type BrainAccessContext,
  type KnowledgeDocument,
} from "../../src/domain.js";
import { boundaryDependencies } from "../support/engine-dependencies.js";
import { provisionTestDatabase, type DisposableTestDatabase } from "./support/database.js";

const accountId = randomUUID();
const spaceId = randomUUID();
const personIds = [randomUUID(), randomUUID()].sort();
const actor = {
  actorKind: "account" as const,
  actorAccountId: accountId,
  actorClientId: null,
  actorSource: "direct" as const,
};
const access: BrainAccessContext = {
  accountId,
  role: "owner",
  actor: {
    kind: "account", accountId, clientId: null, source: "direct",
    requestId: "knowledge-list-test", correlationId: null,
    causationId: null, dreamingRunId: null,
  },
};

describe("knowledge document listing query budget", () => {
  let resource: DisposableTestDatabase;
  let engine: ReturnType<typeof createSecondBrainEngine>;
  let baseId: string;
  const documents = new Map<string, KnowledgeDocument>();
  const relationQueries: { query: string; params: unknown[] }[] = [];

  beforeAll(async () => {
    resource = await provisionTestDatabase("knowledge_list");
    await runMigrations(resource.pool);
    const database = drizzle(resource.pool, {
      schema,
      logger: {
        logQuery(query, params) {
          if (query.includes('from "knowledge_document_people"')) relationQueries.push({ query, params });
        },
      },
    });
    await database.insert(schema.accounts).values({
      id: accountId, email: "knowledge-list@example.test", passwordHash: "unused", role: "owner",
    });
    await database.insert(schema.embeddingSpaces).values({
      id: spaceId, entityType: "knowledge_chunk", provider: "test", model: "test",
      modelRevision: "1", recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
      dimensions: 1536, metric: "cosine", status: "active", promotedAt: new Date(),
    });
    await database.insert(schema.people).values(personIds.map((id, index) => ({
      id, name: `Person ${index}`, ...actor,
    })));
    const knowledge = new DrizzleKnowledgeStore(database);
    engine = createSecondBrainEngine({
      ...boundaryDependencies(), access: new DrizzleBrainAccessStore(database), knowledge,
    });
    const base = await knowledge.createKnowledgeBase(access, {
      name: "Document listing", description: null, idempotencyKey: "list-base",
    }, new AbortController().signal);
    baseId = base.id;
    for (let index = 0; index < 101; index += 1) {
      const content = `Document content ${index}`;
      const result = await knowledge.createDocumentRevision(access, {
        knowledgeBaseId: baseId, documentId: null, expectedRevision: null,
        title: `Document ${index}`, sourceUri: null, tags: [], projectId: null,
        personIds: index % 3 === 0 ? personIds : index % 3 === 1 ? personIds.slice(0, 1) : [],
        contentHash: sha256Hex(content), idempotencyKey: `document-${index}`,
        chunks: [{ content, position: 0, embedding: {
          spaceId, contentHash: knowledgeChunkEmbeddingRecipe(content).contentHash,
          vector: [1, ...Array<number>(1535).fill(0)],
        } }],
      }, new AbortController().signal);
      if (result === null) throw new Error("The document fixture could not be created.");
      documents.set(result.document.id, result.document);
    }
    relationQueries.length = 0;
  });

  afterAll(async () => { await resource?.destroy(); });

  it("loads a 100-document page with one relation query and preserves cursor membership", async () => {
    relationQueries.length = 0;
    const first = await engine.invoke("knowledge_documents_list", { knowledgeBaseId: baseId, limit: 100 }, {
      principal: { id: accountId },
    });
    expect(first.documents).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    for (const document of first.documents) {
      expect(document).toEqual(documents.get(document.id));
    }
    expect(relationQueries).toHaveLength(1);
    expect(new Set(relationQueries[0]!.params)).toEqual(new Set(first.documents.map(({ id }) => id)));

    relationQueries.length = 0;
    const second = await engine.invoke("knowledge_documents_list", {
      knowledgeBaseId: baseId, limit: 100, cursor: first.nextCursor,
    }, { principal: { id: accountId } });
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0]).toEqual(documents.get(second.documents[0]!.id));
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.documents, ...second.documents].map(({ id }) => id)).size).toBe(101);
    expect(relationQueries).toHaveLength(1);
    expect(relationQueries[0]!.params).toEqual([second.documents[0]!.id]);
  });

  it("does not query document relations for an empty page", async () => {
    relationQueries.length = 0;
    const result = await engine.invoke("knowledge_documents_list", {
      knowledgeBaseId: randomUUID(), limit: 100,
    }, { principal: { id: accountId } });
    expect(result).toEqual({ documents: [], nextCursor: null });
    expect(relationQueries).toEqual([]);
  });
});
