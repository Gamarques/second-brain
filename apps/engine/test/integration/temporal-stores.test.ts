import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/client.js";
import { runMigrations } from "../../src/database/migrate.js";
import { accounts } from "../../src/database/schema/identity.js";
import {
  activities,
  goalVersions,
  mutationReceipts,
  priorityPlanVersions,
  priorityPlans,
} from "../../src/database/schema/temporal.js";
import { DrizzleActivityStore } from "../../src/database/stores/activity-store.js";
import { DrizzleGoalStore } from "../../src/database/stores/goal-store.js";
import { DrizzlePriorityPlanStore } from "../../src/database/stores/priority-store.js";
import type { BrainAccessContext } from "../../src/domain.js";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

function accessContext(
  accountId: string,
  requestId: string,
): BrainAccessContext {
  return {
    accountId,
    role: "owner",
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

describe("Drizzle temporal stores", () => {
  let databaseResource: DisposableTestDatabase;
  let database: ReturnType<typeof createDatabase>;

  beforeEach(async () => {
    databaseResource = await provisionTestDatabase("temporal_stores");
    await runMigrations(databaseResource.pool);
    database = createDatabase(databaseResource.pool);
  });

  afterEach(async () => {
    await databaseResource?.destroy();
  });

  async function createAccountFixture() {
    const accountId = randomUUID();
    await database.insert(accounts).values({
      id: accountId,
      email: `${accountId}@example.test`,
      passwordHash: "integration-test-password-hash",
      status: "active",
      role: "owner",
    });
    return { accountId };
  }

  it("atomically creates immutable goal history and replays the same request", async () => {
    const fixture = await createAccountFixture();
    const goals = new DrizzleGoalStore(database);
    const access = accessContext(fixture.accountId, "goal-create-request");
    const input = {
      title: "Launch the product",
      description: "Reach the first production release.",
      successCriteria: "The release is available to members.",
      targetAt: "2026-09-01T12:00:00.000Z",
      projectId: null,
      idempotencyKey: "goal-create-launch",
    } as const;

    const created = await goals.createGoal(
      access,
      input,
      AbortSignal.timeout(10_000),
    );
    const replay = await goals.createGoal(
      access,
      { ...input, targetAt: "2026-09-01T09:00:00-03:00" },
      AbortSignal.timeout(10_000),
    );

    expect(created).not.toBeNull();
    expect(replay).toEqual(created);
    const versions = await database
      .select({ id: goalVersions.id, operation: goalVersions.operation })
      .from(goalVersions)
      .where(eq(goalVersions.goalId, created!.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.operation).toBe("created");

    const completed = await goals.updateGoal(
      accessContext(fixture.accountId, "goal-complete-request"),
      created!.id,
      {
        status: "achieved",
        precondition: {
          expectedVersion: 1,
          idempotencyKey: "goal-complete-launch",
        },
      },
      AbortSignal.timeout(10_000),
    );
    expect(completed?.version).toBe(2);
    expect(
      await goals.createGoal(access, input, AbortSignal.timeout(10_000)),
    ).toEqual(created);
    expect(
      await goals.updateGoal(
        accessContext(fixture.accountId, "goal-complete-replay-request"),
        created!.id,
        {
          status: "achieved",
          precondition: {
            expectedVersion: 1,
            idempotencyKey: "goal-complete-launch",
          },
        },
        AbortSignal.timeout(10_000),
      ),
    ).toEqual(completed);
    const history = await goals.listGoalHistory(
      accessContext(fixture.accountId, "goal-history-request"),
      { goalId: created!.id, cursor: null, limit: 10 },
      AbortSignal.timeout(10_000),
    );
    expect(history.items.map((version) => version.operation)).toEqual([
      "completed",
      "created",
    ]);
    expect(history.coverage.completeFrom).not.toBeNull();
  });

  it("rejects missing project references without leaving an idempotency event", async () => {
    const fixture = await createAccountFixture();
    const missingProjectId = randomUUID();
    const key = "missing-project-goal-link";
    const result = await new DrizzleGoalStore(database).createGoal(
      accessContext(fixture.accountId, "missing-project-request"),
      {
        title: "Must stay unrecorded",
        description: null,
        successCriteria: null,
        targetAt: null,
        projectId: missingProjectId,
        idempotencyKey: key,
      },
      AbortSignal.timeout(10_000),
    );
    expect(result).toBeNull();
    const events = await database
      .select({ id: mutationReceipts.id })
      .from(mutationReceipts)
      .where(
        and(
          eq(mutationReceipts.operation, "goals.create"),
          eq(mutationReceipts.idempotencyKey, key),
        ),
      );
    expect(events).toEqual([]);
  });

  it("enforces complete priority shares, non-overlap, and idempotent versions", async () => {
    const fixture = await createAccountFixture();
    const goals = new DrizzleGoalStore(database);
    const goal = await goals.createGoal(
      accessContext(fixture.accountId, "priority-goal-request"),
      {
        title: "Ship",
        description: null,
        successCriteria: null,
        targetAt: null,
        projectId: null,
        idempotencyKey: "priority-goal",
      },
      AbortSignal.timeout(10_000),
    );
    const priorities = new DrizzlePriorityPlanStore(database);
    const input = {
      projectId: null,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      items: [{ goalId: goal!.id, rank: 1, intendedSharePercent: 100 }],
      note: "Launch month",
      idempotencyKey: "priority-september",
    };
    const created = await priorities.createPriorityPlan(
      accessContext(fixture.accountId, "priority-create-request"),
      input,
      AbortSignal.timeout(10_000),
    );
    const replay = await priorities.createPriorityPlan(
      accessContext(fixture.accountId, "priority-create-request"),
      input,
      AbortSignal.timeout(10_000),
    );
    expect(replay).toEqual(created);
    const updated = await priorities.updatePriorityPlan(
      accessContext(fixture.accountId, "priority-update-request"),
      created!.id,
      {
        note: "Launch month, revised",
        precondition: {
          expectedVersion: 1,
          idempotencyKey: "priority-september-update",
        },
      },
      AbortSignal.timeout(10_000),
    );
    expect(updated?.version).toBe(2);
    expect(
      await priorities.createPriorityPlan(
        accessContext(fixture.accountId, "priority-create-late-replay-request"),
        input,
        AbortSignal.timeout(10_000),
      ),
    ).toEqual(created);
    expect(
      await priorities.updatePriorityPlan(
        accessContext(fixture.accountId, "priority-update-replay-request"),
        created!.id,
        {
          note: "Launch month, revised",
          precondition: {
            expectedVersion: 1,
            idempotencyKey: "priority-september-update",
          },
        },
        AbortSignal.timeout(10_000),
      ),
    ).toEqual(updated);
    expect(
      await priorities.createPriorityPlan(
        accessContext(fixture.accountId, "priority-overlap-request"),
        {
          ...input,
          periodStart: "2026-09-15T00:00:00.000Z",
          periodEnd: "2026-10-15T00:00:00.000Z",
          idempotencyKey: "priority-overlap",
        },
        AbortSignal.timeout(10_000),
      ),
    ).toBeNull();
    const overlapEvents = await database
      .select({ id: mutationReceipts.id })
      .from(mutationReceipts)
      .where(
        and(
          eq(mutationReceipts.operation, "priorities.create"),
          eq(mutationReceipts.idempotencyKey, "priority-overlap"),
        ),
      );
    expect(overlapEvents).toEqual([]);
    await expect(
      priorities.createPriorityPlan(
        accessContext(fixture.accountId, "priority-share-request"),
        {
          ...input,
          items: [{ goalId: goal!.id, rank: 1, intendedSharePercent: 80 }],
          idempotencyKey: "priority-bad-share",
        },
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toThrow(/total one hundred/u);
    const planRows = await database
      .select({
        id: priorityPlans.id,
        version: priorityPlans.version,
        currentVersionId: priorityPlans.currentVersionId,
      })
      .from(priorityPlans)
      .where(eq(priorityPlans.id, created!.id));
    expect(planRows).toHaveLength(1);
    expect(planRows[0]).toMatchObject({
      id: created!.id,
      version: 2,
      currentVersionId: updated!.currentVersionId,
    });
    const versionRows = await database
      .select({
        id: priorityPlanVersions.id,
        version: priorityPlanVersions.versionNumber,
      })
      .from(priorityPlanVersions)
      .where(eq(priorityPlanVersions.priorityPlanId, created!.id));
    expect(versionRows).toEqual(
      expect.arrayContaining([
        { id: created!.currentVersionId, version: 1 },
        { id: updated!.currentVersionId, version: 2 },
      ]),
    );
    expect(versionRows).toHaveLength(2);
  });

  it("serializes concurrent overlapping general priority plans at the database boundary", async () => {
    const fixture = await createAccountFixture();
    const goal = await new DrizzleGoalStore(database).createGoal(
      accessContext(fixture.accountId, "concurrent-priority-goal-request"),
      {
        title: "Protect the priority invariant",
        description: null,
        successCriteria: null,
        targetAt: null,
        projectId: null,
        idempotencyKey: "concurrent-priority-goal",
      },
      AbortSignal.timeout(10_000),
    );
    expect(goal).not.toBeNull();

    // Hold the first INSERT until the second transaction has also passed the
    // store's pre-insert overlap query. This makes the test depend on the
    // PostgreSQL exclusion constraint instead of scheduler timing.
    await databaseResource.pool.query(`
      CREATE SEQUENCE priority_plan_insert_barrier START WITH 1;
      CREATE FUNCTION wait_for_two_priority_plan_inserts()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        position bigint;
      BEGIN
        position := nextval('priority_plan_insert_barrier');
        IF position <= 2 THEN
          WHILE (SELECT last_value FROM priority_plan_insert_barrier) < 2 LOOP
            PERFORM pg_sleep(0.01);
          END LOOP;
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER priority_plan_insert_barrier_trigger
        BEFORE INSERT ON priority_plans
        FOR EACH ROW EXECUTE FUNCTION wait_for_two_priority_plan_inserts();
    `);

    const outcomes = await (async () => {
      try {
        const priorities = new DrizzlePriorityPlanStore(database);
        const common = {
          projectId: null,
          periodStart: "2099-01-01T00:00:00.000Z",
          periodEnd: "2099-02-01T00:00:00.000Z",
          items: [
            { goalId: goal!.id, rank: 1, intendedSharePercent: 100 },
          ],
          note: null,
        } as const;
        return await Promise.allSettled([
          priorities.createPriorityPlan(
            accessContext(fixture.accountId, "concurrent-priority-a-request"),
            { ...common, idempotencyKey: "concurrent-priority-a" },
            AbortSignal.timeout(10_000),
          ),
          priorities.createPriorityPlan(
            accessContext(fixture.accountId, "concurrent-priority-b-request"),
            { ...common, idempotencyKey: "concurrent-priority-b" },
            AbortSignal.timeout(10_000),
          ),
        ]);
      } finally {
        await databaseResource.pool.query(`
          DROP TRIGGER IF EXISTS priority_plan_insert_barrier_trigger ON priority_plans;
          DROP FUNCTION IF EXISTS wait_for_two_priority_plan_inserts();
          DROP SEQUENCE IF EXISTS priority_plan_insert_barrier;
        `);
      }
    })();

    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual(
      [],
    );
    const plans = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    expect(plans.filter((plan) => plan !== null)).toHaveLength(1);
    expect(plans.filter((plan) => plan === null)).toHaveLength(1);
  });

  it("uses clipped explicit intervals for deterministic alignment summaries", async () => {
    const fixture = await createAccountFixture();
    const goal = await new DrizzleGoalStore(database).createGoal(
      accessContext(fixture.accountId, "activity-goal-request"),
      {
        title: "Prepare launch",
        description: null,
        successCriteria: null,
        targetAt: null,
        projectId: null,
        idempotencyKey: "activity-goal",
      },
      AbortSignal.timeout(10_000),
    );
    const start = Date.now() + 60 * 60 * 1_000;
    const from = new Date(start).toISOString();
    const to = new Date(start + 60 * 60 * 1_000).toISOString();
    await new DrizzlePriorityPlanStore(database).createPriorityPlan(
      accessContext(fixture.accountId, "activity-priority-request"),
      {
        projectId: null,
        periodStart: new Date(start - 60 * 60 * 1_000).toISOString(),
        periodEnd: new Date(start + 2 * 60 * 60 * 1_000).toISOString(),
        items: [{ goalId: goal!.id, rank: 1, intendedSharePercent: 100 }],
        note: null,
        idempotencyKey: "activity-priority",
      },
      AbortSignal.timeout(10_000),
    );
    const store = new DrizzleActivityStore(database);
    const input = {
      kind: "work_session" as const,
      occurredAt: new Date(start - 30 * 60 * 1_000).toISOString(),
      endedAt: new Date(start + 90 * 60 * 1_000).toISOString(),
      taskId: null,
      projectId: null,
      summary: "Worked on the launch.",
      analysisAllowed: true,
      allocations: [{ goalId: goal!.id, allocationPercent: 50 }],
      idempotencyKey: "launch-session",
    };
    const access = accessContext(
      fixture.accountId,
      "activity-record-request",
    );
    const recorded = await store.recordActivity(
      access,
      input,
      AbortSignal.timeout(10_000),
    );
    const replay = await store.recordActivity(
      access,
      input,
      AbortSignal.timeout(10_000),
    );
    expect(recorded?.created).toBe(true);
    expect(replay).toEqual({ activity: recorded!.activity, created: false });

    const listed = await store.listActivities(
      accessContext(fixture.accountId, "activity-list-request"),
      {
        from,
        to,
        kinds: ["work_session"],
        projectId: null,
        goalId: goal!.id,
        includeRetracted: false,
        cursor: null,
        limit: 10,
      },
      AbortSignal.timeout(10_000),
    );
    expect(listed.items.map((activity) => activity.id)).toEqual([
      recorded!.activity.id,
    ]);

    const summary = await store.summarizeActivities(
      accessContext(fixture.accountId, "activity-summary-request"),
      { from, to, timeZone: "America/Sao_Paulo" },
      AbortSignal.timeout(10_000),
    );
    const replayedSummary = await store.summarizeActivities(
      accessContext(fixture.accountId, "activity-summary-replay"),
      { from, to, timeZone: "America/Sao_Paulo" },
      AbortSignal.timeout(10_000),
    );
    expect(summary.recordedIntervals).toEqual({
      sessionCount: 1,
      rawRecordedMinutes: 120,
      overlappingMinutes: 60,
      allocatedMinutes: 30,
      priorityAllocatedMinutes: 30,
      rateAmongAllocated: 1,
    });
    expect(replayedSummary.provenanceHash).toBe(summary.provenanceHash);
    expect(summary.coverage.completeFrom).not.toBeNull();
    expect(summary.coverage.warnings[0]).toMatch(/explicit work sessions/u);

    const retracted = await store.retractActivity(
      accessContext(fixture.accountId, "activity-retract-request"),
      recorded!.activity.id,
      {
        reason: "The session was recorded against the wrong day.",
        idempotencyKey: "retract-session",
      },
      AbortSignal.timeout(10_000),
    );
    const retractionReplay = await store.retractActivity(
      accessContext(fixture.accountId, "activity-retract-request"),
      recorded!.activity.id,
      {
        reason: "The session was recorded against the wrong day.",
        idempotencyKey: "retract-session",
      },
      AbortSignal.timeout(10_000),
    );
    expect(retracted?.retractedAt).not.toBeNull();
    expect(retractionReplay).toEqual(retracted);
    const storedRows = await database
      .select({ id: activities.id })
      .from(activities)
      .where(eq(activities.idempotencyKey, "launch-session"));
    expect(storedRows).toHaveLength(1);
  });
});
