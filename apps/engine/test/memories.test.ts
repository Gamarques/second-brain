import { createEngine } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import { createMemoryCapabilities } from "../src/capabilities/memories.js";
import { MEMORY_EMBEDDING_RECIPE_VERSION } from "../src/domain.js";
import type {
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
  ContentEmbedding,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
  Memory,
  MemoryStore,
  MemoryWriteInput,
} from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000004";
const personId = "00000000-0000-4000-8000-000000000005";
const memoryId = "00000000-0000-4000-8000-000000000006";
const lineageId = "00000000-0000-4000-8000-000000000007";
const replacementId = "00000000-0000-4000-8000-000000000008";
const spaceId = "00000000-0000-4000-8000-000000000009";
const principal = { id: accountId };

const activeSpace: EmbeddingSpace = {
  id: spaceId,
  entityType: "memory",
  provider: "fake",
  model: "fake-embedding-v1",
  modelRevision: "2026-08-01",
  recipeVersion: MEMORY_EMBEDDING_RECIPE_VERSION,
  dimensions: 3,
  metric: "cosine",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  promotedAt: "2026-08-01T00:00:01.000Z",
  retiredAt: null,
};

function actor(request: BrainAccessRequest): BrainAccessContext["actor"] {
  const clientId = request.principal.attributes?.clientId;
  const common = {
    accountId: request.principal.id,
    source: request.source,
    requestId: request.requestId,
    correlationId: null,
    causationId: null,
    dreamingRunId: null,
  } as const;
  if (request.source === "mcp_http" && typeof clientId === "string") {
    return { ...common, kind: "oauth_client", clientId };
  }
  return { ...common, kind: "account", clientId: null };
}

function makeMemory(
  input: MemoryWriteInput,
  overrides: Partial<Memory> = {},
): Memory {
  const isReplacement = input.supersedesId !== null;
  const timestamp = isReplacement
    ? "2026-08-16T10:00:01.000Z"
    : "2026-08-16T10:00:00.000Z";
  return {
    id: isReplacement ? replacementId : memoryId,
    lineageId,
    version: isReplacement ? 2 : 1,
    supersedesId: input.supersedesId,
    content: input.content,
    category: input.category,
    tags: input.tags,
    projectId: input.projectId,
    personIds: input.personIds,
    effectiveAt: input.effectiveAt,
    capturedAt: input.capturedAt,
    supersededBy: null,
    supersededAt: null,
    provenance: {
      kind: "account",
      accountId,
      clientId: null,
      source: "direct",
    },
    sourceExcerpt: input.sourceExcerpt,
    contentHash: input.embedding.contentHash,
    createdAt: timestamp,
    ...overrides,
  };
}

function createHarness(
  options: {
    readonly space?: EmbeddingSpace | null;
    readonly role?: "viewer" | "editor" | "admin" | "owner";
    readonly vector?: readonly number[];
  } = {},
) {
  const accessRequests: BrainAccessRequest[] = [];
  const role = options.role ?? "owner";
  const access: BrainAccessStore = {
    resolveAccess: vi.fn(async (request: BrainAccessRequest) => {
      accessRequests.push(request);
      return {
        accountId: request.principal.id,
        role,
        actor: actor(request),
      };
    }),
    revalidateAccess: vi.fn(async (value) => value),
    getTimeZone: vi.fn(async () => {
      throw new Error("Not used by memory capabilities.");
    }),
  };

  const writes: Array<{
    readonly input: MemoryWriteInput;
  }> = [];
  let currentMemory: Memory | null = null;
  const memories: MemoryStore = {
    writeMemoryVersion: vi.fn(async (resolvedAccess, input) => {
      writes.push({ input });
      const memory = makeMemory(input);
      currentMemory = memory;
      return {
        memory,
        created: true,
        supersededMemoryId: input.supersedesId,
        similarity: input.supersedesId === null ? null : 0.94,
      };
    }),
    getMemory: vi.fn(async (resolvedAccess, id) => {
      if (id !== memoryId) return null;
      return (
        currentMemory ??
        makeMemory({
          content: "The launch is approved.",
          category: "work",
          tags: ["launch"],
          projectId,
          personIds: [personId],
          effectiveAt: "2026-08-15T09:00:00.000Z",
          capturedAt: "2026-08-15T09:05:00.000Z",
          sourceExcerpt: null,
          supersedesId: null,
          expectedSupersededHash: null,
          expectedSupersededVersion: null,
          idempotencyKey: "seed",
          embedding: {
            spaceId,
            contentHash: "a".repeat(64),
            vector: [1, 0, 0],
          },
        })
      );
    }),
    searchMemories: vi.fn(async () => []),
    listMemories: vi.fn(async () => ({ items: [], nextCursor: null })),
    deleteMemory: vi.fn(async () => true),
  };

  const embeddingSpaces: EmbeddingSpaceStore = {
    getActiveSpace: vi.fn(async (resolvedAccess, entityType) => {
      if (entityType !== "memory") return null;
      const configured =
        options.space === undefined ? activeSpace : options.space;
      return configured === null
        ? null
        : { ...configured };
    }),
    createSpace: vi.fn(async () => {
      throw new Error("Not used by memory capabilities.");
    }),
    promoteSpace: vi.fn(async () => {
      throw new Error("Not used by memory capabilities.");
    }),
  };

  const embedded: Array<{
    readonly texts: readonly string[];
    readonly inputType: "search_document" | "search_query";
  }> = [];
  const embeddings: EmbeddingProvider = {
    provider: "fake",
    model: "fake-embedding-v1",
    modelRevision: "2026-08-01",
    dimensions: 3,
    embed: vi.fn(async (texts, _signal, inputType) => {
      embedded.push({ texts, inputType });
      return texts.map(() => options.vector ?? [1, 0, 0]);
    }),
  };

  const capabilities = createMemoryCapabilities(
    access,
    memories,
    embeddingSpaces,
    embeddings,
  );
  const engine = createEngine({ name: "test", version: "1.0.0", capabilities });
  return {
    accessRequests,
    capabilities,
    embedded,
    embeddingSpaces,
    engine,
    memories,
    setCurrentMemory(memory: Memory | null) {
      currentMemory = memory;
    },
    writes,
  };
}

function executionError(message: string) {
  return {
    code: "EXECUTION_FAILED",
    cause: expect.objectContaining({ message }),
  };
}

describe("memory capability contracts", () => {
  it("requires authentication and resolves explicit brain access with the correct roles", async () => {
    const { accessRequests, engine } = createHarness();

    await expect(
      engine.invoke(
        "memories_create",
        { content: "Memory", idempotencyKey: "create-1" },
        { principal: null },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    await engine.invoke(
      "memories_create",
      { content: "Memory", idempotencyKey: "create-2" },
      { principal },
    );
    await engine.invoke("memories_list", {}, { principal });
    await engine.invoke(
      "memories_delete",
      { id: memoryId, idempotencyKey: "delete-1" },
      { principal },
    );

    expect(accessRequests.map(({ requiredRole }) => requiredRole)).toEqual([
      "editor",
      "viewer",
      "admin",
    ]);
  });

  it("publishes honest annotations for idempotent writes and privacy deletion", () => {
    const { engine } = createHarness();

    expect(engine.describe("memories_create").annotations).toEqual({
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: true,
    });
    expect(engine.describe("memories_delete").annotations).toEqual({
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: false,
    });
    expect(engine.describe("memories_delete")).toMatchObject({
      title: "Delete a memory lineage",
      description: expect.stringContaining(
        "Independent ingestion source excerpts, dreaming evidence or reports, and handoff prose",
      ),
    });
  });
});

describe("memories_create", () => {
  it("writes effective and captured time with a tagged active-space embedding", async () => {
    const { embedded, engine, writes } = createHarness();

    const result = await engine.invoke(
      "memories_create",
      {
        content: "  PostgreSQL   is the storage layer.  ",
        category: "architecture",
        tags: ["database"],
        projectId,
        personIds: [personId],
        effectiveAt: "2026-08-15T09:00:00.000Z",
        capturedAt: "2026-08-15T09:05:00.000Z",
        idempotencyKey: "memory-create-1",
      },
      { principal },
    );

    expect(result).toMatchObject({
      content: "PostgreSQL   is the storage layer.",
      effectiveAt: "2026-08-15T09:00:00.000Z",
      capturedAt: "2026-08-15T09:05:00.000Z",
      created: true,
      deduplication: null,
    });
    expect(embedded).toEqual([
      {
        texts: ["postgresql is the storage layer."],
        inputType: "search_document",
      },
    ]);
    expect(writes[0]?.input).toMatchObject({
      idempotencyKey: "memory-create-1",
      supersedesId: null,
      expectedSupersededHash: null,
      expectedSupersededVersion: null,
      embedding: {
        spaceId,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        vector: [1, 0, 0],
      },
    });
  });

  it("defaults effectiveAt to a server timestamp and requires an idempotency key", async () => {
    const { engine, writes } = createHarness();

    await expect(
      engine.invoke("memories_create", { content: "Memory" } as never, {
        principal,
      }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });

    await engine.invoke(
      "memories_create",
      { content: "Memory", idempotencyKey: "memory-create-2" },
      { principal },
    );
    expect(writes[0]?.input.effectiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(writes[0]?.input.capturedAt).toBeNull();
  });

  it("never turns semantic similarity or opposite wording into implicit supersession", async () => {
    const { engine, writes } = createHarness();

    await engine.invoke(
      "memories_create",
      {
        content: "The launch is approved.",
        projectId,
        personIds: [personId],
        idempotencyKey: "approved",
      },
      { principal },
    );
    await engine.invoke(
      "memories_create",
      {
        content: "The launch is not approved.",
        projectId,
        personIds: [personId],
        idempotencyKey: "not-approved",
      },
      { principal },
    );
    await engine.invoke(
      "memories_create",
      {
        content: "The launch remains approved.",
        projectId: null,
        personIds: [],
        idempotencyKey: "other-context",
      },
      { principal },
    );

    expect(writes).toHaveLength(3);
    expect(writes.every(({ input }) => input.supersedesId === null)).toBe(true);
    expect(
      writes.every(({ input }) => input.expectedSupersededHash === null),
    ).toBe(true);
  });

  it("normalizes only exact content identity while preserving project and person scope", async () => {
    const { engine, writes } = createHarness();

    await engine.invoke(
      "memories_create",
      {
        content: "PostgreSQL   is durable.",
        projectId,
        personIds: [personId],
        idempotencyKey: "normalized-a",
      },
      { principal },
    );
    await engine.invoke(
      "memories_create",
      {
        content: "  postgresql is durable.  ",
        projectId: null,
        personIds: [],
        idempotencyKey: "normalized-b",
      },
      { principal },
    );

    expect(writes[0]?.input.embedding.contentHash).toBe(
      writes[1]?.input.embedding.contentHash,
    );
    expect(
      writes.map(({ input }) => [input.projectId, input.personIds]),
    ).toEqual([
      [projectId, [personId]],
      [null, []],
    ]);
    expect(writes.every(({ input }) => input.supersedesId === null)).toBe(true);
  });

  it("returns an exact normalized duplicate as a replay instead of claiming a semantic merge", async () => {
    const { engine, memories } = createHarness();
    vi.mocked(memories.writeMemoryVersion).mockImplementationOnce(
      async (_resolvedAccess, input) => ({
        memory: makeMemory(input),
        created: false,
        supersededMemoryId: null,
        similarity: null,
      }),
    );

    await expect(
      engine.invoke(
        "memories_create",
        {
          content: " postgres   is durable ",
          idempotencyKey: "exact-duplicate",
        },
        { principal },
      ),
    ).resolves.toMatchObject({ created: false, deduplication: null });
  });

  it.each([
    ["missing", null],
    ["wrong provider", { ...activeSpace, provider: "other" }],
    [
      "wrong model revision",
      { ...activeSpace, modelRevision: "mutable-alias" },
    ],
    ["wrong recipe", { ...activeSpace, recipeVersion: "legacy" }],
    ["wrong dimensions", { ...activeSpace, dimensions: 2 }],
  ])("fails closed for a %s active embedding space", async (_case, space) => {
    const { embedded, engine } = createHarness({ space });

    await expect(
      engine.invoke(
        "memories_create",
        { content: "Memory", idempotencyKey: "no-anonymous-vector" },
        { principal },
      ),
    ).rejects.toMatchObject(
      executionError(
        "The active memory embedding space does not match the provider.",
      ),
    );
    expect(embedded).toEqual([]);
  });

  it.each([
    ["wrong dimensions", [1, 0]],
    ["non-finite component", [1, Number.NaN, 0]],
    ["zero norm", [0, 0, 0]],
  ])("rejects a provider vector with %s", async (_case, vector) => {
    const { engine, memories } = createHarness({ vector });

    await expect(
      engine.invoke(
        "memories_create",
        { content: "Memory", idempotencyKey: "invalid-vector" },
        { principal },
      ),
    ).rejects.toMatchObject(
      executionError("The embedding provider returned an invalid vector."),
    );
    expect(memories.writeMemoryVersion).not.toHaveBeenCalled();
  });
});

describe("memories_update", () => {
  it("requires reviewed target hash and version preconditions", async () => {
    const { engine } = createHarness();

    await expect(
      engine.invoke(
        "memories_update",
        {
          id: memoryId,
          content: "Correction",
          idempotencyKey: "update-1",
        } as never,
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "memories_update",
        {
          id: memoryId,
          content: "Correction",
          expectedVersion: 1,
          expectedContentHash: "not-a-sha256",
          idempotencyKey: "update-2",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("creates a reviewed version and pins the exact target atomically", async () => {
    const { engine, writes } = createHarness();

    const result = await engine.invoke(
      "memories_update",
      {
        id: memoryId,
        content: "The launch is not approved.",
        expectedVersion: 1,
        expectedContentHash: "a".repeat(64),
        effectiveAt: "2026-08-16T10:00:00.000Z",
        idempotencyKey: "reviewed-correction",
      },
      { principal },
    );

    expect(result).toMatchObject({
      id: replacementId,
      supersedesId: memoryId,
      version: 2,
      content: "The launch is not approved.",
      created: true,
      deduplication: { supersededMemoryId: memoryId, similarity: 0.94 },
    });
    expect(writes[0]?.input).toMatchObject({
      category: "work",
      tags: ["launch"],
      projectId,
      personIds: [personId],
      supersedesId: memoryId,
      expectedSupersededHash: "a".repeat(64),
      expectedSupersededVersion: 1,
      idempotencyKey: "reviewed-correction",
    });
  });

  it("detaches a memory from its project only when projectId is explicitly null", async () => {
    const harness = createHarness();
    const { engine, writes } = harness;

    const omitted = await engine.invoke(
      "memories_update",
      {
        id: memoryId,
        category: "operations",
        expectedVersion: 1,
        expectedContentHash: "a".repeat(64),
        idempotencyKey: "memory-preserve-project",
      },
      { principal },
    );
    expect(omitted).toMatchObject({ projectId });

    const currentAfterPreserve = await harness.memories.getMemory(
      {
        accountId,
        role: "owner",
        actor: {
          kind: "account",
          accountId,
          clientId: null,
          source: "direct",
          requestId: "preserve-project",
          correlationId: null,
          causationId: null,
          dreamingRunId: null,
        },
      },
      memoryId,
      new AbortController().signal,
    );

    await engine.invoke(
      "memories_update",
      {
        id: memoryId,
        projectId: null,
        expectedVersion: currentAfterPreserve!.version,
        expectedContentHash: currentAfterPreserve!.contentHash,
        idempotencyKey: "memory-detach-project",
      },
      { principal },
    );

    expect(writes.map(({ input }) => input.projectId)).toEqual([
      projectId,
      null,
    ]);
  });

  it("defaults effectiveAt to a fresh server timestamp instead of the superseded version's", async () => {
    const { engine, writes } = createHarness();

    await engine.invoke(
      "memories_update",
      {
        id: memoryId,
        content: "The launch is not approved.",
        expectedVersion: 1,
        expectedContentHash: "a".repeat(64),
        idempotencyKey: "reviewed-correction-default-time",
      },
      { principal },
    );

    const effectiveAt = writes[0]?.input.effectiveAt;
    expect(effectiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(effectiveAt!).getTime()).toBeGreaterThan(
      new Date("2026-08-15T09:00:00.000Z").getTime(),
    );
  });

  it("rejects stale or already-superseded targets without embedding", async () => {
    const harness = createHarness();
    const current = await harness.memories.getMemory(
      {
        accountId,
        role: "owner",
        actor: {
          kind: "account",
          accountId,
          clientId: null,
          source: "direct",
          requestId: "seed",
          correlationId: null,
          causationId: null,
          dreamingRunId: null,
        },
      },
      memoryId,
      new AbortController().signal,
    );
    harness.setCurrentMemory({
      ...current!,
      supersededBy: replacementId,
      supersededAt: "2026-08-16T10:00:01.000Z",
    });

    await expect(
      harness.engine.invoke(
        "memories_update",
        {
          id: memoryId,
          content: "Stale",
          expectedVersion: 1,
          expectedContentHash: "a".repeat(64),
          idempotencyKey: "stale",
        },
        { principal },
      ),
    ).rejects.toMatchObject(executionError("Current memory was not found."));

    await expect(
      harness.engine.invoke(
        "memories_update",
        {
          id: memoryId,
          content: "Foreign",
          expectedVersion: 1,
          expectedContentHash: "a".repeat(64),
          idempotencyKey: "foreign",
        },
        { principal },
      ),
    ).rejects.toMatchObject(executionError("Current memory was not found."));
    expect(harness.embedded).toEqual([]);
  });
});

describe("memory reads and deletion", () => {
  it("passes temporal, person, project, and threshold filters to semantic search", async () => {
    const { engine, memories } = createHarness();
    const matchMemory = makeMemory({
      content: "Use PostgreSQL.",
      category: "architecture",
      tags: ["database"],
      projectId,
      personIds: [personId],
      effectiveAt: "2026-08-10T00:00:00.000Z",
      capturedAt: null,
      sourceExcerpt: null,
      supersedesId: null,
      expectedSupersededHash: null,
      expectedSupersededVersion: null,
      idempotencyKey: "seed",
      embedding: { spaceId, contentHash: "b".repeat(64), vector: [1, 0, 0] },
    });
    vi.mocked(memories.searchMemories).mockResolvedValueOnce([
      { memory: matchMemory, score: 0.91, spaceId },
    ]);

    const result = await engine.invoke(
      "memories_search",
      {
        query: "database choice",
        minimumScore: 0.8,
        category: "architecture",
        tags: ["database"],
        projectId,
        personId,
        createdAfter: "2026-08-01T00:00:00.000Z",
        createdBefore: "2026-08-16T00:00:00.000Z",
        asOf: "2026-08-15T00:00:00.000Z",
        includeSuperseded: true,
      },
      { principal },
    );

    expect(result.matches).toEqual([{ ...matchMemory, score: 0.91, spaceId }]);
    expect(memories.searchMemories).toHaveBeenCalledWith(
      expect.objectContaining({ accountId }),
      expect.objectContaining({
        embedding: expect.objectContaining({ spaceId, vector: [1, 0, 0] }),
        minimumScore: 0.8,
        personId,
        projectId,
        asOf: "2026-08-15T00:00:00.000Z",
      }),
      expect.any(AbortSignal),
    );
  });

  it("lists as-of history with opaque cursor translation", async () => {
    const { engine, memories } = createHarness();
    const nextCursor = { ts: "2026-08-10T00:00:00.000Z", id: memoryId };
    vi.mocked(memories.listMemories).mockResolvedValueOnce({
      items: [],
      nextCursor,
    });

    const first = await engine.invoke(
      "memories_list",
      { asOf: "2026-08-15T00:00:00.000Z", personId, projectId },
      { principal },
    );
    expect(first.nextCursor).toEqual(expect.any(String));

    await engine.invoke(
      "memories_list",
      { cursor: first.nextCursor, includeSuperseded: true },
      { principal },
    );
    expect(memories.listMemories).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountId }),
      expect.objectContaining({ cursor: nextCursor, includeSuperseded: true }),
      expect.any(AbortSignal),
    );
  });

  it("rejects inverted date ranges before querying the store", async () => {
    const { engine, memories } = createHarness();

    await expect(
      engine.invoke(
        "memories_search",
        {
          query: "memory",
          createdAfter: "2026-08-16T00:00:00.000Z",
          createdBefore: "2026-08-15T00:00:00.000Z",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(memories.searchMemories).not.toHaveBeenCalled();
  });

  it("deletes through the brain-scoped store with an idempotency key", async () => {
    const { engine, memories } = createHarness();

    await expect(
      engine.invoke(
        "memories_delete",
        { id: memoryId, idempotencyKey: "privacy-delete-1" },
        { principal },
      ),
    ).resolves.toEqual({ deleted: true });
    expect(memories.deleteMemory).toHaveBeenCalledWith(
      expect.objectContaining({ accountId }),
      memoryId,
      { idempotencyKey: "privacy-delete-1" },
      expect.any(AbortSignal),
    );
  });

  it("reports a missing lineage without claiming independent-source erasure", async () => {
    const { engine, memories } = createHarness();
    vi.mocked(memories.deleteMemory).mockResolvedValueOnce(false);

    await expect(
      engine.invoke(
        "memories_delete",
        { id: memoryId, idempotencyKey: "missing-lineage" },
        { principal },
      ),
    ).rejects.toMatchObject(executionError("Memory lineage was not found."));
  });
});
