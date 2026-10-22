import { describe, expect, it } from "vitest";

import type { EmbeddingProvider, EmbeddingSpace } from "../src/domain.js";
import { KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION } from "../src/domain.js";
import {
  assertProviderMatchesSpace,
  embedChunksInBatches,
  knowledgeChunkSize,
  splitKnowledgeDocument,
} from "../src/domain/knowledge-indexing.js";

const space: EmbeddingSpace = {
  id: "00000000-0000-4000-8000-000000000020",
  entityType: "knowledge_chunk",
  provider: "fake",
  model: "embed-v1",
  modelRevision: "2026-08-01",
  recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  dimensions: 3,
  metric: "cosine",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  promotedAt: "2026-08-01T00:00:00.000Z",
  retiredAt: null,
};

function fakeProvider(
  options: {
    vectorFor?: (text: string) => readonly number[];
    onCall?: (texts: readonly string[], signal: AbortSignal) => void;
  } = {},
) {
  const calls: (readonly string[])[] = [];
  const provider: EmbeddingProvider = {
    provider: "fake",
    model: "embed-v1",
    modelRevision: "2026-08-01",
    dimensions: 3,
    async embed(texts, signal, inputType) {
      if (inputType !== "search_document") {
        throw new Error(`unexpected input type ${inputType}`);
      }
      options.onCall?.(texts, signal);
      calls.push(texts);
      return texts.map((text) => options.vectorFor?.(text) ?? [1, 0, 0]);
    },
  };
  return { provider, calls };
}

const chunks = (count: number): readonly string[] =>
  Array.from({ length: count }, (_, index) => `chunk ${index}`);
const signal = () => new AbortController().signal;

describe("splitKnowledgeDocument", () => {
  it("keeps a short document as one normalised chunk", () => {
    expect(
      splitKnowledgeDocument("  First   paragraph.\r\n\r\nSecond paragraph.  "),
    ).toEqual(["First   paragraph.\n\nSecond paragraph."]);
  });

  it("splits a long document into bounded overlapping chunks", () => {
    const sentence = "A sentence of moderate length that keeps repeating. ";
    const pieces = splitKnowledgeDocument(sentence.repeat(60));

    expect(pieces.length).toBeGreaterThan(1);
    expect(
      pieces.every((piece) => piece.length > 0 && piece.length <= knowledgeChunkSize),
    ).toBe(true);
    expect(pieces[0]!.length).toBeGreaterThan(knowledgeChunkSize / 2);
  });
});

describe("assertProviderMatchesSpace", () => {
  it("rejects a space that does not match the provider", () => {
    const { provider } = fakeProvider();

    expect(() => assertProviderMatchesSpace(provider, null)).toThrow(
      /No compatible active embedding space/,
    );
    expect(() =>
      assertProviderMatchesSpace(provider, { ...space, model: "embed-v2" }),
    ).toThrow(/No compatible active embedding space/);
    expect(assertProviderMatchesSpace(provider, space)).toBe(space);
  });
});

describe("embedChunksInBatches", () => {
  it.each([
    [1, [1]],
    [63, [63]],
    [64, [64]],
    [65, [64, 1]],
    [130, [64, 64, 2]],
  ])("embeds %i chunks in batches of at most 64: %j", async (count, sizes) => {
    const { provider, calls } = fakeProvider();

    const embeddings = await embedChunksInBatches(provider, space, chunks(count), {
      signal: signal(),
    });

    expect(calls.map((call) => call.length)).toEqual(sizes);
    expect(embeddings).toHaveLength(count);
  });

  it("keeps every chunk aligned with its own vector across batches", async () => {
    const { provider } = fakeProvider({
      vectorFor: (text) => [Number(text.replace("chunk ", "")) + 1, 0, 0],
    });

    const embeddings = await embedChunksInBatches(provider, space, chunks(130), {
      signal: signal(),
      batchSize: 64,
    });

    expect(embeddings.map((embedding) => embedding.vector[0])).toEqual(
      chunks(130).map((_, index) => index + 1),
    );
    expect(embeddings[129]).toMatchObject({
      spaceId: space.id,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("honours a custom batch size", async () => {
    const { provider, calls } = fakeProvider();

    await embedChunksInBatches(provider, space, chunks(10), {
      signal: signal(),
      batchSize: 4,
    });

    expect(calls.map((call) => call.length)).toEqual([4, 4, 2]);
  });

  it("stops at the first batch boundary after the signal aborts", async () => {
    const controller = new AbortController();
    const { provider, calls } = fakeProvider({ onCall: () => controller.abort() });

    await expect(
      embedChunksInBatches(provider, space, chunks(130), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });

  it("does not call the provider at all when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, calls } = fakeProvider();

    await expect(
      embedChunksInBatches(provider, space, chunks(3), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a batch whose vector count does not match", async () => {
    const provider: EmbeddingProvider = {
      ...fakeProvider().provider,
      async embed(texts) {
        return texts.slice(1).map(() => [1, 0, 0]);
      },
    };

    await expect(
      embedChunksInBatches(provider, space, chunks(2), { signal: signal() }),
    ).rejects.toThrow(/invalid vector batch/);
  });

  it("rejects a malformed vector inside any batch", async () => {
    const { provider } = fakeProvider({
      vectorFor: (text) => (text === "chunk 70" ? [0, 0, 0] : [1, 0, 0]),
    });

    await expect(
      embedChunksInBatches(provider, space, chunks(71), { signal: signal() }),
    ).rejects.toThrow(/invalid vector/);
  });

  it("returns nothing for no chunks without calling the provider", async () => {
    const { provider, calls } = fakeProvider();

    expect(
      await embedChunksInBatches(provider, space, [], { signal: signal() }),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
