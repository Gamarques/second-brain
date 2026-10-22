import { createEngine } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { createActivityCapabilities } from "../src/capabilities/activities.js";
import { createGoalCapabilities } from "../src/capabilities/goals.js";
import { createPriorityCapabilities } from "../src/capabilities/priorities.js";
import type {
  Activity,
  ActivityStore,
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
  Goal,
  GoalStore,
  GoalVersion,
  PriorityPlan,
  PriorityPlanStore,
  TemporalCoverage,
} from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const goalId = "00000000-0000-4000-8000-000000000010";
const goalVersionId = "00000000-0000-4000-8000-000000000011";
const activityEventId = "00000000-0000-4000-8000-000000000012";
const planId = "00000000-0000-4000-8000-000000000020";
const planVersionId = "00000000-0000-4000-8000-000000000021";
const activityId = "00000000-0000-4000-8000-000000000030";
const projectId = "00000000-0000-4000-8000-000000000040";
const taskId = "00000000-0000-4000-8000-000000000050";
const from = "2026-08-15T00:00:00.000Z";
const to = "2026-08-16T00:00:00.000Z";

const attribution = {
  kind: "account",
  accountId,
  clientId: null,
  source: "direct",
} as const;

const coverage: TemporalCoverage = {
  completeFrom: "2026-01-01T00:00:00.000Z",
  requestedAsOf: null,
  complete: true,
  warnings: [],
};

const goal: Goal = {
  id: goalId,
  title: "Launch the product",
  description: null,
  successCriteria: "A customer completes the core workflow",
  status: "active",
  targetAt: "2026-09-01T00:00:00.000Z",
  projectId,
  version: 1,
  historyCompleteFrom: "2026-08-01T00:00:00.000Z",
  provenance: attribution,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const goalVersion: GoalVersion = {
  id: goalVersionId,
  goalId,
  version: 1,
  operation: "created",
  snapshot: {
    id: goalId,
    title: goal.title,
    description: goal.description,
    successCriteria: goal.successCriteria,
    status: goal.status,
    targetAt: goal.targetAt,
    projectId: goal.projectId,
  },
  effectiveAt: goal.createdAt,
  recordedAt: goal.createdAt,
  changedFields: ["title"],
  provenance: attribution,
  activityEventId,
};

const priorityPlan: PriorityPlan = {
  id: planId,
  projectId: null,
  periodStart: from,
  periodEnd: to,
  version: 1,
  currentVersionId: planVersionId,
  items: [{ goalId, rank: 1, intendedSharePercent: 100 }],
  note: null,
  provenance: attribution,
  createdAt: from,
  updatedAt: from,
};

const activity: Activity = {
  id: activityId,
  kind: "work_session",
  occurredAt: "2026-08-15T10:00:00.000Z",
  endedAt: "2026-08-15T11:00:00.000Z",
  timeBasis: "explicit_interval",
  taskId,
  projectId,
  summary: "Prepared the launch",
  analysisAllowed: true,
  allocations: [{ goalId, allocationPercent: 80 }],
  idempotencyKey: "activity-1",
  provenance: attribution,
  recordedAt: "2026-08-15T11:00:00.000Z",
  retractedAt: null,
  retractionReason: null,
};

interface Captures {
  readonly accessRequests: BrainAccessRequest[];
  readonly timeZoneAccesses: BrainAccessContext[];
  goalCreate: Parameters<GoalStore["createGoal"]>[1] | null;
  goalUpdate: Parameters<GoalStore["updateGoal"]>[2] | null;
  goalList: Parameters<GoalStore["listGoals"]>[1] | null;
  priorityCreate: Parameters<PriorityPlanStore["createPriorityPlan"]>[1] | null;
  priorityUpdate: Parameters<PriorityPlanStore["updatePriorityPlan"]>[2] | null;
  priorityList: Parameters<PriorityPlanStore["listPriorityPlans"]>[1] | null;
  activityRecord: Parameters<ActivityStore["recordActivity"]>[1] | null;
  activityList: Parameters<ActivityStore["listActivities"]>[1] | null;
  activityRetraction: Parameters<ActivityStore["retractActivity"]>[2] | null;
  activitySummary: Parameters<ActivityStore["summarizeActivities"]>[1] | null;
}

function createTestEngine() {
  const controls = { priorityPlanResult: priorityPlan };
  const captures: Captures = {
    accessRequests: [],
    timeZoneAccesses: [],
    goalCreate: null,
    goalUpdate: null,
    goalList: null,
    priorityCreate: null,
    priorityUpdate: null,
    priorityList: null,
    activityRecord: null,
    activityList: null,
    activityRetraction: null,
    activitySummary: null,
  };

  const access: BrainAccessStore = {
    async resolveAccess(request) {
      captures.accessRequests.push(request);
      const clientId = request.principal.attributes?.clientId;
      const common = {
        accountId: request.principal.id,
        role: "owner",
      } as const;
      return request.source === "mcp_http" && typeof clientId === "string"
        ? {
            ...common,
            actor: {
              kind: "oauth_client",
              accountId: request.principal.id,
              clientId,
              source: request.source,
              requestId: request.requestId,
              correlationId: null,
              causationId: null,
              dreamingRunId: null,
            },
          }
        : {
            ...common,
            actor: {
              kind: "account",
              accountId: request.principal.id,
              clientId: null,
              source: request.source,
              requestId: request.requestId,
              correlationId: null,
              causationId: null,
              dreamingRunId: null,
            },
          };
    },
    async revalidateAccess(value) {
      return value;
    },
    async getTimeZone(access) {
      captures.timeZoneAccesses.push(access);
      return "America/Sao_Paulo";
    },
  };

  const goals: GoalStore = {
    async createGoal(_access, input) {
      captures.goalCreate = input;
      return goal;
    },
    async updateGoal(_access, _id, changes) {
      captures.goalUpdate = changes;
      return { ...goal, version: 2, status: changes.status ?? goal.status };
    },
    async listGoals(_access, input) {
      captures.goalList = input;
      return {
        items: [goal],
        nextCursor: { ts: goal.updatedAt, id: goal.id },
        coverage: { ...coverage, requestedAsOf: input.asOf },
      };
    },
    async listGoalHistory() {
      return { items: [goalVersion], nextCursor: null, coverage };
    },
  };

  const priorities: PriorityPlanStore = {
    async createPriorityPlan(_access, input) {
      captures.priorityCreate = input;
      return controls.priorityPlanResult;
    },
    async updatePriorityPlan(_access, _id, changes) {
      captures.priorityUpdate = changes;
      return {
        ...controls.priorityPlanResult,
        version: 2,
        note: changes.note ?? controls.priorityPlanResult.note,
      };
    },
    async listPriorityPlans(_access, input) {
      captures.priorityList = input;
      return {
        items: [controls.priorityPlanResult],
        nextCursor: {
          ts: controls.priorityPlanResult.updatedAt,
          id: controls.priorityPlanResult.id,
        },
        coverage,
      };
    },
  };

  const activities: ActivityStore = {
    async recordActivity(_access, input) {
      captures.activityRecord = input;
      return { activity, created: false };
    },
    async retractActivity(_access, _id, input) {
      captures.activityRetraction = input;
      return {
        ...activity,
        retractedAt: "2026-08-15T12:00:00.000Z",
        retractionReason: input.reason,
      };
    },
    async listActivities(_access, input) {
      captures.activityList = input;
      return { items: [activity], nextCursor: null, coverage };
    },
    async summarizeActivities(_access, input) {
      captures.activitySummary = input;
      return {
        from: input.from,
        to: input.to,
        timeZone: input.timeZone,
        tasksCreated: 3,
        tasksStarted: 2,
        tasksCompleted: 1,
        tasksReopened: 0,
        tasksCanceled: 0,
        remindersScheduled: 1,
        remindersCompleted: 0,
        overdueTasksAtEnd: 1,
        pendingPastDueRemindersAtEnd: 0,
        completedTasks: {
          linkedCount: 1,
          unlinkedCount: 0,
          alignedLinkedCount: 1,
          nonPriorityLinkedCount: 0,
          rateAmongLinked: 1,
        },
        recordedIntervals: {
          sessionCount: 1,
          rawRecordedMinutes: 60,
          overlappingMinutes: 0,
          allocatedMinutes: 48,
          priorityAllocatedMinutes: 48,
          rateAmongAllocated: 1,
        },
        sourceEventIds: [activityEventId],
        sourceActivityIds: [activityId],
        provenanceHash: "a".repeat(64),
        coverage,
      };
    },
  };

  const engine = createEngine({
    name: "temporal-test",
    version: "1.0.0",
    capabilities: {
      ...createGoalCapabilities(access, goals),
      ...createPriorityCapabilities(access, priorities),
      ...createActivityCapabilities(access, activities),
    },
  });
  return { engine, captures, controls };
}

describe("goal capabilities", () => {
  it("authorizes the single deployment with editor access and forwards idempotency", async () => {
    const { engine, captures } = createTestEngine();

    await expect(
      engine.invoke(
        "goals_create",
        {
          title: "Launch the product",
          projectId,
          idempotencyKey: "goal-create-1",
        },
        {
          principal: { id: accountId, attributes: { clientId: "cursor-client" } },
          source: "mcp-http",
          requestId: "request-goal-create",
        },
      ),
    ).resolves.toMatchObject({ id: goalId, title: "Launch the product" });

    expect(captures.accessRequests[0]).toMatchObject({
      requiredRole: "editor",
      source: "mcp_http",
      requestId: "request-goal-create",
    });
    expect(captures.goalCreate).toMatchObject({
      projectId,
      idempotencyKey: "goal-create-1",
      description: null,
      successCriteria: null,
    });
  });

  it("requires a version precondition, preserves as-of coverage, and exposes history", async () => {
    const { engine, captures } = createTestEngine();
    const principal = { id: accountId };

    await engine.invoke(
      "goals_update",
      {
        id: goalId,
        status: "paused",
        expectedVersion: 1,
        idempotencyKey: "goal-update-1",
      },
      { principal },
    );
    expect(captures.goalUpdate?.precondition).toEqual({
      expectedVersion: 1,
      idempotencyKey: "goal-update-1",
    });

    const page = await engine.invoke(
      "goals_list",
      { asOf: "2026-08-15T12:00:00.000Z", limit: 1 },
      { principal },
    );
    expect(captures.goalList).toMatchObject({
      asOf: "2026-08-15T12:00:00.000Z",
      limit: 1,
    });
    expect(page.coverage.requestedAsOf).toBe("2026-08-15T12:00:00.000Z");
    expect(page.nextCursor).not.toBeNull();
    await expect(
      engine.invoke("goals_list", { cursor: page.nextCursor }, { principal }),
    ).resolves.toBeDefined();
    await expect(
      engine.invoke("goals_history", { goalId }, { principal }),
    ).resolves.toMatchObject({ versions: [{ version: 1, operation: "created" }] });
  });

  it("rejects an update without a domain change", async () => {
    const { engine } = createTestEngine();
    await expect(
      engine.invoke(
        "goals_update",
        { id: goalId, expectedVersion: 1, idempotencyKey: "no-change" },
        { principal: { id: accountId } },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("distinguishes an omitted project link from an explicit goal detach", async () => {
    const { engine, captures } = createTestEngine();
    const principal = { id: accountId };

    await engine.invoke("goals_update", {
      id: goalId,
      status: "paused",
      expectedVersion: 1,
      idempotencyKey: "goal-project-omitted",
    }, { principal });
    expect(Object.hasOwn(captures.goalUpdate!, "projectId")).toBe(false);

    await engine.invoke("goals_update", {
      id: goalId,
      projectId: null,
      expectedVersion: 2,
      idempotencyKey: "goal-project-detached",
    }, { principal });
    expect(captures.goalUpdate).toMatchObject({ projectId: null });
  });
});

describe("priority capabilities", () => {
  it("records ranked strategic goals and forwards optimistic updates", async () => {
    const { engine, captures } = createTestEngine();
    const principal = { id: accountId };

    await engine.invoke(
      "priorities_create",
      {
        periodStart: from,
        periodEnd: to,
        items: [{ goalId, rank: 1, intendedSharePercent: 100 }],
        idempotencyKey: "priority-create-1",
      },
      { principal },
    );
    expect(captures.priorityCreate).toMatchObject({ projectId: null });
    expect(captures.priorityCreate).not.toHaveProperty("scope");

    await engine.invoke(
      "priorities_update",
      { id: planId, note: "Ship", expectedVersion: 1, idempotencyKey: "priority-update-1" },
      { principal },
    );
    expect(captures.priorityUpdate?.precondition).toEqual({
      expectedVersion: 1,
      idempotencyKey: "priority-update-1",
    });

    await engine.invoke("priorities_list", { activeAt: from }, { principal });
    expect(captures.priorityList?.activeAt).toBe(from);
  });

  it("treats an omitted projectId as the general plan and forwards a project link", async () => {
    const { engine, captures } = createTestEngine();
    const principal = { id: accountId };
    const base = {
      periodStart: from,
      periodEnd: to,
      items: [{ goalId, rank: 1, intendedSharePercent: 100 }],
    };

    await engine.invoke(
      "priorities_create",
      { ...base, idempotencyKey: "priority-general-1" },
      { principal },
    );
    expect(captures.priorityCreate).toMatchObject({ projectId: null });

    await engine.invoke(
      "priorities_create",
      { ...base, projectId, idempotencyKey: "priority-project-1" },
      { principal },
    );
    expect(captures.priorityCreate).toMatchObject({ projectId });
  });

  it("rejects invalid periods, ranks, and intended shares", async () => {
    const { engine } = createTestEngine();
    const principal = { id: accountId };
    const base = {
      periodStart: from,
      periodEnd: to,
      items: [{ goalId, rank: 1, intendedSharePercent: 100 }],
      idempotencyKey: "priority-invalid",
    };

    await expect(
      engine.invoke("priorities_create", { ...base, periodEnd: from }, { principal }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "priorities_create",
        {
          ...base,
          items: [{ goalId, rank: 1, intendedSharePercent: 70 }],
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "priorities_create",
        {
          ...base,
          items: [
            { goalId, rank: 1, intendedSharePercent: 60 },
            {
              goalId: "00000000-0000-4000-8000-000000000098",
              rank: 2,
              intendedSharePercent: null,
            },
          ],
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "priorities_create",
        {
          ...base,
          items: [
            { goalId, rank: 1, intendedSharePercent: 33.333 },
            {
              goalId: "00000000-0000-4000-8000-000000000098",
              rank: 2,
              intendedSharePercent: 66.667,
            },
          ],
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "priorities_create",
        {
          ...base,
          items: [
            { goalId, rank: 2, intendedSharePercent: 70 },
            {
              goalId: "00000000-0000-4000-8000-000000000099",
              rank: 2,
              intendedSharePercent: 40,
            },
          ],
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("rejects a store result that violates the complete-share output contract", async () => {
    const { engine, controls } = createTestEngine();
    controls.priorityPlanResult = {
      ...priorityPlan,
      items: [{ goalId, rank: 1, intendedSharePercent: 70 }],
    };

    await expect(
      engine.invoke(
        "priorities_create",
        {
          periodStart: from,
          periodEnd: to,
          items: [{ goalId, rank: 1, intendedSharePercent: 100 }],
          idempotencyKey: "invalid-output",
        },
        { principal: { id: accountId } },
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
  });
});

describe("activity capabilities", () => {
  it("records only explicit interval evidence and reports idempotent replay", async () => {
    const { engine, captures } = createTestEngine();

    await expect(
      engine.invoke(
        "activities_record",
        {
          kind: "work_session",
          occurredAt: activity.occurredAt,
          endedAt: activity.endedAt,
          taskId,
          projectId,
          allocations: [{ goalId, allocationPercent: 80 }],
          idempotencyKey: "activity-1",
        },
        { principal: { id: accountId } },
      ),
    ).resolves.toMatchObject({
      created: false,
      activity: { timeBasis: "explicit_interval", allocations: [{ allocationPercent: 80 }] },
    });
    expect(captures.activityRecord).toMatchObject({
      endedAt: activity.endedAt,
      idempotencyKey: "activity-1",
    });
  });

  it("lists and retracts recorded activity within a brain access boundary", async () => {
    const { engine, captures } = createTestEngine();
    const principal = { id: accountId };

    await engine.invoke(
      "activities_list",
      { from, to, kinds: ["work_session"], includeRetracted: true },
      { principal },
    );
    expect(captures.activityList).toMatchObject({
      from,
      to,
      kinds: ["work_session"],
      includeRetracted: true,
    });

    await expect(
      engine.invoke(
        "activities_retract",
        { id: activityId, reason: "Recorded twice", idempotencyKey: "retract-1" },
        { principal },
      ),
    ).resolves.toMatchObject({ retractionReason: "Recorded twice" });
    expect(captures.activityRetraction).toEqual({
      reason: "Recorded twice",
      idempotencyKey: "retract-1",
    });
  });

  it("summarizes recorded intervals with coverage and defaults to the deployment time zone", async () => {
    const { engine, captures } = createTestEngine();

    await expect(
      engine.invoke("activities_summary", { from, to }, { principal: { id: accountId } }),
    ).resolves.toMatchObject({
      timeZone: "America/Sao_Paulo",
      recordedIntervals: {
        sessionCount: 1,
        rawRecordedMinutes: 60,
        allocatedMinutes: 48,
      },
      coverage: { complete: true },
    });
    expect(captures.activitySummary?.timeZone).toBe("America/Sao_Paulo");
    expect(captures.timeZoneAccesses).toEqual([
      expect.objectContaining({ accountId, role: "owner" }),
    ]);
  });

  it("rejects invented intervals, duplicate kinds, and over-allocation", async () => {
    const { engine } = createTestEngine();
    const principal = { id: accountId };

    await expect(
      engine.invoke(
        "activities_record",
        {
          kind: "work_session",
          occurredAt: to,
          endedAt: from,
          idempotencyKey: "bad-time",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "activities_record",
        {
          kind: "work_session",
          occurredAt: from,
          allocations: [
            { goalId, allocationPercent: 80 },
            {
              goalId: "00000000-0000-4000-8000-000000000099",
              allocationPercent: 30,
            },
          ],
          idempotencyKey: "bad-allocation",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "activities_record",
        {
          kind: "work_session",
          occurredAt: from,
          allocations: [{ goalId, allocationPercent: 33.333 }],
          idempotencyKey: "bad-allocation-precision",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "activities_list",
        { from, to, kinds: ["meeting", "meeting"] },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("requires authentication for every temporal capability", async () => {
    const { engine } = createTestEngine();
    await expect(
      engine.invoke(
        "goals_create",
        { title: "Goal", idempotencyKey: "auth-1" },
        { principal: null },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      engine.invoke("priorities_list", {}, { principal: null }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      engine.invoke("activities_summary", { from, to }, { principal: null }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("marks retraction as destructive and all temporal writes as idempotent", () => {
    const { engine } = createTestEngine();
    const catalog = new Map(engine.list().map((capability) => [capability.id, capability]));
    expect(catalog.get("activities_retract")?.annotations).toMatchObject({
      destructive: true,
      idempotent: true,
    });
    for (const id of [
      "goals_create",
      "goals_update",
      "priorities_create",
      "priorities_update",
      "activities_record",
    ]) {
      expect(catalog.get(id)?.annotations?.idempotent).toBe(true);
    }
  });
});
