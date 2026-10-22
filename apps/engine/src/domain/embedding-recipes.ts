import type { RejectedAlternative } from "./entities.js";
import { canonicalJson, sha256Hex } from "./digests.js";

/** Identifies the exact text construction used for memory document embeddings. */
export const MEMORY_EMBEDDING_RECIPE_VERSION = "memory-v1";

/** Identifies the exact text construction used for decision document embeddings. */
export const DECISION_EMBEDDING_RECIPE_VERSION = "decision-v1";

/** Identifies the exact text construction used for knowledge chunk embeddings. */
export const KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION = "knowledge-chunk-v1";

export interface EmbeddingRecipeContent<RecipeVersion extends string = string> {
  readonly recipeVersion: RecipeVersion;
  readonly text: string;
  readonly contentHash: string;
}

/**
 * Produces the canonical memory identity and embedding input. Compatibility
 * characters, case, and whitespace-only differences represent the same fact.
 */
export function canonicalMemoryEmbeddingText(content: string): string {
  return normalizeText(content).toLowerCase();
}

export function memoryEmbeddingRecipe(
  content: string,
): EmbeddingRecipeContent<typeof MEMORY_EMBEDDING_RECIPE_VERSION> {
  const text = canonicalMemoryEmbeddingText(content);
  return {
    recipeVersion: MEMORY_EMBEDDING_RECIPE_VERSION,
    text,
    contentHash: sha256Hex(text),
  };
}

export interface DecisionEmbeddingRecipeInput {
  readonly statement: string;
  readonly rationale: string;
  readonly rejectedAlternatives: readonly RejectedAlternative[];
}

/**
 * Produces a canonical JSON decision document. Object key order never changes
 * the embedding identity; alternative order remains meaningful and is kept.
 */
export function canonicalDecisionEmbeddingText(
  input: DecisionEmbeddingRecipeInput,
): string {
  return canonicalJson({
    statement: normalizeText(input.statement),
    rationale: normalizeText(input.rationale),
    rejectedAlternatives: input.rejectedAlternatives.map((alternative) => ({
      option: normalizeText(alternative.option),
      reason:
        alternative.reason === null ? null : normalizeText(alternative.reason),
    })),
  });
}

export function decisionEmbeddingRecipe(
  input: DecisionEmbeddingRecipeInput,
): EmbeddingRecipeContent<typeof DECISION_EMBEDDING_RECIPE_VERSION> {
  const text = canonicalDecisionEmbeddingText(input);
  return {
    recipeVersion: DECISION_EMBEDDING_RECIPE_VERSION,
    text,
    contentHash: sha256Hex(text),
  };
}

/**
 * Knowledge chunks preserve case while normalizing compatibility characters
 * and whitespace so equivalent chunk boundaries have one stable identity.
 */
export function canonicalKnowledgeChunkEmbeddingText(content: string): string {
  return normalizeText(content);
}

export function knowledgeChunkEmbeddingRecipe(
  content: string,
): EmbeddingRecipeContent<typeof KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION> {
  const text = canonicalKnowledgeChunkEmbeddingText(content);
  return {
    recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
    text,
    contentHash: sha256Hex(text),
  };
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}
