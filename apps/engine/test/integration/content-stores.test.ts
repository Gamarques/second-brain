import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  decisionEmbeddingRecipe,
  memoryEmbeddingRecipe,
} from "../../src/domain.js";
import type {
  BrainAccessContext,
  ContentEmbedding,
  DecisionWriteInput,
  MemoryWriteInput,
} from "../../src/domain.js";
import { runMigrations } from "../../src/database/migrate.js";
import { schema } from "../../src/database/schema/index.js";
import { accounts } from "../../src/database/schema/identity.js";
import { adminAuditEvents } from "../../src/database/schema/admin.js";
import { DrizzleDecisionStore } from "../../src/database/stores/decision-store.js";
import {
  ActiveEmbeddingSpaceMismatchError,
  DrizzleEmbeddingSpaceStore,
  assertActiveEmbeddingSpacesMatchProvider,
  provisionInitialEmbeddingSpacesInTransaction,
} from "../../src/database/stores/embedding-space-store.js";
import {
  DrizzleMemoryStore,
  MutationReceiptConflictError,
} from "../../src/database/stores/memory-store.js";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

const fingerprint = {
  provider: "integration-provider",
  model: "integration-embedding-model",
  modelRevision: "2026-08-16",
  dimensions: 1_536,
} as const;

const vector = [1, ...Array<number>(1_535).fill(0)] as const;

function access(
  accountId: string,
  role = "owner" as const,
): BrainAccessContext {
  return {
    accountId,
    role,
    actor: {
      kind: "account",
      accountId,
      clientId: null,
      source: "direct",
      requestId: randomUUID(),
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
}

function memoryInput(
  spaceId: string,
  content: string,
  idempotencyKey: string,
  overrides: Partial<MemoryWriteInput> = {},
): MemoryWriteInput {
  const recipe = memoryEmbeddingRecipe(content);
  return {
    content,
    category: "product",
    tags: ["architecture"],
    projectId: null,
    personIds: [],
    effectiveAt: "2026-08-01T12:00:00.000Z",
    capturedAt: null,
    sourceExcerpt: null,
    idempotencyKey,
    embedding: { spaceId, contentHash: recipe.contentHash, vector },
    supersedesId: null,
    expectedSupersededHash: null,
    expectedSupersededVersion: null,
    ...overrides,
  } as MemoryWriteInput;
}

function decisionInput(
  spaceId: string,
  statement: string,
  idempotencyKey: string,
  overrides: Partial<DecisionWriteInput> = {},
): DecisionWriteInput {
  const base = {
    statement,
    rationale: "A relational model preserves the decision context.",
    rejectedAlternatives: [
      { option: "MongoDB", reason: "We need relational integrity." },
    ],
  } as const;
  const recipe = decisionEmbeddingRecipe(base);
  return {
    ...base,
    projectId: null,
    personIds: [],
    decidedAt: "2026-08-01T12:00:00.000Z",
    sourceExcerpt: null,
    idempotencyKey,
    embedding: { spaceId, contentHash: recipe.contentHash, vector },
    supersedesId: null,
    expectedSupersededHash: null,
    expectedSupersededVersion: null,
    ...overrides,
  } as DecisionWriteInput;
}

describe("Drizzle memory, decision, and embedding space stores", () => {
  let database: DisposableTestDatabase;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let accountId: string;
  let ownerAccess: BrainAccessContext;
  let memorySpaceId: string;
  let decisionSpaceId: string;

  beforeAll(async () => {
    database = await provisionTestDatabase("content_stores");
    await runMigrations(database.pool);
    db = drizzle(database.pool, { schema });
    accountId = randomUUID();
    await db.insert(accounts).values({
      id: accountId,
      email: `stores-${accountId}@example.com`,
      passwordHash: "not-used-in-store-integration-tests",
      role: "owner",
    });
    const spaces = await db.transaction((transaction) =>
      provisionInitialEmbeddingSpacesInTransaction(
        transaction,
        fingerprint,
        AbortSignal.timeout(10_000),
      ),
    );
    memorySpaceId = spaces.find((space) => space.entityType === "memory")!.id;
    decisionSpaceId = spaces.find(
      (space) => space.entityType === "decision",
    )!.id;
    ownerAccess = access(accountId);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it("provisions the three domain spaces exactly once and validates the provider", async () => {
    const replay = await db.transaction((transaction) =>
      provisionInitialEmbeddingSpacesInTransaction(
        transaction,
        fingerprint,
        AbortSignal.timeout(10_000),
      ),
    );
    expect(replay.map((space) => space.entityType)).toEqual([
      "memory",
      "decision",
      "knowledge_chunk",
    ]);
    await expect(
      assertActiveEmbeddingSpacesMatchProvider(
        db,
        fingerprint,
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertActiveEmbeddingSpacesMatchProvider(
        db,
        { ...fingerprint, modelRevision: "different" },
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toBeInstanceOf(ActiveEmbeddingSpaceMismatchError);
  });

  it("replays an exact memory write and rejects idempotency-key payload drift", async () => {
    const store = new DrizzleMemoryStore(db);
    const input = memoryInput(
      memorySpaceId,
      "  We   chose PostgreSQL  ",
      `memory-create-${randomUUID()}`,
    );
    const created = await store.writeMemoryVersion(
      ownerAccess,
      input,
      AbortSignal.timeout(10_000),
    );
    expect(created?.created).toBe(true);
    expect(created?.memory.contentHash).toBe(
      memoryEmbeddingRecipe(input.content).contentHash,
    );

    const replay = await store.writeMemoryVersion(
      ownerAccess,
      input,
      AbortSignal.timeout(10_000),
    );
    expect(replay?.created).toBe(false);
    expect(replay?.memory.id).toBe(created?.memory.id);

    await expect(
      store.writeMemoryVersion(
        ownerAccess,
        { ...input, content: "A different fact" },
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toBeInstanceOf(MutationReceiptConflictError);
  });

  it("atomically audits browser-admin memory create, update, and delete", async () => {
    const store = new DrizzleMemoryStore(db);
    const adminAccess = (requestId: string): BrainAccessContext => ({
      ...access(accountId),
      administrativeChannel: true,
      actor: { ...access(accountId).actor, requestId },
    });
    const createRequestId = `admin-memory-create-${randomUUID()}`;
    const created = await store.writeMemoryVersion(
      adminAccess(createRequestId),
      memoryInput(
        memorySpaceId,
        "Sensitive memory text must not enter the administrative audit log.",
        `admin-memory-create-key-${randomUUID()}`,
      ),
      AbortSignal.timeout(10_000),
    );
    expect(created).not.toBeNull();

    const updateRequestId = `admin-memory-update-${randomUUID()}`;
    const updated = await store.writeMemoryVersion(
      adminAccess(updateRequestId),
      memoryInput(
        memorySpaceId,
        "Updated sensitive memory text.",
        `admin-memory-update-key-${randomUUID()}`,
        {
          effectiveAt: "2026-08-02T12:00:00.000Z",
          supersedesId: created!.memory.id,
          expectedSupersededHash: created!.memory.contentHash,
          expectedSupersededVersion: created!.memory.version,
        },
      ),
      AbortSignal.timeout(10_000),
    );
    expect(updated).not.toBeNull();

    const deleteRequestId = `admin-memory-delete-${randomUUID()}`;
    await expect(
      store.deleteMemory(
        adminAccess(deleteRequestId),
        updated!.memory.id,
        { idempotencyKey: `admin-memory-delete-key-${randomUUID()}` },
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBe(true);

    const rows = await db
      .select({
        action: adminAuditEvents.action,
        targetId: adminAuditEvents.targetId,
        metadata: adminAuditEvents.metadata,
      })
      .from(adminAuditEvents)
      .where(eq(adminAuditEvents.category, "domain"));
    expect(rows).toEqual(
      expect.arrayContaining([
        { action: "memory.created", targetId: created!.memory.id, metadata: {} },
        { action: "memory.updated", targetId: updated!.memory.id, metadata: {} },
        { action: "memory.deleted", targetId: updated!.memory.id, metadata: {} },
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain("Sensitive memory text");
    expect(JSON.stringify(rows)).not.toContain("Updated sensitive memory text");
  });

  it("serializes exact memory supersession and rejects an older effective backfill", async () => {
    const store = new DrizzleMemoryStore(db);
    const root = await store.writeMemoryVersion(
      ownerAccess,
      memoryInput(
        memorySpaceId,
        "The launch is the first priority.",
        `memory-root-${randomUUID()}`,
      ),
      AbortSignal.timeout(10_000),
    );
    expect(root).not.toBeNull();
    const updateContent = "The launch remains the first priority.";
    const update = await store.writeMemoryVersion(
      ownerAccess,
      memoryInput(
        memorySpaceId,
        updateContent,
        `memory-update-${randomUUID()}`,
        {
          effectiveAt: "2026-08-02T12:00:00.000Z",
          supersedesId: root!.memory.id,
          expectedSupersededHash: root!.memory.contentHash,
          expectedSupersededVersion: root!.memory.version,
        },
      ),
      AbortSignal.timeout(10_000),
    );
    expect(update?.memory.version).toBe(2);
    expect(update?.memory.lineageId).toBe(root?.memory.lineageId);

    const stale = await store.writeMemoryVersion(
      ownerAccess,
      memoryInput(
        memorySpaceId,
        "Backfilled older wording.",
        `memory-stale-${randomUUID()}`,
        {
          effectiveAt: "2026-07-31T12:00:00.000Z",
          supersedesId: update!.memory.id,
          expectedSupersededHash: update!.memory.contentHash,
          expectedSupersededVersion: update!.memory.version,
        },
      ),
      AbortSignal.timeout(10_000),
    );
    expect(stale).toBeNull();

    const historical = await store.listMemories(
      ownerAccess,
      {
        category: null,
        tags: [],
        projectId: null,
        personId: null,
        createdAfter: null,
        createdBefore: null,
        asOf: "2026-08-01T18:00:00.000Z",
        includeSuperseded: false,
        cursor: null,
        limit: 100,
      },
      AbortSignal.timeout(10_000),
    );
    expect(
      historical.items.some((memory) => memory.id === root!.memory.id),
    ).toBe(true);
    expect(
      historical.items.some((memory) => memory.id === update!.memory.id),
    ).toBe(false);
  });

  it("rejects cross-space search and deletes a complete memory lineage idempotently", async () => {
    const memoryStore = new DrizzleMemoryStore(db);
    const embeddingStore = new DrizzleEmbeddingSpaceStore(db);
    const root = await memoryStore.writeMemoryVersion(
      ownerAccess,
      memoryInput(
        memorySpaceId,
        "Delete this private lineage.",
        `memory-delete-root-${randomUUID()}`,
      ),
      AbortSignal.timeout(10_000),
    );
    const next = await memoryStore.writeMemoryVersion(
      ownerAccess,
      memoryInput(
        memorySpaceId,
        "Delete the updated private lineage.",
        `memory-delete-next-${randomUUID()}`,
        {
          effectiveAt: "2026-08-03T12:00:00.000Z",
          supersedesId: root!.memory.id,
          expectedSupersededHash: root!.memory.contentHash,
          expectedSupersededVersion: root!.memory.version,
        },
      ),
      AbortSignal.timeout(10_000),
    );
    const replacement = await embeddingStore.createSpace(
      ownerAccess,
      {
        entityType: "memory",
        ...fingerprint,
        modelRevision: "replacement",
        recipeVersion: "memory-v1",
        metric: "cosine",
      },
      AbortSignal.timeout(10_000),
    );
    await embeddingStore.promoteSpace(
      ownerAccess,
      replacement.id,
      {
        expectedStatus: "preparing",
        idempotencyKey: `promote-${randomUUID()}`,
      },
      AbortSignal.timeout(10_000),
    );
    const staleQuery: ContentEmbedding = {
      spaceId: memorySpaceId,
      contentHash: memoryEmbeddingRecipe("query").contentHash,
      vector,
    };
    await expect(
      memoryStore.searchMemories(
        ownerAccess,
        {
          embedding: staleQuery,
          limit: 10,
          minimumScore: -1,
          category: null,
          tags: [],
          projectId: null,
          personId: null,
          createdAfter: null,
          createdBefore: null,
          asOf: null,
          includeSuperseded: false,
        },
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toThrow("not active");

    const key = `delete-${randomUUID()}`;
    await expect(
      memoryStore.deleteMemory(
        ownerAccess,
        next!.memory.id,
        { idempotencyKey: key },
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBe(true);
    await expect(
      memoryStore.deleteMemory(
        ownerAccess,
        next!.memory.id,
        { idempotencyKey: key },
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBe(true);
    await expect(
      memoryStore.getMemory(
        ownerAccess,
        root!.memory.id,
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBeNull();
    await expect(
      memoryStore.getMemory(
        ownerAccess,
        next!.memory.id,
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBeNull();
  });

  it("reconstructs decision valid time and replays revocation", async () => {
    const store = new DrizzleDecisionStore(db);
    const root = await store.createDecision(
      ownerAccess,
      decisionInput(
        decisionSpaceId,
        "Use PostgreSQL.",
        `decision-root-${randomUUID()}`,
      ),
      AbortSignal.timeout(10_000),
    );
    expect(root).not.toBeNull();
    const nextInputBase = decisionInput(
      decisionSpaceId,
      "Use PostgreSQL with row-level tenancy.",
      `decision-next-${randomUUID()}`,
      {
        decidedAt: "2026-08-10T12:00:00.000Z",
        supersedesId: root!.id,
        expectedSupersededHash: root!.contentHash,
        expectedSupersededVersion: root!.version,
      },
    );
    const nextRecipe = decisionEmbeddingRecipe({
      statement: nextInputBase.statement,
      rationale: nextInputBase.rationale,
      rejectedAlternatives: nextInputBase.rejectedAlternatives,
    });
    const next = await store.createDecision(
      ownerAccess,
      {
        ...nextInputBase,
        embedding: {
          spaceId: decisionSpaceId,
          contentHash: nextRecipe.contentHash,
          vector,
        },
      },
      AbortSignal.timeout(10_000),
    );
    expect(next?.version).toBe(2);

    const historical = await store.listDecisions(
      ownerAccess,
      {
        status: null,
        projectId: null,
        personId: null,
        asOf: "2026-08-05T12:00:00.000Z",
        includeSuperseded: false,
        cursor: null,
        limit: 100,
      },
      AbortSignal.timeout(10_000),
    );
    expect(historical.items.some((decision) => decision.id === root!.id)).toBe(
      true,
    );
    expect(historical.items.some((decision) => decision.id === next!.id)).toBe(
      false,
    );

    const revokeKey = `decision-revoke-${randomUUID()}`;
    const revoked = await store.revokeDecision(
      ownerAccess,
      next!.id,
      { expectedVersion: next!.version, idempotencyKey: revokeKey },
      AbortSignal.timeout(10_000),
    );
    expect(revoked?.status).toBe("revoked");
    const replay = await store.revokeDecision(
      ownerAccess,
      next!.id,
      { expectedVersion: next!.version, idempotencyKey: revokeKey },
      AbortSignal.timeout(10_000),
    );
    expect(replay?.id).toBe(next?.id);
    expect(replay?.status).toBe("revoked");
  });
});
