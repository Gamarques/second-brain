import { z } from "zod";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import { automationJobStatuses } from "@second-brain/engine/domain/automation";
import { defineCapability } from "@second-brain/engine/capabilities/define";
import { idSchema, idempotencyKeySchema, timestampSchema } from "@second-brain/engine/capabilities/schemas";
import type { AdminDreamingStore } from "../dreaming-domain.js";
import { adminChannelAccess, requireAdminAccess } from "./admin-access.js";

const monthSchema = z.string().regex(/^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export function createAdminDreamingCapabilities(access: BrainAccessStore, store: AdminDreamingStore) {
  return {
    admin_dreaming_calendar_get: defineCapability({
      title: "Read Dreaming calendar", description: "Lists a bounded month of daily jobs and replay history, with stored report links and retry eligibility.",
      input: z.object({ month: monthSchema }),
      output: z.object({ month: monthSchema, timeZone: z.string(), today: dateSchema, truncated: z.boolean(), items: z.array(z.object({
        jobId: idSchema, localDate: dateSchema, status: z.enum(automationJobStatuses), attemptCount: z.number().int().nonnegative(),
        runId: idSchema.nullable(), reportRunId: idSchema.nullable(), replayOfRunId: idSchema.nullable(), sourceJobId: idSchema.nullable(),
        mode: z.enum(["preview", "apply"]).nullable(), timeZone: z.string(), model: z.string().nullable(), sanitizedError: z.string().nullable(), createdAt: timestampSchema, updatedAt: timestampSchema, canRetry: z.boolean(),
      })).max(500) }),
      access: adminChannelAccess, timeoutMs: 15_000, annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      async run({ input, context }) { const authorized = await requireAdminAccess(access, context, "admin"); const result = await store.calendar(authorized, input, context.signal); return { ...result, items: [...result.items] }; },
    }),
    admin_dreaming_retry: defineCapability({
      title: "Reprocess a failed Dreaming job in preview", description: "Creates one durable preview replay of a terminal failed job, preserving its history and previously applied effects. It never resets an active job.",
      input: z.object({ jobId: idSchema, idempotencyKey: idempotencyKeySchema }),
      output: z.object({ jobId: idSchema, sourceJobId: idSchema, created: z.boolean(), mode: z.literal("preview") }),
      access: adminChannelAccess, timeoutMs: 15_000, annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
      async run({ input, context }) { const authorized = await requireAdminAccess(access, context, "admin"); return store.retry(authorized, input, context.signal); },
    }),
  } as const;
}
