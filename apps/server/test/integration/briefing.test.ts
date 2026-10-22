import { randomUUID } from "node:crypto";
import { createEngine, type ExecutionSource } from "@invokta/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase } from "@second-brain/engine/database/client";
import { runMigrations } from "@second-brain/engine/database/migrate";
import { accounts } from "@second-brain/engine/database/schema/identity";
import { automationJobs } from "@second-brain/engine/database/schema/automation";
import {
  dreamingEvidence,
  dreamingReports,
  dreamingRuns,
} from "@second-brain/engine/database/schema/dreaming";
import { briefingActions } from "@second-brain/engine/database/schema/briefing";
import {
  taskLists,
  tasks,
  reminders,
} from "@second-brain/engine/database/schema/content";
import { DrizzleBrainAccessStore } from "@second-brain/engine/database/stores/access-store";
import { DrizzleBriefingStore } from "@second-brain/engine/database/stores/briefing-store";
import { createAdminBriefingCapabilities } from "../../src/services/admin/capabilities/admin-briefing.js";
import {
  provisionTestDatabase,
  type DisposableTestDatabase,
} from "./support/database.js";
let resource: DisposableTestDatabase;
let database: ReturnType<typeof createDatabase>;
let engine: ReturnType<
  typeof createEngine<ReturnType<typeof createAdminBriefingCapabilities>>
>;
const accountId = randomUUID();
const listId = randomUUID();
const reportId = randomUUID();
const runId = randomUUID();
const evidenceId = randomUUID();
const options = {
  source: "admin" as ExecutionSource,
  principal: { id: accountId },
};
beforeAll(async () => {
  resource = await provisionTestDatabase("briefing");
  await runMigrations(resource.pool);
  database = createDatabase(resource.pool);
  await database
    .insert(accounts)
    .values({
      id: accountId,
      email: "briefing@example.test",
      passwordHash: "test",
      role: "admin",
    });
  await database
    .insert(taskLists)
    .values({
      id: listId,
      name: "Briefing tasks",
      actorKind: "account",
      actorAccountId: accountId,
      actorSource: "direct",
    });
  const jobId = randomUUID();
  await database
    .insert(automationJobs)
    .values({
      id: jobId,
      kind: "daily_dreaming",
      canonicalKey: "daily_dreaming:2020-01-01",
      scheduledFor: new Date(),
      status: "completed",
      payload: { localDate: "2020-01-01" },
    });
  await database
    .insert(dreamingRuns)
    .values({
      id: runId,
      automationJobId: jobId,
      localDate: "2020-01-01",
      timeZone: "UTC",
      windowStart: new Date("2020-01-01T00:00:00Z"),
      windowEnd: new Date("2020-01-02T00:00:00Z"),
      mode: "preview",
      status: "completed",
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
      observedAt: new Date(),
      effectiveAt: new Date(),
      excerpt: "The product review is unresolved.",
      contentHash: "a".repeat(64),
    });
  await database
    .insert(dreamingReports)
    .values({
      id: reportId,
      runId,
      localDate: "2020-01-01",
      mode: "preview",
      status: "completed",
      summary: "Review pending.",
      insights: [0, 1, 2].map((index) => ({
        kind: "open_loop",
        statement: `Review open question ${index}.`,
        confidence: "high",
        evidence: [
          {
            type: "activity",
            id: evidenceId,
            versionId: null,
            excerpt: "Review is unresolved.",
          },
        ],
      })),
    });
  engine = createEngine({
    name: "briefing",
    version: "1",
    capabilities: createAdminBriefingCapabilities(
      new DrizzleBrainAccessStore(database),
      new DrizzleBriefingStore(database),
    ),
  });
}, 180_000);
afterAll(async () => {
  await resource?.destroy();
});
it("creates one task under concurrent requests and closes the insight when work is completed", async () => {
  const briefing = await engine.invoke("admin_briefing_get", {}, options);
  const insight = briefing.insights[0]!;
  const input = {
    reportId,
    insightIndex: insight.index,
    expectedDigest: insight.digest,
    kind: "task" as const,
    text: "Prepare the product review",
    listId,
    dueAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const [first, second] = await Promise.all(
    ["task-one", "task-two"].map((idempotencyKey) =>
      engine.invoke(
        "admin_briefing_act",
        { ...input, idempotencyKey },
        options,
      ),
    ),
  );
  expect(first).toEqual(second);
  expect(await database.select().from(tasks)).toHaveLength(1);
  const current = await engine.invoke("admin_briefing_get", {}, options);
  expect(
    current.insights.find((item) => item.index === insight.index)?.actions,
  ).toEqual([first]);
  expect(current.dueTasks).toHaveLength(1);
  await expect(
    engine.invoke(
      "admin_briefing_act",
      { ...input, text: "Different task", idempotencyKey: "other-title" },
      options,
    ),
  ).rejects.toMatchObject({ cause: { code: "BRIEFING_CONFLICT" } });
  await database
    .update(tasks)
    .set({ status: "done", completedAt: new Date() })
    .where(eq(tasks.id, first!.entityId!));
  expect(
    (await engine.invoke("admin_briefing_get", {}, options)).insights.some(
      (item) => item.index === insight.index,
    ),
  ).toBe(false);
});
it("creates a reminder only after an explicit future schedule and saves resolution without domain effects", async () => {
  const insight = (await engine.invoke("admin_briefing_get", {}, options))
    .insights[0]!;
  const input = {
    reportId,
    insightIndex: insight.index,
    expectedDigest: insight.digest,
    kind: "reminder" as const,
    text: "Review the product notes",
    idempotencyKey: "reminder-one",
  };
  await expect(
    engine.invoke(
      "admin_briefing_act",
      { ...input, dueAt: "2020-01-01T00:00:00Z" },
      options,
    ),
  ).rejects.toMatchObject({ cause: { code: "BRIEFING_CONFLICT" } });
  const result = await engine.invoke(
    "admin_briefing_act",
    { ...input, dueAt: new Date(Date.now() + 3600000).toISOString() },
    options,
  );
  expect(result.kind).toBe("reminder");
  expect(await database.select().from(reminders)).toHaveLength(1);
  await engine.invoke(
    "admin_briefing_act",
    {
      reportId,
      insightIndex: insight.index,
      expectedDigest: insight.digest,
      kind: "resolve",
      idempotencyKey: "resolve-insight",
    },
    options,
  );
  expect(
    (await engine.invoke("admin_briefing_get", {}, options)).insights.some(
      (item) => item.index === insight.index,
    ),
  ).toBe(false);
  expect(await database.select().from(reminders)).toHaveLength(1);
});
it("rejects stale evidence, reused request keys and revoked access without creating records", async () => {
  const insight = (await engine.invoke("admin_briefing_get", {}, options))
    .insights[0]!;
  const input = {
    reportId,
    insightIndex: insight.index,
    expectedDigest: insight.digest,
    kind: "task" as const,
    text: "New task",
    listId,
    idempotencyKey: "stale-task",
  };
  await expect(
    engine.invoke(
      "admin_briefing_act",
      { ...input, expectedDigest: "0".repeat(64) },
      options,
    ),
  ).rejects.toMatchObject({ cause: { code: "BRIEFING_CONFLICT" } });
  await expect(
    engine.invoke(
      "admin_briefing_act",
      { ...input, idempotencyKey: "task-one" },
      options,
    ),
  ).rejects.toMatchObject({ cause: { code: "BRIEFING_CONFLICT" } });
  await database
    .update(dreamingEvidence)
    .set({ redactedAt: new Date() })
    .where(eq(dreamingEvidence.id, evidenceId));
  await expect(
    engine.invoke("admin_briefing_act", input, options),
  ).rejects.toMatchObject({ cause: { code: "BRIEFING_CONFLICT" } });
  expect(
    (await engine.invoke("admin_briefing_get", {}, options)).insights,
  ).toHaveLength(0);
  const before = await database.select().from(briefingActions);
  await database
    .update(accounts)
    .set({ role: "viewer" })
    .where(eq(accounts.id, accountId));
  await expect(
    engine.invoke("admin_briefing_act", input, options),
  ).rejects.toBeDefined();
  expect(await database.select().from(briefingActions)).toHaveLength(
    before.length,
  );
});
