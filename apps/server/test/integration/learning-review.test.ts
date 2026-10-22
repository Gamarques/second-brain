import { DrizzleMemoryStore } from "@second-brain/engine/database/stores/memory-store";
import { randomUUID } from "node:crypto";
import { createEngine, type ExecutionSource } from "@invokta/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase } from "@second-brain/engine/database/client";
import { runMigrations } from "@second-brain/engine/database/migrate";
import { accounts } from "@second-brain/engine/database/schema/identity";
import { automationJobs } from "@second-brain/engine/database/schema/automation";
import {
  dreamingChanges,
  dreamingRuns,
  dreamingEvidence,
} from "@second-brain/engine/database/schema/dreaming";
import { dreamingReviews } from "@second-brain/engine/database/schema/learning-review";
import { memories } from "@second-brain/engine/database/schema/content";
import { activityEvents } from "@second-brain/engine/database/schema/temporal";
import {
  embeddingSpaces,
  memoryEmbeddings,
} from "@second-brain/engine/database/schema/embeddings";
import { DrizzleBrainAccessStore } from "@second-brain/engine/database/stores/access-store";
import { DrizzleLearningReviewStore } from "@second-brain/engine/database/stores/learning-review-store";
import { memoryEmbeddingRecipe } from "@second-brain/engine/domain";
import { createAdminLearningCapabilities } from "../../src/services/admin/capabilities/admin-learning.js";
import {
  provisionTestDatabase,
  type DisposableTestDatabase,
} from "./support/database.js";

let resource: DisposableTestDatabase;
let database: ReturnType<typeof createDatabase>;
let engine: ReturnType<
  typeof createEngine<ReturnType<typeof createAdminLearningCapabilities>>
>;
const accountId = randomUUID();
const spaceId = randomUUID();
const vector = [1, ...Array<number>(1535).fill(0)];
const options = {
  source: "admin" as ExecutionSource,
  principal: { id: accountId },
};
const embed = vi.fn(
  async (recipe: ReturnType<typeof memoryEmbeddingRecipe>) => ({
    spaceId,
    contentHash: recipe.contentHash,
    vector,
  }),
);
const verifyUpdates = vi.fn(async () => [
  {
    supported: true,
    sameFact: true,
    contradictionResolved: true,
    quoteIndexes: [0],
  },
]);
beforeAll(async () => {
  resource = await provisionTestDatabase("learning_review");
  await runMigrations(resource.pool);
  database = createDatabase(resource.pool);
  await database
    .insert(accounts)
    .values({
      id: accountId,
      email: "review@example.test",
      passwordHash: "test",
      role: "admin",
    });
  await database
    .insert(embeddingSpaces)
    .values({
      id: spaceId,
      entityType: "memory",
      provider: "test",
      model: "test",
      modelRevision: "1",
      recipeVersion: memoryEmbeddingRecipe("a").recipeVersion,
      dimensions: 1536,
      status: "active",
      promotedAt: new Date(),
    });
  engine = createEngine({
    name: "learning",
    version: "1",
    capabilities: createAdminLearningCapabilities(
      new DrizzleBrainAccessStore(database),
      new DrizzleLearningReviewStore(database, {
        embed,
        verifier: { verifyUpdates },
      }),
    ),
  });
}, 180_000);
afterAll(async () => {
  await resource?.destroy();
});
let day = 0;
async function seed(
  input: { target?: string; redacted?: boolean; truncated?: boolean } = {},
) {
  const jobId = randomUUID();
  const runId = randomUUID();
  const changeId = randomUUID();
  const evidenceId = randomUUID();
  const localDate = `2020-01-${String(++day).padStart(2, "0")}`;
  const start = new Date(`${localDate}T00:00:00Z`);
  const end = new Date(start.valueOf() + 86400000);
  const content = `The product review ${changeId} is ready.`;
  const fingerprint = memoryEmbeddingRecipe(changeId).contentHash;
  await database
    .insert(automationJobs)
    .values({
      id: jobId,
      kind: "daily_dreaming",
      canonicalKey: `daily_dreaming:${localDate}`,
      scheduledFor: end,
      status: "completed",
      payload: { localDate },
    });
  await database
    .insert(dreamingRuns)
    .values({
      id: runId,
      automationJobId: jobId,
      localDate,
      timeZone: "UTC",
      windowStart: start,
      windowEnd: end,
      mode: "preview",
      status: "completed_with_skips",
      snapshotTruncated: input.truncated ?? false,
      settingsRevision: 1,
      pipelineVersion: "test",
      promptVersion: "test",
      schemaVersion: "test",
      policyVersion: "test",
    });
  await database
    .insert(dreamingEvidence)
    .values({
      id: evidenceId,
      runId,
      evidenceIndex: 0,
      role: "primary",
      type: "activity",
      entityId: randomUUID(),
      observedAt: start,
      effectiveAt: start,
      excerpt: content,
      contentHash: memoryEmbeddingRecipe(content).contentHash,
      ...(input.redacted ? { redactedAt: new Date() } : {}),
    });
  const [target] = input.target
    ? await database
        .select()
        .from(memories)
        .where(eq(memories.id, input.target))
    : [];
  await database
    .insert(dreamingChanges)
    .values({
      id: changeId,
      runId,
      ordinal: 0,
      operation: target ? "update" : "create",
      proposal: {
        operation: target ? "update" : "create",
        ...(target ? { targetMemoryIndex: 0 } : {}),
        content,
        category: null,
        tags: [],
        sourceQuotes: [content],
        evidenceIndexes: [0],
      },
      fingerprint,
      status: "skipped",
      skipReason: "policy_denied",
      expectedTargetMemoryId: target?.id ?? null,
      expectedTargetHash: target?.contentHash ?? null,
      expectedTargetVersion: target?.versionNumber ?? null,
    });
  return { changeId, fingerprint, runId, evidenceId, content };
}
const review = (
  item: { changeId: string; fingerprint: string },
  decision: "accept" | "reject",
  key: string = randomUUID(),
) =>
  engine.invoke(
    "admin_learning_dreaming_review",
    {
      changeId: item.changeId,
      fingerprint: item.fingerprint,
      decision,
      idempotencyKey: key,
    },
    options,
  );

it("accepts one suggestion once under concurrent approvals and preserves preview history", async () => {
  const item = await seed();
  const results = await Promise.all([
    review(item, "accept"),
    review(item, "accept"),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]!.resultMemoryId).not.toBeNull();
  expect(await database.select().from(memories)).toHaveLength(1);
  expect(
    (
      await database
        .select()
        .from(dreamingChanges)
        .where(eq(dreamingChanges.id, item.changeId))
    )[0],
  ).toMatchObject({ status: "skipped", resultMemoryId: null });
  expect(
    (
      await database
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.entityId, results[0]!.resultMemoryId!))
    )[0],
  ).toMatchObject({ analysisAllowed: false, actorAccountId: accountId });
  const calls = embed.mock.calls.length;
  await expect(review(item, "accept")).resolves.toEqual(results[0]);
  expect(embed).toHaveBeenCalledTimes(calls);
  await expect(review(item, "reject")).rejects.toMatchObject({
    cause: { code: "LEARNING_REVIEW_CONFLICT" },
  });
});

it("rejects without paid calls, detects reused request keys, and pages without losing microseconds", async () => {
  const a = await seed();
  const b = await seed();
  const c = await seed();
  const calls = embed.mock.calls.length;
  await review(a, "reject", "reject-request");
  await expect(review(b, "reject", "reject-request")).rejects.toMatchObject({
    cause: { code: "LEARNING_REVIEW_CONFLICT" },
  });
  expect(embed).toHaveBeenCalledTimes(calls);
  await database
    .update(dreamingChanges)
    .set({ createdAt: sql`'2026-01-01T00:00:00.123999Z'::timestamptz` })
    .where(eq(dreamingChanges.id, b.changeId));
  await database
    .update(dreamingChanges)
    .set({ createdAt: sql`'2026-01-01T00:00:00.123555Z'::timestamptz` })
    .where(eq(dreamingChanges.id, c.changeId));
  const found: string[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: { id: string }[]; nextCursor: string | null } =
      await engine.invoke(
        "admin_learning_list",
        { kind: "dreaming", status: "pending", limit: 1, cursor },
        options,
      );
    found.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(found.sort()).toEqual([b.changeId, c.changeId].sort());
  expect(new Set(found).size).toBe(found.length);
});

it("blocks redacted or truncated evidence and altered fingerprints before using models", async () => {
  const redacted = await seed({ redacted: true });
  const truncated = await seed({ truncated: true });
  const valid = await seed();
  const calls = embed.mock.calls.length;
  for (const item of [
    redacted,
    truncated,
    { ...valid, fingerprint: "0".repeat(64) },
  ])
    await expect(review(item, "accept")).rejects.toMatchObject({
      cause: { code: "LEARNING_REVIEW_CONFLICT" },
    });
  expect(embed).toHaveBeenCalledTimes(calls);
  expect(
    (
      await engine.invoke(
        "admin_learning_dreaming_get",
        { changeId: redacted.changeId },
        options,
      )
    ).result?.evidence[0]?.excerpt,
  ).toBe("");
  expect(
    (
      await engine.invoke(
        "admin_learning_dreaming_get",
        { changeId: redacted.changeId },
        options,
      )
    ).result?.proposal.content,
  ).toBe("");
  await review(redacted, "reject");
});

it("verifies updates and refuses a target superseded while the model was running", async () => {
  const targetId = randomUUID();
  const contentHash = memoryEmbeddingRecipe("Original fact").contentHash;
  await database
    .insert(memories)
    .values({
      id: targetId,
      lineageId: targetId,
      versionNumber: 1,
      content: "Original fact",
      contentHash,
      effectiveAt: new Date("2019-01-01T00:00:00Z"),
      actorKind: "account",
      actorAccountId: accountId,
      actorSource: "direct",
    });
  await database
    .insert(memoryEmbeddings)
    .values({
      memoryId: targetId,
      spaceId,
      contentHash,
      recipeVersion: memoryEmbeddingRecipe("Original fact").recipeVersion,
      embedding: vector,
    });
  const item = await seed({ target: targetId });
  embed.mockImplementationOnce(async (recipe) => {
    const id = randomUUID();
    await database
      .insert(memories)
      .values({
        id,
        lineageId: targetId,
        versionNumber: 2,
        supersedesId: targetId,
        content: "New human edit",
        contentHash: memoryEmbeddingRecipe("New human edit").contentHash,
        effectiveAt: new Date("2020-01-01T00:00:00Z"),
        actorKind: "account",
        actorAccountId: accountId,
        actorSource: "direct",
      });
    return { spaceId, contentHash: recipe.contentHash, vector };
  });
  await expect(review(item, "accept")).rejects.toMatchObject({
    cause: { code: "LEARNING_REVIEW_CONFLICT" },
  });
  expect(verifyUpdates).toHaveBeenCalledTimes(1);
  expect(
    await database
      .select()
      .from(dreamingReviews)
      .where(eq(dreamingReviews.changeId, item.changeId)),
  ).toHaveLength(0);
});

it("requires supporting verification before writing a new version of the same memory", async () => {
  const targetId = randomUUID();
  const oldContent = "The previous reviewed fact";
  const contentHash = memoryEmbeddingRecipe(oldContent).contentHash;
  await database
    .insert(memories)
    .values({
      id: targetId,
      lineageId: targetId,
      versionNumber: 1,
      content: oldContent,
      contentHash,
      effectiveAt: new Date("2019-01-01T00:00:00Z"),
      actorKind: "account",
      actorAccountId: accountId,
      actorSource: "direct",
    });
  await database
    .insert(memoryEmbeddings)
    .values({
      memoryId: targetId,
      spaceId,
      contentHash,
      recipeVersion: memoryEmbeddingRecipe(oldContent).recipeVersion,
      embedding: vector,
    });
  const item = await seed({ target: targetId });
  verifyUpdates.mockResolvedValueOnce([
    {
      supported: false,
      sameFact: true,
      contradictionResolved: false,
      quoteIndexes: [0],
    },
  ]);
  const calls = embed.mock.calls.length;
  await expect(review(item, "accept")).rejects.toMatchObject({
    cause: { code: "LEARNING_REVIEW_CONFLICT" },
  });
  expect(embed).toHaveBeenCalledTimes(calls);
  const accepted = await review(item, "accept");
  expect(
    (
      await database
        .select()
        .from(memories)
        .where(eq(memories.id, accepted.resultMemoryId!))
    )[0],
  ).toMatchObject({
    lineageId: targetId,
    supersedesId: targetId,
    versionNumber: 2,
    content: item.content,
  });
  expect(
    (
      await database
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.entityId, targetId))
    )[0],
  ).toMatchObject({ action: "superseded", analysisAllowed: false });
});

it("keeps the decision after deleting an approved memory without recreating it on retry", async () => {
  const item = await seed();
  const accepted = await review(item, "accept");
  const authorized = {
    accountId,
    role: "admin" as const,
    actor: {
      kind: "account" as const,
      accountId,
      clientId: null,
      source: "direct" as const,
      requestId: "delete-reviewed",
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
  await expect(
    new DrizzleMemoryStore(database).deleteMemory(
      authorized,
      accepted.resultMemoryId!,
      { idempotencyKey: "delete-reviewed" },
      new AbortController().signal,
    ),
  ).resolves.toBe(true);
  const calls = embed.mock.calls.length;
  await expect(review(item, "accept")).resolves.toEqual(accepted);
  expect(embed).toHaveBeenCalledTimes(calls);
  expect(
    await database
      .select()
      .from(memories)
      .where(eq(memories.id, accepted.resultMemoryId!)),
  ).toHaveLength(0);
});

it("revalidates authorization after model work before committing", async () => {
  const item = await seed();
  embed.mockImplementationOnce(async (recipe) => {
    await database
      .update(accounts)
      .set({ role: "viewer" })
      .where(eq(accounts.id, accountId));
    return { spaceId, contentHash: recipe.contentHash, vector };
  });
  await expect(review(item, "accept")).rejects.toBeDefined();
  expect(
    await database
      .select()
      .from(dreamingReviews)
      .where(eq(dreamingReviews.changeId, item.changeId)),
  ).toHaveLength(0);
});
