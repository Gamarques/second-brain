import { z } from "zod";

import { activityKinds } from "../domain.js";
import type {
  Activity,
  ActivityStore,
  BrainAccessStore,
} from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  activityGoalAllocationSchema,
  activitySchema,
  cursorSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  idSchema,
  requireFound,
  temporalCoverageSchema,
  timestampSchema,
} from "./schemas.js";

const allocationsInputSchema = z
  .array(activityGoalAllocationSchema)
  .max(20)
  .superRefine((allocations, context) => {
    if (
      allocations.some((item) => {
        const scaled = item.allocationPercent * 100;
        const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
        return Math.abs(scaled - Math.round(scaled)) > tolerance;
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Allocation percentages may have at most two decimal places.",
      });
    }
    if (new Set(allocations.map((item) => item.goalId)).size !== allocations.length) {
      context.addIssue({ code: "custom", message: "A goal may appear only once." });
    }
    const total = allocations.reduce((sum, item) => sum + item.allocationPercent, 0);
    if (total > 100) {
      context.addIssue({
        code: "custom",
        message: "Allocation percentages must not total more than 100.",
      });
    }
  });

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .superRefine((value, context) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
    } catch {
      context.addIssue({ code: "custom", message: "The time zone must be a valid IANA name." });
    }
  });

const completedTaskAlignmentSchema = z.object({
  linkedCount: z.number().int().nonnegative(),
  unlinkedCount: z.number().int().nonnegative(),
  alignedLinkedCount: z.number().int().nonnegative(),
  nonPriorityLinkedCount: z.number().int().nonnegative(),
  rateAmongLinked: z.number().min(0).max(1).nullable(),
});

const recordedIntervalAlignmentSchema = z.object({
  sessionCount: z.number().int().nonnegative(),
  rawRecordedMinutes: z.number().nonnegative(),
  overlappingMinutes: z.number().nonnegative(),
  allocatedMinutes: z.number().nonnegative(),
  priorityAllocatedMinutes: z.number().nonnegative(),
  rateAmongAllocated: z.number().min(0).max(1).nullable(),
});

const activitySummarySchema = z.object({
  from: timestampSchema,
  to: timestampSchema,
  timeZone: timeZoneSchema,
  tasksCreated: z.number().int().nonnegative(),
  tasksStarted: z.number().int().nonnegative(),
  tasksCompleted: z.number().int().nonnegative(),
  tasksReopened: z.number().int().nonnegative(),
  tasksCanceled: z.number().int().nonnegative(),
  remindersScheduled: z.number().int().nonnegative(),
  remindersCompleted: z.number().int().nonnegative(),
  overdueTasksAtEnd: z.number().int().nonnegative(),
  pendingPastDueRemindersAtEnd: z.number().int().nonnegative(),
  completedTasks: completedTaskAlignmentSchema,
  recordedIntervals: recordedIntervalAlignmentSchema,
  sourceEventIds: z.array(idSchema),
  sourceActivityIds: z.array(idSchema),
  provenanceHash: z.string().regex(/^[0-9a-f]{64}$/),
  coverage: temporalCoverageSchema,
});

function orderedRange(from: string, to: string): boolean {
  return Date.parse(to) > Date.parse(from);
}

function writableActivity(activity: Activity) {
  return {
    ...activity,
    allocations: activity.allocations.map((allocation) => ({ ...allocation })),
    provenance: { ...activity.provenance },
  };
}

export function createActivityCapabilities(
  accessStore: BrainAccessStore,
  activities: ActivityStore,
) {
  const recordActivity = defineCapability({
    title: "Record an activity",
    description:
      "Records an observed activity or explicit interval without claiming inferred time spent. Omit projectId to record general activity not tied to a project.",
    input: z
      .object({
        kind: z.enum(activityKinds),
        occurredAt: timestampSchema,
        endedAt: timestampSchema.nullable().default(null),
        taskId: idSchema.nullable().default(null),
        projectId: idSchema.nullable().default(null),
        summary: z.string().trim().min(1).max(2_000).nullable().default(null),
        analysisAllowed: z.boolean().default(true),
        allocations: allocationsInputSchema.default([]),
        idempotencyKey: idempotencyKeySchema,
      })
      .refine(
        (value) => value.endedAt === null || orderedRange(value.occurredAt, value.endedAt),
        { message: "endedAt must be after occurredAt." },
      ),
    output: z.object({ activity: activitySchema, created: z.boolean() }),
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const result = await activities.recordActivity(
        access,
        {
          kind: input.kind,
          occurredAt: input.occurredAt,
          endedAt: input.endedAt,
          taskId: input.taskId,
          projectId: input.projectId,
          summary: input.summary,
          analysisAllowed: input.analysisAllowed,
          allocations: input.allocations,
          idempotencyKey: input.idempotencyKey,
        },
        context.signal,
      );
      const found = requireFound(result, "Linked record");
      return { activity: writableActivity(found.activity), created: found.created };
    },
  });

  const listActivities = defineCapability({
    title: "List activities",
    description: "Lists recorded activities in an explicit interval with coverage metadata.",
    input: z
      .object({
        from: timestampSchema,
        to: timestampSchema,
        kinds: z.array(z.enum(activityKinds)).max(activityKinds.length).default([]),
        projectId: idSchema.nullable().default(null),
        goalId: idSchema.nullable().default(null),
        includeRetracted: z.boolean().default(false),
        cursor: cursorSchema.nullable().default(null),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .refine((value) => orderedRange(value.from, value.to), {
        message: "to must be after from.",
      })
      .superRefine((value, context) => {
        if (new Set(value.kinds).size !== value.kinds.length) {
          context.addIssue({ code: "custom", message: "Activity kinds must be unique." });
        }
      }),
    output: z.object({
      activities: z.array(activitySchema),
      nextCursor: cursorSchema.nullable(),
      coverage: temporalCoverageSchema,
    }),
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const page = await activities.listActivities(
        access,
        {
          from: input.from,
          to: input.to,
          kinds: input.kinds,
          projectId: input.projectId,
          goalId: input.goalId,
          includeRetracted: input.includeRetracted,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        activities: page.items.map(writableActivity),
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
        coverage: temporalCoverageSchema.parse(page.coverage),
      };
    },
  });

  const retractActivity = defineCapability({
    title: "Retract an activity",
    description: "Retracts an incorrectly recorded activity while retaining its audit history.",
    input: z.object({
      id: idSchema,
      reason: z.string().trim().min(1).max(500),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: activitySchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const activity = await activities.retractActivity(
        access,
        input.id,
        { reason: input.reason, idempotencyKey: input.idempotencyKey },
        context.signal,
      );
      return writableActivity(requireFound(activity, "Activity"));
    },
  });

  const summarizeActivities = defineCapability({
    title: "Summarize recorded activity",
    description:
      "Summarizes task events and explicitly recorded intervals, including linkage and history coverage; it does not infer time spent from update frequency.",
    input: z
      .object({
        from: timestampSchema,
        to: timestampSchema,
        timeZone: timeZoneSchema.optional(),
      })
      .refine((value) => orderedRange(value.from, value.to), {
        message: "to must be after from.",
      }),
    output: activitySummarySchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const timeZone =
        input.timeZone ?? (await accessStore.getTimeZone(access, context.signal));
      const summary = await activities.summarizeActivities(
        access,
        { from: input.from, to: input.to, timeZone },
        context.signal,
      );
      return activitySummarySchema.parse({
        ...summary,
        completedTasks: { ...summary.completedTasks },
        recordedIntervals: { ...summary.recordedIntervals },
        sourceEventIds: [...summary.sourceEventIds],
        sourceActivityIds: [...summary.sourceActivityIds],
        coverage: temporalCoverageSchema.parse(summary.coverage),
      });
    },
  });

  return {
    activities_record: recordActivity,
    activities_list: listActivities,
    activities_retract: retractActivity,
    activities_summary: summarizeActivities,
  } as const;
}
