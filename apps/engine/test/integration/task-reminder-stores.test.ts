import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BrainAccessContext } from "../../src/domain.js";
import { runMigrations } from "../../src/database/migrate.js";
import { schema } from "../../src/database/schema/index.js";
import { accounts } from "../../src/database/schema/identity.js";
import {
  activityEvents,
  goals,
  mutationReceipts,
  reminderVersions,
  taskGoalLinks,
  taskVersionGoalLinks,
  taskVersions,
} from "../../src/database/schema/temporal.js";
import { reminders, tasks } from "../../src/database/schema/content.js";
import type { SecondBrainDatabase } from "../../src/database/stores/database.js";
import { DrizzleReminderStore } from "../../src/database/stores/reminder-store.js";
import { DrizzleTaskStore } from "../../src/database/stores/task-store.js";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

function access(
  accountId: string,
  role: BrainAccessContext["role"] = "owner",
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

function oauthAccess(
  accountId: string,
  clientId: string,
): BrainAccessContext {
  return {
    ...access(accountId),
    actor: {
      kind: "oauth_client",
      accountId,
      clientId,
      source: "mcp_http",
      requestId: randomUUID(),
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
}

describe("Drizzle task and reminder stores", () => {
  let database: DisposableTestDatabase;
  let db: SecondBrainDatabase;
  let accountId: string;
  let actor: BrainAccessContext;
  let goalId: string;

  beforeAll(async () => {
    database = await provisionTestDatabase("task_reminder_stores");
    await runMigrations(database.pool);
    db = drizzle(database.pool, { schema });
    accountId = randomUUID();
    goalId = randomUUID();
    const now = new Date("2026-08-16T12:00:00.000Z");
    await db.insert(accounts).values({
      id: accountId,
      email: `store-${accountId}@example.com`,
      passwordHash: "not-used-by-store-tests",
      status: "active",
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(goals).values({
      id: goalId,
      title: "Ship v1",
      status: "active",
      version: 1,
      historyCompleteFrom: now,
      actorKind: "account",
      actorAccountId: accountId,
      actorClientId: null,
      actorSource: "direct",
      createdAt: now,
      updatedAt: now,
    });
    actor = access(accountId);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it("atomically creates, replays, versions, and reconstructs tasks with goal snapshots", async () => {
    const store = new DrizzleTaskStore(db);
    const list = await store.createTaskList(
      actor,
      { name: "Launch", description: null, idempotencyKey: "task-list-launch" },
      AbortSignal.timeout(10_000),
    );
    expect(
      await store.createTaskList(
        oauthAccess(accountId, "chatgpt-list-client"),
        { name: "Launch", description: null, idempotencyKey: "task-list-launch" },
        AbortSignal.timeout(10_000),
      ),
    ).toEqual(list);
    const createInput = {
      listId: list.id,
      title: "Publish release",
      description: "Publish the v1 release",
      priority: "high" as const,
      dueAt: "2026-08-20T12:00:00.000Z",
      projectId: null,
      goalLinks: [{ goalId, basis: "explicit" as const, confidence: null }],
      idempotencyKey: "task-create-release",
    };
    const created = await store.createTask(actor, createInput, AbortSignal.timeout(10_000));
    expect(created).toMatchObject({
      id: expect.any(String),
      listId: list.id,
      title: "Publish release",
      description: "Publish the v1 release",
      status: "todo",
      priority: "high",
      dueAt: "2026-08-20T12:00:00.000Z",
      completedAt: null,
      projectId: null,
      goalLinks: [{ goalId, basis: "explicit", confidence: null }],
      version: 1,
      provenance: { kind: "account", accountId, clientId: null },
    });
    expect(
      await store.createTask(
        oauthAccess(accountId, "chatgpt-client"),
        createInput,
        AbortSignal.timeout(10_000),
      ),
    ).toEqual(created);
    await expect(
      store.createTask(
        actor,
        { ...createInput, title: "Different payload" },
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toMatchObject({ code: "TASK_STORE_IDEMPOTENCY_CONFLICT" });

    const updated = await store.updateTask(
      oauthAccess(accountId, "cursor-client"),
      created!.id,
      {
        status: "done",
        goalLinks: [],
        precondition: { expectedVersion: 1, idempotencyKey: "task-complete-release" },
      },
      AbortSignal.timeout(10_000),
    );
    expect(updated).toMatchObject({
      version: 2,
      status: "done",
      goalLinks: [],
      provenance: { kind: "oauth_client", clientId: "cursor-client" },
    });
    expect(
      await store.updateTask(
        oauthAccess(accountId, "codex-client"),
        created!.id,
        {
          status: "done",
          goalLinks: [],
          precondition: { expectedVersion: 1, idempotencyKey: "task-complete-release" },
        },
        AbortSignal.timeout(10_000),
      ),
    ).toEqual(updated);

    const history = await store.listTaskHistory(
      actor,
      { taskId: created!.id, from: null, to: null, cursor: null, limit: 10 },
      AbortSignal.timeout(10_000),
    );
    expect(history.items.map((item) => item.operation)).toEqual(["completed", "created"]);
    expect(history.items.map((item) => item.provenance.kind)).toEqual([
      "oauth_client",
      "account",
    ]);
    expect(history.items[1]!.goalLinks).toEqual([{ goalId, basis: "explicit", confidence: null }]);
    const asOf = await store.listTasks(
      actor,
      {
        listId: list.id,
        status: null,
        projectId: null,
        goalId,
        asOf: history.items[1]!.effectiveAt,
        cursor: null,
        limit: 10,
      },
      AbortSignal.timeout(10_000),
    );
    expect(asOf.items).toMatchObject([
      {
        id: created!.id,
        version: 1,
        status: "todo",
        provenance: { kind: "account", clientId: null },
      },
    ]);
    expect(asOf.coverage).toMatchObject({ complete: true, requestedAsOf: history.items[1]!.effectiveAt });

    const [versions, currentLinks, snapshots, receipts, events] = await Promise.all([
      db.select().from(taskVersions).where(eq(taskVersions.taskId, created!.id)),
      db.select().from(taskGoalLinks).where(eq(taskGoalLinks.taskId, created!.id)),
      db
        .select({
          taskVersionId: taskVersionGoalLinks.taskVersionId,
          goalId: taskVersionGoalLinks.goalId,
        })
        .from(taskVersionGoalLinks)
        .innerJoin(taskVersions, eq(taskVersions.id, taskVersionGoalLinks.taskVersionId))
        .where(eq(taskVersions.taskId, created!.id)),
      db
        .select()
        .from(mutationReceipts)
        .where(eq(mutationReceipts.resultEntityId, created!.id)),
      db
        .select()
        .from(activityEvents)
        .where(
          and(
            eq(activityEvents.entityType, "task"),
            eq(activityEvents.entityId, created!.id),
          ),
        ),
    ]);
    expect(versions).toHaveLength(2);
    expect(currentLinks).toHaveLength(0);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ goalId });
    expect(receipts).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(new Set(versions.map((row) => row.recordedAt.toISOString()))).toEqual(
      new Set(events.map((row) => row.recordedAt.toISOString())),
    );
  });

  it("prevents missing references and lost concurrent updates", async () => {
    const store = new DrizzleTaskStore(db);
    const localList = await store.createTaskList(
      actor,
      { name: "Concurrency", description: null, idempotencyKey: "list-concurrency" },
      AbortSignal.timeout(10_000),
    );
    await expect(
      store.createTask(
        actor,
        {
          listId: randomUUID(),
          title: "Missing list",
          description: null,
          priority: "normal",
          dueAt: null,
          projectId: null,
          goalLinks: [],
          idempotencyKey: "missing-list-task",
        },
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBeNull();

    const concurrentCreateInput = {
      listId: localList.id,
      title: "Same-key concurrent create",
      description: null,
      priority: "normal" as const,
      dueAt: null,
      projectId: null,
      goalLinks: [],
      idempotencyKey: "same-key-concurrent-create",
    };
    const concurrentlyCreated = await Promise.all([
      store.createTask(actor, concurrentCreateInput, AbortSignal.timeout(10_000)),
      store.createTask(actor, concurrentCreateInput, AbortSignal.timeout(10_000)),
    ]);
    expect(concurrentlyCreated[0]).toEqual(concurrentlyCreated[1]);

    const created = await store.createTask(
      actor,
      {
        listId: localList.id,
        title: "Concurrent update",
        description: null,
        priority: "normal",
        dueAt: null,
        projectId: null,
        goalLinks: [],
        idempotencyKey: "concurrent-task-create",
      },
      AbortSignal.timeout(10_000),
    );
    const results = await Promise.all([
      store.updateTask(
        actor,
        created!.id,
        {
          title: "Winner A",
          precondition: { expectedVersion: 1, idempotencyKey: "concurrent-update-a" },
        },
        AbortSignal.timeout(10_000),
      ),
      store.updateTask(
        actor,
        created!.id,
        {
          title: "Winner B",
          precondition: { expectedVersion: 1, idempotencyKey: "concurrent-update-b" },
        },
        AbortSignal.timeout(10_000),
      ),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(
      await db.select().from(taskVersions).where(eq(taskVersions.taskId, created!.id)),
    ).toHaveLength(2);

    const relation = await store.createTaskRelation(
      actor,
      {
        fromTaskId: created!.id,
        toTaskId: concurrentlyCreated[0]!.id,
        kind: "depends_on",
        idempotencyKey: "relation-create",
      },
      AbortSignal.timeout(10_000),
    );
    expect(
      await store.createTaskRelation(
        oauthAccess(accountId, "claude-relation-client"),
        {
          fromTaskId: created!.id,
          toTaskId: concurrentlyCreated[0]!.id,
          kind: "depends_on",
          idempotencyKey: "relation-create",
        },
        AbortSignal.timeout(10_000),
      ),
    ).toEqual(relation);
    await expect(
      store.createTaskRelation(
        actor,
        {
          fromTaskId: created!.id,
          toTaskId: randomUUID(),
          kind: "blocks",
          idempotencyKey: "relation-missing-task",
        },
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBeNull();

    await expect(
      store.deleteTask(
        oauthAccess(accountId, "cursor-delete-client"),
        created!.id,
        { idempotencyKey: "task-privacy-delete" },
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBe(true);
    await expect(
      store.deleteTask(
        actor,
        created!.id,
        { idempotencyKey: "task-privacy-delete" },
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBe(true);
    expect(await db.select().from(tasks).where(eq(tasks.id, created!.id))).toEqual([]);
    expect(
      await db.select().from(taskVersions).where(eq(taskVersions.taskId, created!.id)),
    ).toEqual([]);
  });

  it("reconstructs reminder history and permanently erases private content", async () => {
    const store = new DrizzleReminderStore(db);
    const input = {
      message: "Call the release partner",
      remindAt: "2026-08-19T12:00:00.000Z",
      idempotencyKey: "reminder-call-partner",
    };
    const created = await store.createReminder(actor, input, AbortSignal.timeout(10_000));
    expect(
      await store.createReminder(
        oauthAccess(accountId, "cursor-reminder-client"),
        input,
        AbortSignal.timeout(10_000),
      ),
    ).toEqual(created);
    const completed = await store.updateReminder(
      oauthAccess(accountId, "chatgpt-client"),
      created.id,
      {
        completed: true,
        precondition: { expectedVersion: 1, idempotencyKey: "reminder-complete" },
      },
      AbortSignal.timeout(10_000),
    );
    expect(completed).toMatchObject({
      version: 2,
      completedAt: expect.any(String),
      provenance: { kind: "oauth_client", clientId: "chatgpt-client" },
    });
    expect(
      await store.updateReminder(
        oauthAccess(accountId, "codex-reminder-client"),
        created.id,
        {
          completed: true,
          precondition: { expectedVersion: 1, idempotencyKey: "reminder-complete" },
        },
        AbortSignal.timeout(10_000),
      ),
    ).toEqual(completed);
    const history = await store.listReminderHistory(
      actor,
      { reminderId: created.id, from: null, to: null, cursor: null, limit: 10 },
      AbortSignal.timeout(10_000),
    );
    expect(history.items.map((item) => item.operation)).toEqual(["completed", "created"]);
    expect(history.items.map((item) => item.provenance.kind)).toEqual([
      "oauth_client",
      "account",
    ]);
    const past = await store.listReminders(
      actor,
      {
        includeCompleted: false,
        asOf: history.items[1]!.effectiveAt,
        cursor: null,
        limit: 10,
      },
      AbortSignal.timeout(10_000),
    );
    expect(past.items).toMatchObject([
      {
        id: created.id,
        version: 1,
        completedAt: null,
        provenance: { kind: "account", clientId: null },
      },
    ]);

    await expect(
      store.deleteReminder(
        oauthAccess(accountId, "claude-delete-client"),
        created.id,
        { idempotencyKey: "reminder-delete" },
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBe(true);
    await expect(
      store.deleteReminder(
        actor,
        created.id,
        { idempotencyKey: "reminder-delete" },
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBe(true);
    expect(await db.select().from(reminders).where(eq(reminders.id, created.id))).toEqual([]);
    expect(
      await db.select().from(reminderVersions).where(eq(reminderVersions.reminderId, created.id)),
    ).toEqual([]);
    const receipts = await db
      .select({ result: mutationReceipts.result })
      .from(mutationReceipts)
      .where(eq(mutationReceipts.resultEntityId, created.id));
    expect(JSON.stringify(receipts)).not.toContain("Call the release partner");
    const erasedHistory = await store.listReminderHistory(
      actor,
      { reminderId: created.id, from: null, to: null, cursor: null, limit: 10 },
      AbortSignal.timeout(10_000),
    );
    expect(erasedHistory).toMatchObject({ items: [], coverage: { complete: false } });
  });

  it("revalidates account access inside each transaction", async () => {
    const disabledAccountId = randomUUID();
    await db.insert(accounts).values({
      id: disabledAccountId,
      email: `disabled-${disabledAccountId}@example.com`,
      passwordHash: "not-used-by-store-tests",
      status: "active",
      role: "owner",
    });
    const staleAccess = access(disabledAccountId);
    await db
      .update(accounts)
      .set({ status: "disabled" })
      .where(eq(accounts.id, disabledAccountId));
    await expect(
      new DrizzleTaskStore(db).listTaskLists(staleAccess, AbortSignal.timeout(10_000)),
    ).rejects.toMatchObject({ code: "BRAIN_ACCESS_DENIED" });
  });
});
