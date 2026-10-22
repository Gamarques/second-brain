import { z } from "zod";

import {
  MEMORY_EMBEDDING_RECIPE_VERSION,
  memoryEmbeddingRecipe,
  sha256Hex,
} from "../domain.js";
import type {
  BrainAccessContext,
  BrainAccessStore,
  ContentEmbedding,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
  Memory,
  MemoryStore,
  MemoryWriteResult,
} from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  cursorSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  idSchema,
  memorySchema,
  requireEmbedding,
  timestampSchema,
  uniqueIdsSchema,
} from "./schemas.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const memoryWriteOutputSchema = memorySchema.extend({
  created: z.boolean(),
  deduplication: z
    .object({
      supersededMemoryId: idSchema,
      similarity: z.number().min(-1).max(1).nullable(),
    })
    .nullable(),
});

const memorySearchOutputSchema = z.object({
  matches: z.array(
    memorySchema.extend({
      score: z.number().min(-1).max(1),
      spaceId: idSchema,
    }),
  ),
});

function writableMemory(memory: Memory) {
  return {
    ...memory,
    tags: [...memory.tags],
    personIds: [...memory.personIds],
  };
}

function assertActiveSpace(
  space: EmbeddingSpace | null,
  embeddings: EmbeddingProvider,
): EmbeddingSpace {
  if (
    space === null ||
    space.entityType !== "memory" ||
    space.status !== "active" ||
    space.metric !== "cosine" ||
    space.provider !== embeddings.provider ||
    space.model !== embeddings.model ||
    space.modelRevision !== embeddings.modelRevision ||
    space.recipeVersion !== MEMORY_EMBEDDING_RECIPE_VERSION ||
    space.dimensions !== embeddings.dimensions
  ) {
    throw new Error(
      "The active memory embedding space does not match the provider.",
    );
  }
  return space;
}

async function activeMemorySpace(
  access: BrainAccessContext,
  embeddingSpaces: EmbeddingSpaceStore,
  embeddings: EmbeddingProvider,
  signal: AbortSignal,
): Promise<EmbeddingSpace> {
  return assertActiveSpace(
    await embeddingSpaces.getActiveSpace(access, "memory", signal),
    embeddings,
  );
}

async function embedMemoryDocument(
  access: BrainAccessContext,
  embeddingSpaces: EmbeddingSpaceStore,
  embeddings: EmbeddingProvider,
  content: string,
  signal: AbortSignal,
): Promise<ContentEmbedding> {
  const space = await activeMemorySpace(
    access,
    embeddingSpaces,
    embeddings,
    signal,
  );
  const recipe = memoryEmbeddingRecipe(content);
  const vectors = await embeddings.embed(
    [recipe.text],
    signal,
    "search_document",
  );
  return {
    spaceId: space.id,
    contentHash: recipe.contentHash,
    vector: requireEmbedding(vectors[0], space.dimensions),
  };
}

async function embedMemoryQuery(
  access: BrainAccessContext,
  embeddingSpaces: EmbeddingSpaceStore,
  embeddings: EmbeddingProvider,
  query: string,
  signal: AbortSignal,
): Promise<ContentEmbedding> {
  const space = await activeMemorySpace(
    access,
    embeddingSpaces,
    embeddings,
    signal,
  );
  const vectors = await embeddings.embed([query], signal, "search_query");
  return {
    spaceId: space.id,
    contentHash: sha256Hex(query),
    vector: requireEmbedding(vectors[0], space.dimensions),
  };
}

function writeOutput(result: MemoryWriteResult) {
  if (result.supersededMemoryId === null && result.similarity !== null) {
    throw new Error(
      "The memory store returned an inconsistent supersession result.",
    );
  }
  return {
    ...writableMemory(result.memory),
    created: result.created,
    deduplication:
      result.supersededMemoryId === null
        ? null
        : {
            supersededMemoryId: result.supersededMemoryId,
            similarity: result.similarity,
          },
  };
}

const dateRangeRefinement = (
  value: {
    readonly createdAfter: string | null;
    readonly createdBefore: string | null;
  },
  context: z.RefinementCtx,
): void => {
  if (
    value.createdAfter !== null &&
    value.createdBefore !== null &&
    Date.parse(value.createdAfter) >= Date.parse(value.createdBefore)
  ) {
    context.addIssue({
      code: "custom",
      message: "createdAfter must be earlier than createdBefore.",
    });
  }
};

export function createMemoryCapabilities(
  accessStore: BrainAccessStore,
  memories: MemoryStore,
  embeddingSpaces: EmbeddingSpaceStore,
  embeddings: EmbeddingProvider,
) {
  const createMemory = defineCapability({
    title: "Create a memory",
    description:
      "Stores a memory. Exact normalized duplicates are replayed by the store; semantic similarity never supersedes a memory implicitly. Omit projectId to record general information not tied to a project.",
    input: z.object({
      content: z.string().trim().min(1).max(10_000),
      category: z.string().trim().min(1).max(100).nullable().default(null),
      tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      projectId: idSchema.nullable().default(null),
      personIds: uniqueIdsSchema(20).default([]),
      effectiveAt: timestampSchema.nullable().default(null),
      capturedAt: timestampSchema.nullable().default(null),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: memoryWriteOutputSchema,
    access: "authenticated",
    timeoutMs: 30_000,
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
      const embedding = await embedMemoryDocument(
        access,
        embeddingSpaces,
        embeddings,
        input.content,
        context.signal,
      );
      const result = await memories.writeMemoryVersion(
        access,
        {
          content: input.content,
          category: input.category,
          tags: input.tags,
          projectId: input.projectId,
          personIds: input.personIds,
          effectiveAt:
            input.effectiveAt ?? input.capturedAt ?? new Date().toISOString(),
          capturedAt: input.capturedAt,
          sourceExcerpt: null,
          supersedesId: null,
          expectedSupersededHash: null,
          expectedSupersededVersion: null,
          idempotencyKey: input.idempotencyKey,
          embedding,
        },
        context.signal,
      );
      if (result === null)
        throw new Error("A linked project or person was not found.");
      return writeOutput(result);
    },
  });

  const updateMemory = defineCapability({
    title: "Update a memory",
    description:
      "Creates a reviewed memory version and atomically pins the exact version and content hash it supersedes.",
    input: z
      .object({
        id: idSchema,
        expectedVersion: z.number().int().positive(),
        expectedContentHash: sha256Schema,
        idempotencyKey: idempotencyKeySchema,
        content: z.string().trim().min(1).max(10_000).optional(),
        category: z.string().trim().min(1).max(100).nullable().optional(),
        tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        projectId: idSchema.nullable().optional(),
        personIds: uniqueIdsSchema(20).optional(),
        effectiveAt: timestampSchema.optional(),
        capturedAt: timestampSchema.nullable().optional(),
      })
      .refine(
        ({
          id: _id,
          expectedVersion: _expectedVersion,
          expectedContentHash: _expectedContentHash,
          idempotencyKey: _idempotencyKey,
          ...changes
        }) => Object.values(changes).some((value) => value !== undefined),
        { message: "At least one memory field must be provided." },
      ),
    output: memoryWriteOutputSchema,
    access: "authenticated",
    timeoutMs: 30_000,
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
      const current = await memories.getMemory(
        access,
        input.id,
        context.signal,
      );
      if (
        current === null ||
        current.version !== input.expectedVersion ||
        current.contentHash !== input.expectedContentHash ||
        current.supersededBy !== null ||
        current.supersededAt !== null
      ) {
        throw new Error("Current memory was not found.");
      }

      const content = input.content ?? current.content;
      const embedding = await embedMemoryDocument(
        access,
        embeddingSpaces,
        embeddings,
        content,
        context.signal,
      );
      const result = await memories.writeMemoryVersion(
        access,
        {
          content,
          category:
            input.category === undefined ? current.category : input.category,
          tags: input.tags ?? current.tags,
          projectId:
            input.projectId === undefined ? current.projectId : input.projectId,
          personIds: input.personIds ?? current.personIds,
          effectiveAt: input.effectiveAt ?? new Date().toISOString(),
          capturedAt:
            input.capturedAt === undefined
              ? current.capturedAt
              : input.capturedAt,
          sourceExcerpt:
            input.content === undefined ? current.sourceExcerpt : null,
          supersedesId: current.id,
          expectedSupersededHash: input.expectedContentHash,
          expectedSupersededVersion: input.expectedVersion,
          idempotencyKey: input.idempotencyKey,
          embedding,
        },
        context.signal,
      );
      if (result === null) {
        throw new Error(
          "Current memory or a linked project or person was not found.",
        );
      }
      return writeOutput(result);
    },
  });

  const searchMemories = defineCapability({
    title: "Search memories",
    description:
      "Searches the memory history in its active embedding space with temporal and context filters. This does not search knowledge documents, people, or projects. For who/what/about questions, call brain_search instead.",
    input: z
      .object({
        query: z.string().trim().min(1).max(5_000),
        limit: z.number().int().min(1).max(50).default(10),
        minimumScore: z.number().min(-1).max(1).default(0.25),
        category: z.string().trim().min(1).max(100).nullable().default(null),
        tags: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
        projectId: idSchema.nullable().default(null),
        personId: idSchema.nullable().default(null),
        createdAfter: timestampSchema.nullable().default(null),
        createdBefore: timestampSchema.nullable().default(null),
        asOf: timestampSchema.nullable().default(null),
        includeSuperseded: z.boolean().default(false),
      })
      .superRefine(dateRangeRefinement),
    output: memorySearchOutputSchema,
    access: "authenticated",
    timeoutMs: 30_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const embedding = await embedMemoryQuery(
        access,
        embeddingSpaces,
        embeddings,
        input.query,
        context.signal,
      );
      const matches = await memories.searchMemories(
        access,
        {
          embedding,
          limit: input.limit,
          minimumScore: input.minimumScore,
          category: input.category,
          tags: input.tags,
          projectId: input.projectId,
          personId: input.personId,
          createdAfter: input.createdAfter,
          createdBefore: input.createdBefore,
          asOf: input.asOf,
          includeSuperseded: input.includeSuperseded,
        },
        context.signal,
      );
      for (const match of matches) {
        if (match.spaceId !== embedding.spaceId) {
          throw new Error(
            "The memory store returned a result from another embedding space.",
          );
        }
      }
      return {
        matches: matches.map(({ memory, score, spaceId: resultSpaceId }) => ({
          ...writableMemory(memory),
          score,
          spaceId: resultSpaceId,
        })),
      };
    },
  });

  const listMemories = defineCapability({
    title: "List memories",
    description:
      "Lists memory versions with temporal, context, and as-of filters.",
    input: z
      .object({
        category: z.string().trim().min(1).max(100).nullable().default(null),
        tags: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
        projectId: idSchema.nullable().default(null),
        personId: idSchema.nullable().default(null),
        createdAfter: timestampSchema.nullable().default(null),
        createdBefore: timestampSchema.nullable().default(null),
        asOf: timestampSchema.nullable().default(null),
        includeSuperseded: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: cursorSchema.nullable().default(null),
      })
      .superRefine(dateRangeRefinement),
    output: z.object({
      memories: z.array(memorySchema),
      nextCursor: cursorSchema.nullable(),
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
      const result = await memories.listMemories(
        access,
        {
          category: input.category,
          tags: input.tags,
          projectId: input.projectId,
          personId: input.personId,
          createdAfter: input.createdAfter,
          createdBefore: input.createdBefore,
          asOf: input.asOf,
          includeSuperseded: input.includeSuperseded,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        memories: result.items.map(writableMemory),
        nextCursor:
          result.nextCursor === null ? null : encodeCursor(result.nextCursor),
      };
    },
  });

  const deleteMemory = defineCapability({
    title: "Delete a memory lineage",
    description:
      "Deletes a memory lineage from memory retrieval and history. Independent ingestion source excerpts, dreaming evidence or reports, and handoff prose follow their own retention and erasure flows.",
    input: z.object({
      id: idSchema,
      idempotencyKey: idempotencyKeySchema,
    }),
    output: z.object({ deleted: z.literal(true) }),
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: {
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "admin",
      });
      const deleted = await memories.deleteMemory(
        access,
        input.id,
        { idempotencyKey: input.idempotencyKey },
        context.signal,
      );
      if (!deleted) throw new Error("Memory lineage was not found.");
      return { deleted: true as const };
    },
  });

  return {
    memories_create: createMemory,
    memories_update: updateMemory,
    memories_search: searchMemories,
    memories_list: listMemories,
    memories_delete: deleteMemory,
  } as const;
}
