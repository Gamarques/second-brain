import { describe, expect, it } from "vitest";

import {
  canonicalDecisionEmbeddingText,
  canonicalDigest,
  canonicalJson,
  canonicalKnowledgeChunkEmbeddingText,
  canonicalMemoryEmbeddingText,
  DECISION_EMBEDDING_RECIPE_VERSION,
  decisionEmbeddingRecipe,
  ingestionReviewDigest,
  ingestionRequestDigest,
  isValidIngestSourceSpan,
  KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  knowledgeChunkEmbeddingRecipe,
  MEMORY_EMBEDDING_RECIPE_VERSION,
  memoryEmbeddingRecipe,
  sha256Hex,
} from "../src/domain.js";

describe("canonical domain digests", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const first = { z: [{ b: 2, a: 1 }, 3], a: "value" };
    const second = { a: "value", z: [{ a: 1, b: 2 }, 3] };

    expect(canonicalJson(first)).toBe('{"a":"value","z":[{"a":1,"b":2},3]}');
    expect(canonicalDigest(first)).toBe(canonicalDigest(second));
    expect(canonicalDigest({ values: [1, 2] })).not.toBe(
      canonicalDigest({ values: [2, 1] }),
    );
  });

  it("rejects values that canonical JSON cannot represent", () => {
    expect(() => canonicalDigest({ invalid: undefined })).toThrow(
      "$.invalid contains a value that JSON cannot represent.",
    );
    expect(() => canonicalDigest({ invalid: Number.NaN })).toThrow(
      "$.invalid must contain a finite number.",
    );
  });

  it("uses one stable ingestion request recipe", () => {
    const input = {
      schemaVersion: "ingestion-v1",
      brainId: "00000000-0000-4000-8000-000000000001",
      excerpt: "We chose PostgreSQL.",
      capturedAt: "2026-08-16T12:00:00.000Z",
    };

    expect(ingestionRequestDigest(input)).toBe(sha256Hex(canonicalJson(input)));
  });

  it("binds a review independently of submitted item order", () => {
    const base = {
      runId: "00000000-0000-4000-8000-000000000001",
      proposalDigest: "a".repeat(64),
    };
    const first = {
      proposalId: "00000000-0000-4000-8000-000000000002",
      decision: "accept" as const,
      replacement: null,
    };
    const second = {
      proposalId: "00000000-0000-4000-8000-000000000003",
      decision: "reject" as const,
      replacement: null,
    };

    expect(ingestionReviewDigest({ ...base, items: [first, second] })).toBe(
      ingestionReviewDigest({ ...base, items: [second, first] }),
    );
  });

  it("validates source spans as JavaScript UTF-16 code-unit offsets", () => {
    expect(
      isValidIngestSourceSpan("A😀B", {
        sourceStart: 1,
        sourceEnd: 3,
        sourceQuote: "😀",
      }),
    ).toBe(true);
    expect(
      isValidIngestSourceSpan("A😀B", {
        sourceStart: 1,
        sourceEnd: 2,
        sourceQuote: "😀",
      }),
    ).toBe(false);
  });
});

describe("canonical embedding recipes", () => {
  it("normalizes Unicode, case, and whitespace for memory identity", () => {
    const first = memoryEmbeddingRecipe("  PostgreSQL\tＦＡＣＴＳ  ");
    const second = memoryEmbeddingRecipe("postgresql facts");

    expect(first).toEqual(second);
    expect(first).toEqual({
      recipeVersion: MEMORY_EMBEDDING_RECIPE_VERSION,
      text: "postgresql facts",
      contentHash: sha256Hex("postgresql facts"),
    });
    expect(canonicalMemoryEmbeddingText("A\n\nB")).toBe("a b");
  });

  it("builds stable decision JSON independent of caller object key order", () => {
    const first = {
      statement: "  Use\u00a0PostgreSQL ",
      rationale: "Relational\t integrity",
      rejectedAlternatives: [{ option: "ＭｏｎｇｏＤＢ", reason: "No joins" }],
    };
    const second = {
      rejectedAlternatives: [{ reason: "No joins", option: "MongoDB" }],
      rationale: "Relational integrity",
      statement: "Use PostgreSQL",
    };

    expect(canonicalDecisionEmbeddingText(first)).toBe(
      canonicalDecisionEmbeddingText(second),
    );
    expect(decisionEmbeddingRecipe(first)).toEqual({
      recipeVersion: DECISION_EMBEDDING_RECIPE_VERSION,
      text: canonicalDecisionEmbeddingText(second),
      contentHash: sha256Hex(canonicalDecisionEmbeddingText(second)),
    });
  });

  it("preserves rejected-alternative order in decision identity", () => {
    const base = {
      statement: "Use PostgreSQL",
      rationale: "Relational integrity",
    };
    const mongo = { option: "MongoDB", reason: null };
    const sqlite = { option: "SQLite", reason: null };

    expect(
      decisionEmbeddingRecipe({
        ...base,
        rejectedAlternatives: [mongo, sqlite],
      }).contentHash,
    ).not.toBe(
      decisionEmbeddingRecipe({
        ...base,
        rejectedAlternatives: [sqlite, mongo],
      }).contentHash,
    );
  });

  it("normalizes Unicode and whitespace without folding knowledge chunk case", () => {
    const first = knowledgeChunkEmbeddingRecipe("  ＰｏｓｔｇｒｅＳＱＬ\n facts ");
    const second = knowledgeChunkEmbeddingRecipe("PostgreSQL facts");

    expect(first).toEqual(second);
    expect(first).toEqual({
      recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
      text: "PostgreSQL facts",
      contentHash: sha256Hex("PostgreSQL facts"),
    });
    expect(canonicalKnowledgeChunkEmbeddingText("Fact A\t Fact B")).toBe(
      "Fact A Fact B",
    );
    expect(knowledgeChunkEmbeddingRecipe("Fact").contentHash).not.toBe(
      knowledgeChunkEmbeddingRecipe("fact").contentHash,
    );
  });
});
