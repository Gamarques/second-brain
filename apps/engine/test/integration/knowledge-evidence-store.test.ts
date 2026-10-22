import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleBrainEvidenceStore } from "../../src/database/stores/evidence-store.js";
import { DrizzleBrainSearchStore } from "../../src/database/stores/search-store.js";
import { DrizzlePersonStore } from "../../src/database/stores/person-store.js";
import { DrizzleEmbeddingSpaceStore } from "../../src/database/stores/embedding-space-store.js";
import {
  DrizzleKnowledgeStore,
  KnowledgeStoreConflictError,
} from "../../src/database/stores/knowledge-store.js";
import { runMigrations } from "../../src/database/migrate.js";
import * as schema from "../../src/database/schema/index.js";
import {
  DECISION_EMBEDDING_RECIPE_VERSION,
  KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  MEMORY_EMBEDDING_RECIPE_VERSION,
  decisionEmbeddingRecipe,
  knowledgeChunkEmbeddingRecipe,
  memoryEmbeddingRecipe,
  type BrainAccessContext,
} from "../../src/domain.js";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

const accountId = "10000000-0000-4000-8000-000000000001";
const memorySpaceId = "10000000-0000-4000-8000-000000000003";
const decisionSpaceId = "10000000-0000-4000-8000-000000000004";
const knowledgeSpaceId = "10000000-0000-4000-8000-000000000005";
const nextKnowledgeSpaceId = "10000000-0000-4000-8000-000000000015";
const listId = "10000000-0000-4000-8000-000000000006";
const taskId = "10000000-0000-4000-8000-000000000007";
const reminderId = "10000000-0000-4000-8000-000000000008";
const goalId = "10000000-0000-4000-8000-000000000009";
const decisionId = "10000000-0000-4000-8000-000000000010";
const memoryId = "10000000-0000-4000-8000-000000000011";
const planId = "10000000-0000-4000-8000-000000000012";
const planVersionId = "10000000-0000-4000-8000-000000000013";
const activityId = "10000000-0000-4000-8000-000000000014";
const before = new Date("2026-08-15T10:00:00.000Z");
const cutoff = "2026-08-15T12:00:00.000Z";
const after = new Date("2026-08-16T10:00:00.000Z");

const access: BrainAccessContext = {
  accountId,
  role: "owner",
  actor: {
    kind: "account",
    accountId,
    clientId: null,
    source: "direct",
    requestId: "integration-request",
    correlationId: null,
    causationId: null,
    dreamingRunId: null,
  },
};

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function vector(first: number): number[] {
  return [
    first,
    Math.sqrt(Math.max(0, 1 - first ** 2)),
    ...Array<number>(1_534).fill(0),
  ];
}

async function waitUntil(
  check: () => Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

const actor = {
  actorKind: "account" as const,
  actorAccountId: accountId,
  actorClientId: null,
  actorSource: "direct" as const,
};

describe("Drizzle knowledge and evidence stores", () => {
  let database: DisposableTestDatabase;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let knowledge: DrizzleKnowledgeStore;
  let evidence: DrizzleBrainEvidenceStore;

  beforeAll(async () => {
    database = await provisionTestDatabase("knowledge_evidence");
    await runMigrations(database.pool);
    db = drizzle(database.pool, { schema });
    knowledge = new DrizzleKnowledgeStore(db);
    evidence = new DrizzleBrainEvidenceStore(db);

    await db.insert(schema.accounts).values({
      id: accountId,
      email: "knowledge-evidence@example.com",
      passwordHash: "not-used-by-this-test",
      role: "owner",
      createdAt: before,
      updatedAt: before,
    });
    await db.insert(schema.embeddingSpaces).values([
      {
        id: memorySpaceId,
        entityType: "memory",
        provider: "test",
        model: "embedding",
        modelRevision: "1",
        recipeVersion: MEMORY_EMBEDDING_RECIPE_VERSION,
        dimensions: 1_536,
        metric: "cosine",
        status: "active",
        promotedAt: before,
        createdAt: before,
      },
      {
        id: decisionSpaceId,
        entityType: "decision",
        provider: "test",
        model: "embedding",
        modelRevision: "1",
        recipeVersion: DECISION_EMBEDDING_RECIPE_VERSION,
        dimensions: 1_536,
        metric: "cosine",
        status: "active",
        promotedAt: before,
        createdAt: before,
      },
      {
        id: knowledgeSpaceId,
        entityType: "knowledge_chunk",
        provider: "test",
        model: "embedding",
        modelRevision: "1",
        recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
        dimensions: 1_536,
        metric: "cosine",
        status: "active",
        promotedAt: before,
        createdAt: before,
      },
      {
        id: nextKnowledgeSpaceId,
        entityType: "knowledge_chunk",
        provider: "test",
        model: "embedding",
        modelRevision: "2",
        recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
        dimensions: 1_536,
        metric: "cosine",
        status: "preparing",
        createdAt: before,
      },
    ]);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it("commits immutable document revisions atomically and searches only the current revision", async () => {
    const base = await knowledge.createKnowledgeBase(
      access,
      {
        name: "Architecture",
        description: null,
        idempotencyKey: "base-architecture",
      },
      new AbortController().signal,
    );
    const sameBase = await knowledge.createKnowledgeBase(
      access,
      {
        name: "Architecture",
        description: null,
        idempotencyKey: "base-architecture",
      },
      new AbortController().signal,
    );
    expect(sameBase.id).toBe(base.id);
    await expect(
      knowledge.createKnowledgeBase(
        access,
        {
          name: "Different payload",
          description: null,
          idempotencyKey: "base-architecture",
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(KnowledgeStoreConflictError);

    const firstContent = "Use a modular monolith.";
    const first = await knowledge.createDocumentRevision(
      access,
      {
        knowledgeBaseId: base.id,
        documentId: null,
        expectedRevision: null,
        title: "Backend",
        sourceUri: null,
        contentHash: hash(firstContent),
        chunks: [
          {
            content: firstContent,
            position: 0,
            embedding: {
              spaceId: knowledgeSpaceId,
              contentHash:
                knowledgeChunkEmbeddingRecipe(firstContent).contentHash,
              vector: vector(1),
            },
          },
        ],
        tags: [],
        projectId: null,
        personIds: [],
        idempotencyKey: "backend-revision-1",
      },
      new AbortController().signal,
    );
    expect(first?.revision.version).toBe(1);
    const firstReplay = await knowledge.createDocumentRevision(
      access,
      {
        knowledgeBaseId: base.id,
        documentId: null,
        expectedRevision: null,
        title: "Backend",
        sourceUri: null,
        contentHash: hash(firstContent),
        chunks: [
          {
            content: firstContent,
            position: 0,
            embedding: {
              spaceId: knowledgeSpaceId,
              contentHash:
                knowledgeChunkEmbeddingRecipe(firstContent).contentHash,
              vector: vector(1),
            },
          },
        ],
        tags: [],
        projectId: null,
        personIds: [],
        idempotencyKey: "backend-revision-1",
      },
      new AbortController().signal,
    );
    expect(firstReplay?.revision.id).toBe(first?.revision.id);

    const secondContent = "Use a modular monolith with PostgreSQL.";
    const second = await knowledge.createDocumentRevision(
      access,
      {
        knowledgeBaseId: base.id,
        documentId: first!.document.id,
        expectedRevision: 1,
        title: "Backend architecture",
        sourceUri: "https://example.com/backend",
        contentHash: hash(secondContent),
        chunks: [
          {
            content: secondContent,
            position: 0,
            embedding: {
              spaceId: knowledgeSpaceId,
              contentHash:
                knowledgeChunkEmbeddingRecipe(secondContent).contentHash,
              vector: vector(0.8),
            },
          },
        ],
        tags: [],
        projectId: null,
        personIds: [],
        idempotencyKey: "backend-revision-2",
      },
      new AbortController().signal,
    );
    expect(second?.document.currentRevision).toBe(2);

    const documents = await knowledge.listDocuments(
      access,
      { knowledgeBaseId: base.id, cursor: null, limit: 10 },
      new AbortController().signal,
    );
    expect(documents).toMatchObject({
      items: [{ id: first!.document.id, currentRevision: 2 }],
      nextCursor: null,
    });

    const currentDocument = await knowledge.getDocument(
      access,
      { documentId: first!.document.id, revision: null },
      new AbortController().signal,
    );
    const firstDocument = await knowledge.getDocument(
      access,
      { documentId: first!.document.id, revision: 1 },
      new AbortController().signal,
    );
    expect(currentDocument).toMatchObject({
      revision: { version: 2 },
      content: secondContent,
    });
    expect(firstDocument).toMatchObject({
      revision: { version: 1 },
      content: firstContent,
    });

    const revisions = await knowledge.listDocumentRevisions(
      access,
      { documentId: first!.document.id, cursor: null, limit: 10 },
      new AbortController().signal,
    );
    expect(revisions.items.map(({ revision, content }) => ({
      version: revision.version,
      content,
    }))).toEqual([
      { version: 2, content: secondContent },
      { version: 1, content: firstContent },
    ]);
    expect(revisions.nextCursor).toBeNull();

    const matches = await knowledge.searchKnowledge(
      access,
      {
        knowledgeBaseId: base.id,
        embedding: {
          spaceId: knowledgeSpaceId,
          contentHash: hash("backend"),
          vector: vector(1),
        },
        limit: 5,
      },
      new AbortController().signal,
    );
    expect(matches).toHaveLength(1);
    expect(matches?.[0]).toMatchObject({
      revisionId: second!.revision.id,
      content: secondContent,
      spaceId: knowledgeSpaceId,
    });
  });

  it("atomically audits browser-admin knowledge base and revision mutations", async () => {
    const adminAccess: BrainAccessContext = {
      ...access,
      administrativeChannel: true,
      actor: { ...access.actor, requestId: "admin-knowledge-base-create" },
    };
    const base = await knowledge.createKnowledgeBase(
      adminAccess,
      {
        name: "Private operations",
        description: "Sensitive description must not be audited.",
        idempotencyKey: "admin-audited-knowledge-base",
      },
      AbortSignal.timeout(10_000),
    );
    const content = "Sensitive document body must not be audited.";
    const revisionAccess: BrainAccessContext = {
      ...adminAccess,
      actor: { ...adminAccess.actor, requestId: "admin-knowledge-revision-create" },
    };
    const created = await knowledge.createDocumentRevision(
      revisionAccess,
      {
        knowledgeBaseId: base.id,
        documentId: null,
        expectedRevision: null,
        title: "Private document title",
        sourceUri: null,
        contentHash: hash(content),
        chunks: [
          {
            content,
            position: 0,
            embedding: {
              spaceId: knowledgeSpaceId,
              contentHash: knowledgeChunkEmbeddingRecipe(content).contentHash,
              vector: vector(1),
            },
          },
        ],
        tags: [],
        projectId: null,
        personIds: [],
        idempotencyKey: "admin-audited-knowledge-revision",
      },
      AbortSignal.timeout(10_000),
    );
    expect(created).not.toBeNull();

    const rows = await db
      .select({
        action: schema.adminAuditEvents.action,
        targetId: schema.adminAuditEvents.targetId,
        metadata: schema.adminAuditEvents.metadata,
      })
      .from(schema.adminAuditEvents)
      .where(eq(schema.adminAuditEvents.category, "domain"));
    expect(rows).toEqual(
      expect.arrayContaining([
        { action: "knowledge_base.created", targetId: base.id, metadata: {} },
        {
          action: "knowledge_document.revision_created",
          targetId: created!.document.id,
          metadata: {},
        },
      ]),
    );
    const encoded = JSON.stringify(rows);
    expect(encoded).not.toContain("Sensitive description");
    expect(encoded).not.toContain("Private document title");
    expect(encoded).not.toContain("Sensitive document body");
  });

  it("serializes document revision writes with embedding-space promotion", async () => {
    const base = await knowledge.createKnowledgeBase(
      access,
      {
        name: "Promotion race",
        description: null,
        idempotencyKey: "promotion-race-base",
      },
      new AbortController().signal,
    );
    const content =
      "The active embedding space must remain stable until commit.";
    const barrierKey = 7_310_551;
    const barrier = await database.pool.connect();
    const monitor = await database.pool.connect();
    let revisionPromise: ReturnType<
      DrizzleKnowledgeStore["createDocumentRevision"]
    > | null = null;
    let promotionPromise: ReturnType<
      DrizzleEmbeddingSpaceStore["promoteSpace"]
    > | null = null;
    try {
      await monitor.query(`
        CREATE FUNCTION hold_knowledge_chunk_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${barrierKey});
          RETURN NULL;
        END
        $$
      `);
      await monitor.query(`
        CREATE TRIGGER hold_knowledge_chunk_insert_trigger
        BEFORE INSERT ON knowledge_chunks
        FOR EACH STATEMENT EXECUTE FUNCTION hold_knowledge_chunk_insert()
      `);
      await barrier.query("SELECT pg_advisory_lock($1)", [barrierKey]);

      revisionPromise = knowledge.createDocumentRevision(
        access,
        {
          knowledgeBaseId: base.id,
          documentId: null,
          expectedRevision: null,
          title: "Embedding lock",
          sourceUri: null,
          contentHash: hash(content),
          chunks: [
            {
              content,
              position: 0,
              embedding: {
                spaceId: knowledgeSpaceId,
                contentHash: knowledgeChunkEmbeddingRecipe(content).contentHash,
                vector: vector(1),
              },
            },
          ],
          tags: [],
          projectId: null,
          personIds: [],
          idempotencyKey: "promotion-race-revision",
        },
        new AbortController().signal,
      );
      await waitUntil(async () => {
        const result = await monitor.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND state = 'active'
              AND wait_event_type = 'Lock'
              AND query ILIKE '%insert into "knowledge_chunks"%'
          ) AS waiting
        `);
        return result.rows[0]?.waiting === true;
      }, "the revision insert barrier");

      const spaces = new DrizzleEmbeddingSpaceStore(db);
      promotionPromise = spaces.promoteSpace(
        access,
        nextKnowledgeSpaceId,
        {
          expectedStatus: "preparing",
          idempotencyKey: "promote-knowledge-space-v2",
        },
        new AbortController().signal,
      );
      // The revision already holds the active-space FOR SHARE lock. Give the
      // promotion a chance to reach that lock without making the assertion
      // depend on polling another backend within the store's short lock
      // timeout; releasing the barrier still proves commit-side ordering.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await barrier.query("SELECT pg_advisory_unlock($1)", [barrierKey]);
      const [revision, promoted] = await Promise.all([
        revisionPromise,
        promotionPromise,
      ]);
      expect(revision).not.toBeNull();
      expect(promoted).toMatchObject({
        id: nextKnowledgeSpaceId,
        status: "active",
      });

      const sidecars = await db
        .select({ spaceId: schema.knowledgeChunkEmbeddings.spaceId })
        .from(schema.knowledgeChunkEmbeddings)
        .innerJoin(
          schema.knowledgeChunks,
          eq(
            schema.knowledgeChunks.id,
            schema.knowledgeChunkEmbeddings.chunkId,
          ),
        )
        .where(eq(schema.knowledgeChunks.revisionId, revision!.revision.id));
      expect(sidecars).toEqual([{ spaceId: knowledgeSpaceId }]);
    } finally {
      await barrier
        .query("SELECT pg_advisory_unlock($1)", [barrierKey])
        .catch(() => undefined);
      await Promise.allSettled([
        ...(revisionPromise === null ? [] : [revisionPromise]),
        ...(promotionPromise === null ? [] : [promotionPromise]),
      ]);
      await monitor.query(
        "DROP TRIGGER IF EXISTS hold_knowledge_chunk_insert_trigger ON knowledge_chunks",
      );
      await monitor.query(
        "DROP FUNCTION IF EXISTS hold_knowledge_chunk_insert()",
      );
      monitor.release();
      barrier.release();
    }
  });

  it("uses historical versions and excludes future, revoked, and cross-space evidence", async () => {
    const eventValues = (
      id: string,
      entityType: "task" | "reminder" | "goal" | "priority_plan",
      entityId: string,
      action: "created" | "completed" | "deleted",
      occurredAt: Date,
      idempotencyKey: string,
    ) => ({
      id,
      entityType,
      entityId,
      action,
      occurredAt,
      effectiveAt: occurredAt,
      changedFields: [],
      requestDigest: hash(idempotencyKey),
      analysisAllowed: true,
      idempotencyKey,
      ...actor,
      requestId: idempotencyKey,
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
      recordedAt: occurredAt,
    });
    const taskEvent1 = "20000000-0000-4000-8000-000000000001";
    const taskEvent2 = "20000000-0000-4000-8000-000000000002";
    const reminderEvent1 = "20000000-0000-4000-8000-000000000003";
    const reminderEvent2 = "20000000-0000-4000-8000-000000000004";
    const goalEvent1 = "20000000-0000-4000-8000-000000000005";
    const goalEvent2 = "20000000-0000-4000-8000-000000000006";
    const priorityEvent = "20000000-0000-4000-8000-000000000007";
    const purgedTaskId = "20000000-0000-4000-8000-000000000008";
    const purgedTaskCreated = "20000000-0000-4000-8000-000000000009";
    const purgedTaskDeleted = "20000000-0000-4000-8000-000000000010";

    const memoryRecipe = memoryEmbeddingRecipe(
      "Launch distribution begins this week.",
    );
    const decisionRecipe = decisionEmbeddingRecipe({
      statement: "Launch the modular monolith.",
      rationale: "It keeps delivery fast.",
      rejectedAlternatives: [],
    });
    await db.insert(schema.memories).values({
      id: memoryId,
      lineageId: memoryId,
      versionNumber: 1,
      content: "Launch distribution begins this week.",
      contentHash: memoryRecipe.contentHash,
      effectiveAt: before,
      createdAt: before,
      ...actor,
    });
    await db.insert(schema.memoryEmbeddings).values({
      memoryId,
      spaceId: memorySpaceId,
      contentHash: memoryRecipe.contentHash,
      recipeVersion: MEMORY_EMBEDDING_RECIPE_VERSION,
      embedding: vector(1),
      createdAt: before,
    });
    await db.insert(schema.decisions).values({
      id: decisionId,
      lineageId: decisionId,
      versionNumber: 1,
      statement: "Launch the modular monolith.",
      rationale: "It keeps delivery fast.",
      rejectedAlternatives: [],
      decidedAt: before,
      revokedAt: after,
      contentHash: decisionRecipe.contentHash,
      createdAt: before,
      updatedAt: after,
      ...actor,
    });
    await db.insert(schema.decisionEmbeddings).values({
      decisionId,
      spaceId: decisionSpaceId,
      contentHash: decisionRecipe.contentHash,
      recipeVersion: DECISION_EMBEDDING_RECIPE_VERSION,
      embedding: vector(1),
      createdAt: before,
    });
    await db.insert(schema.taskLists).values({
      id: listId,
      name: "Launch",
      ...actor,
      createdAt: before,
      updatedAt: after,
    });
    await db.insert(schema.tasks).values({
      id: taskId,
      listId,
      title: "Ship launch page",
      status: "done",
      priority: "high",
      completedAt: after,
      historyVersion: 2,
      historyCompleteFrom: before,
      ...actor,
      createdAt: before,
      updatedAt: after,
    });
    await db.insert(schema.reminders).values({
      id: reminderId,
      message: "Review launch metrics",
      remindAt: after,
      completedAt: after,
      historyVersion: 2,
      historyCompleteFrom: before,
      ...actor,
      createdAt: before,
      updatedAt: after,
    });
    await db.insert(schema.goals).values({
      id: goalId,
      title: "Launch the product",
      status: "achieved",
      version: 2,
      historyCompleteFrom: before,
      ...actor,
      createdAt: before,
      updatedAt: after,
    });
    await db
      .insert(schema.activityEvents)
      .values([
        eventValues(
          taskEvent1,
          "task",
          taskId,
          "created",
          before,
          "task-created",
        ),
        eventValues(
          taskEvent2,
          "task",
          taskId,
          "completed",
          after,
          "task-completed",
        ),
        eventValues(
          reminderEvent1,
          "reminder",
          reminderId,
          "created",
          before,
          "reminder-created",
        ),
        eventValues(
          reminderEvent2,
          "reminder",
          reminderId,
          "completed",
          after,
          "reminder-completed",
        ),
        eventValues(
          goalEvent1,
          "goal",
          goalId,
          "created",
          before,
          "goal-created",
        ),
        eventValues(
          goalEvent2,
          "goal",
          goalId,
          "completed",
          after,
          "goal-completed",
        ),
        eventValues(
          priorityEvent,
          "priority_plan",
          planId,
          "created",
          before,
          "priority-created",
        ),
        eventValues(
          purgedTaskCreated,
          "task",
          purgedTaskId,
          "created",
          before,
          "purged-task-created",
        ),
        eventValues(
          purgedTaskDeleted,
          "task",
          purgedTaskId,
          "deleted",
          after,
          "purged-task-deleted",
        ),
      ]);
    await db.insert(schema.taskVersions).values([
      {
        id: "30000000-0000-4000-8000-000000000001",
        taskId,
        versionNumber: 1,
        operation: "created",
        listId,
        title: "Ship launch page",
        status: "todo",
        priority: "high",
        effectiveAt: before,
        recordedAt: before,
        activityEventId: taskEvent1,
      },
      {
        id: "30000000-0000-4000-8000-000000000002",
        taskId,
        versionNumber: 2,
        operation: "completed",
        listId,
        title: "Ship launch page",
        status: "done",
        priority: "high",
        completedAt: after,
        effectiveAt: after,
        recordedAt: after,
        activityEventId: taskEvent2,
      },
    ]);
    await db.insert(schema.reminderVersions).values([
      {
        id: "30000000-0000-4000-8000-000000000003",
        reminderId,
        versionNumber: 1,
        operation: "created",
        message: "Review launch metrics",
        remindAt: after,
        effectiveAt: before,
        recordedAt: before,
        activityEventId: reminderEvent1,
      },
      {
        id: "30000000-0000-4000-8000-000000000004",
        reminderId,
        versionNumber: 2,
        operation: "completed",
        message: "Review launch metrics",
        remindAt: after,
        completedAt: after,
        effectiveAt: after,
        recordedAt: after,
        activityEventId: reminderEvent2,
      },
    ]);
    await db.insert(schema.goalVersions).values([
      {
        id: "30000000-0000-4000-8000-000000000005",
        goalId,
        versionNumber: 1,
        operation: "created",
        title: "Launch the product",
        status: "active",
        effectiveAt: before,
        recordedAt: before,
        activityEventId: goalEvent1,
      },
      {
        id: "30000000-0000-4000-8000-000000000006",
        goalId,
        versionNumber: 2,
        operation: "completed",
        title: "Launch the product",
        status: "achieved",
        effectiveAt: after,
        recordedAt: after,
        activityEventId: goalEvent2,
      },
    ]);
    await db.transaction(async (transaction) => {
      await transaction.insert(schema.priorityPlans).values({
        id: planId,
        periodStart: new Date("2026-08-01T00:00:00.000Z"),
        periodEnd: new Date("2026-09-01T00:00:00.000Z"),
        version: 1,
        currentVersionId: planVersionId,
        ...actor,
        createdAt: before,
        updatedAt: before,
      });
      await transaction.insert(schema.priorityPlanVersions).values({
        id: planVersionId,
        priorityPlanId: planId,
        versionNumber: 1,
        periodStart: new Date("2026-08-01T00:00:00.000Z"),
        periodEnd: new Date("2026-09-01T00:00:00.000Z"),
        note: "Launch is the top priority.",
        effectiveAt: before,
        recordedAt: before,
        ...actor,
        activityEventId: priorityEvent,
      });
      await transaction.insert(schema.priorityPlanVersionItems).values({
        priorityPlanVersionId: planVersionId,
        goalId,
        rank: 1,
        // Share totals are enforced at commit: present shares must sum to 100.
        intendedSharePercent: 100,
      });
    });
    await db.insert(schema.activities).values({
      id: activityId,
      kind: "work_session",
      occurredAt: before,
      endedAt: new Date("2026-08-15T11:00:00.000Z"),
      timeBasis: "explicit_interval",
      summary: "Worked on launch distribution.",
      analysisAllowed: true,
      idempotencyKey: "launch-session",
      ...actor,
      recordedAt: before,
    });

    const result = await evidence.searchEvidence(
      access,
      {
        embeddings: {
          memories: {
            spaceId: memorySpaceId,
            contentHash: hash("launch"),
            vector: vector(1),
          },
          decisions: {
            spaceId: decisionSpaceId,
            contentHash: hash("launch"),
            vector: vector(1),
          },
        },
        query: "launch",
        asOf: cutoff,
        projectId: null,
        limits: {
          memories: 5,
          decisions: 5,
          tasks: 5,
          reminders: 5,
          goals: 5,
          priorities: 5,
          activities: 5,
        },
      },
      new AbortController().signal,
    );

    expect(result.coverage).toMatchObject({
      complete: false,
      requestedAsOf: cutoff,
    });
    expect(result.coverage.warnings).toContain(
      "Historical task or reminder content is unavailable because a later privacy deletion purged its canonical row and versions.",
    );
    expect(result.evidence.map((item) => item.type)).toEqual([
      "memory",
      "decision",
      "task",
      "reminder",
      "goal",
      "priority_plan",
      "activity",
    ]);
    expect(
      result.evidence.find((item) => item.type === "task")?.content,
    ).toContain("todo");
    expect(
      result.evidence.find((item) => item.type === "reminder")?.content,
    ).toContain("pending");
    expect(
      result.evidence.find((item) => item.type === "goal")?.content,
    ).toContain("active");

    await expect(
      evidence.searchEvidence(
        access,
        {
          embeddings: {
            memories: {
              spaceId: decisionSpaceId,
              contentHash: hash("launch"),
              vector: vector(1),
            },
            decisions: null,
          },
          query: "launch",
          asOf: cutoff,
          projectId: null,
          limits: {
            memories: 1,
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
    ).rejects.toThrow("memory embedding space is not active");
  });

  it("finds a person in a knowledge base from a who-is query", async () => {
    const search = new DrizzleBrainSearchStore(db);
    const peopleStore = new DrizzlePersonStore(db);
    const base = await knowledge.createKnowledgeBase(
      access,
      {
        name: "Example Academy",
        description: "Team, courses, and academy operating context.",
        idempotencyKey: "academy-base",
      },
      new AbortController().signal,
    );
    const content =
      "Jane Doe is a faculty member of Example Academy.";
    await knowledge.createDocumentRevision(
      access,
      {
        knowledgeBaseId: base.id,
        documentId: null,
        expectedRevision: null,
        title: "Faculty",
        sourceUri: null,
        contentHash: hash(content),
        chunks: [
          {
            content,
            position: 0,
            embedding: {
              // The preceding promotion test intentionally retires the initial
              // space; this test must use the space that is active now.
              spaceId: nextKnowledgeSpaceId,
              contentHash: knowledgeChunkEmbeddingRecipe(content).contentHash,
              vector: vector(0.9),
            },
          },
        ],
        tags: ["faculty"],
        projectId: null,
        personIds: [],
        idempotencyKey: "faculty-doc",
      },
      new AbortController().signal,
    );
    await peopleStore.createPerson(
      access,
      {
        name: "Jane Doe",
        aliases: ["Lana"],
        notes: null,
        summary: "Faculty member at Example Academy.",
        tags: ["faculty"],
        projectIds: [],
        knowledgeBaseIds: [base.id],
        idempotencyKey: "person-jane",
      },
      new AbortController().signal,
    );

    const result = await search.search(
      access,
      {
        query: "quem é Jane Doe",
        intent: "lookup_person",
        subject: "Jane Doe",
        embeddings: { memories: null, knowledge: null },
        projectId: null,
        limit: 20,
      },
      new AbortController().signal,
    );

    expect(result.knowledgeBases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Example Academy",
          description: "Team, courses, and academy operating context.",
        }),
      ]),
    );
    expect(result.hits.some((item) => item.sourceType === "knowledge_chunk")).toBe(
      true,
    );
    expect(result.hits.some((item) => item.sourceType === "person")).toBe(true);
    expect(result.people[0]).toMatchObject({
      name: "Jane Doe",
      relatedKnowledgeBases: [
        expect.objectContaining({ name: "Example Academy" }),
      ],
    });
    expect(result.suggestedKnowledgeBases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Example Academy" }),
      ]),
    );
  });
});
