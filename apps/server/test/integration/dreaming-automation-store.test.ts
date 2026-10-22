import { randomUUID } from "node:crypto";

import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { memoryEmbeddingRecipe } from "@second-brain/engine/domain";
import { schema } from "@second-brain/engine/database/schema/index";
import {
  automationJobs,
  automationSettings,
  automationWorkerHeartbeats,
} from "@second-brain/engine/database/schema/automation";
import { memories } from "@second-brain/engine/database/schema/content";
import { embeddingSpaces } from "@second-brain/engine/database/schema/embeddings";
import { accounts } from "@second-brain/engine/database/schema/identity";
import { activityEvents } from "@second-brain/engine/database/schema/temporal";
import {
  dreamingChanges,
  dreamingReports,
  dreamingRuns,
} from "@second-brain/engine/database/schema/dreaming";
import { DrizzleAutomationStore } from "../../src/services/automation/persistence/store.js";
import { DrizzleDreamingStore } from "@second-brain/engine/database/stores/dreaming-store";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

async function runMigrations(resource: DisposableTestDatabase): Promise<void> {
  const migrationModule = (await import("@second-brain/engine/database/migrate")) as {
    runMigrations?: (pool: DisposableTestDatabase["pool"]) => Promise<void>;
  };
  if (!migrationModule.runMigrations)
    throw new Error("runMigrations is not exported.");
  await migrationModule.runMigrations(resource.pool);
}

async function seedAutomationAccount(
  database: SecondBrainDatabase,
  input: {
    readonly timeZone?: string;
    readonly mode?: "preview" | "apply";
    readonly nextDreamAt?: Date | null;
  } = {},
) {
  const accountId = randomUUID();
  await database.insert(accounts).values({
    id: accountId,
    email: `${accountId}@example.com`,
    passwordHash: "integration-test-password-hash",
    role: "owner",
  });
  await database
    .insert(automationSettings)
    .values({
      id: 1,
      timeZone: input.timeZone ?? "UTC",
      dreamingEnabled: true,
      dreamingMode: input.mode ?? "apply",
      nextDreamAt: input.nextDreamAt ?? null,
    })
    .onConflictDoUpdate({
      target: automationSettings.id,
      set: {
        timeZone: input.timeZone ?? "UTC",
        dreamingEnabled: true,
        dreamingMode: input.mode ?? "apply",
        nextDreamAt: input.nextDreamAt ?? null,
        revision: 1,
      },
    });
  return {
    accountId,
    access: {
      accountId,
      role: "owner" as const,
      actor: {
        kind: "account" as const,
        accountId,
        clientId: null,
        source: "direct" as const,
        requestId: randomUUID(),
        correlationId: null,
        causationId: null,
        dreamingRunId: null,
      },
    },
  };
}

describe("Drizzle daily dreaming and automation stores", () => {
  let resource: DisposableTestDatabase;
  let database: SecondBrainDatabase;

  beforeAll(async () => {
    resource = await provisionTestDatabase("dreaming_store");
    await runMigrations(resource);
    database = drizzle(resource.pool, { schema });
  });

  afterAll(async () => {
    await resource?.destroy();
  });

  it("upserts bounded worker heartbeats by worker identity", async () => {
    const store = new DrizzleAutomationStore(database);
    const signal = new AbortController().signal;

    await expect(
      store.recordHeartbeat(
        "worker-heartbeat",
        {
          version: "1.2.0",
          startedAt: "2026-08-16T06:00:00.000Z",
          lastSeenAt: "2026-08-16T06:00:00.000Z",
        },
        signal,
      ),
    ).resolves.toEqual({
      workerId: "worker-heartbeat",
      version: "1.2.0",
      startedAt: "2026-08-16T06:00:00.000Z",
      lastSeenAt: "2026-08-16T06:00:00.000Z",
    });

    await expect(
      store.recordHeartbeat(
        "worker-heartbeat",
        {
          version: "1.2.1",
          startedAt: "2026-08-16T06:00:00.000Z",
          lastSeenAt: "2026-08-16T06:00:30.000Z",
        },
        signal,
      ),
    ).resolves.toEqual({
      workerId: "worker-heartbeat",
      version: "1.2.1",
      startedAt: "2026-08-16T06:00:00.000Z",
      lastSeenAt: "2026-08-16T06:00:30.000Z",
    });

    await expect(
      database
        .select()
        .from(automationWorkerHeartbeats)
        .where(eq(automationWorkerHeartbeats.workerId, "worker-heartbeat")),
    ).resolves.toHaveLength(1);

    await store.recordHeartbeat(
      "worker-heartbeat",
      {
        version: "1.3.0",
        startedAt: "2026-08-16T06:01:00.000Z",
        lastSeenAt: "2026-08-16T06:01:00.000Z",
      },
      signal,
    );
    await expect(
      store.recordHeartbeat(
        "worker-heartbeat",
        {
          version: "1.2.1",
          startedAt: "2026-08-16T06:00:00.000Z",
          lastSeenAt: "2026-08-16T06:02:00.000Z",
        },
        signal,
      ),
    ).rejects.toThrow("heartbeat was not stored");
  });

  it("enforces retry due times and fencing across a retry takeover", async () => {
    await seedAutomationAccount(database);
    const jobId = randomUUID();
    await database.insert(automationJobs).values({
      id: jobId,
      kind: "daily_dreaming",
      canonicalKey: `daily_dreaming:retry:${jobId}`,
      scheduledFor: new Date("2099-08-16T06:00:00.000Z"),
      payload: { localDate: "2099-08-15" },
    });
    const store = new DrizzleAutomationStore(database);
    const signal = new AbortController().signal;
    const first = await store.claimNextJob(
      "worker-first",
      {
        now: "2099-08-16T06:00:00.000Z",
        leaseSeconds: 60,
        kinds: ["daily_dreaming"],
      },
      signal,
    );
    expect(first?.job.id).toBe(jobId);
    expect(first?.job.attemptCount).toBe(1);
    await expect(
      store.retryJob(
        first!,
        {
          nextAttemptAt: "2099-08-16T06:02:00.000Z",
          sanitizedError: "DREAMING_PROVIDER_FAILED",
        },
        signal,
      ),
    ).resolves.toBe(true);
    await expect(
      store.claimNextJob(
        "worker-second",
        {
          now: "2099-08-16T06:01:59.999Z",
          leaseSeconds: 60,
          kinds: ["daily_dreaming"],
        },
        signal,
      ),
    ).resolves.toBeNull();
    const second = await store.claimNextJob(
      "worker-second",
      {
        now: "2099-08-16T06:02:00.000Z",
        leaseSeconds: 60,
        kinds: ["daily_dreaming"],
      },
      signal,
    );
    expect(second?.job.attemptCount).toBe(2);
    expect(second?.fencingToken).not.toBe(first?.fencingToken);

    await expect(store.completeJob(first!, signal)).resolves.toBe(false);
    await expect(store.completeJob(second!, signal)).resolves.toBe(true);
  });

  it("materializes separate catch-up days exactly once and claims jobs without duplication", async () => {
    const identity = await seedAutomationAccount(database, {
      nextDreamAt: new Date("2026-08-14T03:00:00.000Z"),
    });
    const first = new DrizzleAutomationStore(database);
    const second = new DrizzleAutomationStore(database);
    const [left, right] = await Promise.all([
      first.materializeDueDreamingRuns(
        "worker-a",
        { now: "2026-08-16T12:00:00.000Z", catchUpLimit: 3 },
        new AbortController().signal,
      ),
      second.materializeDueDreamingRuns(
        "worker-b",
        { now: "2026-08-16T12:00:00.000Z", catchUpLimit: 3 },
        new AbortController().signal,
      ),
    ]);
    expect(left.length + right.length).toBe(3);
    const rows = await database
      .select({ canonicalKey: automationJobs.canonicalKey })
      .from(automationJobs)
      .where(like(automationJobs.canonicalKey, "daily_dreaming:2026-%"));
    expect(new Set(rows.map((row) => row.canonicalKey)).size).toBe(3);

    const [claimA, claimB] = await Promise.all([
      first.claimNextJob(
        "worker-a",
        {
          now: "2026-08-16T12:00:00.000Z",
          leaseSeconds: 60,
          kinds: ["daily_dreaming"],
        },
        new AbortController().signal,
      ),
      second.claimNextJob(
        "worker-b",
        {
          now: "2026-08-16T12:00:00.000Z",
          leaseSeconds: 60,
          kinds: ["daily_dreaming"],
        },
        new AbortController().signal,
      ),
    ]);
    expect(claimA?.job.id).not.toBe(claimB?.job.id);
  });

  it("captures a bounded previous-day snapshot and applies one memory effect idempotently", async () => {
    const identity = await seedAutomationAccount(database, { mode: "apply" });
    const localDate = "2026-08-15";
    const sourceContents = [
      "Distribution began late.",
      "Validation happened after automation.",
    ];
    for (const [position, content] of sourceContents.entries()) {
      const memoryId = randomUUID();
      const recipe = memoryEmbeddingRecipe(content);
      const occurredAt = new Date(
        `2026-08-15T${(position + 9).toString().padStart(2, "0")}:00:00.000Z`,
      );
      await database.insert(memories).values({
        id: memoryId,
        lineageId: memoryId,
        content,
        contentHash: recipe.contentHash,
        effectiveAt: occurredAt,
        actorKind: "account",
        actorAccountId: identity.accountId,
        actorClientId: null,
        actorSource: "direct",
      });
      await database.insert(activityEvents).values({
        entityType: "memory",
        entityId: memoryId,
        action: "created",
        occurredAt,
        effectiveAt: occurredAt,
        afterVersionId: memoryId,
        contentHash: recipe.contentHash,
        requestDigest: recipe.contentHash,
        idempotencyKey: `source:${memoryId}`,
        actorKind: "account",
        actorAccountId: identity.accountId,
        actorClientId: null,
        actorSource: "direct",
        requestId: randomUUID(),
      });
    }
    const jobId = randomUUID();
    const fence = randomUUID();
    await database
      .delete(automationJobs)
      .where(eq(automationJobs.canonicalKey, `daily_dreaming:${localDate}`));
    await database.insert(automationJobs).values({
      id: jobId,
      kind: "daily_dreaming",
      canonicalKey: `daily_dreaming:${localDate}`,
      scheduledFor: new Date("2026-08-16T03:00:00.000Z"),
      status: "running",
      attemptCount: 1,
      leaseOwner: "dream-worker",
      leaseExpiresAt: new Date("2099-08-16T03:10:00.000Z"),
      fencingToken: fence,
      payload: { localDate },
    });
    const store = new DrizzleDreamingStore(database);
    const claim = await store.claimRun(
      "dream-worker",
      {
        automationJobId: jobId,
        now: "2026-08-16T03:01:00.000Z",
        leaseSeconds: 60,
      },
      new AbortController().signal,
    );
    expect(claim).not.toBeNull();
    const snapshot = await store.captureSnapshot(
      claim!,
      {
        maximumEvents: 20,
        maximumPrimaryRecords: 20,
        maximumTargetMemories: 5,
        maximumComparisonRecords: 5,
        maximumCharacters: 40_000,
      },
      new AbortController().signal,
    );
    expect(
      snapshot.evidence.filter((item) => item.role === "primary"),
    ).toHaveLength(2);
    const primaryIndexes = snapshot.evidence
      .filter((item) => item.role === "primary")
      .map((item) => item.index);
    const content = sourceContents.join(" ");
    const secondContent = [...sourceContents].reverse().join(" ");
    const plan = {
      summary: "Two execution lessons were observed.",
      insights: [
        {
          kind: "observation" as const,
          statement: "Distribution and validation sequencing need attention.",
          confidence: "high" as const,
          evidenceIndexes: primaryIndexes,
        },
      ],
      memories: [
        {
          operation: "create" as const,
          content,
          category: "launch",
          tags: ["execution"],
          sourceQuotes: sourceContents,
          evidenceIndexes: primaryIndexes,
        },
        {
          operation: "create" as const,
          content: secondContent,
          category: "launch",
          tags: ["sequence"],
          sourceQuotes: [...sourceContents].reverse(),
          evidenceIndexes: primaryIndexes,
        },
        {
          operation: "create" as const,
          content: `${content} Respect the dreaming kill switch.`,
          category: "launch",
          tags: ["policy"],
          sourceQuotes: sourceContents,
          evidenceIndexes: primaryIndexes,
        },
      ],
    };
    const stalePlanFence = randomUUID();
    let stalePlan!: ReturnType<typeof store.savePlan>;
    await database.transaction(async (transaction) => {
      await transaction
        .update(automationJobs)
        .set({
          fencingToken: stalePlanFence,
          leaseOwner: "plan-takeover-worker",
        })
        .where(eq(automationJobs.id, jobId));
      stalePlan = store.savePlan(
        claim!,
        {
          plan,
          provider: "test-provider",
          model: "test-model",
          inputTokens: 100,
          outputTokens: 50,
          responseDigest: memoryEmbeddingRecipe(JSON.stringify(plan))
            .contentHash,
        },
        new AbortController().signal,
      );
      let settled = false;
      void stalePlan.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);
    });
    await expect(stalePlan).rejects.toThrow("lease was lost");
    await expect(
      database
        .select({ id: dreamingChanges.id })
        .from(dreamingChanges)
        .where(eq(dreamingChanges.runId, claim!.run.id)),
    ).resolves.toEqual([]);
    await database
      .update(automationJobs)
      .set({ fencingToken: fence, leaseOwner: "dream-worker" })
      .where(eq(automationJobs.id, jobId));
    const changes = await store.savePlan(
      claim!,
      {
        plan,
        provider: "test-provider",
        model: "test-model",
        inputTokens: 100,
        outputTokens: 50,
        responseDigest: memoryEmbeddingRecipe(JSON.stringify(plan)).contentHash,
      },
      new AbortController().signal,
    );
    expect(changes[0]?.status).toBe("eligible");
    const [space] = await database
      .insert(embeddingSpaces)
      .values({
        entityType: "memory",
        provider: "test-provider",
        model: "test-embedding",
        modelRevision: "1",
        recipeVersion: memoryEmbeddingRecipe(content).recipeVersion,
        dimensions: 1536,
        status: "active",
        promotedAt: new Date(),
      })
      .returning();
    const recipe = memoryEmbeddingRecipe(content);
    const applied = await store.applyEligibleChange(
      claim!,
      changes[0]!.id,
      {
        verified: true,
        embedding: {
          spaceId: space!.id,
          contentHash: recipe.contentHash,
          vector: [1, ...Array.from({ length: 1535 }, () => 0)],
        },
      },
      new AbortController().signal,
    );
    const replay = await store.applyEligibleChange(
      claim!,
      changes[0]!.id,
      {
        verified: true,
        embedding: {
          spaceId: space!.id,
          contentHash: recipe.contentHash,
          vector: [1, ...Array.from({ length: 1535 }, () => 0)],
        },
      },
      new AbortController().signal,
    );
    expect(replay.resultMemoryId).toBe(applied.resultMemoryId);
    const takeoverFence = randomUUID();
    await database
      .update(automationJobs)
      .set({ fencingToken: takeoverFence, leaseOwner: "takeover-worker" })
      .where(eq(automationJobs.id, jobId));
    const secondRecipe = memoryEmbeddingRecipe(secondContent);
    await expect(
      store.applyEligibleChange(
        claim!,
        changes[1]!.id,
        {
          verified: true,
          embedding: {
            spaceId: space!.id,
            contentHash: secondRecipe.contentHash,
            vector: [1, ...Array.from({ length: 1535 }, () => 0)],
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("lease was lost");
    const unchanged = await database
      .select({ status: dreamingChanges.status })
      .from(dreamingChanges)
      .where(eq(dreamingChanges.id, changes[1]!.id));
    expect(unchanged).toEqual([{ status: "eligible" }]);
    await database
      .update(automationJobs)
      .set({ fencingToken: fence, leaseOwner: "dream-worker" })
      .where(eq(automationJobs.id, jobId));
    const killSwitchRecipe = memoryEmbeddingRecipe(plan.memories[2]!.content);
    let killSwitchApply!: ReturnType<typeof store.applyEligibleChange>;
    await database.transaction(async (transaction) => {
      await transaction
        .update(automationSettings)
        .set({ dreamingMode: "preview" })
        .where(eq(automationSettings.id, 1));
      killSwitchApply = store.applyEligibleChange(
        claim!,
        changes[2]!.id,
        {
          verified: true,
          embedding: {
            spaceId: space!.id,
            contentHash: killSwitchRecipe.contentHash,
            vector: [1, ...Array.from({ length: 1535 }, () => 0)],
          },
        },
        new AbortController().signal,
      );
      let settled = false;
      void killSwitchApply.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);
    });
    await expect(killSwitchApply).resolves.toMatchObject({
      status: "skipped",
      skipReason: "policy_denied",
    });
    await store.skipChange(
      claim!,
      changes[1]!.id,
      "policy_denied",
      new AbortController().signal,
    );
    const finalizationFence = randomUUID();
    let staleFinalize!: ReturnType<typeof store.finalizeRun>;
    await database.transaction(async (transaction) => {
      await transaction
        .update(automationJobs)
        .set({
          fencingToken: finalizationFence,
          leaseOwner: "finalize-takeover-worker",
        })
        .where(eq(automationJobs.id, jobId));
      staleFinalize = store.finalizeRun(
        claim!,
        { coverageWarnings: snapshot.coverageWarnings },
        new AbortController().signal,
      );
      let settled = false;
      void staleFinalize.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);
    });
    await expect(staleFinalize).rejects.toThrow("lease was lost");
    await expect(
      database
        .select({ id: dreamingReports.id })
        .from(dreamingReports)
        .where(eq(dreamingReports.runId, claim!.run.id)),
    ).resolves.toEqual([]);
    const unfinishedRun = await database
      .select({ status: dreamingRuns.status })
      .from(dreamingRuns)
      .where(eq(dreamingRuns.id, claim!.run.id));
    expect(unfinishedRun[0]?.status).not.toMatch(/^completed/u);
    await database
      .update(automationJobs)
      .set({ fencingToken: fence, leaseOwner: "dream-worker" })
      .where(eq(automationJobs.id, jobId));
    const report = await store.finalizeRun(
      claim!,
      { coverageWarnings: snapshot.coverageWarnings },
      new AbortController().signal,
    );
    expect(report.memoriesCreated[0]?.id).toBe(applied.resultMemoryId);
    expect(report.insights[0]?.evidence).toHaveLength(2);

    const anotherAccount = await seedAutomationAccount(database);
    await expect(
      store.getReport(
        anotherAccount.access,
        { kind: "run_id", runId: report.runId },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ runId: report.runId });
    await expect(
      store.getReport(
        identity.access,
        { kind: "run_id", runId: report.runId },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ runId: report.runId });
  });

  it("uses half-open local-day windows across a DST transition", async () => {
    const identity = await seedAutomationAccount(database, {
      timeZone: "America/New_York",
    });
    const jobId = randomUUID();
    await database.insert(automationJobs).values({
      id: jobId,
      kind: "daily_dreaming",
      canonicalKey: "daily_dreaming:2026-11-01",
      scheduledFor: new Date("2026-11-02T08:00:00.000Z"),
      status: "running",
      attemptCount: 1,
      leaseOwner: "dst-worker",
      leaseExpiresAt: new Date("2099-11-02T08:10:00.000Z"),
      fencingToken: randomUUID(),
      payload: { localDate: "2026-11-01" },
    });
    const claim = await new DrizzleDreamingStore(database).claimRun(
      "dst-worker",
      {
        automationJobId: jobId,
        now: "2026-11-02T08:01:00.000Z",
        leaseSeconds: 60,
      },
      new AbortController().signal,
    );
    expect(claim?.run.windowStart).toBe("2026-11-01T04:00:00.000Z");
    expect(claim?.run.windowEnd).toBe("2026-11-02T05:00:00.000Z");
    expect(
      Date.parse(claim!.run.windowEnd) - Date.parse(claim!.run.windowStart),
    ).toBe(25 * 60 * 60 * 1_000);
  });
});
