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

const fingerprint = {
  provider: "test-provider",
  model: "test-embedding-model",
  modelRevision: "2026-08-17",
  dimensions: 1_536,
} as const;

function activeSpace(
  entityType: "memory" | "decision" | "knowledge_chunk",
  recipeVersion: string,
) {
  return {
    id: randomUUID(),
    entityType,
    ...fingerprint,
    recipeVersion,
    metric: "cosine" as const,
    status: "active" as const,
    createdAt: new Date("2026-08-17T12:00:00.000Z"),
    promotedAt: new Date("2026-08-17T12:00:01.000Z"),
    retiredAt: null,
  };
}

const exactRequiredSpaces = [
  activeSpace("memory", MEMORY_EMBEDDING_RECIPE_VERSION),
  activeSpace("decision", DECISION_EMBEDDING_RECIPE_VERSION),
  activeSpace("knowledge_chunk", KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION),
] as const;

function databaseReturning(rows: readonly unknown[]): EmbeddingSpaceDatabase {
  const where = vi.fn(async () => rows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select } as unknown as EmbeddingSpaceDatabase;
}

describe("active embedding-space startup validation", () => {
  it("rejects an empty active-space set", async () => {
    await expect(
      assertActiveEmbeddingSpacesMatchProvider(
        databaseReturning([]),
        fingerprint,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ActiveEmbeddingSpaceMismatchError);
  });

  it("rejects an active-space set missing one required entity type", async () => {
    await expect(
      assertActiveEmbeddingSpacesMatchProvider(
        databaseReturning(exactRequiredSpaces.slice(0, 2)),
        fingerprint,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ActiveEmbeddingSpaceMismatchError);
  });

  it("accepts exactly one compatible active space for each required entity type", async () => {
    await expect(
      assertActiveEmbeddingSpacesMatchProvider(
        databaseReturning(exactRequiredSpaces),
        fingerprint,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });
});
