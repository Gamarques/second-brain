import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema } from "@second-brain/engine/database/schema/index";
import { adminAuditEvents } from "@second-brain/engine/database/schema/admin";
import {
  automationJobs,
  automationSettings,
  automationWorkerHeartbeats,
} from "@second-brain/engine/database/schema/automation";
import { accounts } from "@second-brain/engine/database/schema/identity";
import { mutationReceipts } from "@second-brain/engine/database/schema/temporal";
import {
  AdminAutomationIdempotencyConflictError,
  AdminDreamingDateError,
  AdminDreamingDisabledError,
  DrizzleAdminAutomationStore,
} from "../../src/services/admin/persistence/automation-store.js";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import type { BrainAccessContext, BrainRole } from "@second-brain/engine/domain";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

async function runMigrations(resource: DisposableTestDatabase): Promise<void> {
  const migrationModule = (await import("@second-brain/engine/database/migrate")) as {
    runMigrations?: (pool: DisposableTestDatabase["pool"]) => Promise<void>;
  };
  if (!migrationModule.runMigrations) {
    throw new Error("runMigrations is not exported.");
  }
  await migrationModule.runMigrations(resource.pool);
}

async function seedAccess(
  database: SecondBrainDatabase,
  role: BrainRole = "admin",
): Promise<BrainAccessContext> {
  const accountId = randomUUID();
  const requestId = randomUUID();
  await database.insert(accounts).values({
    id: accountId,
    email: `${accountId}@example.com`,
    passwordHash: "admin-automation-test-password-hash",
    role,
  });
  return {
    accountId,
    role,
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

async function seedSettings(
  database: SecondBrainDatabase,
  dreamingEnabled: boolean,
): Promise<void> {
  await database.insert(automationSettings).values({
    id: 1,
    timeZone: "UTC",
    dreamingEnabled,
    dreamingMode: "preview",
    dreamLocalTime: "03:00",
    dailyInputTokenLimit: 20_000,
    dailyOutputTokenLimit: 2_000,
    nextDreamAt: dreamingEnabled ? new Date("2099-01-01T03:00:00.000Z") : null,
  });
}

describe("Drizzle admin automation store", () => {
  let resource: DisposableTestDatabase;
  let database: SecondBrainDatabase;

  beforeAll(async () => {
    resource = await provisionTestDatabase("admin_automation_store");
    await runMigrations(resource);
    database = drizzle(resource.pool, { schema });
  }, 180_000);

  beforeEach(async () => {
    await database.delete(automationJobs);
    await database.delete(automationWorkerHeartbeats);
    await database.delete(mutationReceipts);
    await database.delete(automationSettings);
    await database.delete(accounts);
  });

  afterAll(async () => {
    await resource?.destroy();
  });

  it("reads and idempotently revision-updates the complete settings with one safe audit", async () => {
    const access = await seedAccess(database);
    await seedSettings(database, false);
    const store = new DrizzleAdminAutomationStore(database);

    await expect(
      store.getSettings(access, new AbortController().signal),
    ).resolves.toMatchObject({
      timeZone: "UTC",
      dreamingEnabled: false,
      dreamingMode: "preview",
      dailyInputTokenLimit: 20_000,
      dailyOutputTokenLimit: 2_000,
      revision: 1,
    });

    const input = {
      expectedRevision: 1,
      idempotencyKey: "settings-preview-enable",
      timeZone: "America/Sao_Paulo",
      dreamingEnabled: true,
      dreamingMode: "preview" as const,
      dailyInputTokenLimit: 30_000,
      dailyOutputTokenLimit: 3_000,
    };
    const first = await store.updateSettings(
      access,
      input,
      new AbortController().signal,
    );
    const replay = await store.updateSettings(
      access,
      input,
      new AbortController().signal,
    );

    expect(first).toMatchObject({
      timeZone: "America/Sao_Paulo",
      dreamingEnabled: true,
      dreamingMode: "preview",
      dailyInputTokenLimit: 30_000,
      dailyOutputTokenLimit: 3_000,
      revision: 2,
    });
    expect(replay).toEqual(first);
    await expect(
      store.updateSettings(
        access,
        { ...input, dreamingMode: "apply" },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(AdminAutomationIdempotencyConflictError);

    const auditRows = await database
      .select({
        action: adminAuditEvents.action,
        metadata: adminAuditEvents.metadata,
        changedNames: adminAuditEvents.changedNames,
      })
      .from(adminAuditEvents)
      .where(
        and(
          eq(adminAuditEvents.requestId, access.actor.requestId),
          eq(adminAuditEvents.action, "automation.settings.updated"),
        ),
      );
    expect(auditRows).toEqual([
      {
        action: "automation.settings.updated",
        changedNames: [],
        metadata: {
          changedNames: [
            "dailyInputTokenLimit",
            "dailyOutputTokenLimit",
            "dreamingEnabled",
            "dreamingMode",
            "timeZone",
          ],
        },
      },
    ]);
  });

  it("requires a live admin role for every operation", async () => {
    const access = await seedAccess(database, "editor");
    await seedSettings(database, false);
    const store = new DrizzleAdminAutomationStore(database);

    await expect(
      store.getSettings(access, new AbortController().signal),
    ).rejects.toMatchObject({ code: "BRAIN_ACCESS_DENIED" });
    await expect(
      store.updateSettings(
        access,
        {
          expectedRevision: 1,
          idempotencyKey: "editor-update",
          dreamingEnabled: true,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "BRAIN_ACCESS_DENIED" });
  });

  it("enforces the kill switch, completed-day bound, canonical dedupe, and audit idempotency", async () => {
    const access = await seedAccess(database);
    await seedSettings(database, false);
    const store = new DrizzleAdminAutomationStore(database);
    const signal = new AbortController().signal;

    await expect(
      store.enqueueDreamingRun(
        access,
        { localDate: "2026-08-22", idempotencyKey: "disabled-run" },
        signal,
      ),
    ).rejects.toBeInstanceOf(AdminDreamingDisabledError);
    await database
      .update(automationSettings)
      .set({ dreamingEnabled: true })
      .where(eq(automationSettings.id, 1));
    const todayResult = await resource.pool.query<{ today: string }>(
      // Match the seeded schedule even when PostgreSQL uses another time zone.
      "select (current_timestamp at time zone 'UTC')::date::text as today",
    );
    const today = todayResult.rows[0]!.today;
    await expect(
      store.enqueueDreamingRun(
        access,
        { localDate: today, idempotencyKey: "current-day" },
        signal,
      ),
    ).rejects.toBeInstanceOf(AdminDreamingDateError);

    const first = await store.enqueueDreamingRun(
      access,
      { localDate: "2000-01-01", idempotencyKey: "run-2000" },
      signal,
    );
    const replay = await store.enqueueDreamingRun(
      access,
      { localDate: "2000-01-01", idempotencyKey: "run-2000" },
      signal,
    );
    const canonicalReplay = await store.enqueueDreamingRun(
      access,
      { localDate: "2000-01-01", idempotencyKey: "run-2000-second-key" },
      signal,
    );

    expect(first).toMatchObject({ created: true, job: { status: "pending" } });
    expect(replay).toMatchObject({ created: false, job: { id: first.job.id } });
    expect(canonicalReplay).toMatchObject({
      created: false,
      job: { id: first.job.id },
    });
    await expect(
      database
        .select()
        .from(automationJobs)
        .where(eq(automationJobs.canonicalKey, "daily_dreaming:2000-01-01")),
    ).resolves.toHaveLength(1);
    await expect(
      database
        .select()
        .from(adminAuditEvents)
        .where(
          and(
            eq(adminAuditEvents.requestId, access.actor.requestId),
            eq(adminAuditEvents.action, "automation.dreaming.enqueued"),
          ),
        ),
    ).resolves.toHaveLength(2);
    await database
      .update(automationSettings)
      .set({ dreamingEnabled: false, nextDreamAt: null })
      .where(eq(automationSettings.id, 1));
    await expect(
      store.enqueueDreamingRun(
        access,
        { localDate: "2000-01-01", idempotencyKey: "run-2000" },
        signal,
      ),
    ).rejects.toBeInstanceOf(AdminDreamingDisabledError);
  });

  it("reports heartbeat health and paginates filtered jobs without payloads", async () => {
    const access = await seedAccess(database);
    await seedSettings(database, true);
    const now = new Date();
    await database.insert(automationWorkerHeartbeats).values([
      {
        workerId: "healthy-worker",
        version: "1.2.0",
        startedAt: new Date(now.valueOf() - 3_600_000),
        lastSeenAt: new Date(now.valueOf() + 30_000),
      },
      {
        workerId: "stale-worker",
        version: "1.1.0",
        startedAt: new Date(now.valueOf() - 7_200_000),
        lastSeenAt: new Date(now.valueOf() - 300_000),
      },
    ]);
    await database.insert(automationJobs).values([
      {
        kind: "daily_dreaming",
        canonicalKey: `daily_dreaming:page:${randomUUID()}`,
        scheduledFor: now,
        payload: { private: "must-not-be-returned" },
        updatedAt: new Date(now.valueOf() - 1_000),
      },
      {
        kind: "daily_dreaming",
        canonicalKey: `daily_dreaming:page:${randomUUID()}`,
        scheduledFor: now,
        payload: { private: "must-not-be-returned" },
        updatedAt: new Date(now.valueOf() - 2_000),
      },
      {
        kind: "reminder_delivery",
        canonicalKey: `reminder:page:${randomUUID()}`,
        scheduledFor: now,
      },
    ]);
    await database.insert(automationJobs).values({
      kind: "reminder_delivery",
      canonicalKey: `reminder:completed:${randomUUID()}`,
      scheduledFor: now,
      status: "completed",
      updatedAt: new Date("2026-08-23T12:34:56.000Z"),
    });
    const store = new DrizzleAdminAutomationStore(database);
    const signal = new AbortController().signal;

    await expect(store.getStatus(access, signal)).resolves.toMatchObject({
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      workers: [
        { workerId: "healthy-worker", health: "healthy" },
        { workerId: "stale-worker", health: "stale" },
      ],
      jobs: {
        pending: 3,
        running: 0,
        retryWait: 0,
        failed: 0,
        lastCompletedAt: "2026-08-23T12:34:56.000Z",
      },
    });
    const first = await store.listJobs(
      access,
      { kind: "daily_dreaming", status: "pending", cursor: null, limit: 1 },
      signal,
    );
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items[0]).not.toHaveProperty("payload");
    const second = await store.listJobs(
      access,
      {
        kind: "daily_dreaming",
        status: "pending",
        cursor: first.nextCursor,
        limit: 1,
      },
      signal,
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });
});
