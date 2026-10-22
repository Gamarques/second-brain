import { randomUUID } from "node:crypto";
import { createEngine, type ExecutionSource } from "@invokta/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase } from "@second-brain/engine/database/client";
import { runMigrations } from "@second-brain/engine/database/migrate";
import { accounts } from "@second-brain/engine/database/schema/identity";
import { automationJobs, automationSettings } from "@second-brain/engine/database/schema/automation";
import { dreamingRuns } from "@second-brain/engine/database/schema/dreaming";
import { DrizzleBrainAccessStore } from "@second-brain/engine/database/stores/access-store";
import { DrizzleDreamingStore } from "@second-brain/engine/database/stores/dreaming-store";
import { createAdminDreamingCapabilities } from "../../src/services/admin/capabilities/admin-dreaming.js";
import { DrizzleAdminDreamingStore } from "../../src/services/admin/persistence/dreaming-store.js";
import { provisionTestDatabase, type DisposableTestDatabase } from "./support/database.js";

let resource: DisposableTestDatabase;
let database: ReturnType<typeof createDatabase>;
let engine: ReturnType<typeof createEngine<ReturnType<typeof createAdminDreamingCapabilities>>>;
const accountId = randomUUID();
const options = { source: "admin" as ExecutionSource, principal: { id: accountId } };
beforeAll(async () => {
  resource = await provisionTestDatabase("dreaming_calendar"); await runMigrations(resource.pool); database = createDatabase(resource.pool);
  await database.insert(accounts).values({ id: accountId, email: "calendar@example.test", passwordHash: "test", role: "admin" });
  await database.insert(automationSettings).values({ id: 1, dreamingEnabled: true, dreamingMode: "apply", timeZone: "UTC" });
  engine = createEngine({ name: "calendar", version: "1", capabilities: createAdminDreamingCapabilities(new DrizzleBrainAccessStore(database), new DrizzleAdminDreamingStore(database)) });
}, 180_000);
afterAll(async () => { await resource?.destroy(); });

it("creates one preview replay under concurrent requests, retaining the failed job and its original window", async () => {
  const jobId = randomUUID(); const runId = randomUUID();
  await database.insert(automationJobs).values({ id: jobId, kind: "daily_dreaming", canonicalKey: "daily_dreaming:2020-01-06", scheduledFor: new Date("2020-01-07T03:00:00Z"), status: "failed", attemptCount: 5, sanitizedError: "DREAMING_PROVIDER_FAILED", payload: { localDate: "2020-01-06" } });
  await database.insert(dreamingRuns).values({ id: runId, automationJobId: jobId, localDate: "2020-01-06", timeZone: "America/Sao_Paulo", windowStart: new Date("2020-01-06T03:00:00Z"), windowEnd: new Date("2020-01-07T03:00:00Z"), mode: "apply", status: "failed", attemptCount: 5, settingsRevision: 1, pipelineVersion: "test", promptVersion: "test", schemaVersion: "test", policyVersion: "test" });
  const results = await Promise.all(["first", "second"].map((key) => engine.invoke("admin_dreaming_retry", { jobId, idempotencyKey: key }, options)));
  expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
  expect(results.filter((result) => result.created)).toHaveLength(1);
  expect(results[0]!.mode).toBe("preview");
  expect((await database.select().from(automationJobs).where(eq(automationJobs.id, jobId)))[0]).toMatchObject({ status: "failed", attemptCount: 5, sanitizedError: "DREAMING_PROVIDER_FAILED" });
  const replayJobId = results[0]!.jobId;
  await database.update(automationJobs).set({ status: "running", leaseOwner: "replay-worker", leaseExpiresAt: new Date(Date.now() + 60_000), fencingToken: randomUUID(), attemptCount: 1 }).where(eq(automationJobs.id, replayJobId));
  const claim = await new DrizzleDreamingStore(database).claimRun("replay-worker", { automationJobId: replayJobId, now: new Date().toISOString(), leaseSeconds: 60 }, new AbortController().signal);
  expect(claim?.run).toMatchObject({ mode: "preview", localDate: "2020-01-06", timeZone: "America/Sao_Paulo", windowStart: "2020-01-06T03:00:00.000Z", replayOfRunId: runId });
  const runs = await database.select().from(dreamingRuns);
  expect(runs).toHaveLength(2);
  expect(runs.find((row) => row.id === runId)).toMatchObject({ canonical: true, status: "failed", attemptCount: 5 });
  expect(runs.find((row) => row.id !== runId)).toMatchObject({ canonical: false, replayOfRunId: runId });
  const calendar = await engine.invoke("admin_dreaming_calendar_get", { month: "2020-01" }, options);
  expect(calendar.items).toHaveLength(2);
  expect(calendar.items.find((item) => item.jobId === jobId)).toMatchObject({ canRetry: false, status: "failed" });
});

it("rejects running jobs and idempotency-key reuse without creating more work", async () => {
  const jobId = randomUUID();
  await database.insert(automationJobs).values({ id: jobId, kind: "daily_dreaming", canonicalKey: "daily_dreaming:2020-01-08", scheduledFor: new Date(), status: "pending", payload: { localDate: "2020-01-08" } });
  await expect(engine.invoke("admin_dreaming_retry", { jobId, idempotencyKey: "pending" }, options)).rejects.toMatchObject({ cause: { code: "REVISION_CONFLICT" } });
  await expect(engine.invoke("admin_dreaming_retry", { jobId, idempotencyKey: "first" }, options)).rejects.toMatchObject({ cause: { code: "IDEMPOTENCY_KEY_REUSED" } });
  expect((await engine.invoke("admin_dreaming_calendar_get", { month: "2020-02" }, options)).items).toEqual([]);
});

it("retries a job that failed before creating a run and retains inherited replay lineage", async () => {
  const sourceId = randomUUID();
  await database.insert(automationJobs).values({ id: sourceId, kind: "daily_dreaming", canonicalKey: "daily_dreaming:2020-01-10", scheduledFor: new Date(), status: "failed", payload: { localDate: "2020-01-10" } });
  const first = await engine.invoke("admin_dreaming_retry", { jobId: sourceId, idempotencyKey: "before-claim" }, options);
  const claimJob = async (jobId: string) => {
    await database.update(automationJobs).set({ status: "running", leaseOwner: "worker-no-run", leaseExpiresAt: new Date(Date.now() + 60_000), fencingToken: randomUUID(), attemptCount: 1 }).where(eq(automationJobs.id, jobId));
    return new DrizzleDreamingStore(database).claimRun("worker-no-run", { automationJobId: jobId, now: new Date().toISOString(), leaseSeconds: 60 }, new AbortController().signal);
  };
  const firstClaim = await claimJob(first.jobId);
  expect(firstClaim?.run).toMatchObject({ mode: "preview", replayOfRunId: null });
  await database.update(automationJobs).set({ status: "failed", leaseOwner: null, leaseExpiresAt: null, fencingToken: null }).where(eq(automationJobs.id, first.jobId));
  const second = await engine.invoke("admin_dreaming_retry", { jobId: first.jobId, idempotencyKey: "second-generation" }, options);
  // A worker can fail before creating the second run; the next request must
  // still find the earlier canonical run rather than collide with its date.
  await database.update(automationJobs).set({ status: "failed" }).where(eq(automationJobs.id, second.jobId));
  const third = await engine.invoke("admin_dreaming_retry", { jobId: second.jobId, idempotencyKey: "third-generation" }, options);
  expect((await claimJob(third.jobId))?.run).toMatchObject({ mode: "preview", replayOfRunId: firstClaim!.run.id });
});

it("denies disabled automation and revoked administrative access", async () => {
  const sourceId = randomUUID();
  await database.insert(automationJobs).values({ id: sourceId, kind: "daily_dreaming", canonicalKey: "daily_dreaming:2020-01-12", scheduledFor: new Date(), status: "failed", payload: { localDate: "2020-01-12" } });
  await database.update(automationSettings).set({ dreamingEnabled: false }).where(eq(automationSettings.id, 1));
  await expect(engine.invoke("admin_dreaming_retry", { jobId: sourceId, idempotencyKey: "disabled" }, options)).rejects.toMatchObject({ cause: { code: "DREAMING_DISABLED" } });
  await database.update(accounts).set({ role: "viewer" }).where(eq(accounts.id, accountId));
  await expect(engine.invoke("admin_dreaming_calendar_get", { month: "2020-01" }, options)).rejects.toBeDefined();
});
