import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
import type { BrainAccessContext, ClaimedAutomationJob } from "../../domain.js";
import {
  NotificationError,
  type NotificationAdminStore,
  type NotificationChannel,
  type NotificationDelivery,
  type NotificationCipher,
  type NotificationConfig,
  type NotificationProvider,
  type ReminderDispatchStore,
  type SaveNotificationChannel,
} from "../../domain/notifications.js";
import { validateNotificationConfig } from "../../providers/notification-provider.js";
import {
  automationJobs,
  automationSettings,
  notificationChannels,
  reminderDeliveries,
} from "../schema/automation.js";
import { reminders } from "../schema/content.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";
type ChannelRow = typeof notificationChannels.$inferSelect;
function conflict(): never {
  throw new NotificationError("failed", "NOTIFICATION_CONFLICT");
}
export class DrizzleNotificationStore
  implements NotificationAdminStore, ReminderDispatchStore
{
  constructor(
    private readonly database: SecondBrainDatabase,
    private readonly dependencies: {
      cipher: NotificationCipher;
      provider: NotificationProvider;
      encryptionAvailable: boolean;
      audit?: (
        tx: SecondBrainTransaction,
        access: BrainAccessContext,
        channel: NotificationChannel,
        signal: AbortSignal,
      ) => Promise<void>;
    },
  ) {}
  private map(row: ChannelRow): NotificationChannel {
    const config = this.dependencies.cipher.decrypt(
      row.id,
      row.encryptedConfig ?? "",
    );
    return {
      id: row.id,
      kind: config.kind,
      name: row.name,
      destination: config.destination,
      enabled: row.enabled,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      revision: row.revision,
    };
  }
  async channels(access: BrainAccessContext, signal: AbortSignal) {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "admin", signal);
      const rows = await tx
        .select()
        .from(notificationChannels)
        .where(inArray(notificationChannels.kind, ["slack", "telegram"]))
        .orderBy(asc(notificationChannels.id))
        .limit(20);
      return {
        channels: rows.map((row) => this.map(row)),
        encryptionAvailable: this.dependencies.encryptionAvailable,
      };
    });
  }
  async saveChannel(
    access: BrainAccessContext,
    input: SaveNotificationChannel,
    signal: AbortSignal,
  ) {
    const current = await this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "owner", signal);
      return (
        await tx
          .select()
          .from(notificationChannels)
          .where(eq(notificationChannels.id, input.id))
          .limit(1)
      )[0];
    });
    if (current && (current.kind !== input.kind || !current.encryptedConfig))
      conflict();
    const token =
      input.token ??
      (current
        ? this.dependencies.cipher.decrypt(current.id, current.encryptedConfig!)
            .token
        : "");
    const config = validateNotificationConfig({
      kind: input.kind,
      token,
      destination: input.destination,
    });
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          config,
          name: input.name,
          enabled: input.enabled,
          expectedRevision: input.expectedRevision,
        }),
      )
      .digest("hex");
    if (input.enabled && current?.configDigest !== digest)
      await this.dependencies.provider.verify(config, signal);
    const encryptedConfig = this.dependencies.cipher.encrypt(input.id, config);
    return this.database.transaction(async (tx) => {
      const authorized = await authorizeBrainTransaction(
        tx,
        access,
        "owner",
        signal,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('notification-channels',0))`,
      );
      const row = (
        await tx
          .select()
          .from(notificationChannels)
          .where(eq(notificationChannels.id, input.id))
          .for("update")
      )[0];
      if (row?.configDigest === digest) return this.map(row);
      if ((row?.revision ?? 0) !== input.expectedRevision) conflict();
      if (!row) {
        const count = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(notificationChannels)
          .where(inArray(notificationChannels.kind, ["slack", "telegram"]));
        if (count[0]!.count >= 20) conflict();
      }
      const values = {
        kind: input.kind,
        name: input.name,
        encryptedConfig,
        configDigest: digest,
        enabled: input.enabled,
        verifiedAt: input.enabled ? new Date() : null,
        revision: (row?.revision ?? 0) + 1,
        updatedAt: new Date(),
      };
      const [saved] = row
        ? await tx
            .update(notificationChannels)
            .set(values)
            .where(eq(notificationChannels.id, input.id))
            .returning()
        : await tx
            .insert(notificationChannels)
            .values({ id: input.id, ...values })
            .returning();
      const result = this.map(saved!);
      await this.dependencies.audit?.(tx, authorized, result, signal);
      signal.throwIfAborted();
      return result;
    });
  }
  async deliveries(
    access: BrainAccessContext,
    input: { cursor?: string | null | undefined; limit: number },
    signal: AbortSignal,
  ) {
    let cursor: { id: string; time: string } | null = null;
    if (input.cursor) {
      try {
        cursor = z
          .object({ id: z.string().uuid(), time: z.iso.datetime() })
          .parse(
            JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
          );
      } catch {
        conflict();
      }
    }
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "admin", signal);
      const limit = Math.max(1, Math.min(100, input.limit));
      const rows = await tx
        .select({
          delivery: reminderDeliveries,
          channel: notificationChannels,
          job: automationJobs,
          stamp: sql<string>`to_char(${reminderDeliveries.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(reminderDeliveries)
        .innerJoin(
          notificationChannels,
          eq(notificationChannels.id, reminderDeliveries.channelId),
        )
        .innerJoin(
          automationJobs,
          eq(automationJobs.id, reminderDeliveries.automationJobId),
        )
        .where(
          and(
            inArray(notificationChannels.kind, ["slack", "telegram"]),
            cursor
              ? sql`(${reminderDeliveries.createdAt},${reminderDeliveries.id}) < (${cursor.time}::timestamptz,${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(
          desc(reminderDeliveries.createdAt),
          desc(reminderDeliveries.id),
        )
        .limit(limit + 1);
      return {
        deliveries: rows.slice(0, limit).map(
          ({ delivery, channel, job }): NotificationDelivery => ({
            id: delivery.id,
            reminderId: delivery.reminderId,
            channelId: channel.id,
            channelName: channel.name,
            kind: channel.kind as NotificationConfig["kind"],
            message: delivery.messageSnapshot,
            remindAt: delivery.remindAtSnapshot.toISOString(),
            status:
              job.status === "canceled" && delivery.status !== "delivered"
                ? "canceled"
                : delivery.status,
            deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
            errorCode: delivery.errorCode ?? job.sanitizedError,
            attemptCount: job.attemptCount,
            createdAt: delivery.createdAt.toISOString(),
          }),
        ),
        nextCursor:
          rows.length > limit
            ? Buffer.from(
                JSON.stringify({
                  id: rows[limit - 1]!.delivery.id,
                  time: rows[limit - 1]!.stamp,
                }),
              ).toString("base64url")
            : null,
      };
    });
  }
  async materialize(now: Date, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.database.transaction(async (tx) => {
      const [settings] = await tx
        .select()
        .from(automationSettings)
        .where(eq(automationSettings.id, 1))
        .for("share");
      if (!settings?.reminderDeliveryEnabled) return;
      // Serialize only the bounded scheduling batch; network requests never hold this lock.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('reminder-materialization',0))`,
      );
      const pairs = await tx
        .select({ reminder: reminders, channel: notificationChannels })
        .from(reminders)
        .innerJoin(
          notificationChannels,
          and(
            eq(notificationChannels.enabled, true),
            inArray(notificationChannels.kind, ["slack", "telegram"]),
          ),
        )
        .where(
          and(
            isNull(reminders.completedAt),
            lte(reminders.remindAt, now),
            notExists(
              tx
                .select({ id: reminderDeliveries.id })
                .from(reminderDeliveries)
                .where(
                  and(
                    eq(reminderDeliveries.reminderId, reminders.id),
                    eq(reminderDeliveries.channelId, notificationChannels.id),
                    eq(
                      reminderDeliveries.reminderVersion,
                      reminders.historyVersion,
                    ),
                  ),
                ),
            ),
          ),
        )
        .orderBy(
          asc(reminders.remindAt),
          asc(reminders.id),
          asc(notificationChannels.id),
        )
        .limit(100);
      for (const { reminder, channel } of pairs) {
        const key = `reminder:${reminder.id}:${channel.id}:${reminder.historyVersion}`;
        const jobId = randomUUID();
        const [job] = await tx
          .insert(automationJobs)
          .values({
            id: jobId,
            kind: "reminder_delivery",
            canonicalKey: key,
            scheduledFor: reminder.remindAt,
          })
          .onConflictDoNothing()
          .returning();
        if (!job) continue;
        await tx.insert(reminderDeliveries).values({
          reminderId: reminder.id,
          channelId: channel.id,
          automationJobId: job.id,
          reminderVersion: reminder.historyVersion,
          channelRevision: channel.revision,
          messageSnapshot: reminder.message,
          remindAtSnapshot: reminder.remindAt,
          idempotencyKey: key,
        });
      }
      signal.throwIfAborted();
    });
  }
  private live(claim: ClaimedAutomationJob) {
    return and(
      eq(automationJobs.id, claim.job.id),
      eq(automationJobs.kind, "reminder_delivery"),
      eq(automationJobs.status, "running"),
      eq(automationJobs.leaseOwner, claim.workerId),
      eq(automationJobs.fencingToken, claim.fencingToken),
      isNull(automationJobs.cancelRequestedAt),
      sql`${automationJobs.leaseExpiresAt}>clock_timestamp()`,
    );
  }
  async prepare(claim: ClaimedAutomationJob, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.database.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(automationJobs)
        .where(this.live(claim))
        .for("update");
      if (!job) return null;
      const [delivery] = await tx
        .select()
        .from(reminderDeliveries)
        .where(eq(reminderDeliveries.automationJobId, job.id))
        .for("update");
      if (!delivery) return null;
      if (delivery.status === "running") {
        await tx
          .update(reminderDeliveries)
          .set({
            status: "uncertain",
            errorCode: "NOTIFICATION_DELIVERY_UNCERTAIN",
            updatedAt: new Date(),
          })
          .where(eq(reminderDeliveries.id, delivery.id));
        return null;
      }
      if (!["pending", "retry_wait"].includes(delivery.status)) return null;
      const [settings] = await tx
        .select()
        .from(automationSettings)
        .where(eq(automationSettings.id, 1))
        .for("share");
      const [channel] = await tx
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.id, delivery.channelId))
        .for("share");
      const [reminder] = await tx
        .select()
        .from(reminders)
        .where(eq(reminders.id, delivery.reminderId))
        .for("share");
      if (
        !settings?.reminderDeliveryEnabled ||
        !channel?.enabled ||
        !channel.verifiedAt ||
        channel.revision !== delivery.channelRevision ||
        !reminder ||
        reminder.completedAt ||
        reminder.historyVersion !== delivery.reminderVersion ||
        reminder.remindAt.getTime() > Date.now()
      ) {
        await tx
          .update(reminderDeliveries)
          .set({ status: "canceled", updatedAt: new Date() })
          .where(eq(reminderDeliveries.id, delivery.id));
        return null;
      }
      let config: NotificationConfig;
      try {
        config = this.dependencies.cipher.decrypt(
          channel.id,
          channel.encryptedConfig ?? "",
        );
      } catch {
        await tx
          .update(reminderDeliveries)
          .set({
            status: "failed",
            errorCode: "NOTIFICATION_CONFIGURATION_UNAVAILABLE",
            updatedAt: new Date(),
          })
          .where(eq(reminderDeliveries.id, delivery.id));
        return null;
      }
      signal.throwIfAborted();
      await tx
        .update(reminderDeliveries)
        .set({ status: "running", errorCode: null, updatedAt: new Date() })
        .where(eq(reminderDeliveries.id, delivery.id));
      return {
        deliveryId: delivery.id,
        config,
        message: delivery.messageSnapshot,
      };
    });
  }
  async finish(
    claim: ClaimedAutomationJob,
    input: {
      status: "delivered" | "failed" | "uncertain" | "retry_wait";
      messageId?: string;
      errorCode?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    return this.database.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(automationJobs)
        .where(this.live(claim))
        .for("update");
      if (!job) return false;
      const rows = await tx
        .update(reminderDeliveries)
        .set({
          status: input.status,
          providerMessageId: input.messageId ?? null,
          deliveredAt: input.status === "delivered" ? new Date() : null,
          errorCode: input.errorCode ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reminderDeliveries.automationJobId, job.id),
            eq(reminderDeliveries.status, "running"),
          ),
        )
        .returning({ id: reminderDeliveries.id });
      return rows.length === 1;
    });
  }
}
