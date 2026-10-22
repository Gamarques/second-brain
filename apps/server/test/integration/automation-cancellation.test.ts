import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema } from "@second-brain/engine/database/schema/index";
import { automationJobs } from "@second-brain/engine/database/schema/automation";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import type { ClaimedAutomationJob } from "@second-brain/engine/domain";
import { DrizzleAutomationStore } from "../../src/services/automation/persistence/store.js";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

async function runMigrations(resource: DisposableTestDatabase): Promise<void> {
  const migrationModule = (await import("@second-brain/engine/database/migrate")) as {
    runMigrations?: (pool: DisposableTestDatabase["pool"]) => Promise<void>;
  };
  if (!migrationModule.runMigrations) throw new Error("runMigrations is not exported.");
  await migrationModule.runMigrations(resource.pool);
}

const signal = new AbortController().signal;
// Leases are compared against the wall clock when a job finishes, so the clock here must be the real one.
const now = new Date();
const iso = now.toISOString();

describe("automation job cancellation", () => {
  let resource: DisposableTestDatabase;
  let database: SecondBrainDatabase;
  let store: DrizzleAutomationStore;

  beforeAll(async () => {
    resource = await provisionTestDatabase("automation_cancellation");
    await runMigrations(resource);
    database = drizzle(resource.pool, { schema }) as unknown as SecondBrainDatabase;
    store = new DrizzleAutomationStore(database);
  });

  afterAll(async () => {
    await resource?.destroy();
  });

  async function insertJob(values: Partial<typeof automationJobs.$inferInsert> = {}) {
    const id = randomUUID();
    await database.insert(automationJobs).values({
      id,
      kind: "daily_dreaming",
      canonicalKey: `daily-dreaming:${id}`,
      scheduledFor: new Date(now.getTime() - 60_000),
      status: "pending",
      ...values,
    });
    return id;
  }

  async function readJob(id: string) {
    const rows = await database.select().from(automationJobs).where(eq(automationJobs.id, id));
    return rows[0]!;
  }

  it("cancels a waiting job outright and records who asked", async () => {
    const pending = await insertJob();
    const waiting = await insertJob({ status: "retry_wait", nextAttemptAt: new Date(now.getTime() + 60_000), attemptCount: 1 });

    const canceled = await store.requestCancel(pending, { requestedBy: "owner-1", now: iso }, signal);
    expect(canceled).toMatchObject({ id: pending, status: "canceled", cancelRequestedAt: iso });
    await expect(store.requestCancel(waiting, { requestedBy: "owner-1", now: iso }, signal)).resolves.toMatchObject({ status: "canceled" });
    expect((await readJob(pending)).payload).toMatchObject({ cancelRequestedBy: "owner-1" });
    expect((await readJob(waiting)).nextAttemptAt).toBeNull();

    await expect(store.requestCancel(randomUUID(), { requestedBy: "owner-1", now: iso }, signal)).resolves.toBeNull();
    const again = await store.requestCancel(pending, { requestedBy: "owner-2", now: iso }, signal);
    expect(again).toMatchObject({ status: "canceled" });
    expect((await readJob(pending)).payload).toMatchObject({ cancelRequestedBy: "owner-1" });
  });

  it("flags a running job, lets its worker see the request, and finishes it as canceled without a retry", async () => {
    const id = await insertJob();
    const claim = await store.claimNextJob("worker-1", { now: iso, leaseSeconds: 300, kinds: ["daily_dreaming"] }, signal);
    expect(claim?.job.id).toBe(id);

    await expect(store.cancelRequested(claim!, signal)).resolves.toBe(false);
    const flagged = await store.requestCancel(id, { requestedBy: "owner-1", now: iso }, signal);
    expect(flagged).toMatchObject({ id, status: "running", cancelRequestedAt: iso });
    await expect(store.cancelRequested(claim!, signal)).resolves.toBe(true);

    // The lease still renews so the worker can stop cleanly at a stage boundary.
    const renewed = await store.renewLease(claim!, { now: iso, leaseSeconds: 300 }, signal);
    expect(renewed?.job.cancelRequestedAt).toBe(iso);

    await expect(store.cancelJob(claim!, signal)).resolves.toBe(true);
    const row = await readJob(id);
    expect(row.status).toBe("canceled");
    expect(row.leaseOwner).toBeNull();
    expect(row.fencingToken).toBeNull();
    await expect(store.completeJob(claim!, signal)).resolves.toBe(false);
  });

  it("turns a retry of a cancel-requested job into a cancellation", async () => {
    const id = await insertJob();
    const claim = (await store.claimNextJob("worker-1", { now: iso, leaseSeconds: 300, kinds: ["daily_dreaming"] }, signal))!;
    await store.requestCancel(id, { requestedBy: "owner-1", now: iso }, signal);

    await expect(store.retryJob(claim, { nextAttemptAt: new Date(now.getTime() + 60_000).toISOString(), sanitizedError: "PROVIDER_RETRY" }, signal)).resolves.toBe(true);

    const row = await readJob(id);
    expect(row.status).toBe("canceled");
    expect(row.nextAttemptAt).toBeNull();
  });

  it("sweeps an abandoned cancel-requested job instead of re-claiming it", async () => {
    const id = await insertJob({
      status: "running",
      attemptCount: 1,
      leaseOwner: "worker-gone",
      leaseExpiresAt: new Date(now.getTime() - 1_000),
      fencingToken: randomUUID(),
      cancelRequestedAt: new Date(now.getTime() - 120_000),
    });
    const other = await insertJob();

    const claim = await store.claimNextJob("worker-2", { now: iso, leaseSeconds: 300, kinds: ["daily_dreaming"] }, signal);

    expect(claim?.job.id).toBe(other);
    const swept = await readJob(id);
    expect(swept.status).toBe("canceled");
    expect(swept.leaseOwner).toBeNull();
  });

  it("validates the requester before touching the database", async () => {
    const claim: ClaimedAutomationJob = {
      job: { id: randomUUID(), kind: "daily_dreaming", canonicalKey: "x", scheduledFor: iso, status: "running", attemptCount: 1, nextAttemptAt: null, leaseOwner: "w", leaseExpiresAt: iso, fencingToken: randomUUID(), cancelRequestedAt: null, sanitizedError: null, createdAt: iso, updatedAt: iso },
      workerId: "w",
      fencingToken: randomUUID(),
    };
    await expect(store.requestCancel(claim.job.id, { requestedBy: "   ", now: iso }, signal)).rejects.toThrow(/requestedBy/u);
    await expect(store.requestCancel(claim.job.id, { requestedBy: "owner-1", now: "yesterday" }, signal)).rejects.toThrow(/now/u);
  });
});
