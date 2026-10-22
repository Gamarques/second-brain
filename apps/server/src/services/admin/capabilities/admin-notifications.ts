import { z } from "zod";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import {
  deliveryChannelKinds,
  type NotificationAdminStore,
} from "@second-brain/engine/domain/notifications";
import { defineCapability } from "@second-brain/engine/capabilities/define";
import {
  idSchema,
  timestampSchema,
} from "@second-brain/engine/capabilities/schemas";
import { adminChannelAccess, requireAdminAccess } from "./admin-access.js";
const channel = z.object({
  id: idSchema,
  kind: z.enum(deliveryChannelKinds),
  name: z.string(),
  destination: z.string(),
  enabled: z.boolean(),
  verifiedAt: timestampSchema.nullable(),
  revision: z.number().int().positive(),
});
const notificationCursorSchema = z.string().min(1).max(500).regex(/^[A-Za-z0-9_-]+$/u);
const read = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
} as const;
export function createAdminNotificationCapabilities(
  access: BrainAccessStore,
  store: NotificationAdminStore,
) {
  return {
    admin_notification_channels_list: defineCapability({
      title: "List reminder channels",
      description:
        "Lists destinations and verification status without returning credentials.",
      input: z.object({}),
      output: z.object({
        channels: z.array(channel).max(20).readonly(),
        encryptionAvailable: z.boolean(),
      }),
      access: adminChannelAccess,
      annotations: read,
      timeoutMs: 15_000,
      async run({ context }) {
        return store.channels(
          await requireAdminAccess(access, context),
          context.signal,
        );
      },
    }),
    admin_notification_channel_save: defineCapability({
      title: "Save a reminder channel",
      description:
        "An owner verifies a Slack or Telegram destination without sending messages, then saves encrypted credentials and explicit delivery consent with a revision precondition.",
      input: z.object({
        id: idSchema,
        kind: z.enum(deliveryChannelKinds),
        name: z.string().trim().min(1).max(200),
        destination: z.string().trim().min(1).max(100),
        token: z.string().trim().min(1).max(500).optional(),
        enabled: z.boolean(),
        expectedRevision: z.number().int().nonnegative(),
      }),
      output: channel,
      access: adminChannelAccess,
      annotations: { ...read, readOnly: false, openWorld: true },
      timeoutMs: 70_000,
      async run({ context, input }) {
        return store.saveChannel(
          await requireAdminAccess(access, context, "owner"),
          input,
          context.signal,
        );
      },
    }),
    admin_notification_deliveries_list: defineCapability({
      title: "Read reminder delivery history",
      description:
        "Pages delivery receipts, cancellations and uncertain outcomes in stable creation order.",
      input: z.object({
        cursor: notificationCursorSchema.nullable().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      output: z.object({
        deliveries: z
          .array(
            z.object({
              id: idSchema,
              reminderId: idSchema,
              channelId: idSchema,
              channelName: z.string(),
              kind: z.enum(deliveryChannelKinds),
              message: z.string(),
              remindAt: timestampSchema,
              status: z.enum([
                "pending",
                "running",
                "delivered",
                "retry_wait",
                "failed",
                "canceled",
                "uncertain",
              ]),
              deliveredAt: timestampSchema.nullable(),
              errorCode: z.string().nullable(),
              attemptCount: z.number().int().nonnegative(),
              createdAt: timestampSchema,
            }),
          )
          .max(100)
          .readonly(),
        nextCursor: notificationCursorSchema.nullable(),
      }),
      access: adminChannelAccess,
      annotations: read,
      timeoutMs: 15_000,
      async run({ context, input }) {
        return store.deliveries(
          await requireAdminAccess(access, context),
          input,
          context.signal,
        );
      },
    }),
  } as const;
}
