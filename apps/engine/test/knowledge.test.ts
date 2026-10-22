import { createEngine } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { createKnowledgeCapabilities } from "../src/capabilities/knowledge.js";
import { KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION } from "../src/domain.js";
import type {
  AnswerProvider,
  BrainAccessContext,
  BrainAccessStore,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
  KnowledgeChunkMatch,
  KnowledgeStore,
} from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const knowledgeBaseId = "00000000-0000-4000-8000-000000000004";
const documentId = "00000000-0000-4000-8000-000000000005";
const revisionId = "00000000-0000-4000-8000-000000000006";
const chunkId = "00000000-0000-4000-8000-000000000007";
const spaceId = "00000000-0000-4000-8000-000000000008";
const now = "2026-08-16T12:00:00.000Z";
const principal = { id: accountId };

const attribution = {
  kind: "account",
  accountId,
  clientId: null,
  source: "direct",
} as const;

const packOrigin = {
  publisher: { namespace: "acme.engineering", displayName: "Acme Engineering" },
  packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60",
  packRevision: 3,
  packTitle: "Engineering Brain Pack",
  itemKey: "architecture-notes",
  authors: [{ name: "Alex Rivera", uri: null }],
} as const;

function accessFor(requestId: string): BrainAccessContext {
  return {
    accountId,
    role: "owner",
    actor: {
      ...attribution,
      requestId,
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
}

function activeSpace(overrides: Partial<EmbeddingSpace> = {}): EmbeddingSpace {
  return {
    id: spaceId,
    entityType: "knowledge_chunk",
    provider: "fake",
    model: "embed-v1",
    modelRevision: "2026-08-01",
    recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
    dimensions: 3,
    metric: "cosine",
    status: "active",
    createdAt: now,
    promotedAt: now,
    retiredAt: null,
    ...overrides,
  };
}

function setup() {
  const accessRequests: Parameters<BrainAccessStore["resolveAccess"]>[0][] = [];
  const revalidations: string[] = [];
  const accessStore: BrainAccessStore = {
    async resolveAccess(request) {
      accessRequests.push(request);
      return accessFor(request.requestId);
    },
    async revalidateAccess(access, role) {
      revalidations.push(role);
      return access;
    },
    async getTimeZone() {
      return "America/Sao_Paulo";
    },
  };

  let space: EmbeddingSpace | null = activeSpace();
  const embeddingSpaces: EmbeddingSpaceStore = {
    async getActiveSpace() {
      return space;
    },
    async createSpace() {
      throw new Error("not used");
    },
    async promoteSpace() {
      throw new Error("not used");
    },
  };

  const embedCalls: { texts: readonly string[]; inputType: string }[] = [];
  let vectors: readonly (readonly number[])[] | null = null;
  const embeddings: EmbeddingProvider = {
    provider: "fake",
    model: "embed-v1",
    modelRevision: "2026-08-01",
    dimensions: 3,
    async embed(texts, _signal, inputType) {
      embedCalls.push({ texts, inputType });
      return vectors ?? texts.map(() => [1, 0, 0]);
    },
  };

  const base = {
    id: knowledgeBaseId,
    name: "Architecture",
    description: null,
    provenance: attribution,
    createdAt: now,
    updatedAt: now,
  } as const;
  const document = {
    id: documentId,
    knowledgeBaseId,
    currentRevision: 1,
    title: "Backend",
    sourceUri: null,
    tags: [] as const,
    projectId: null,
    personIds: [] as const,
    provenance: attribution,
    createdAt: now,
    updatedAt: now,
  } as const;
  const revision = {
    id: revisionId,
    documentId,
    version: 1,
    contentHash: "a".repeat(64),
    chunkCount: 1,
    provenance: attribution,
    createdAt: now,
  } as const;

  const createBaseCalls: Parameters<
    KnowledgeStore["createKnowledgeBase"]
  >[1][] = [];
  const revisionCalls: Parameters<
    KnowledgeStore["createDocumentRevision"]
  >[1][] = [];
  const searchCalls: Parameters<KnowledgeStore["searchKnowledge"]>[1][] = [];
  const listDocumentCalls: Parameters<KnowledgeStore["listDocuments"]>[1][] = [];
  const getDocumentCalls: Parameters<KnowledgeStore["getDocument"]>[1][] = [];
  const listRevisionCalls: Parameters<
    KnowledgeStore["listDocumentRevisions"]
  >[1][] = [];
  let matches: readonly KnowledgeChunkMatch[] | null = [
    {
      chunkId,
      documentId,
      revisionId,
      documentTitle: "Backend",
      content: "Use a modular monolith.",
      score: 0.91,
      spaceId,
      knowledgeBaseId,
      knowledgeBaseName: "Architecture",
    },
  ];
  const knowledge: KnowledgeStore = {
    async createKnowledgeBase(_access, input) {
      createBaseCalls.push(input);
      return { ...base, name: input.name, description: input.description };
    },
    async listKnowledgeBases() {
      return [base];
    },
    async createDocumentRevision(_access, input) {
      revisionCalls.push(input);
      return {
        document: {
          ...document,
          title: input.title,
          sourceUri: input.sourceUri,
          tags: [...input.tags],
          projectId: input.projectId,
          personIds: [...input.personIds],
          currentRevision:
            input.expectedRevision === null ? 1 : input.expectedRevision + 1,
        },
        revision: {
          ...revision,
          version:
            input.expectedRevision === null ? 1 : input.expectedRevision + 1,
          contentHash: input.contentHash,
          chunkCount: input.chunks.length,
        },
      };
    },
    async listDocuments(_access, input) {
      listDocumentCalls.push(input);
      return {
        items: [document],
        nextCursor: { ts: now, id: documentId },
      };
    },
    async getDocument(_access, input) {
      getDocumentCalls.push(input);
      return {
        document,
        revision,
        content: "Use a modular monolith.",
        representation: "canonical",
        origin: packOrigin,
      };
    },
    async listDocumentRevisions(_access, input) {
      listRevisionCalls.push(input);
      return {
        items: [
          {
            revision,
            content: "Use a modular monolith.",
            representation: "reconstructed",
            origin: null,
          },
        ],
        nextCursor: null,
      };
    },
    async searchKnowledge(_access, input) {
      searchCalls.push(input);
      return matches;
    },
  };

  const answerCalls: Parameters<AnswerProvider["answer"]>[0][] = [];
  const answers: AnswerProvider = {
    async answer(input) {
      answerCalls.push(input);
      return "Use a modular monolith [1].";
    },
    async reason() {
      throw new Error("not used");
    },
  };

  const capabilities = createKnowledgeCapabilities(
    accessStore,
    knowledge,
    embeddingSpaces,
    embeddings,
    answers,
  );
  const engine = createEngine({ name: "test", version: "1.0.0", capabilities });
  return {
    engine,
    controls: {
      accessRequests,
      revalidations,
      embedCalls,
      createBaseCalls,
      revisionCalls,
      listDocumentCalls,
      getDocumentCalls,
      listRevisionCalls,
      searchCalls,
      answerCalls,
      setSpace(value: EmbeddingSpace | null) {
        space = value;
      },
      setVectors(value: readonly (readonly number[])[]) {
        vectors = value;
      },
      setMatches(value: readonly KnowledgeChunkMatch[] | null) {
        matches = value;
      },
    },
  };
}

describe("knowledge capabilities", () => {
  it("creates a knowledge base with an idempotency key", async () => {
    const { engine, controls } = setup();

    await engine.invoke(
      "knowledge_bases_create",
      {
        name: "Architecture",
        description: null,
        idempotencyKey: "kb-1",
      },
      { principal },
    );

    expect(controls.accessRequests[0]).toMatchObject({
      requiredRole: "editor",
    });
    expect(controls.createBaseCalls).toEqual([
      { name: "Architecture", description: null, idempotencyKey: "kb-1" },
    ]);
  });

  it("creates immutable document revisions with tagged chunk embeddings and optimistic concurrency", async () => {
    const { engine, controls } = setup();
    const content = "First   paragraph.\n\nSecond paragraph.";

    const created = await engine.invoke(
      "knowledge_document_revisions_create",
      {
        knowledgeBaseId,
        title: "Backend",
        content,
        idempotencyKey: "doc-1",
      },
      { principal },
    );
    const revised = await engine.invoke(
      "knowledge_document_revisions_create",
      {
        knowledgeBaseId,
        documentId,
        expectedRevision: 1,
        title: "Backend v2",
        content: "The revised content.",
        idempotencyKey: "doc-2",
      },
      { principal },
    );

    expect(created.revision.version).toBe(1);
    expect(revised.revision.version).toBe(2);
    expect(controls.revisionCalls[0]).toMatchObject({
      documentId: null,
      expectedRevision: null,
      idempotencyKey: "doc-1",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(controls.revisionCalls[0]!.chunks[0]!.embedding).toMatchObject({
      spaceId,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      vector: [1, 0, 0],
    });
    expect(controls.embedCalls[0]).toEqual({
      texts: ["First paragraph. Second paragraph."],
      inputType: "search_document",
    });
    expect(controls.revisionCalls[1]).toMatchObject({
      documentId,
      expectedRevision: 1,
    });
    expect(controls.revalidations).toEqual(["editor", "editor"]);
  });

  it("lists knowledge documents with bounded cursor pagination for viewers", async () => {
    const { engine, controls } = setup();

    const result = await engine.invoke(
      "knowledge_documents_list",
      { knowledgeBaseId, limit: 25 },
      { principal },
    );

    expect(result.documents).toEqual([expect.objectContaining({ id: documentId })]);
    expect(result.nextCursor).toEqual(expect.any(String));
    await engine.invoke(
      "knowledge_documents_list",
      { knowledgeBaseId, limit: 25, cursor: result.nextCursor },
      { principal },
    );
    expect(controls.listDocumentCalls).toEqual([
      { knowledgeBaseId, cursor: null, limit: 25 },
      {
        knowledgeBaseId,
        cursor: { ts: now, id: documentId },
        limit: 25,
      },
    ]);
    expect(controls.accessRequests.at(-1)).toMatchObject({ requiredRole: "viewer" });
  });

  it("gets the current or selected document revision with reconstructed content", async () => {
    const { engine, controls } = setup();

    const current = await engine.invoke(
      "knowledge_documents_get",
      { documentId },
      { principal },
    );
    const historical = await engine.invoke(
      "knowledge_documents_get",
      { documentId, revision: 1 },
      { principal },
    );

    expect(current).toMatchObject({
      document: { id: documentId },
      revision: { id: revisionId, version: 1 },
      content: "Use a modular monolith.",
      representation: "canonical",
      origin: {
        publisher: { namespace: "acme.engineering", displayName: "Acme Engineering" },
        packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60",
        packRevision: 3,
        itemKey: "architecture-notes",
        authors: [{ name: "Alex Rivera", uri: null }],
      },
    });
    expect(historical.content).toBe("Use a modular monolith.");
    expect(controls.getDocumentCalls).toEqual([
      { documentId, revision: null },
      { documentId, revision: 1 },
    ]);
    expect(controls.accessRequests.slice(-2)).toEqual([
      expect.objectContaining({ requiredRole: "viewer" }),
      expect.objectContaining({ requiredRole: "viewer" }),
    ]);
  });

  it("lists immutable document revisions with full content and bounded pagination", async () => {
    const { engine, controls } = setup();

    const result = await engine.invoke(
      "knowledge_document_revisions_list",
      { documentId, limit: 10 },
      { principal },
    );

    expect(result).toEqual({
      revisions: [expect.objectContaining({
        id: revisionId,
        version: 1,
        content: "Use a modular monolith.",
        representation: "reconstructed",
        origin: null,
      })],
      nextCursor: null,
    });
    expect(controls.listRevisionCalls).toEqual([
      { documentId, cursor: null, limit: 10 },
    ]);
    expect(controls.accessRequests.at(-1)).toMatchObject({ requiredRole: "viewer" });
  });

  it("rejects unbounded knowledge browsing inputs at the engine boundary", async () => {
    const { engine, controls } = setup();

    await expect(
      engine.invoke(
        "knowledge_documents_list",
        { knowledgeBaseId, limit: 101 },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "knowledge_document_revisions_list",
        { documentId, limit: 101 },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(controls.listDocumentCalls).toHaveLength(0);
    expect(controls.listRevisionCalls).toHaveLength(0);
  });

  it("rejects a revision precondition without a document and vice versa", async () => {
    const { engine } = setup();

    await expect(
      engine.invoke(
        "knowledge_document_revisions_create",
        {
          knowledgeBaseId,
          expectedRevision: 1,
          title: "Invalid",
          content: "Invalid",
          idempotencyKey: "invalid-1",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "knowledge_document_revisions_create",
        {
          knowledgeBaseId,
          documentId,
          title: "Invalid",
          content: "Invalid",
          idempotencyKey: "invalid-2",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("fails closed before writing when the active space does not match the provider", async () => {
    const { engine, controls } = setup();
    controls.setSpace(activeSpace({ recipeVersion: "different" }));

    await expect(
      engine.invoke(
        "knowledge_document_revisions_create",
        {
          knowledgeBaseId,
          title: "Backend",
          content: "Content",
          idempotencyKey: "doc-1",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
    expect(controls.embedCalls).toHaveLength(0);
    expect(controls.revisionCalls).toHaveLength(0);
  });

  it("answers only from score-qualified matches in the selected embedding space", async () => {
    const { engine, controls } = setup();
    controls.setMatches([
      {
        chunkId,
        documentId,
        revisionId,
        documentTitle: "Backend",
        content: "Use a modular monolith.",
        score: 0.91,
        spaceId,
        origin: packOrigin,
        knowledgeBaseId,
        knowledgeBaseName: "Architecture",
      },
      {
        chunkId: "00000000-0000-4000-8000-000000000009",
        documentId,
        revisionId,
        documentTitle: "Old",
        content: "Wrong space.",
        score: 1,
        spaceId: "00000000-0000-4000-8000-000000000010",
        knowledgeBaseId,
        knowledgeBaseName: "Architecture",
      },
      {
        chunkId: "00000000-0000-4000-8000-000000000011",
        documentId,
        revisionId,
        documentTitle: "Weak",
        content: "Too weak.",
        score: 0.1,
        spaceId,
        knowledgeBaseId,
        knowledgeBaseName: "Architecture",
      },
    ]);

    const result = await engine.invoke(
      "knowledge_ask",
      { knowledgeBaseId, question: "How should the backend be structured?" },
      { principal },
    );

    expect(result.citations.map(({ content }) => content)).toEqual([
      "Use a modular monolith.",
    ]);
    expect(result.citations[0]!.origin).toEqual({
      publisher: { namespace: "acme.engineering", displayName: "Acme Engineering" },
      packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60",
      packRevision: 3,
      packTitle: "Engineering Brain Pack",
      itemKey: "architecture-notes",
      authors: [{ name: "Alex Rivera", uri: null }],
    });
    expect(controls.searchCalls[0]!.embedding).toMatchObject({
      spaceId,
      vector: [1, 0, 0],
    });
    expect(controls.answerCalls[0]!.contexts).toHaveLength(1);
    expect(controls.revalidations).toEqual(["viewer", "viewer"]);
  });

  it("does not call the answer provider when retrieval has no grounded match", async () => {
    const { engine, controls } = setup();
    controls.setMatches([]);

    await expect(
      engine.invoke(
        "knowledge_ask",
        { knowledgeBaseId, question: "Unknown?" },
        { principal },
      ),
    ).resolves.toEqual({
      answer:
        "This knowledge base has no recorded information that answers this.",
      citations: [],
    });
    expect(controls.answerCalls).toHaveLength(0);
  });

  it("rejects malformed embedding vectors before a document write", async () => {
    const { engine, controls } = setup();
    controls.setVectors([[0, 0, 0]]);

    await expect(
      engine.invoke(
        "knowledge_document_revisions_create",
        {
          knowledgeBaseId,
          title: "Backend",
          content: "Content",
          idempotencyKey: "doc-1",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
    expect(controls.revisionCalls).toHaveLength(0);
  });
});
