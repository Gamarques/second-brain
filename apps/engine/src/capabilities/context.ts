import { z } from "zod";

import type {
  BrainAccessStore,
  BrainContextSnapshot,
  BrainHandoff,
  ContextStore,
} from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  knowledgeBaseCatalogEntrySchema,
  personIndexEntrySchema,
  actorProvenanceSchema,
  cursorSchema,
  decisionSchema,
  decodeCursor,
  encodeCursor,
  goalSchema,
  idempotencyKeySchema,
  idSchema,
  memorySchema,
  priorityPlanSchema,
  reminderSchema,
  taskSchema,
  temporalCoverageSchema,
  timestampSchema,
} from "./schemas.js";

const contextMaximums = {
  memories: 20,
  decisions: 20,
  tasks: 50,
  reminders: 20,
  goals: 20,
  priorities: 20,
} as const;

const contextLimitsSchema = z
  .object({
    memories: z.number().int().min(1).max(contextMaximums.memories).default(10),
    decisions: z
      .number()
      .int()
      .min(1)
      .max(contextMaximums.decisions)
      .default(10),
    tasks: z.number().int().min(1).max(contextMaximums.tasks).default(20),
    reminders: z
      .number()
      .int()
      .min(1)
      .max(contextMaximums.reminders)
      .default(10),
    goals: z.number().int().min(1).max(contextMaximums.goals).default(10),
  })
  .default({
    memories: 10,
    decisions: 10,
    tasks: 20,
    reminders: 10,
    goals: 10,
  });

const contextSnapshotSchema = z.object({
  generatedAt: timestampSchema,
  asOf: timestampSchema,
  purpose: z.string().trim().min(1).max(1_000).nullable(),
  currentPriorities: z
    .array(priorityPlanSchema)
    .max(contextMaximums.priorities),
  activeGoals: z.array(goalSchema).max(contextMaximums.goals),
  activeDecisions: z.array(decisionSchema).max(contextMaximums.decisions),
  relevantMemories: z.array(memorySchema).max(contextMaximums.memories),
  openTasks: z.array(taskSchema).max(contextMaximums.tasks),
  pendingReminders: z.array(reminderSchema).max(contextMaximums.reminders),
  knowledgeBases: z.array(knowledgeBaseCatalogEntrySchema).max(100),
  peopleIndex: z.array(personIndexEntrySchema).max(50),
  coverage: temporalCoverageSchema,
});

const handoffEntityTypes = [
  "memory",
  "decision",
  "task",
  "reminder",
  "goal",
  "project",
] as const;

const handoffEntityRefSchema = z.object({
  type: z.enum(handoffEntityTypes),
  id: idSchema,
});

const handoffEntityRefsSchema = z
  .array(handoffEntityRefSchema)
  .max(50)
  .superRefine((references, context) => {
    const keys = references.map(({ type, id }) => `${type}:${id}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        message: "entityRefs must not contain duplicates.",
      });
    }
  });

const handoffSchema = z.object({
  id: idSchema,
  fromClientId: z.string().min(1).max(500).nullable(),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(5_000),
  nextActions: z.array(z.string().trim().min(1).max(500)).max(20),
  entityRefs: handoffEntityRefsSchema,
  provenance: actorProvenanceSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
});

function writableContext(snapshot: BrainContextSnapshot) {
  return {
    ...snapshot,
    currentPriorities: snapshot.currentPriorities.map((priority) => ({
      ...priority,
      items: priority.items.map((item) => ({ ...item })),
      provenance: { ...priority.provenance },
    })),
    activeGoals: snapshot.activeGoals.map((goal) => ({
      ...goal,
      provenance: { ...goal.provenance },
    })),
    activeDecisions: snapshot.activeDecisions.map((decision) => ({
      ...decision,
      rejectedAlternatives: decision.rejectedAlternatives.map(
        (alternative) => ({
          ...alternative,
        }),
      ),
      personIds: [...decision.personIds],
      provenance: { ...decision.provenance },
    })),
    relevantMemories: snapshot.relevantMemories.map((memory) => ({
      ...memory,
      tags: [...memory.tags],
      personIds: [...memory.personIds],
      provenance: { ...memory.provenance },
    })),
    openTasks: snapshot.openTasks.map((task) => ({
      ...task,
      goalLinks: task.goalLinks.map((link) => ({ ...link })),
      provenance: { ...task.provenance },
    })),
    pendingReminders: snapshot.pendingReminders.map((reminder) => ({
      ...reminder,
      provenance: { ...reminder.provenance },
    })),
    knowledgeBases: snapshot.knowledgeBases.map((base) => ({ ...base })),
    peopleIndex: snapshot.peopleIndex.map((person) => ({
      ...person,
      aliases: [...person.aliases],
      tags: [...person.tags],
      relatedProjects: person.relatedProjects.map((project) => ({ ...project })),
      relatedKnowledgeBases: person.relatedKnowledgeBases.map((base) => ({
        ...base,
      })),
    })),
    coverage: {
      ...snapshot.coverage,
      warnings: [...snapshot.coverage.warnings],
    },
  };
}

function writableHandoff(handoff: BrainHandoff) {
  return {
    ...handoff,
    nextActions: [...handoff.nextActions],
    entityRefs: handoff.entityRefs.map((reference) => ({ ...reference })),
    provenance: { ...handoff.provenance },
  };
}

export function createContextCapabilities(
  accessStore: BrainAccessStore,
  contextStore: ContextStore,
) {
  const getContext = defineCapability({
    title: "Get brain context",
    description:
      "Loads a bounded, point-in-time brain context snapshot for continuing work in another AI client. Always includes the knowledge-base catalog (name plus the description of what each base covers) and a people index (id, name, summary, and related projects and knowledge bases). Call this at session start. For who/what questions after startup, use brain_search so documents are searched in the same step.",
    input: z.object({
      purpose: z.string().trim().min(1).max(1_000).nullable().default(null),
      asOf: timestampSchema.optional(),
      limits: contextLimitsSchema,
    }),
    output: contextSnapshotSchema,
    access: "authenticated",
    timeoutMs: 20_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      return writableContext(
        await contextStore.loadContext(
          access,
          {
            purpose: input.purpose,
            asOf: input.asOf ?? new Date().toISOString(),
            limits: input.limits,
          },
          context.signal,
        ),
      );
    },
  });

  const createHandoff = defineCapability({
    title: "Create a handoff",
    description:
      "Creates a bounded, idempotent continuity note for another AI client without invoking an external system.",
    input: z.object({
      title: z.string().trim().min(1).max(300),
      summary: z.string().trim().min(1).max(5_000),
      nextActions: z
        .array(z.string().trim().min(1).max(500))
        .max(20)
        .default([]),
      entityRefs: handoffEntityRefsSchema.default([]),
      expiresAt: timestampSchema.nullable().default(null),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: handoffSchema,
    access: "authenticated",
    timeoutMs: 15_000,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      return writableHandoff(
        await contextStore.createHandoff(access, input, context.signal),
      );
    },
  });

  const listHandoffs = defineCapability({
    title: "List handoffs",
    description:
      "Lists bounded cross-client continuity notes with opaque cursor pagination.",
    input: z.object({
      cursor: cursorSchema.nullable().default(null),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    output: z.object({
      items: z.array(handoffSchema).max(50),
      nextCursor: cursorSchema.nullable(),
    }),
    access: "authenticated",
    timeoutMs: 15_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const page = await contextStore.listHandoffs(
        access,
        {
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        items: page.items.map(writableHandoff),
        nextCursor:
          page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      };
    },
  });

  return {
    context_get: getContext,
    handoffs_create: createHandoff,
    handoffs_list: listHandoffs,
  } as const;
}
