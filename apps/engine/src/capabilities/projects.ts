import { z } from "zod";

import { projectStatuses } from "../domain.js";
import type { BrainAccessStore, ProjectStore } from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  cursorSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  idSchema,
  nullableTextSchema,
  projectSchema,
  requireFound,
} from "./schemas.js";

const projectNameSchema = z.string().trim().min(1).max(300);

export function createProjectCapabilities(
  accessStore: BrainAccessStore,
  projectStore: ProjectStore,
) {
  const createProject = defineCapability({
    title: "Create a project",
    description:
      "Creates a project in the brain that memories, decisions, tasks, and goals can reference.",
    input: z.object({
      name: projectNameSchema,
      description: nullableTextSchema.default(null),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: projectSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      return projectStore.createProject(
        access,
        {
          name: input.name,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
        },
        context.signal,
      );
    },
  });

  const listProjects = defineCapability({
    title: "List projects",
    description:
      "Lists projects in the brain, optionally filtered by status, with cursor pagination.",
    input: z.object({
      status: z.enum(projectStatuses).nullable().default(null),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: cursorSchema.nullable().default(null),
    }),
    output: z.object({
      projects: z.array(projectSchema),
      nextCursor: cursorSchema.nullable(),
    }),
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const page = await projectStore.listProjects(
        access,
        {
          status: input.status,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        projects: page.items.map((project) => ({ ...project })),
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      };
    },
  });

  const updateProject = defineCapability({
    title: "Update a project",
    description:
      "Updates a project in the brain using an optimistic version precondition.",
    input: z
      .object({
        id: idSchema,
        expectedVersion: z.number().int().positive(),
        idempotencyKey: idempotencyKeySchema,
        name: projectNameSchema.optional(),
        description: nullableTextSchema.optional(),
        status: z.enum(projectStatuses).optional(),
      })
      .refine(
        (value) =>
          value.name !== undefined ||
          value.description !== undefined ||
          value.status !== undefined,
        { message: "At least one project change is required." },
      ),
    output: projectSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      return requireFound(
        await projectStore.updateProject(
          access,
          input.id,
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.status === undefined ? {} : { status: input.status }),
            precondition: {
              expectedVersion: input.expectedVersion,
              idempotencyKey: input.idempotencyKey,
            },
          },
          context.signal,
        ),
        "Project",
      );
    },
  });

  return {
    projects_create: createProject,
    projects_list: listProjects,
    projects_update: updateProject,
  } as const;
}
