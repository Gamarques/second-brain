import { z } from "zod";

import { brainRoles } from "@second-brain/engine/domain";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import {
  adminAuditCategories,
  adminAuditOutcomes,
  type AdminAuditStore,
} from "../domain.js";
import { adminChannelAccess, requireAdminAccess } from "./admin-access.js";
import { defineCapability } from "@second-brain/engine/capabilities/define";
import {
  cursorSchema,
  decodeCursor,
  encodeCursor,
  idSchema,
  timestampSchema,
} from "@second-brain/engine/capabilities/schemas";

const auditMetadataSchema = z
  .record(z.string().trim().min(1).max(100), z.json())
  .refine((metadata) => Object.keys(metadata).length <= 50, {
    message: "Audit metadata must contain no more than 50 fields.",
  });

const auditEventSchema = z.object({
  id: idSchema,
  category: z.enum(adminAuditCategories),
  action: z.string().trim().min(1).max(200),
  outcome: z.enum(adminAuditOutcomes),
  targetType: z.string().trim().min(1).max(100).nullable(),
  targetId: z.string().trim().min(1).max(500).nullable(),
  actorAccountId: idSchema.nullable(),
  actorRole: z.enum(brainRoles).nullable(),
  requestId: z.string().trim().min(1).max(500),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,99}$/u)
    .nullable(),
  metadata: auditMetadataSchema,
  occurredAt: timestampSchema,
});

const listAuditEventsInputSchema = z
  .object({
    category: z.enum(adminAuditCategories).nullable().default(null),
    action: z.string().trim().min(1).max(200).nullable().default(null),
    outcome: z.enum(adminAuditOutcomes).nullable().default(null),
    actorAccountId: idSchema.nullable().default(null),
    targetType: z.string().trim().min(1).max(100).nullable().default(null),
    from: timestampSchema.nullable().default(null),
    to: timestampSchema.nullable().default(null),
    cursor: cursorSchema.nullable().default(null),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .refine(
    ({ from, to }) =>
      from === null || to === null || Date.parse(from) <= Date.parse(to),
    { message: "from must not be later than to." },
  );

export function createAdminAuditCapabilities(
  accessStore: BrainAccessStore,
  audit: AdminAuditStore,
) {
  const listAuditEvents = defineCapability({
    title: "List audit events",
    description:
      "Lists normalized domain, administration, authentication, and automation audit entries without secret values.",
    input: listAuditEventsInputSchema,
    output: z.object({
      events: z.array(auditEventSchema).max(200),
      nextCursor: cursorSchema.nullable(),
    }),
    access: adminChannelAccess,
    timeoutMs: 10_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const access = await requireAdminAccess(accessStore, context);
      const page = await audit.listAuditEvents(
        access,
        {
          category: input.category,
          action: input.action,
          outcome: input.outcome,
          actorAccountId: input.actorAccountId,
          targetType: input.targetType,
          from: input.from,
          to: input.to,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        events: page.items.map((item) => auditEventSchema.parse(item)),
        nextCursor:
          page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      };
    },
  });

  return { admin_audit_events_list: listAuditEvents } as const;
}
