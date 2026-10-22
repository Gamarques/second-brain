import type {
  BrainAccessContext,
  ContentEmbedding,
  EmbeddingProvider,
  EmbeddingSpace,
} from "./core.js";
import {
  KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  knowledgeChunkEmbeddingRecipe,
} from "./embedding-recipes.js";
import type { EmbeddingSpaceStore } from "./stores.js";

/**
 * How knowledge text becomes searchable chunks: the splitting rules, the
 * check that the embedding provider matches the active space, and embedding
 * in bounded batches. The revision capability and any bulk indexing stage
 * share this module so the stored chunks and hashes stay byte-for-byte the
 * same whichever path produced them.
 */

export const knowledgeChunkSize = 1_200;
export const knowledgeChunkOverlap = 200;
/** Chunks sent to the provider per call; keeps a 1,000-chunk document from becoming one request. */
export const knowledgeEmbeddingBatchSize = 64;

export function splitKnowledgeDocument(content: string): readonly string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= knowledgeChunkSize) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + knowledgeChunkSize, normalized.length);
    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf("\n\n", end);
      const sentenceBreak = normalized.lastIndexOf(". ", end);
      const preferredBreak = Math.max(paragraphBreak, sentenceBreak);
      if (preferredBreak > start + knowledgeChunkSize / 2) end = preferredBreak + 1;
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end === normalized.length) break;
    start = Math.max(end - knowledgeChunkOverlap, start + 1);
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

export function requireEmbedding(
  embedding: readonly number[] | undefined,
  dimensions: number,
): readonly number[] {
  const norm = embedding === undefined ? 0 : Math.hypot(...embedding);
  if (
    embedding === undefined ||
    embedding.length !== dimensions ||
    !embedding.every(Number.isFinite) ||
    !Number.isFinite(norm) ||
    norm === 0
  ) {
    throw new Error("The embedding provider returned an invalid vector.");
  }
  return embedding;
}

export function assertProviderMatchesSpace(
  provider: EmbeddingProvider,
  space: EmbeddingSpace | null,
): EmbeddingSpace {
  if (
    space === null ||
    space.entityType !== "knowledge_chunk" ||
    space.status !== "active" ||
    space.provider !== provider.provider ||
    space.model !== provider.model ||
    space.modelRevision !== provider.modelRevision ||
    space.recipeVersion !== KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION ||
    space.dimensions !== provider.dimensions
  ) {
    throw new Error(
      "No compatible active embedding space is configured for this brain.",
    );
  }
  return space;
}

export async function activeKnowledgeSpace(
  access: BrainAccessContext,
  spaces: EmbeddingSpaceStore,
  provider: EmbeddingProvider,
  signal: AbortSignal,
): Promise<EmbeddingSpace> {
  return assertProviderMatchesSpace(
    provider,
    await spaces.getActiveSpace(access, "knowledge_chunk", signal),
  );
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("Knowledge indexing was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Embeds chunk texts in order, `batchSize` per provider call, validating every
 * returned vector against the space. A batch never starts once the signal has
 * aborted, so a cancelled run stops at the next batch boundary.
 */
export async function embedChunksInBatches(
  provider: EmbeddingProvider,
  space: EmbeddingSpace,
  chunks: readonly string[],
  options: { readonly signal: AbortSignal; readonly batchSize?: number },
): Promise<readonly ContentEmbedding[]> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? knowledgeEmbeddingBatchSize));
  const recipes = chunks.map((chunk) => knowledgeChunkEmbeddingRecipe(chunk));
  const embeddings: ContentEmbedding[] = [];
  for (let start = 0; start < recipes.length; start += batchSize) {
    if (options.signal.aborted) throw abortError(options.signal);
    const batch = recipes.slice(start, start + batchSize);
    const vectors = await provider.embed(
      batch.map((recipe) => recipe.text),
      options.signal,
      "search_document",
    );
    if (vectors.length !== batch.length) {
      throw new Error("The embedding provider returned an invalid vector batch.");
    }
    batch.forEach((recipe, index) => {
      embeddings.push({
        spaceId: space.id,
        contentHash: recipe.contentHash,
        vector: requireEmbedding(vectors[index], space.dimensions),
      });
    });
  }
  return embeddings;
}
