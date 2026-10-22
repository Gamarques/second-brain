import { z } from "zod";

import {
  automationJobKinds,
  automationJobStatuses,
  dreamingModes,
} from "@second-brain/engine/domain";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import {
  AdminRevisionConflictError,
  type AdminAutomationSettingsChanges,
  type AdminAutomationStore,
} from "../domain.js";
import { adminChannelAccess, requireAdminAccess } from "./admin-access.js";
import { defineCapability } from "@second-brain/engine/capabilities/define";
import {
  automationJobSchema,
  cursorSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  localDateSchema,
  timestampSchema,
} from "@second-brain/engine/capabilities/schemas";

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(validTimeZone, "timeZone must be a valid IANA time zone.");

const localTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "dreamLocalTime must use HH:MM format.");

const automationSettingsSchema = z.object({
  timeZone: timeZoneSchema,
  dreamingEnabled: z.boolean(),
  dreamLocalTime: localTimeSchema,
  nextDreamAt: timestampSchema.nullable(),
  dreamingMode: z.enum(dreamingModes),
  dailyInputTokenLimit: z.number().int().min(1).max(1_000_000),
  dailyOutputTokenLimit: z.number().int().min(1).max(100_000),
  reminderDeliveryEnabled: z.boolean(),
  revision: z.number().int().positive(),
  updatedAt: timestampSchema,
});

const settingsUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: idempotencyKeySchema,
    timeZone: timeZoneSchema.optional(),
    dreamingEnabled: z.boolean().optional(),
    dreamLocalTime: localTimeSchema.optional(),
    dreamingMode: z.enum(dreamingModes).optional(),
    dailyInputTokenLimit: z.number().int().min(1).max(1_000_000).optional(),
    dailyOutputTokenLimit: z.number().int().min(1).max(100_000).optional(),
    reminderDeliveryEnabled: z.boolean().optional(),
  })
  .refine(
    ({ expectedRevision: _revision, idempotencyKey: _key, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: "At least one automation setting must be provided." },
  );

const workerStatusSchema = z.object({
  workerId: z.string().trim().min(1).max(500),
  version: z.string().trim().min(1).max(100),
  startedAt: timestampSchema,
  lastSeenAt: timestampSchema,
  health: z.enum(["healthy", "stale"]),
});

const statusSchema = z.object({
  observedAt: timestampSchema,
  workers: z.array(workerStatusSchema).max(100),
  jobs: z.object({
    pending: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    retryWait: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    lastCompletedAt: timestampSchema.nullable(),
  }),
});

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

function settingsChanges(
  input: z.output<typeof settingsUpdateSchema>,
): AdminAutomationSettingsChanges {
  return {
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
    ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    ...(input.dreamingEnabled === undefined
      ? {}
      : { dreamingEnabled: input.dreamingEnabled }),
    ...(input.dreamLocalTime === undefined
      ? {}
      : { dreamLocalTime: input.dreamLocalTime }),
    ...(input.dreamingMode === undefined
      ? {}
      : { dreamingMode: input.dreamingMode }),
    ...(input.dailyInputTokenLimit === undefined
      ? {}
      : { dailyInputTokenLimit: input.dailyInputTokenLimit }),
    ...(input.dailyOutputTokenLimit === undefined
      ? {}
      : { dailyOutputTokenLimit: input.dailyOutputTokenLimit }),
    ...(input.reminderDeliveryEnabled === undefined
      ? {}
      : { reminderDeliveryEnabled: input.reminderDeliveryEnabled }),
  };
}

export function createAdminAutomationCapabilities(
  accessStore: BrainAccessStore,
  automation: AdminAutomationStore,
) {
  const getSettings = defineCapability({
    title: "Get automation settings",
    description:
      "Returns the complete operator-controlled automation settings snapshot.",
    input: z.object({}),
    output: z.object({ settings: automationSettingsSchema }),
    access: adminChannelAccess,
    timeoutMs: 10_000,
    annotations: readAnnotations,
    async run({ input, context }) {
      const access = await requireAdminAccess(accessStore, context);
      return {
        settings: automationSettingsSchema.parse(
          await automation.getSettings(access, context.signal),
        ),
      };
    },
  });

  const updateSettings = defineCapability({
    title: "Update automation settings",
    description:
      "Revision-updates the daily dreaming schedule, mode, and bounded token controls.",
    input: settingsUpdateSchema,
    output: z.object({ settings: automationSettingsSchema }),
    access: adminChannelAccess,
    timeoutMs: 10_000,
    annotations: mutationAnnotations,
    async run({ input, context }) {
      const access = await requireAdminAccess(accessStore, context);
      const updated = await automation.updateSettings(
        access,
        settingsChanges(input),
        context.signal,
      );
      if (updated === null) throw new AdminRevisionConflictError();
      return { settings: automationSettingsSchema.parse(updated) };
    },
  });

  const getStatus = defineCapability({
    title: "Get automation status",
    description:
      "Returns worker heartbeat health and bounded automation job counts.",
    input: z.object({}),
    output: statusSchema,
    access: adminChannelAccess,
    timeoutMs: 10_000,
    annotations: readAnnotations,
    async run({ input, context }) {
      const access = await requireAdminAccess(accessStore, context);
      return statusSchema.parse(
        await automation.getStatus(access, context.signal),
      );
    },
  });

  const listJobs = defineCapability({
    title: "List automation jobs",
    description:
      "Lists durable automation jobs by kind and status without exposing job payloads.",
    input: z.object({
      kind: z.enum(automationJobKinds).nullable().default(null),
      status: z.enum(automationJobStatuses).nullable().default(null),
      cursor: cursorSchema.nullable().default(null),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    output: z.object({
      jobs: z.array(automationJobSchema).max(100),
      nextCursor: cursorSchema.nullable(),
    }),
    access: adminChannelAccess,
    timeoutMs: 10_000,
    annotations: readAnnotations,
    async run({ input, context }) {
      const access = await requireAdminAccess(accessStore, context);
      const result = await automation.listJobs(
        access,
        {
          kind: input.kind,
          status: input.status,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        jobs: result.items.map((item) => automationJobSchema.parse(item)),
        nextCursor:
          result.nextCursor === null ? null : encodeCursor(result.nextCursor),
      };
    },
  });

  const createDreamingRun = defineCapability({
    title: "Enqueue a dreaming run",
    description:
      "Durably enqueues one completed civil day for the automation worker and returns immediately.",
    input: z.object({
      localDate: localDateSchema.nullable().default(null),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: z.object({
      job: automationJobSchema,
      created: z.boolean(),
    }),
    access: adminChannelAccess,
    timeoutMs: 10_000,
    annotations: mutationAnnotations,
    async run({ input, context }) {
      const access = await requireAdminAccess(accessStore, context);
      const result = await automation.enqueueDreamingRun(
        access,
        input,
        context.signal,
      );
      return {
        job: automationJobSchema.parse(result.job),
        created: result.created,
      };
    },
  });

  return {
    admin_automation_settings_get: getSettings,
    admin_automation_settings_update: updateSettings,
    admin_automation_status_get: getStatus,
    admin_automation_jobs_list: listJobs,
    admin_dreaming_runs_create: createDreamingRun,
  } as const;
}
