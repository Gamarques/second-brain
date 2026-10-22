import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DrizzleBrainEvidenceStore } from "../src/database/stores/evidence-store.js";
import {
  DrizzleKnowledgeStore,
  reconstructKnowledgeContent,
} from "../src/database/stores/knowledge-store.js";
import type { SecondBrainDatabase } from "../src/database/stores/database.js";
import type { BrainAccessContext } from "../src/domain.js";

const accountId = "40000000-0000-4000-8000-000000000001";
const access: BrainAccessContext = {
  accountId,
  role: "owner",
  actor: {
    kind: "account",
    accountId,
    clientId: null,
    source: "direct",
    requestId: "validation-test",
    correlationId: null,
    causationId: null,
    dreamingRunId: null,
  },
};

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const databaseMustNotBeReached = {} as SecondBrainDatabase;

describe("Drizzle knowledge and evidence store boundary validation", () => {
  it("reconstructs revision content from ordered overlapping chunks", () => {
    expect(
      reconstructKnowledgeContent(
        [
          { position: 0, content: "Architecture uses a modular monolith." },
          { position: 1, content: "modular monolith. Deploy it as one unit." },
        ],
        2,
      ),
    ).toBe("Architecture uses a modular monolith. Deploy it as one unit.");
  });

  it("rejects incomplete or unordered revision chunks", () => {
    expect(() =>
      reconstructKnowledgeContent([{ position: 1, content: "Missing" }], 1),
    ).toThrow("invalid chunk ordering");
    expect(() =>
      reconstructKnowledgeContent([{ position: 0, content: "Only" }], 2),
    ).toThrow("incomplete chunks");
  });

  it("rejects unbounded knowledge browsing before database access", async () => {
    const store = new DrizzleKnowledgeStore(databaseMustNotBeReached);
    await expect(
      store.listDocuments(
        access,
        { knowledgeBaseId: null, cursor: null, limit: 101 },
        new AbortController().signal,
      ),
    ).rejects.toThrow("between 1 and 100");
    await expect(
      store.listDocumentRevisions(
        access,
        {
          documentId: "40000000-0000-4000-8000-000000000003",
          cursor: null,
          limit: 101,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("between 1 and 100");
  });

  it("rejects a chunk whose embedding identity does not match its canonical text", async () => {
    const store = new DrizzleKnowledgeStore(databaseMustNotBeReached);
    await expect(
      store.createDocumentRevision(
        access,
        {
          knowledgeBaseId: "40000000-0000-4000-8000-000000000003",
          documentId: null,
          expectedRevision: null,
          title: "Document",
          sourceUri: null,
          contentHash: hash("Document"),
          chunks: [{
            content: "Canonical chunk",
            position: 0,
            embedding: {
              spaceId: "40000000-0000-4000-8000-000000000004",
              contentHash: hash("different text"),
              vector: [1],
            },
          }],
          tags: [],
          projectId: null,
          personIds: [],
          idempotencyKey: "document-create",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("content hash does not match its chunk");
  });

  it("rejects unbounded evidence limits before opening a transaction", async () => {
    const store = new DrizzleBrainEvidenceStore(databaseMustNotBeReached);
    await expect(
      store.searchEvidence(
        access,
        {
          embeddings: { memories: null, decisions: null },
          query: "launch",
          asOf: null,
          projectId: null,
          limits: {
            memories: 101,
            decisions: 0,
            tasks: 0,
            reminders: 0,
            goals: 0,
            priorities: 0,
            activities: 0,
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("memories evidence limit must be between 0 and 100");
  });

  it("rejects a future historical cutoff before opening a transaction", async () => {
    const store = new DrizzleBrainEvidenceStore(databaseMustNotBeReached);
    await expect(
      store.searchEvidence(
        access,
        {
          embeddings: { memories: null, decisions: null },
          query: "launch",
          asOf: "2999-01-01T00:00:00.000Z",
          projectId: null,
          limits: {
            memories: 0,
            decisions: 0,
            tasks: 0,
            reminders: 0,
            goals: 0,
            priorities: 0,
            activities: 0,
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("asOf must not be in the future");
  });

  it("holds a row lock on the active knowledge embedding space during revision writes", async () => {
    const source = await readFile(
      new URL("../src/database/stores/knowledge-store.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('.for("share", { of: embeddingSpaces })');
    expect(source.indexOf('.for("share", { of: embeddingSpaces })')).toBeLessThan(
      source.indexOf(".insert(knowledgeDocumentRevisions)"),
    );
  });

  it("honors cancellation before validation or database access", async () => {
    const controller = new AbortController();
    controller.abort(new Error("canceled"));
    const store = new DrizzleBrainEvidenceStore(databaseMustNotBeReached);
    await expect(
      store.searchEvidence(
        access,
        {
          embeddings: { memories: null, decisions: null },
          query: "launch",
          asOf: null,
          projectId: null,
          limits: {
            memories: 0,
            decisions: 0,
            tasks: 0,
            reminders: 0,
            goals: 0,
            priorities: 0,
            activities: 0,
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("canceled");
  });
});
