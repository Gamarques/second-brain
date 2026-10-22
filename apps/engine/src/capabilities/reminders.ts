import { z } from "zod";

import { versionOperations } from "../domain.js";
import type { BrainAccessStore, ReminderStore } from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  actorAttributionSchema,
  cursorSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  idSchema,
  reminderSchema,
  temporalCoverageSchema,
  timestampSchema,
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

const reminderSnapshotSchema = z.object({
  id: idSchema,
  message: z.string().trim().min(1).max(2_000),
  remindAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});

const reminderVersionSchema = z.object({
  id: idSchema,
  reminderId: idSchema,
  version: z.number().int().positive(),
  operation: z.enum(versionOperations),
  snapshot: reminderSnapshotSchema,
  effectiveAt: timestampSchema,
  recordedAt: timestampSchema,
  changedFields: z.array(z.string().trim().min(1).max(100)).max(100),
  provenance: actorAttributionSchema,
  activityEventId: idSchema,
});

const temporalReminderPageSchema = z.object({
  reminders: z.array(reminderSchema),
  nextCursor: cursorSchema.nullable(),
  coverage: temporalCoverageSchema,
});

const reminderHistoryPageSchema = z.object({
  versions: z.array(reminderVersionSchema),
  nextCursor: cursorSchema.nullable(),
  coverage: temporalCoverageSchema,
});

function validTimeRange(input: { readonly from: string | null; readonly to: string | null }) {
  return (
    input.from === null || input.to === null || Date.parse(input.from) <= Date.parse(input.to)
  );
}

function reminderUpdateFailed(): never {
  throw new Error("Reminder was not found or changed after the expected version.");
}

export function createReminderCapabilities(
  accessStore: BrainAccessStore,
  reminderStore: ReminderStore,
) {
  const createReminder = defineCapability({
    title: "Create a reminder",
    description: "Creates a versioned reminder in the brain.",
    input: z.object({
      message: z.string().trim().min(1).max(2_000),
      remindAt: timestampSchema,
      idempotencyKey: idempotencyKeySchema,
    }),
    output: reminderSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: mutationAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      return reminderSchema.parse(
        await reminderStore.createReminder(
          access,
          {
            message: input.message,
            remindAt: input.remindAt,
            idempotencyKey: input.idempotencyKey,
          },
          context.signal,
        ),
      );
    },
  });

  const listReminders = defineCapability({
    title: "List reminders",
    description: "Lists the reminder versions visible at a point in time with explicit coverage.",
    input: z.object({
      includeCompleted: z.boolean().default(false),
      asOf: timestampSchema.nullable().default(null),
      cursor: optionalCursor,
      limit: z.number().int().min(1).max(200).default(50),
    }),
    output: temporalReminderPageSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: readAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const page = await reminderStore.listReminders(
        access,
        {
          includeCompleted: input.includeCompleted,
          asOf: input.asOf,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return temporalReminderPageSchema.parse({
        reminders: [...page.items],
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
        coverage: page.coverage,
      });
    },
  });

  const updateReminder = defineCapability({
    title: "Update a reminder",
    description:
      "Updates a reminder atomically using an expected version. Set completed to true to complete it or false to reopen it.",
    input: z
      .object({
        id: idSchema,
        expectedVersion: z.number().int().positive(),
        idempotencyKey: idempotencyKeySchema,
        message: z.string().trim().min(1).max(2_000).optional(),
        remindAt: timestampSchema.optional(),
        completed: z.boolean().optional(),
      })
      .refine(
        (input) =>
          input.message !== undefined ||
          input.remindAt !== undefined ||
          input.completed !== undefined,
        { message: "At least one reminder field must be provided." },
      ),
    output: reminderSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: mutationAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const reminder = await reminderStore.updateReminder(
        access,
        input.id,
        {
          ...(input.message === undefined ? {} : { message: input.message }),
          ...(input.remindAt === undefined ? {} : { remindAt: input.remindAt }),
          ...(input.completed === undefined ? {} : { completed: input.completed }),
          precondition: {
            expectedVersion: input.expectedVersion,
            idempotencyKey: input.idempotencyKey,
          },
        },
        context.signal,
      );
      return reminderSchema.parse(reminder ?? reminderUpdateFailed());
    },
  });

  const deleteReminder = defineCapability({
    title: "Permanently delete a reminder",
    description:
      "Permanently deletes the canonical reminder and its version and delivery history. Independent excerpts or prose in ingestion sources, dreaming reports, or handoffs are not purged. This destructive operation requires brain administrator access.",
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
      const deleted = await reminderStore.deleteReminder(
        access,
        input.id,
        { idempotencyKey: input.idempotencyKey },
        context.signal,
      );
      if (!deleted) throw new Error("Reminder was not found.");
      return { deleted: true as const };
    },
  });

  const listReminderHistory = defineCapability({
    title: "List reminder history",
    description: "Lists immutable versions for one reminder with temporal coverage.",
    input: z
      .object({
        reminderId: idSchema,
        from: timestampSchema.nullable().default(null),
        to: timestampSchema.nullable().default(null),
        cursor: optionalCursor,
        limit: z.number().int().min(1).max(200).default(50),
      })
      .refine(validTimeRange, { message: "from must not be later than to." }),
    output: reminderHistoryPageSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: readAnnotations,
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const page = await reminderStore.listReminderHistory(
        access,
        {
          reminderId: input.reminderId,
          from: input.from,
          to: input.to,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return reminderHistoryPageSchema.parse({
        versions: [...page.items],
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
        coverage: page.coverage,
      });
    },
  });

  return {
    reminders_create: createReminder,
    reminders_list: listReminders,
    reminders_update: updateReminder,
    reminders_delete: deleteReminder,
    reminders_history_list: listReminderHistory,
  } as const;
}
