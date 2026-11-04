import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  DECISION_EMBEDDING_RECIPE_VERSION,
  KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  MEMORY_EMBEDDING_RECIPE_VERSION,
} from "../src/domain.js";
import {
  ActiveEmbeddingSpaceMismatchError,
  assertActiveEmbeddingSpacesMatchProvider,
  type EmbeddingSpaceDatabase,
} from "../src/database/stores/embedding-space-store.js";
import { createConfiguredModelProvider } from "../src/runtime-config.js";

/**
 * An install created before the provider registry stored its embedding spaces
 * from the legacy OPENROUTER_* identity. Whatever configuration style is used
 * later must reproduce that exact identity, or startup refuses to run.
 */
const legacyEnvironment = { OPENROUTER_API_KEY: "test-key" };
const registryEnvironment = (embedding: string) => ({
  AI_PROVIDERS: "go,or",
  AI_PROVIDER_GO_PRESET: "opencode-go",
  AI_PROVIDER_GO_API_KEY: "test-key",
  AI_PROVIDER_OR_PRESET: "openrouter",
  AI_PROVIDER_OR_API_KEY: "test-key",
  AI_EMBEDDING: embedding,
  AI_ANSWER: "go:deepseek-v4.1-flash,or:deepseek/deepseek-v4.1-flash",
});

function storedSpaces(identity: { provider: string; model: string; modelRevision: string; dimensions: number }) {
  return [
    ["memory", MEMORY_EMBEDDING_RECIPE_VERSION],
    ["decision", DECISION_EMBEDDING_RECIPE_VERSION],
    ["knowledge_chunk", KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION],
  ].map(([entityType, recipeVersion]) => ({
    id: randomUUID(),
    entityType,
    ...identity,
    recipeVersion,
    metric: "cosine" as const,
    status: "active" as const,
    createdAt: new Date("2026-08-17T12:00:00.000Z"),
    promotedAt: new Date("2026-08-17T12:00:01.000Z"),
    retiredAt: null,
  }));
}

function databaseReturning(rows: readonly unknown[]): EmbeddingSpaceDatabase {
  const where = vi.fn(async () => rows);
  return { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) } as unknown as EmbeddingSpaceDatabase;
}

const check = (rows: ReturnType<typeof storedSpaces>, identity: Parameters<typeof assertActiveEmbeddingSpacesMatchProvider>[1]) =>
  assertActiveEmbeddingSpacesMatchProvider(databaseReturning(rows), identity, new AbortController().signal);

describe("embedding identity continuity across configuration styles", () => {
  const legacy = createConfiguredModelProvider(legacyEnvironment).embeddingIdentity;
  const stored = storedSpaces(legacy);

  it("accepts a legacy-created install when configured through the registry with OpenRouter embeddings", async () => {
    const identity = createConfiguredModelProvider(registryEnvironment("or:google/gemini-embedding-001")).embeddingIdentity;
    expect(identity).toEqual(legacy);
    await expect(check(stored, identity)).resolves.toBeUndefined();
  });

  it("keeps the identity when only the chat provider changes", async () => {
    const withGoChat = createConfiguredModelProvider(registryEnvironment("or:google/gemini-embedding-001")).embeddingIdentity;
    await expect(check(stored, withGoChat)).resolves.toBeUndefined();
  });

  it("refuses to start when the embedding model changes against stored vectors", async () => {
    const changed = createConfiguredModelProvider(registryEnvironment("or:openai/text-embedding-3-small")).embeddingIdentity;
    expect(changed.model).toBe("openai/text-embedding-3-small");
    await expect(check(stored, changed)).rejects.toBeInstanceOf(ActiveEmbeddingSpaceMismatchError);
  });
});
