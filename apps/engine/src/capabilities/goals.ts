import { z } from "zod";

import { goalStatuses, versionOperations } from "../domain.js";
import type { BrainAccessStore, Goal, GoalStore, GoalVersion } from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  actorAttributionSchema,
  cursorSchema,
  decodeCursor,
  encodeCursor,
  goalSchema,
  idempotencyKeySchema,
  idSchema,
  nullableTextSchema,
  requireFound,
  temporalCoverageSchema,
  timestampSchema,
} from "./schemas.js";

const goalVersionSchema = z.object({
  id: idSchema,
  goalId: idSchema,
  version: z.number().int().positive(),
  operation: z.enum(versionOperations),
  snapshot: goalSchema.omit({
    version: true,
    historyCompleteFrom: true,
    provenance: true,
    createdAt: true,
    updatedAt: true,
  }),
  effectiveAt: timestampSchema,
  recordedAt: timestampSchema,
  changedFields: z.array(z.string().trim().min(1).max(100)).max(100),
  provenance: actorAttributionSchema,
  activityEventId: idSchema,
});

function writableGoal(goal: Goal) {
  return { ...goal, provenance: { ...goal.provenance } };
}

function writableGoalVersion(version: GoalVersion) {
  return {
    ...version,
    snapshot: { ...version.snapshot },
    changedFields: [...version.changedFields],
    provenance: { ...version.provenance },
  };
}

export function createGoalCapabilities(accessStore: BrainAccessStore, goals: GoalStore) {
  const createGoal = defineCapability({
    title: "Create a goal",
    description:
      "Creates a versioned strategic goal. Omit projectId to create a general goal not tied to a project.",
    input: z.object({
      title: z.string().trim().min(1).max(500),
      description: nullableTextSchema.default(null),
      successCriteria: nullableTextSchema.default(null),
      targetAt: timestampSchema.nullable().default(null),
      projectId: idSchema.nullable().default(null),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: goalSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      return writableGoal(
        requireFound(
          await goals.createGoal(
            access,
            {
              title: input.title,
              description: input.description,
              successCriteria: input.successCriteria,
              targetAt: input.targetAt,
              projectId: input.projectId,
              idempotencyKey: input.idempotencyKey,
            },
            context.signal,
          ),
          "Linked record",
        ),
      );
    },
  });

  const updateGoal = defineCapability({
    title: "Update a goal",
    description:
      "Creates the next version of a strategic goal with optimistic concurrency. An omitted projectId keeps the current project link; an explicit null detaches the goal into general information.",
    input: z
      .object({
        id: idSchema,
        title: z.string().trim().min(1).max(500).optional(),
        description: nullableTextSchema.optional(),
        successCriteria: nullableTextSchema.optional(),
        status: z.enum(goalStatuses).optional(),
        targetAt: timestampSchema.nullable().optional(),
        projectId: idSchema.nullable().optional(),
        expectedVersion: z.number().int().positive(),
        idempotencyKey: idempotencyKeySchema,
      })
      .refine(
        (value) =>
          value.title !== undefined ||
          value.description !== undefined ||
          value.successCriteria !== undefined ||
          value.status !== undefined ||
          value.targetAt !== undefined ||
          value.projectId !== undefined,
        { message: "At least one change is required." },
      ),
    output: goalSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const goal = await goals.updateGoal(
        access,
        input.id,
        {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.successCriteria === undefined
            ? {}
            : { successCriteria: input.successCriteria }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.targetAt === undefined ? {} : { targetAt: input.targetAt }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          precondition: {
            expectedVersion: input.expectedVersion,
            idempotencyKey: input.idempotencyKey,
          },
        },
        context.signal,
      );
      if (goal === null) {
        throw new Error("Goal was not found or its version did not match.");
      }
      return writableGoal(goal);
    },
  });

  const listGoals = defineCapability({
    title: "List goals",
    description: "Lists strategic goals, including an as-of view and explicit history coverage.",
    input: z.object({
      status: z.enum(goalStatuses).nullable().default(null),
      projectId: idSchema.nullable().default(null),
      asOf: timestampSchema.nullable().default(null),
      cursor: cursorSchema.nullable().default(null),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    output: z.object({
      goals: z.array(goalSchema),
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
      const page = await goals.listGoals(
        access,
        {
          status: input.status,
          projectId: input.projectId,
          asOf: input.asOf,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        goals: page.items.map(writableGoal),
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
        coverage: temporalCoverageSchema.parse(page.coverage),
      };
    },
  });

  const listGoalHistory = defineCapability({
    title: "List goal history",
    description: "Lists immutable versions of one strategic goal with coverage metadata.",
    input: z.object({
      goalId: idSchema,
      cursor: cursorSchema.nullable().default(null),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    output: z.object({
      versions: z.array(goalVersionSchema),
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
      const page = await goals.listGoalHistory(
        access,
        {
          goalId: input.goalId,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        versions: page.items.map(writableGoalVersion),
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
        coverage: temporalCoverageSchema.parse(page.coverage),
      };
    },
  });

  return {
    goals_create: createGoal,
    goals_update: updateGoal,
    goals_list: listGoals,
    goals_history: listGoalHistory,
  } as const;
}
