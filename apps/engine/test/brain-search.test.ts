import { createEngine } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { createBrainSearchCapabilities } from "../src/capabilities/brain-search.js";
import {
  KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  MEMORY_EMBEDDING_RECIPE_VERSION,
} from "../src/domain.js";
import type {
  BrainAccessContext,
  BrainAccessStore,
  BrainSearchResult,
  BrainSearchStore,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
} from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const knowledgeBaseId = "00000000-0000-4000-8000-000000000004";
const personId = "00000000-0000-4000-8000-000000000005";
const chunkId = "00000000-0000-4000-8000-000000000006";
const memorySpaceId = "00000000-0000-4000-8000-000000000007";
const knowledgeSpaceId = "00000000-0000-4000-8000-000000000008";
const principal = { id: accountId };
const now = "2026-08-16T12:00:00.000Z";

function accessFor(requestId: string): BrainAccessContext {
  return {
    accountId,
    role: "owner",
    actor: {
      kind: "account",
      accountId,
      clientId: null,
      source: "direct",
      requestId,
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
}

function space(
  entityType: "memory" | "knowledge_chunk",
  idValue: string,
): EmbeddingSpace {
  return {
    id: idValue,
    entityType,
    provider: "fake",
    model: "embed-v1",
    modelRevision: "2026-08-01",
    recipeVersion:
      entityType === "memory"
        ? MEMORY_EMBEDDING_RECIPE_VERSION
        : KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
    dimensions: 3,
    metric: "cosine",
    status: "active",
    createdAt: now,
    promotedAt: now,
    retiredAt: null,
  };
}

function setup() {
  const accessRequests: Parameters<BrainAccessStore["resolveAccess"]>[0][] = [];
  const revalidations: string[] = [];
  const searchCalls: Parameters<BrainSearchStore["search"]>[1][] = [];
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
      return "UTC";
    },
  };
  const spaces: EmbeddingSpaceStore = {
    async getActiveSpace(_access, entityType) {
      if (entityType === "memory") return space("memory", memorySpaceId);
      if (entityType === "knowledge_chunk") {
        return space("knowledge_chunk", knowledgeSpaceId);
      }
      return null;
    },
    async createSpace() {
      throw new Error("not used");
    },
    async promoteSpace() {
      throw new Error("not used");
    },
  };
  const embeddings: EmbeddingProvider = {
    provider: "fake",
    model: "embed-v1",
    modelRevision: "2026-08-01",
    dimensions: 3,
    async embed(texts) {
      return texts.map(() => [1, 0, 0]);
    },
  };
  const stored: BrainSearchResult = {
    query: "quem é Jane Doe",
    routing: {
      intent: "general",
      subject: "quem é Jane Doe",
      guidance: "placeholder",
    },
    hits: [
      {
        sourceType: "knowledge_chunk",
        id: chunkId,
        title: "Faculty",
        excerpt: "Jane Doe is a faculty member at Example Academy.",
        score: 0.94,
        knowledgeBaseId,
        knowledgeBaseName: "Example Academy",
        projectId: null,
        personIds: [personId],
        tags: ["faculty"],
      },
    ],
    people: [
      {
        id: personId,
        name: "Jane Doe",
        aliases: ["Lana"],
        summary: "Faculty member at Example Academy.",
        tags: ["faculty"],
        relatedProjects: [],
        relatedKnowledgeBases: [
          {
            id: knowledgeBaseId,
            name: "Example Academy",
            description: "Team, courses, and academy operating context.",
          },
        ],
      },
    ],
    knowledgeBases: [
      {
        id: knowledgeBaseId,
        name: "Example Academy",
        description: "Team, courses, and academy operating context.",
      },
    ],
    suggestedKnowledgeBases: [
      {
        id: knowledgeBaseId,
        name: "Example Academy",
        description: "Team, courses, and academy operating context.",
        reason: "Document hit names this person.",
      },
    ],
  };
  const searchStore: BrainSearchStore = {
    async search(_access, input) {
      searchCalls.push(input);
      return stored;
    },
  };
  const capabilities = createBrainSearchCapabilities(
    accessStore,
    searchStore,
    spaces,
    embeddings,
  );
  return {
    engine: createEngine({
      name: "brain-search-test",
      version: "1.0.0",
      capabilities,
    }),
    controls: { accessRequests, revalidations, searchCalls },
  };
}

describe("brain_search", () => {
  it("routes a who-is query across knowledge bases and people in one call", async () => {
    const { engine, controls } = setup();

    const result = await engine.invoke(
      "brain_search",
      { query: "quem é Jane Doe" },
      { principal },
    );

    expect(result.routing).toEqual({
      intent: "lookup_person",
      subject: "Jane Doe",
      guidance: expect.stringMatching(/knowledge base/i),
    });
    expect(result.hits[0]).toMatchObject({
      sourceType: "knowledge_chunk",
      knowledgeBaseName: "Example Academy",
    });
    expect(result.people[0]?.name).toBe("Jane Doe");
    expect(result.knowledgeBases).toEqual([
      {
        id: knowledgeBaseId,
        name: "Example Academy",
        description: "Team, courses, and academy operating context.",
      },
    ]);
    expect(result.suggestedKnowledgeBases[0]?.name).toBe("Example Academy");
    expect(controls.accessRequests[0]?.requiredRole).toBe("viewer");
    expect(controls.searchCalls[0]).toMatchObject({
      intent: "lookup_person",
      subject: "Jane Doe",
      projectId: null,
      limit: 20,
    });
    expect(controls.searchCalls[0]?.embeddings.knowledge).not.toBeNull();
  });

  it("advertises unified search and the knowledge-base catalog in discovery", () => {
    const { engine } = setup();
    const listed = engine.list().find((capability) => capability.id === "brain_search");
    const described = engine.describe("brain_search");

    expect(listed?.description).toMatch(/knowledge bases/i);
    expect(listed?.description).toMatch(/who\/what/i);
    expect(listed?.description).toMatch(/catalog/i);
    expect(described.inputSchema).not.toEqual(
      expect.objectContaining({ properties: expect.objectContaining({ brainId: {} }) }),
    );
    expect(JSON.stringify(described.outputSchema)).toContain("knowledgeBases");
    expect(JSON.stringify(described.outputSchema)).toContain("suggestedKnowledgeBases");
  });

  it("rejects empty queries and unauthenticated callers", async () => {
    const { engine } = setup();
    await expect(
      engine.invoke("brain_search", { query: "   " }, { principal }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke("brain_search", { query: "Jane" }, { principal: null }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
