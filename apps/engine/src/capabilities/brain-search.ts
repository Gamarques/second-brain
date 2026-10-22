import { z } from "zod";

import {
  KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  MEMORY_EMBEDDING_RECIPE_VERSION,
  brainSearchGuidance,
  brainSearchIntents,
  brainSearchSourceTypes,
  classifyBrainSearchQuery,
  knowledgeChunkEmbeddingRecipe,
  sha256Hex,
} from "../domain.js";
import type {
  BrainAccessContext,
  BrainAccessStore,
  BrainSearchStore,
  ContentEmbedding,
  EmbeddingEntityType,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
} from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  idSchema,
  knowledgeBaseCatalogEntrySchema,
  personIndexEntrySchema,
  requireEmbedding,
} from "./schemas.js";

const searchHitSchema = z.object({
  sourceType: z.enum(brainSearchSourceTypes),
  id: idSchema,
  title: z.string().trim().min(1).max(500),
  excerpt: z.string().trim().min(1).max(2_000),
  score: z.number().min(0).max(1),
  knowledgeBaseId: idSchema.nullable(),
  knowledgeBaseName: z.string().trim().min(1).max(300).nullable(),
  projectId: idSchema.nullable(),
  personIds: z.array(idSchema).max(20),
  tags: z.array(z.string().trim().min(1).max(100)).max(20),
});

const suggestionSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  description: z.string().trim().max(10_000).nullable(),
  reason: z.string().trim().min(1).max(500),
});

const brainSearchOutputSchema = z.object({
  query: z.string().trim().min(1).max(5_000),
  routing: z.object({
    intent: z.enum(brainSearchIntents),
    subject: z.string().trim().min(1).max(5_000),
    guidance: z.string().trim().min(1).max(1_000),
  }),
  hits: z.array(searchHitSchema).max(50),
  people: z.array(personIndexEntrySchema).max(50),
  knowledgeBases: z.array(knowledgeBaseCatalogEntrySchema).max(100),
  suggestedKnowledgeBases: z.array(suggestionSchema).max(20),
});

function compatibleSpace(
  provider: EmbeddingProvider,
  space: EmbeddingSpace | null,
  entityType: EmbeddingEntityType,
  recipeVersion: string,
): EmbeddingSpace | null {
  if (space === null) return null;
  if (
    space.entityType !== entityType ||
    space.status !== "active" ||
    space.provider !== provider.provider ||
    space.model !== provider.model ||
    space.modelRevision !== provider.modelRevision ||
    space.recipeVersion !== recipeVersion ||
    space.dimensions !== provider.dimensions
  ) {
    throw new Error(
      "An active embedding space is incompatible with the configured provider.",
    );
  }
  return space;
}

export async function createBrainSearchQueryEmbeddings(
  access: BrainAccessContext,
  query: string,
  spaces: EmbeddingSpaceStore,
  provider: EmbeddingProvider,
  signal: AbortSignal,
): Promise<{
  readonly memories: ContentEmbedding | null;
  readonly knowledge: ContentEmbedding | null;
}> {
  const [memorySpace, knowledgeSpace] = await Promise.all([
    spaces.getActiveSpace(access, "memory", signal),
    spaces.getActiveSpace(access, "knowledge_chunk", signal),
  ]);
  const compatibleMemorySpace = compatibleSpace(
    provider,
    memorySpace,
    "memory",
    MEMORY_EMBEDDING_RECIPE_VERSION,
  );
  const compatibleKnowledgeSpace = compatibleSpace(
    provider,
    knowledgeSpace,
    "knowledge_chunk",
    KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  );
  if (compatibleMemorySpace === null && compatibleKnowledgeSpace === null) {
    return { memories: null, knowledge: null };
  }

  const memoryText = query;
  const knowledgeText = knowledgeChunkEmbeddingRecipe(query).text;
  const sameText = memoryText === knowledgeText;
  const texts =
    compatibleMemorySpace !== null &&
    compatibleKnowledgeSpace !== null &&
    !sameText
      ? [memoryText, knowledgeText]
      : [compatibleKnowledgeSpace === null ? memoryText : knowledgeText];
  const vectors = await provider.embed(texts, signal, "search_query");
  if (vectors.length !== texts.length) {
    throw new Error("The embedding provider returned an invalid vector batch.");
  }
  const memoryVector = requireEmbedding(
    vectors[0],
    provider.dimensions,
  );
  const knowledgeVector = requireEmbedding(
    sameText || compatibleMemorySpace === null || compatibleKnowledgeSpace === null
      ? vectors[0]
      : vectors[1],
    provider.dimensions,
  );
  const hash = sha256Hex(query);
  return {
    memories:
      compatibleMemorySpace === null
        ? null
        : {
            spaceId: compatibleMemorySpace.id,
            contentHash: hash,
            vector: memoryVector,
          },
    knowledge:
      compatibleKnowledgeSpace === null
        ? null
        : {
            spaceId: compatibleKnowledgeSpace.id,
            contentHash: knowledgeChunkEmbeddingRecipe(query).contentHash,
            vector: knowledgeVector,
          },
  };
}

export function createBrainSearchCapabilities(
  accessStore: BrainAccessStore,
  searchStore: BrainSearchStore,
  embeddingSpaces: EmbeddingSpaceStore,
  embeddings: EmbeddingProvider,
) {
  const searchBrain = defineCapability({
    title: "Search the second brain",
    description:
      "Primary lookup for who/what/about questions. Searches memories, all knowledge bases, people, projects, decisions, goals, and tasks in one call. Every response includes the live knowledge-base catalog (id, name, and what each base covers), a people index, and suggested bases when the query looks like a person or topic lookup. Use this before memories_search or knowledge_ask; do not assume a person lives only in memories.",
    input: z.object({
      query: z.string().trim().min(1).max(5_000),
      projectId: idSchema.nullable().default(null),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    output: brainSearchOutputSchema,
    access: "authenticated",
    timeoutMs: 30_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    async run({ input, context }) {
      const classified = classifyBrainSearchQuery(input.query);
      let access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const queryVectors = await createBrainSearchQueryEmbeddings(
        access,
        classified.subject,
        embeddingSpaces,
        embeddings,
        context.signal,
      );
      access = await accessStore.revalidateAccess(
        access,
        "viewer",
        context.signal,
      );
      const result = await searchStore.search(
        access,
        {
          query: input.query,
          intent: classified.intent,
          subject: classified.subject,
          embeddings: queryVectors,
          projectId: input.projectId,
          limit: input.limit,
        },
        context.signal,
      );
      return brainSearchOutputSchema.parse({
        ...result,
        query: input.query,
        routing: {
          intent: classified.intent,
          subject: classified.subject,
          guidance: brainSearchGuidance(classified.intent),
        },
      });
    },
  });

  return { brain_search: searchBrain } as const;
}
