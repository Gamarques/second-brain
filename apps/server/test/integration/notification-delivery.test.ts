import { randomUUID } from "node:crypto";
import { createEngine, type ExecutionSource } from "@invokta/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase } from "@second-brain/engine/database/client";
import { runMigrations } from "@second-brain/engine/database/migrate";
import { accounts } from "@second-brain/engine/database/schema/identity";
import {
  automationSettings,
  automationJobs,
  notificationChannels,
  reminderDeliveries,
} from "@second-brain/engine/database/schema/automation";
import { reminders } from "@second-brain/engine/database/schema/content";
import { DrizzleBrainAccessStore } from "@second-brain/engine/database/stores/access-store";
import { DrizzleNotificationStore } from "@second-brain/engine/database/stores/notification-store";
import { createNotificationCipher } from "@second-brain/engine/providers/notification-provider";
import { createAdminNotificationCapabilities } from "../../src/services/admin/capabilities/admin-notifications.js";
import { DrizzleAutomationStore } from "../../src/services/automation/persistence/store.js";
import {
  provisionTestDatabase,
  type DisposableTestDatabase,
} from "./support/database.js";
let resource: DisposableTestDatabase;
let db: ReturnType<typeof createDatabase>;
let store: DrizzleNotificationStore;
let jobs: DrizzleAutomationStore;
let engine: ReturnType<
  typeof createEngine<ReturnType<typeof createAdminNotificationCapabilities>>
>;
const accountId = randomUUID();
const channelId = randomUUID();
const signal = new AbortController().signal;
const options = {
  source: "admin" as ExecutionSource,
  principal: { id: accountId },
};
const verify = vi.fn(async () => undefined);
const input = {
  id: channelId,
  kind: "slack" as const,
  name: "Operations",
  destination: "C123456",
  token: "xoxb-synthetic",
  enabled: true,
  expectedRevision: 0,
};
beforeAll(async () => {
  resource = await provisionTestDatabase("notification");
  await runMigrations(resource.pool);
  db = createDatabase(resource.pool);
  await db
    .insert(accounts)
    .values({
      id: accountId,
      email: "notifications@example.test",
      passwordHash: "test",
      role: "owner",
    });
  await db
    .insert(automationSettings)
    .values({ timeZone: "UTC", reminderDeliveryEnabled: true });
  store = new DrizzleNotificationStore(db, {
    cipher: createNotificationCipher(Buffer.alloc(32, 5)),
    provider: { verify, send: vi.fn() },
    encryptionAvailable: true,
  });
  jobs = new DrizzleAutomationStore(db);
  engine = createEngine({
    name: "notifications-test",
    version: "1",
    capabilities: createAdminNotificationCapabilities(
      new DrizzleBrainAccessStore(db),
      store,
    ),
  });
});
afterAll(async () => resource?.destroy());
async function reminder() {
  const id = randomUUID();
  await db
    .insert(reminders)
    .values({
      id,
      message: "Review the proposal",
      remindAt: new Date(Date.now() - 60000),
      actorKind: "account",
      actorAccountId: accountId,
      actorSource: "direct",
    });
  return id;
}
async function claim() {
  const value = await jobs.claimNextJob(
    "test-worker",
    {
      now: new Date().toISOString(),
      leaseSeconds: 300,
      kinds: ["reminder_delivery"],
    },
    signal,
  );
  expect(value).not.toBeNull();
  return value!;
}
it("saves only encrypted credentials and returns safe, revision-guarded channel data through capabilities", async () => {
  const saved = await engine.invoke(
    "admin_notification_channel_save",
    input,
    options,
  );
  expect(saved).toMatchObject({ id: channelId, revision: 1 });
  expect(JSON.stringify(saved)).not.toContain("synthetic");
  expect(
    await engine.invoke("admin_notification_channel_save", input, options),
  ).toMatchObject({ revision: 1 });
  const [row] = await db.select().from(notificationChannels);
  expect(row!.encryptedConfig).not.toContain("synthetic");
  await expect(
    engine.invoke(
      "admin_notification_channel_save",
      { ...input, name: "Changed" },
      options,
    ),
  ).rejects.toThrow();
  expect(
    JSON.stringify(
      await engine.invoke("admin_notification_channels_list", {}, options),
    ),
  ).not.toContain("synthetic");
});
it("materializes once under concurrent polls, suppresses completed work and delivers a new occurrence after snooze", async () => {
  const id = await reminder();
  await Promise.all([
    store.materialize(new Date(), signal),
    store.materialize(new Date(), signal),
  ]);
  expect(
    (
      await db
        .select()
        .from(reminderDeliveries)
        .where(eq(reminderDeliveries.reminderId, id))
    ).length,
  ).toBe(1);
  const first = await claim();
  await db
    .update(reminders)
    .set({ completedAt: new Date(), historyVersion: 2 })
    .where(eq(reminders.id, id));
  expect(await store.prepare(first, signal)).toBeNull();
  await jobs.completeJob(first, signal);
  await db
    .update(reminders)
    .set({
      completedAt: null,
      historyVersion: 3,
      remindAt: new Date(Date.now() - 1000),
    })
    .where(eq(reminders.id, id));
  await store.materialize(new Date(), signal);
  const next = await claim();
  const prepared = await store.prepare(next, signal);
  expect(prepared?.message).toContain("Review the proposal");
  await store.finish(
    next,
    { status: "delivered", messageId: "123.456" },
    signal,
  );
  await jobs.completeJob(next, signal);
  await store.materialize(new Date(), signal);
  expect(
    await jobs.claimNextJob(
      "test-worker",
      {
        now: new Date().toISOString(),
        leaseSeconds: 300,
        kinds: ["reminder_delivery"],
      },
      signal,
    ),
  ).toBeNull();
});
it("never repeats an in-flight send after lease recovery and rejects stale workers", async () => {
  await reminder();
  await store.materialize(new Date(), signal);
  const old = await claim();
  expect(await store.prepare(old, signal)).not.toBeNull();
  await db
    .update(automationJobs)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(automationJobs.id, old.job.id));
  const fresh = await claim();
  expect(
    await store.finish(
      old,
      { status: "delivered", messageId: "stale" },
      signal,
    ),
  ).toBe(false);
  expect(await store.prepare(fresh, signal)).toBeNull();
  const [delivery] = await db
    .select()
    .from(reminderDeliveries)
    .where(eq(reminderDeliveries.automationJobId, fresh.job.id));
  expect(delivery!.status).toBe("uncertain");
  await jobs.completeJob(fresh, signal);
});
it("rechecks owner access after channel verification", async () => {
  verify.mockImplementationOnce(async () => {
    await db
      .update(accounts)
      .set({ role: "admin" })
      .where(eq(accounts.id, accountId));
  });
  await expect(
    engine.invoke(
      "admin_notification_channel_save",
      { ...input, id: randomUUID() },
      options,
    ),
  ).rejects.toThrow();
  await db
    .update(accounts)
    .set({ role: "owner" })
    .where(eq(accounts.id, accountId));
});

it("cancels a queued occurrence when the channel configuration changes and pages recent receipts without gaps", async () => {
  await reminder();
  await store.materialize(new Date(), signal);
  const queued = await claim();
  await engine.invoke("admin_notification_channel_save", { ...input, enabled: false, expectedRevision: 1 }, options);
  expect(await store.prepare(queued, signal)).toBeNull();
  await jobs.completeJob(queued, signal);
  const rows = await db.select().from(reminderDeliveries);
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: { deliveries: readonly { id: string }[]; nextCursor: string | null } = await engine.invoke("admin_notification_deliveries_list", { cursor, limit: 1 }, options);
    for (const row of page.deliveries) { expect(ids.has(row.id)).toBe(false); ids.add(row.id); }
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids.size).toBe(rows.length);
  expect((await db.select().from(reminderDeliveries).where(eq(reminderDeliveries.automationJobId,queued.job.id)))[0]!.status).toBe("canceled");
});
