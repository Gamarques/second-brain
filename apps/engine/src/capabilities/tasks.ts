import { z } from "zod";

import {
  taskPriorities,
  taskRelationKinds,
  taskStatuses,
  versionOperations,
} from "../domain.js";
import type { BrainAccessStore, TaskGoalLink, TaskStore } from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  actorAttributionSchema,
  cursorSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  idSchema,
  nullableTextSchema,
  taskGoalLinkSchema,
  taskListSchema,
  taskRelationSchema,
  taskSchema,
  temporalCoverageSchema,
  timestampSchema,
  uniqueIdsSchema,
} from "./schemas.js";

const readAnnotations = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
} as const;

const mutationAnnotations = {
  readOnly: false,
  destructive: false,
  idempotent: true,
  openWorld: false,
} as const;

const destructiveAnnotations = {
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: false,
} as const;

const optionalCursor = cursorSchema.nullable().default(null);

const taskSnapshotSchema = z.object({
  id: idSchema,
  listId: idSchema,
  title: z.string().trim().min(1).max(500),
  description: nullableTextSchema,
  status: z.enum(taskStatuses),
  priority: z.enum(taskPriorities),
  dueAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  projectId: idSchema.nullable(),
  goalLinks: z.array(taskGoalLinkSchema).max(20),
});

const taskVersionSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  version: z.number().int().positive(),
  operation: z.enum(versionOperations),
  snapshot: taskSnapshotSchema,
  goalLinks: z.array(taskGoalLinkSchema).max(20),
  effectiveAt: timestampSchema,
  recordedAt: timestampSchema,
  changedFields: z.array(z.string().trim().min(1).max(100)).max(100),
  provenance: actorAttributionSchema,
  activityEventId: idSchema,
});

const temporalTaskPageSchema = z.object({
  tasks: z.array(taskSchema),
  nextCursor: cursorSchema.nullable(),
  coverage: temporalCoverageSchema,
});

const taskListCollectionSchema = z.object({ taskLists: z.array(taskListSchema) });

const taskHistoryPageSchema = z.object({
  versions: z.array(taskVersionSchema),
  nextCursor: cursorSchema.nullable(),
  coverage: temporalCoverageSchema,
});

function explicitGoalLinks(goalIds: readonly string[]): readonly TaskGoalLink[] {
  return goalIds.map((goalId) => ({ goalId, basis: "explicit", confidence: null }));
}

function validTimeRange(input: { readonly from: string | null; readonly to: string | null }) {
  return (
    input.from === null || input.to === null || Date.parse(input.from) <= Date.parse(input.to)
  );
}

function taskUpdateFailed(): never {
  throw new Error("Task was not found or changed after the expected version.");
}

export function createTaskCapabilities(accessStore: BrainAccessStore, taskStore: TaskStore) {
  const createTaskList = defineCapability({
    title: "Create a task list",
    description: "Creates a task list in the brain.",
    input: z.object({
      name: z.string().trim().min(1).max(200),
      description: nullableTextSchema.default(null),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: taskListSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: mutationAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      return taskListSchema.parse(
        await taskStore.createTaskList(
          access,
          {
            name: input.name,
            description: input.description,
            idempotencyKey: input.idempotencyKey,
          },
          context.signal,
        ),
      );
    },
  });

  const listTaskLists = defineCapability({
    title: "List task lists",
    description: "Lists task lists in the brain.",
    input: z.object({}),
    output: taskListCollectionSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: readAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const taskLists = await taskStore.listTaskLists(access, context.signal);
      return taskListCollectionSchema.parse({ taskLists });
    },
  });

  const createTask = defineCapability({
    title: "Create a task",
    description:
      "Creates a versioned task in the brain. Omit projectId to record a general task not tied to a project.",
    input: z.object({
      listId: idSchema,
      title: z.string().trim().min(1).max(500),
      description: nullableTextSchema.default(null),
      priority: z.enum(taskPriorities).default("normal"),
      dueAt: timestampSchema.nullable().default(null),
      projectId: idSchema.nullable().default(null),
      goalIds: uniqueIdsSchema(20).default([]),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: taskSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: mutationAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const task = await taskStore.createTask(
        access,
        {
          listId: input.listId,
          title: input.title,
          description: input.description,
          priority: input.priority,
          dueAt: input.dueAt,
          projectId: input.projectId,
          goalLinks: explicitGoalLinks(input.goalIds),
          idempotencyKey: input.idempotencyKey,
        },
        context.signal,
      );
      if (task === null) {
        throw new Error("A linked task list, project, or goal was not found.");
      }
      return taskSchema.parse(task);
    },
  });

  const listTasks = defineCapability({
    title: "List tasks",
    description: "Lists the task versions visible at a point in time with explicit coverage.",
    input: z.object({
      listId: idSchema.nullable().default(null),
      status: z.enum(taskStatuses).nullable().default(null),
      projectId: idSchema.nullable().default(null),
      goalId: idSchema.nullable().default(null),
      asOf: timestampSchema.nullable().default(null),
      cursor: optionalCursor,
      limit: z.number().int().min(1).max(200).default(50),
    }),
    output: temporalTaskPageSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: readAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const page = await taskStore.listTasks(
        access,
        {
          listId: input.listId,
          status: input.status,
          projectId: input.projectId,
          goalId: input.goalId,
          asOf: input.asOf,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return temporalTaskPageSchema.parse({
        tasks: [...page.items],
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
        coverage: page.coverage,
      });
    },
  });

  const updateTask = defineCapability({
    title: "Update a task",
    description:
      "Updates task content or lifecycle state atomically using an expected version. Use status to start, complete, reopen, or cancel a task. Omitting projectId preserves the current project link; an explicit null detaches the task into general information.",
    input: z
      .object({
        id: idSchema,
        expectedVersion: z.number().int().positive(),
        idempotencyKey: idempotencyKeySchema,
        title: z.string().trim().min(1).max(500).optional(),
        description: nullableTextSchema.optional(),
        status: z.enum(taskStatuses).optional(),
        priority: z.enum(taskPriorities).optional(),
        dueAt: timestampSchema.nullable().optional(),
        projectId: idSchema.nullable().optional(),
        goalIds: uniqueIdsSchema(20).optional(),
      })
      .refine(
        (input) =>
          input.title !== undefined ||
          input.description !== undefined ||
          input.status !== undefined ||
          input.priority !== undefined ||
          input.dueAt !== undefined ||
          input.projectId !== undefined ||
          input.goalIds !== undefined,
        { message: "At least one task field must be provided." },
      ),
    output: taskSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: mutationAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const task = await taskStore.updateTask(
        access,
        input.id,
        {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.goalIds === undefined ? {} : { goalLinks: explicitGoalLinks(input.goalIds) }),
          precondition: {
            expectedVersion: input.expectedVersion,
            idempotencyKey: input.idempotencyKey,
          },
        },
        context.signal,
      );
      return taskSchema.parse(task ?? taskUpdateFailed());
    },
  });

  const deleteTask = defineCapability({
    title: "Permanently delete a task",
    description:
      "Permanently deletes the canonical task and its version and relationship history. Independent excerpts or prose in ingestion sources, dreaming reports, or handoffs are not purged. This destructive operation requires brain administrator access.",
    input: z.object({
      id: idSchema,
      idempotencyKey: idempotencyKeySchema,
    }),
    output: z.object({ deleted: z.literal(true) }),
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: destructiveAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "admin",
      });
      const deleted = await taskStore.deleteTask(
        access,
        input.id,
        { idempotencyKey: input.idempotencyKey },
        context.signal,
      );
      if (!deleted) throw new Error("Task was not found.");
      return { deleted: true as const };
    },
  });

  const listTaskHistory = defineCapability({
    title: "List task history",
    description: "Lists immutable versions for one task with temporal coverage.",
    input: z
      .object({
        taskId: idSchema,
        from: timestampSchema.nullable().default(null),
        to: timestampSchema.nullable().default(null),
        cursor: optionalCursor,
        limit: z.number().int().min(1).max(200).default(50),
      })
      .refine(validTimeRange, { message: "from must not be later than to." }),
    output: taskHistoryPageSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: readAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const page = await taskStore.listTaskHistory(
        access,
        {
          taskId: input.taskId,
          from: input.from,
          to: input.to,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return taskHistoryPageSchema.parse({
        versions: [...page.items],
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
        coverage: page.coverage,
      });
    },
  });

  const createTaskRelation = defineCapability({
    title: "Relate two tasks",
    description: "Creates an explicit blocks, dependency, or duplicate relationship between tasks.",
    input: z
      .object({
        fromTaskId: idSchema,
        toTaskId: idSchema,
        kind: z.enum(taskRelationKinds),
        idempotencyKey: idempotencyKeySchema,
      })
      .refine((input) => input.fromTaskId !== input.toTaskId, {
        message: "A task cannot be related to itself.",
      }),
    output: taskRelationSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: mutationAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const relation = await taskStore.createTaskRelation(
        access,
        {
          fromTaskId: input.fromTaskId,
          toTaskId: input.toTaskId,
          kind: input.kind,
          idempotencyKey: input.idempotencyKey,
        },
        context.signal,
      );
      if (relation === null) throw new Error("A linked task was not found.");
      return taskRelationSchema.parse(relation);
    },
  });

  return {
    task_lists_create: createTaskList,
    task_lists_list: listTaskLists,
    tasks_create: createTask,
    tasks_list: listTasks,
    tasks_update: updateTask,
    tasks_delete: deleteTask,
    tasks_history_list: listTaskHistory,
    task_relations_create: createTaskRelation,
  } as const;
}
