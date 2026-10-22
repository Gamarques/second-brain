import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  canonicalDigest,
  DECISION_EMBEDDING_RECIPE_VERSION,
  ingestionProposalPayloadDigest,
  ingestionRequestDigest,
  ingestionReviewDigest,
  MEMORY_EMBEDDING_RECIPE_VERSION,
} from "../../src/domain.js";
import type {
  BrainAccessContext,
  EmbeddingProvider,
  EmbeddingSpaceStore,
  IngestProposalPayload,
  IngestReviewItem,
} from "../../src/domain.js";
import { createDatabase } from "../../src/database/client.js";
import { DrizzleEmbeddingSpaceStore } from "../../src/database/stores/embedding-space-store.js";
import {
  DrizzleIngestionStore,
  DrizzleReviewedIngestionCommitter,
} from "../../src/database/stores/ingestion-store.js";
import { ingestReceipts } from "../../src/database/schema/ingestion.js";
import { DrizzleTaskStore } from "../../src/database/stores/task-store.js";
import { people } from "../../src/database/schema/content.js";
import { accounts } from "../../src/database/schema/identity.js";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

const schemaVersion = "ingestion-proposal/v1";
const proposalProvider = "test-provider";
const proposalModel = "test-model";
const signal = new AbortController().signal;

async function runMigrations(database: DisposableTestDatabase): Promise<void> {
  const migrationModule = (await import("../../src/database/migrate.js")) as {
    runMigrations?: (pool: DisposableTestDatabase["pool"]) => Promise<void>;
  };
  if (!migrationModule.runMigrations) {
    throw new Error("The database migrator must export runMigrations(pool).");
  }
  await migrationModule.runMigrations(database.pool);
}

describe("Drizzle reliable ingestion persistence", () => {
  let resource: DisposableTestDatabase;
  let store: DrizzleIngestionStore;
  let committer: DrizzleReviewedIngestionCommitter;
  let access: BrainAccessContext;

  beforeAll(async () => {
    resource = await provisionTestDatabase("ingestion_store");
    await runMigrations(resource);
    const database = createDatabase(resource.pool);
    const [account] = await database
      .insert(accounts)
      .values({
        email: `${randomUUID()}@example.com`,
        passwordHash: "test-only-password-hash",
        role: "owner",
      })
      .returning({ id: accounts.id });
    if (account === undefined) throw new Error("Test account was not created.");
    access = {
      accountId: account.id,
      role: "owner",
      actor: {
        kind: "account",
        accountId: account.id,
        clientId: null,
        source: "direct",
        requestId: randomUUID(),
        correlationId: null,
        causationId: null,
        dreamingRunId: null,
      },
    };
    store = new DrizzleIngestionStore(database);
    const embeddingSpaceStore: EmbeddingSpaceStore =
      new DrizzleEmbeddingSpaceStore(database);
    const embeddings = {
      provider: "test-embedding-provider",
      model: "test-embedding-model",
      modelRevision: "test-revision",
      dimensions: 1_536,
      async embed(texts: readonly string[]) {
        return texts.map(() => {
          const vector = Array<number>(1_536).fill(0);
          vector[0] = 1;
          return vector;
        });
      },
    } satisfies EmbeddingProvider;
    for (const [entityType, recipeVersion] of [
      ["memory", MEMORY_EMBEDDING_RECIPE_VERSION],
      ["decision", DECISION_EMBEDDING_RECIPE_VERSION],
    ] as const) {
      const space = await embeddingSpaceStore.createSpace(
        access,
        {
          entityType,
          provider: embeddings.provider,
          model: embeddings.model,
          modelRevision: embeddings.modelRevision,
          recipeVersion,
          dimensions: embeddings.dimensions,
          metric: "cosine",
        },
        signal,
      );
      await embeddingSpaceStore.promoteSpace(
        access,
        space.id,
        { expectedStatus: "preparing", idempotencyKey: randomUUID() },
        signal,
      );
    }
    committer = new DrizzleReviewedIngestionCommitter(
      database,
      embeddingSpaceStore,
      embeddings,
    );
  });

  afterAll(async () => {
    await resource?.destroy();
  });

  async function createRun(excerpt: string, idempotencyKey = randomUUID()) {
    const requestDigest = ingestionRequestDigest({
      schemaVersion,
      excerpt,
      capturedAt: null,
    });
    return store.createSourceAndRun(
      access,
      {
        idempotencyKey,
        requestDigest,
        excerpt,
        capturedAt: null,
        proposalProvider,
        proposalModel,
        schemaVersion,
      },
      signal,
    );
  }

  async function persistReviewedRun(
    excerpt: string,
    candidates: readonly {
      readonly payload: IngestProposalPayload;
      readonly sourceQuote: string;
      readonly confidence: number;
    }[],
  ) {
    const created = await createRun(excerpt);
    const proposals = candidates.map((candidate, ordinal) => {
      const sourceStart = excerpt.indexOf(candidate.sourceQuote);
      if (sourceStart < 0) throw new Error("Test source quote was not found.");
      return {
        ordinal,
        payload: candidate.payload,
        confidence: candidate.confidence,
        sourceStart,
        sourceEnd: sourceStart + candidate.sourceQuote.length,
        sourceQuote: candidate.sourceQuote,
        payloadDigest: ingestionProposalPayloadDigest(candidate.payload),
      };
    });
    const saved = await store.saveProposals(
      access,
      created.run.id,
      {
        proposals,
        responseDigest: canonicalDigest({ excerpt, proposals }),
      },
      signal,
    );
    if (saved.run.proposalDigest === null) {
      throw new Error("Test proposal digest was not persisted.");
    }
    const items: readonly IngestReviewItem[] = saved.proposals.map((proposal) => ({
      proposalId: proposal.id,
      decision: "accept",
      replacement: null,
    }));
    const reviewDigest = ingestionReviewDigest({
      runId: created.run.id,
      proposalDigest: saved.run.proposalDigest,
      items,
    });
    await store.saveReview(
      access,
      created.run.id,
      {
        expectedProposalDigest: saved.run.proposalDigest,
        reviewDigest,
        items,
        idempotencyKey: randomUUID(),
      },
      signal,
    );
    return { runId: created.run.id, reviewDigest };
  }

  it("binds an idempotency key to one immutable source digest", async () => {
    const key = randomUUID();
    const created = await createRun("I prefer tea.", key);
    const replayed = await createRun("I prefer tea.", key);

    expect(created.created).toBe(true);
    expect(replayed.created).toBe(false);
    expect(replayed.source.id).toBe(created.source.id);
    expect(replayed.run.id).toBe(created.run.id);
    await expect(createRun("I prefer coffee.", key)).rejects.toMatchObject({
      code: "INGESTION_IDEMPOTENCY_CONFLICT",
      name: "IngestionPersistenceError",
    });
  });

  it("persists only exact cited proposal spans and owns the proposal digest", async () => {
    const excerpt = "We decided to use PostgreSQL.";
    const created = await createRun(excerpt);
    const payload: IngestProposalPayload = {
      kind: "decision",
      statement: "Use PostgreSQL.",
      rationale: "It matches the relational workload.",
      rejectedAlternatives: [],
      projectId: null,
      personIds: [],
      decidedAt: null,
    };
    const sourceQuote = "use PostgreSQL";
    const sourceStart = excerpt.indexOf(sourceQuote);
    const proposal = {
      ordinal: 0,
      payload,
      confidence: 0.01,
      sourceStart,
      sourceEnd: sourceStart + sourceQuote.length,
      sourceQuote,
      payloadDigest: ingestionProposalPayloadDigest(payload),
    } as const;
    await expect(
      store.saveProposals(
        access,
        created.run.id,
        {
          proposals: [{ ...proposal, sourceStart: sourceStart + 1 }],
          responseDigest: canonicalDigest("invalid-span-response"),
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "INGESTION_INVALID_INPUT" });
    await expect(
      store.saveProposals(
        access,
        created.run.id,
        {
          proposals: [{ ...proposal, confidence: 0.1234 }],
          responseDigest: canonicalDigest("invalid-confidence-response"),
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "INGESTION_INVALID_INPUT" });

    const saved = await store.saveProposals(
      access,
      created.run.id,
      {
        proposals: [proposal],
        responseDigest: canonicalDigest("valid-response"),
      },
      signal,
    );
    expect(saved.run).toMatchObject({
      status: "awaiting_review",
      proposalCount: 1,
    });
    expect(saved.run.proposalDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(saved.proposals[0]).toMatchObject({
      confidence: 0.01,
      sourceStart,
      sourceEnd: sourceStart + sourceQuote.length,
      sourceQuote,
    });
  });

  it("ties a complete explicit review to the exact proposal IDs and digest", async () => {
    const excerpt = "I moved to Lisbon.";
    const created = await createRun(excerpt);
    const payload: IngestProposalPayload = {
      kind: "memory",
      content: "Lives in Lisbon.",
      category: "location",
      tags: ["home"],
      projectId: null,
      personIds: [],
    };
    const sourceQuote = "moved to Lisbon";
    const sourceStart = excerpt.indexOf(sourceQuote);
    const saved = await store.saveProposals(
      access,
      created.run.id,
      {
        proposals: [
          {
            ordinal: 0,
            payload,
            confidence: 0,
            sourceStart,
            sourceEnd: sourceStart + sourceQuote.length,
            sourceQuote,
            payloadDigest: ingestionProposalPayloadDigest(payload),
          },
        ],
        responseDigest: canonicalDigest("review-response"),
      },
      signal,
    );
    if (saved.run.proposalDigest === null || saved.proposals[0] === undefined) {
      throw new Error("Test proposal was not persisted.");
    }
    const items: readonly IngestReviewItem[] = [
      {
        proposalId: saved.proposals[0].id,
        decision: "accept",
        replacement: null,
      },
    ];
    const reviewDigest = ingestionReviewDigest({
      runId: created.run.id,
      proposalDigest: saved.run.proposalDigest,
      items,
    });
    const idempotencyKey = randomUUID();
    const review = await store.saveReview(
      access,
      created.run.id,
      {
        expectedProposalDigest: saved.run.proposalDigest,
        reviewDigest,
        items,
        idempotencyKey,
      },
      signal,
    );
    const replay = await store.saveReview(
      access,
      created.run.id,
      {
        expectedProposalDigest: saved.run.proposalDigest,
        reviewDigest,
        items,
        idempotencyKey,
      },
      signal,
    );
    expect(review).toMatchObject({ reviewDigest, items });
    expect(replay).toEqual(review);

    const status = await store.getRunStatus(access, created.run.id, signal);
    expect(status).toMatchObject({
      run: { status: "reviewed", reviewedDigest: reviewDigest },
      review: { reviewDigest },
      receipts: [],
    });
  });

  it("commits a reviewed low-confidence candidate exactly once", async () => {
    const name = `Reviewed Person ${randomUUID()}`;
    const reviewed = await persistReviewedRun(`Met ${name} today.`, [
      {
        payload: {
          kind: "person",
          name,
          aliases: [],
          notes: "Met today.",
        },
        sourceQuote: name,
        confidence: 0,
      },
    ]);
    const idempotencyKey = randomUUID();
    const first = await committer.commitReviewedRun(
      access,
      reviewed.runId,
      { reviewedDigest: reviewed.reviewDigest, idempotencyKey, mode: "atomic" },
      signal,
    );
    const replay = await committer.commitReviewedRun(
      access,
      reviewed.runId,
      { reviewedDigest: reviewed.reviewDigest, idempotencyKey, mode: "atomic" },
      signal,
    );

    expect(first).toMatchObject({
      run: { status: "completed" },
      receipts: [{ entityType: "person", status: "committed" }],
    });
    expect(replay).toEqual(first);
    const database = createDatabase(resource.pool);
    const persistedPeople = await database
      .select({ id: people.id })
      .from(people)
      .where(eq(people.name, name));
    expect(persistedPeople).toHaveLength(1);
    await expect(
      committer.commitReviewedRun(
        access,
        reviewed.runId,
        {
          reviewedDigest: reviewed.reviewDigest,
          idempotencyKey: randomUUID(),
          mode: "atomic",
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "INGESTION_IDEMPOTENCY_CONFLICT" });
  });

  it("atomically commits all five reviewed entity kinds with exact event receipts", async () => {
    const database = createDatabase(resource.pool);
    const taskList = await new DrizzleTaskStore(database).createTaskList(
      access,
      {
        name: `Ingestion list ${randomUUID()}`,
        description: null,
        idempotencyKey: randomUUID(),
      },
      signal,
    );
    const personName = `Five Kind Person ${randomUUID()}`;
    const excerpt = [
      "prefers oolong",
      "chose PostgreSQL",
      "ship the release",
      "review tomorrow",
      personName,
    ].join("; ");
    const reviewed = await persistReviewedRun(excerpt, [
      {
        payload: {
          kind: "memory",
          content: "Prefers oolong tea.",
          category: "preference",
          tags: ["tea"],
          projectId: null,
          personIds: [],
        },
        sourceQuote: "prefers oolong",
        confidence: 0,
      },
      {
        payload: {
          kind: "decision",
          statement: "Use PostgreSQL.",
          rationale: "The workload is relational.",
          rejectedAlternatives: [],
          projectId: null,
          personIds: [],
          decidedAt: null,
        },
        sourceQuote: "chose PostgreSQL",
        confidence: 0,
      },
      {
        payload: {
          kind: "task",
          listId: taskList.id,
          title: "Ship the release",
          description: null,
          priority: "high",
          dueAt: null,
          projectId: null,
          goalIds: [],
        },
        sourceQuote: "ship the release",
        confidence: 0,
      },
      {
        payload: {
          kind: "reminder",
          message: "Review tomorrow.",
          remindAt: "2035-01-01T12:00:00.000Z",
        },
        sourceQuote: "review tomorrow",
        confidence: 0,
      },
      {
        payload: {
          kind: "person",
          name: personName,
          aliases: [],
          notes: null,
        },
        sourceQuote: personName,
        confidence: 0,
      },
    ]);
    const idempotencyKey = randomUUID();
    const result = await committer.commitReviewedRun(
      access,
      reviewed.runId,
      {
        reviewedDigest: reviewed.reviewDigest,
        idempotencyKey,
        mode: "atomic",
      },
      signal,
    );
    expect(result).toMatchObject({ run: { status: "completed" } });
    expect(result?.receipts.map((receipt) => receipt.entityType).sort()).toEqual([
      "decision",
      "memory",
      "person",
      "reminder",
      "task",
    ]);
    const persistedReceipts = await database
      .select({
        entityType: ingestReceipts.entityType,
        entityId: ingestReceipts.entityId,
        activityEventId: ingestReceipts.activityEventId,
      })
      .from(ingestReceipts)
      .where(eq(ingestReceipts.runId, reviewed.runId));
    expect(persistedReceipts).toHaveLength(5);
    expect(
      persistedReceipts.every(
        (receipt) =>
          receipt.entityId !== null && receipt.activityEventId !== null,
      ),
    ).toBe(true);
    await expect(
      committer.commitReviewedRun(
        access,
        reviewed.runId,
        { reviewedDigest: reviewed.reviewDigest, idempotencyKey, mode: "atomic" },
        signal,
      ),
    ).resolves.toEqual(result);
  });

  it("rolls every accepted effect back when an atomic proposal cannot commit", async () => {
    const name = `Atomic Rollback ${randomUUID()}`;
    const excerpt = `${name} owns a missing task.`;
    const reviewed = await persistReviewedRun(excerpt, [
      {
        payload: {
          kind: "person",
          name,
          aliases: [],
          notes: null,
        },
        sourceQuote: name,
        confidence: 1,
      },
      {
        payload: {
          kind: "task",
          listId: randomUUID(),
          title: "Missing task",
          description: null,
          priority: "normal",
          dueAt: null,
          projectId: null,
          goalIds: [],
        },
        sourceQuote: "missing task",
        confidence: 1,
      },
    ]);
    await expect(
      committer.commitReviewedRun(
        access,
        reviewed.runId,
        {
          reviewedDigest: reviewed.reviewDigest,
          idempotencyKey: randomUUID(),
          mode: "atomic",
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "INGESTION_EFFECT_FAILED" });

    const database = createDatabase(resource.pool);
    const persistedPeople = await database
      .select({ id: people.id })
      .from(people)
      .where(eq(people.name, name));
    expect(persistedPeople).toEqual([]);
    await expect(
      store.getRunStatus(access, reviewed.runId, signal),
    ).resolves.toMatchObject({ run: { status: "reviewed" }, receipts: [] });
  });

  it("refuses durable partial mode until it has resumable semantics", async () => {
    const reviewed = await persistReviewedRun("No partial commit.", [
      {
        payload: {
          kind: "person",
          name: `No Partial ${randomUUID()}`,
          aliases: [],
          notes: null,
        },
        sourceQuote: "No partial commit",
        confidence: 1,
      },
    ]);
    await expect(
      committer.commitReviewedRun(
        access,
        reviewed.runId,
        {
          reviewedDigest: reviewed.reviewDigest,
          idempotencyKey: randomUUID(),
          mode: "durable_partial",
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "INGESTION_MODE_UNSUPPORTED" });
  });

  it("completes an exact zero-proposal review without fabricating receipts", async () => {
    const reviewed = await persistReviewedRun("Nothing durable happened.", []);
    const idempotencyKey = randomUUID();
    const result = await committer.commitReviewedRun(
      access,
      reviewed.runId,
      { reviewedDigest: reviewed.reviewDigest, idempotencyKey, mode: "atomic" },
      signal,
    );
    expect(result).toMatchObject({
      run: { status: "completed", proposalCount: 0 },
      receipts: [],
    });
    await expect(
      committer.commitReviewedRun(
        access,
        reviewed.runId,
        { reviewedDigest: reviewed.reviewDigest, idempotencyKey, mode: "atomic" },
        signal,
      ),
    ).resolves.toEqual(result);
  });

  it("fails closed after the live account is disabled", async () => {
    const created = await createRun("This source becomes inaccessible.");
    const database = createDatabase(resource.pool);
    await database
      .update(accounts)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(eq(accounts.id, access.accountId));
    await expect(
      store.getRunStatus(access, created.run.id, signal),
    ).rejects.toMatchObject({ code: "BRAIN_ACCESS_DENIED" });
  });
});
