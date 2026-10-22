import { z } from "zod";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import {
  projectSections,
  type ProjectOverviewStore,
} from "@second-brain/engine/domain/project-overview";
import { defineCapability } from "@second-brain/engine/capabilities/define";
import {
  idSchema,
  timestampSchema,
} from "@second-brain/engine/capabilities/schemas";
import { adminChannelAccess, requireAdminAccess } from "./admin-access.js";
const annotations = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
} as const;
export function createAdminProjectCapabilities(
  access: BrainAccessStore,
  store: ProjectOverviewStore,
) {
  return {
    admin_project_get: defineCapability({
      title: "Read project overview",
      description:
        "Reads a project and exact counts of its tasks, goals, current decisions and memories, related people and documents.",
      input: z.object({ projectId: idSchema }),
      output: z.object({
        result: z
          .object({
            project: z.object({
              id: idSchema,
              name: z.string(),
              description: z.string().nullable(),
              status: z.string(),
              version: z.number().int().positive(),
            }),
            counts: z.object({
              tasks: z.number().int().nonnegative(),
              goals: z.number().int().nonnegative(),
              decisions: z.number().int().nonnegative(),
              people: z.number().int().nonnegative(),
              documents: z.number().int().nonnegative(),
              memories: z.number().int().nonnegative(),
            }),
          })
          .nullable(),
      }),
      access: adminChannelAccess,
      timeoutMs: 15_000,
      annotations,
      async run({ input, context }) {
        return {
          result: await store.overview(
            await requireAdminAccess(access, context),
            input.projectId,
            context.signal,
          ),
        };
      },
    }),
    admin_project_section: defineCapability({
      title: "Read a project context section",
      description:
        "Pages explicitly linked project records in stable identifier order without loading unbounded collections.",
      input: z.object({
        projectId: idSchema,
        section: z.enum(projectSections),
        cursor: idSchema.nullable().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      output: z.object({
        items: z
          .array(
            z.object({
              id: idSchema,
              title: z.string(),
              body: z.string().nullable(),
              status: z.string().nullable(),
              version: z.number().int().positive().nullable(),
              date: timestampSchema.nullable(),
              priority: z.string().nullable(),
              knowledgeBaseId: idSchema.nullable(),
              tags: z.array(z.string()),
            }),
          )
          .max(100),
        nextCursor: idSchema.nullable(),
      }),
      access: adminChannelAccess,
      timeoutMs: 15_000,
      annotations,
      async run({ input, context }) {
        return store.section(
          await requireAdminAccess(access, context),
          input,
          context.signal,
        );
      },
    }),
  } as const;
}
