import { z } from "zod";

import { knowledgeChunkEmbeddingRecipe, sha256Hex } from "../domain.js";
import type {
  AnswerProvider,
  BrainAccessStore,
  BrainPackOriginAttribution,
  ContentEmbedding,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
  KnowledgeDocument,
  KnowledgeStore,
} from "../domain.js";
import {
  activeKnowledgeSpace,
  embedChunksInBatches,
  knowledgeChunkSize,
  splitKnowledgeDocument,
} from "../domain/knowledge-indexing.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  cursorSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  idSchema,
  knowledgeBaseSchema,
  knowledgeContentRepresentationSchema,
  knowledgeDocumentRevisionSchema,
  knowledgeDocumentRevisionWithContentSchema,
  knowledgeDocumentSchema,
  knowledgeRevisionOriginSchema,
  nullableTextSchema,
  requireEmbedding,
  requireFound,
  uniqueIdsSchema,
} from "./schemas.js";

const knowledgeScoreFloor = 0.25;
const noKnowledgeAnswer =
  "This knowledge base has no recorded information that answers this.";

const citationSchema = z.object({
  chunkId: idSchema,
  documentId: idSchema,
  revisionId: idSchema,
  documentTitle: z.string().trim().min(1).max(500),
  content: z.string().trim().min(1).max(knowledgeChunkSize),
  score: z.number().min(-1).max(1),
  spaceId: idSchema,
  origin: knowledgeRevisionOriginSchema.nullable().default(null),
});
const knowledgeAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(20_000),
  citations: z.array(citationSchema).max(20),
});

function writableKnowledgeDocument(
  document: KnowledgeDocument,
) {
  return {
    ...document,
    tags: [...document.tags],
    personIds: [...document.personIds],
  };
}

function writableOrigin(origin: BrainPackOriginAttribution | null | undefined) {
  if (origin === null || origin === undefined) return null;
  return {
    publisher: { ...origin.publisher },
    packId: origin.packId,
    packRevision: origin.packRevision,
    packTitle: origin.packTitle,
    itemKey: origin.itemKey,
    authors: origin.authors.map((author) => ({ ...author })),
  };
}

export { splitKnowledgeDocument } from "../domain/knowledge-indexing.js";

async function embedContent(
  content: string,
  inputType: "search_document" | "search_query",
  space: EmbeddingSpace,
  provider: EmbeddingProvider,
  signal: AbortSignal,
): Promise<ContentEmbedding> {
  const recipe = knowledgeChunkEmbeddingRecipe(content);
  const vectors = await provider.embed([recipe.text], signal, inputType);
  if (vectors.length !== 1) {
    throw new Error("The embedding provider returned an invalid vector batch.");
  }
  return {
    spaceId: space.id,
    contentHash: recipe.contentHash,
    vector: requireEmbedding(vectors[0], space.dimensions),
  };
}

export function createKnowledgeCapabilities(
  accessStore: BrainAccessStore,
  knowledge: KnowledgeStore,
  embeddingSpaces: EmbeddingSpaceStore,
  embeddings: EmbeddingProvider,
  answers: AnswerProvider,
) {
  const createKnowledgeBase = defineCapability({
    title: "Create a knowledge base",
    description: "Creates a knowledge collection in the brain.",
    input: z.object({
      name: z.string().trim().min(1).max(200),
      description: nullableTextSchema.default(null),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: knowledgeBaseSchema,
    access: "authenticated",
    timeoutMs: 10_000,
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
      return knowledge.createKnowledgeBase(
        access,
        {
          name: input.name,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
        },
        context.signal,
      );
    },
  });

  const listKnowledgeBases = defineCapability({
    title: "List knowledge bases",
    description:
      "Lists every knowledge base with its name and the description of what it covers. The same catalog is also returned by context_get and brain_search, so who/what lookups do not depend on remembering to call this first.",
    input: z.object({}),
    output: z.object({ knowledgeBases: z.array(knowledgeBaseSchema) }),
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
      const knowledgeBases = await knowledge.listKnowledgeBases(
        access,
        context.signal,
      );
      return {
        knowledgeBases: knowledgeBases.map((item) =>
          knowledgeBaseSchema.parse(item),
        ),
      };
    },
  });

  const createDocumentRevision = defineCapability({
    title: "Create a knowledge document revision",
    description:
      "Creates a document or appends an immutable revision using an expected current revision.",
    input: z
      .object({
        knowledgeBaseId: idSchema,
        documentId: idSchema.nullable().default(null),
        expectedRevision: z.number().int().positive().nullable().default(null),
        title: z.string().trim().min(1).max(500),
        content: z.string().trim().min(1).max(1_000_000),
        sourceUri: z.string().url().nullable().default(null),
        tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
        projectId: idSchema.nullable().default(null),
        personIds: uniqueIdsSchema(20).default([]),
        idempotencyKey: idempotencyKeySchema,
      })
      .superRefine((input, refinement) => {
        if ((input.documentId === null) !== (input.expectedRevision === null)) {
          refinement.addIssue({
            code: "custom",
            message:
              "documentId and expectedRevision must either both be provided or both be null.",
            path:
              input.documentId === null ? ["documentId"] : ["expectedRevision"],
          });
        }
      }),
    output: z.object({
      document: knowledgeDocumentSchema,
      revision: knowledgeDocumentRevisionSchema,
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
      let access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const space = await activeKnowledgeSpace(
        access,
        embeddingSpaces,
        embeddings,
        context.signal,
      );
      const chunks = splitKnowledgeDocument(input.content);
      const chunkEmbeddings = await embedChunksInBatches(
        embeddings,
        space,
        chunks,
        { signal: context.signal },
      );

      access = await accessStore.revalidateAccess(
        access,
        "editor",
        context.signal,
      );
      const created = requireFound(
        await knowledge.createDocumentRevision(
          access,
          {
            knowledgeBaseId: input.knowledgeBaseId,
            documentId: input.documentId,
            expectedRevision: input.expectedRevision,
            title: input.title,
            sourceUri: input.sourceUri,
            contentHash: sha256Hex(input.content),
            chunks: chunks.map((content, position) => ({
              content,
              position,
              embedding: chunkEmbeddings[position]!,
            })),
            tags: input.tags,
            projectId: input.projectId,
            personIds: input.personIds,
            idempotencyKey: input.idempotencyKey,
            content: input.content,
          },
          context.signal,
        ),
        "Knowledge base or document revision",
      );
      return {
        document: {
          ...created.document,
          tags: [...created.document.tags],
          personIds: [...created.document.personIds],
        },
        revision: created.revision,
      };
    },
  });

  const listDocuments = defineCapability({
    title: "List knowledge documents",
    description:
      "Lists knowledge documents across the brain or within one knowledge base using bounded cursor pagination.",
    input: z.object({
      knowledgeBaseId: idSchema.nullable().default(null),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: cursorSchema.nullable().default(null),
    }),
    output: z.object({
      documents: z.array(knowledgeDocumentSchema).max(100),
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
      const page = await knowledge.listDocuments(
        access,
        {
          knowledgeBaseId: input.knowledgeBaseId,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        documents: page.items.map(writableKnowledgeDocument),
        nextCursor:
          page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      };
    },
  });

  const getDocument = defineCapability({
    title: "Get a knowledge document",
    description:
      "Gets a knowledge document and the full reconstructed content of its current or selected immutable revision.",
    input: z.object({
      documentId: idSchema,
      revision: z.number().int().positive().nullable().default(null),
    }),
    output: z.object({
      document: knowledgeDocumentSchema,
      revision: knowledgeDocumentRevisionSchema,
      content: z.string().min(1).max(1_000_000),
      representation: knowledgeContentRepresentationSchema,
      origin: knowledgeRevisionOriginSchema.nullable(),
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
      const result = requireFound(
        await knowledge.getDocument(access, input, context.signal),
        "Knowledge document or revision",
      );
      return {
        document: writableKnowledgeDocument(result.document),
        revision: result.revision,
        content: result.content,
        representation: result.representation,
        origin: writableOrigin(result.origin),
      };
    },
  });

  const listDocumentRevisions = defineCapability({
    title: "List knowledge document revisions",
    description:
      "Lists immutable revisions of one knowledge document with their full reconstructed content using bounded cursor pagination.",
    input: z.object({
      documentId: idSchema,
      limit: z.number().int().min(1).max(100).default(20),
      cursor: cursorSchema.nullable().default(null),
    }),
    output: z.object({
      revisions: z.array(knowledgeDocumentRevisionWithContentSchema).max(100),
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
      const page = await knowledge.listDocumentRevisions(
        access,
        {
          documentId: input.documentId,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        revisions: page.items.map(({ revision, content, representation, origin }) => ({
          ...revision,
          content,
          representation,
          origin: writableOrigin(origin),
        })),
        nextCursor:
          page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      };
    },
  });

  const askKnowledge = defineCapability({
    title: "Ask a knowledge base",
    description:
      "Answers from the current immutable document revisions in one knowledge base and returns the retrieved citations. Discover which bases exist via brain_search or context_get first; do not assume a person or topic lives only in memories.",
    input: z.object({
      knowledgeBaseId: idSchema,
      question: z.string().trim().min(1).max(5_000),
      topK: z.number().int().min(1).max(20).default(5),
    }),
    output: knowledgeAnswerSchema,
    access: "authenticated",
    timeoutMs: 120_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    async run({ input, context }) {
      let access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const space = await activeKnowledgeSpace(
        access,
        embeddingSpaces,
        embeddings,
        context.signal,
      );
      const queryEmbedding = await embedContent(
        input.question,
        "search_query",
        space,
        embeddings,
        context.signal,
      );

      access = await accessStore.revalidateAccess(
        access,
        "viewer",
        context.signal,
      );
      const matches = requireFound(
        await knowledge.searchKnowledge(
          access,
          {
            knowledgeBaseId: input.knowledgeBaseId,
            embedding: queryEmbedding,
            limit: input.topK,
          },
          context.signal,
        ),
        "Knowledge base",
      );
      const citations = matches
        .filter(
          (match) =>
            match.spaceId === space.id && match.score >= knowledgeScoreFloor,
        )
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.chunkId.localeCompare(right.chunkId),
        )
        .slice(0, input.topK);
      if (citations.length === 0) {
        return knowledgeAnswerSchema.parse({
          answer: noKnowledgeAnswer,
          citations: [],
        });
      }

      access = await accessStore.revalidateAccess(
        access,
        "viewer",
        context.signal,
      );
      const answer = await answers.answer(
        { question: input.question, contexts: citations },
        context.signal,
      );
      return knowledgeAnswerSchema.parse({
        answer,
        citations: citations.map((citation) => ({ ...citation, origin: writableOrigin(citation.origin) })),
      });
    },
  });

  return {
    knowledge_bases_create: createKnowledgeBase,
    knowledge_bases_list: listKnowledgeBases,
    knowledge_documents_list: listDocuments,
    knowledge_documents_get: getDocument,
    knowledge_document_revisions_create: createDocumentRevision,
    knowledge_document_revisions_list: listDocumentRevisions,
    knowledge_ask: askKnowledge,
  } as const;
}
