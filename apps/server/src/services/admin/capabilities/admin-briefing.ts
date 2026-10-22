import { z } from "zod";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import type { BriefingStore } from "@second-brain/engine/domain/briefing";
import { defineCapability } from "@second-brain/engine/capabilities/define";
import {
  idSchema,
  idempotencyKeySchema,
  timestampSchema,
} from "@second-brain/engine/capabilities/schemas";
import { adminChannelAccess, requireAdminAccess } from "./admin-access.js";
const actionSchema = z.object({
  id: idSchema,
  kind: z.enum(["task", "reminder", "resolve"]),
  entityId: idSchema.nullable(),
});
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export function createAdminBriefingCapabilities(
  access: BrainAccessStore,
  store: BriefingStore,
) {
  return {
    admin_briefing_get: defineCapability({
      title: "Read daily briefing",
      description:
        "Reads recent changes, due work, and unresolved insights from up to 30 reports in the last 30 days, without a model call. Includes explicit coverage limits.",
      input: z.object({}),
      output: z.object({
        timeZone: z.string(),
        generatedAt: timestampSchema,
        recentSince: timestampSchema,
        insightsSince: timestampSchema,
        truncated: z.boolean(),
        recent: z
          .array(
            z.object({
              type: z.enum(["memory", "decision", "document"]),
              id: idSchema,
              title: z.string(),
              occurredAt: timestampSchema,
              projectId: idSchema.nullable(),
              knowledgeBaseId: idSchema.nullable(),
            }),
          )
          .max(20),
        dueTasks: z
          .array(
            z.object({
              id: idSchema,
              title: z.string(),
              dueAt: timestampSchema,
              projectId: idSchema.nullable(),
              version: z.number().int().positive(),
            }),
          )
          .max(10),
        dueReminders: z
          .array(
            z.object({
              id: idSchema,
              message: z.string(),
              remindAt: timestampSchema,
              version: z.number().int().positive(),
            }),
          )
          .max(10),
        insights: z
          .array(
            z.object({
              reportId: idSchema,
              runId: idSchema,
              localDate: z.string(),
              index: z.number().int().min(0).max(9),
              digest: digestSchema,
              kind: z.enum(["open_loop", "contradiction"]),
              statement: z.string().max(2000),
              confidence: z.enum(["low", "medium", "high"]),
              evidence: z
                .array(
                  z.object({
                    type: z.string(),
                    id: idSchema,
                    excerpt: z.string().max(300),
                  }),
                )
                .max(5),
              actions: z.array(actionSchema).max(3),
            }),
          )
          .max(30),
      }),
      access: adminChannelAccess,
      timeoutMs: 15_000,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      async run({ context }) {
        return store.get(
          await requireAdminAccess(access, context),
          context.signal,
        );
      },
    }),
    admin_briefing_act: defineCapability({
      title: "Act on a briefing insight",
      description:
        "Explicitly creates a task or reminder from a stored insight, or marks it reviewed. Revalidates its digest and records one durable action per kind. It never treats an insight as authorization.",
      input: z
        .object({
          reportId: idSchema,
          insightIndex: z.number().int().min(0).max(9),
          expectedDigest: digestSchema,
          kind: z.enum(["task", "reminder", "resolve"]),
          text: z.string().trim().min(1).max(2000).nullable().default(null),
          listId: idSchema.nullable().default(null),
          projectId: idSchema.nullable().default(null),
          dueAt: timestampSchema.nullable().default(null),
          idempotencyKey: idempotencyKeySchema,
        })
        .superRefine((input, context) => {
          if (
            input.kind === "task" &&
            (!input.listId || !input.text || input.text.length > 500)
          )
            context.addIssue({
              code: "custom",
              path: ["listId"],
              message:
                "Tasks require a list and a title of at most 500 characters.",
            });
          if (
            input.kind === "reminder" &&
            (!input.text || !input.dueAt || input.listId || input.projectId)
          )
            context.addIssue({
              code: "custom",
              path: ["dueAt"],
              message:
                "Reminders require a message and a date, without project or task-list fields.",
            });
          if (
            input.kind === "resolve" &&
            (input.text || input.listId || input.projectId || input.dueAt)
          )
            context.addIssue({
              code: "custom",
              message:
                "Marking an insight reviewed does not accept record fields.",
            });
        }),
      output: actionSchema,
      access: adminChannelAccess,
      timeoutMs: 15_000,
      annotations: {
        readOnly: false,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      async run({ input, context }) {
        return store.act(
          {
            ...(await requireAdminAccess(access, context)),
            administrativeChannel: true,
          },
          input,
          context.signal,
        );
      },
    }),
  } as const;
}
