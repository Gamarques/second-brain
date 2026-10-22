import { createHash, randomUUID } from "node:crypto";

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type {
  AutomationJob,
  AutomationJobKind,
  AutomationSettings,
  AutomationStore,
  AutomationWorkerHeartbeat,
  BrainAccessContext,
  ClaimedAutomationJob,
} from "@second-brain/engine/domain";
import {
  automationJobs,
  automationSettings,
  automationWorkerHeartbeats,
} from "@second-brain/engine/database/schema/automation";
import { mutationReceipts } from "@second-brain/engine/database/schema/temporal";
import { authorizeBrainTransaction } from "@second-brain/engine/database/stores/authorization";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function decodeSettingsResult(value: unknown): AutomationSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The stored automation settings receipt is invalid.");
  }
  const row = value as Record<string, unknown>;
  const valid =
    typeof row.timeZone === "string" &&
    typeof row.dreamingEnabled === "boolean" &&
    typeof row.dreamLocalTime === "string" &&
    (row.nextDreamAt === null || typeof row.nextDreamAt === "string") &&
    typeof row.reminderDeliveryEnabled === "boolean" &&
    Number.isInteger(row.revision) &&
    typeof row.updatedAt === "string";
  if (!valid) throw new Error("The stored automation settings receipt is invalid.");
  return row as unknown as AutomationSettings;
}

function mapSettings(row: typeof automationSettings.$inferSelect): AutomationSettings {
  return {
    timeZone: row.timeZone,
    dreamingEnabled: row.dreamingEnabled,
    dreamLocalTime: row.dreamLocalTime.slice(0, 5),
    nextDreamAt: toIso(row.nextDreamAt),
    reminderDeliveryEnabled: row.reminderDeliveryEnabled,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapJob(row: typeof automationJobs.$inferSelect): AutomationJob {
  return {
    id: row.id,
    kind: row.kind,
    canonicalKey: row.canonicalKey,
    scheduledFor: row.scheduledFor.toISOString(),
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: toIso(row.nextAttemptAt),
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: toIso(row.leaseExpiresAt),
    fencingToken: row.fencingToken,
    cancelRequestedAt: toIso(row.cancelRequestedAt),
    sanitizedError: row.sanitizedError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapHeartbeat(
  row: typeof automationWorkerHeartbeats.$inferSelect,
): AutomationWorkerHeartbeat {
  return {
    workerId: row.workerId,
    version: row.version,
    startedAt: row.startedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function validDate(value: string, name: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.valueOf())) {
    throw new Error(`${name} must be a valid ISO timestamp.`);
  }
  return result;
}

function validateWorker(workerId: string): void {
  if (workerId.trim() === "" || workerId.length > 500) {
    throw new Error("workerId must contain between 1 and 500 characters.");
  }
}

function validateRequestedBy(value: string): void {
  if (value.trim() === "" || value.length > 500) {
    throw new Error("requestedBy must contain between 1 and 500 characters.");
  }
}

function validateJobId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("jobId must be a UUID.");
  }
}

function jobPayload(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const canceledSanitizedError = "JOB_CANCELED";

function validateWorkerVersion(version: string): void {
  if (version.trim() === "" || version.length > 100) {
    throw new Error("version must contain between 1 and 100 characters.");
  }
}

function validateLeaseSeconds(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 86_400) {
    throw new Error("leaseSeconds must be an integer between 1 and 86400.");
  }
}

function validateTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    throw new Error("timeZone must be a valid IANA time zone.");
  }
}

function validateLocalTime(value: string): void {
  const match = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u.exec(value);
  if (match?.groups === undefined) {
    throw new Error("dreamLocalTime must use 24-hour HH:MM format.");
  }
}

function validateSanitizedError(value: string): void {
  if (value.trim() === "" || value.length > 2_000) {
    throw new Error("sanitizedError must contain between 1 and 2000 characters.");
  }
}

function leaseExpiration(now: Date, leaseSeconds: number): Date {
  return new Date(now.valueOf() + leaseSeconds * 1_000);
}

function localDateAt(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("The configured time zone could not be formatted.");
  }
  return `${year}-${month}-${day}`;
}

function previousLocalDate(localDate: string): string {
  const [yearText, monthText, dayText] = localDate.split("-");
  const day = new Date(
    Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) - 1),
  );
  return [
    day.getUTCFullYear().toString().padStart(4, "0"),
    (day.getUTCMonth() + 1).toString().padStart(2, "0"),
    day.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

function utcForLocalDateTime(
  localDate: string,
  timeZone: string,
  localTime: string,
): Date {
  const [yearText, monthText, dayText] = localDate.split("-");
  const [hourText, minuteText] = localTime.split(":");
  const desired = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
  };
  const naive = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  );
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const localParts = (instant: Date) => {
    const parts = formatter.formatToParts(instant);
    const number = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    return {
      year: number("year"),
      month: number("month"),
      day: number("day"),
      hour: number("hour"),
      minute: number("minute"),
    };
  };
  const localOrdinal = (parts: ReturnType<typeof localParts>) =>
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const desiredOrdinal = localOrdinal(desired);
  const candidates = new Map<number, Date>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = new Date(naive + hours * 3_600_000);
    const offset = localOrdinal(localParts(sample)) - sample.valueOf();
    const candidate = new Date(naive - offset);
    candidates.set(candidate.valueOf(), candidate);
  }
  const exact = [...candidates.values()]
    .filter((candidate) => localOrdinal(localParts(candidate)) === desiredOrdinal)
    .sort((left, right) => left.valueOf() - right.valueOf());
  if (exact[0] !== undefined) return exact[0];

  // A DST gap has no exact instant. Run at the first representable local time
  // after the configured time instead of silently moving the run to another day.
  const afterGap = [...candidates.values()]
    .filter((candidate) => {
      const parts = localParts(candidate);
      return (
        parts.year === desired.year &&
        parts.month === desired.month &&
        parts.day === desired.day &&
        localOrdinal(parts) > desiredOrdinal
      );
    })
    .sort(
      (left, right) =>
        localOrdinal(localParts(left)) - localOrdinal(localParts(right)),
    );
  if (afterGap[0] !== undefined) return afterGap[0];
  throw new Error(`Unable to resolve the next run in time zone ${timeZone}.`);
}

function shiftLocalDate(localDate: string, days: number): string {
  const [yearText, monthText, dayText] = localDate.split("-");
  const day = new Date(
    Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + days),
  );
  return [
    day.getUTCFullYear().toString().padStart(4, "0"),
    (day.getUTCMonth() + 1).toString().padStart(2, "0"),
    day.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

function nextUtcDayAtSameLocalTime(
  scheduledFor: Date,
  timeZone: string,
  localTime: string,
): Date {
  return utcForLocalDateTime(
    shiftLocalDate(localDateAt(scheduledFor, timeZone), 1),
    timeZone,
    localTime,
  );
}

function nextScheduledInstant(now: Date, timeZone: string, localTime: string): Date {
  const today = localDateAt(now, timeZone);
  const todayCandidate = utcForLocalDateTime(today, timeZone, localTime);
  return todayCandidate > now
    ? todayCandidate
    : utcForLocalDateTime(shiftLocalDate(today, 1), timeZone, localTime);
}

export class DrizzleAutomationStore implements AutomationStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async getSettings(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<AutomationSettings> {
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "viewer", signal);
      const rows = await transaction
        .select()
        .from(automationSettings)
        .where(eq(automationSettings.id, 1))
        .limit(1);
      signal.throwIfAborted();
      const row = rows[0];
      if (row === undefined) {
        throw new Error("Automation settings are not initialized.");
      }
      return mapSettings(row);
    });
  }

  async recordHeartbeat(
    workerId: string,
    input: {
      readonly version: string;
      readonly startedAt: string;
      readonly lastSeenAt: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationWorkerHeartbeat> {
    validateWorker(workerId);
    validateWorkerVersion(input.version);
    const startedAt = validDate(input.startedAt, "startedAt");
    const lastSeenAt = validDate(input.lastSeenAt, "lastSeenAt");
    if (lastSeenAt < startedAt) {
      throw new Error("lastSeenAt must not precede startedAt.");
    }
    signal.throwIfAborted();
    const rows = await this.database
      .insert(automationWorkerHeartbeats)
      .values({ workerId, version: input.version, startedAt, lastSeenAt })
      .onConflictDoUpdate({
        target: automationWorkerHeartbeats.workerId,
        set: { version: input.version, startedAt, lastSeenAt },
        setWhere: lte(automationWorkerHeartbeats.startedAt, startedAt),
      })
      .returning();
    signal.throwIfAborted();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("The automation worker heartbeat was not stored.");
    }
    return mapHeartbeat(row);
  }

  async updateSettings(
    access: BrainAccessContext,
    changes: {
      readonly timeZone?: string | undefined;
      readonly dreamingEnabled?: boolean | undefined;
      readonly dreamLocalTime?: string | undefined;
      readonly reminderDeliveryEnabled?: boolean | undefined;
      readonly expectedRevision: number;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationSettings | null> {
    signal.throwIfAborted();
    if (changes.idempotencyKey.trim() === "") {
      throw new Error("idempotencyKey must not be empty.");
    }
    if (changes.timeZone !== undefined) validateTimeZone(changes.timeZone);
    if (changes.dreamLocalTime !== undefined) {
      validateLocalTime(changes.dreamLocalTime);
    }
    const requestDigest = digest({
      expectedRevision: changes.expectedRevision,
      timeZone: changes.timeZone ?? null,
      dreamingEnabled: changes.dreamingEnabled ?? null,
      dreamLocalTime: changes.dreamLocalTime ?? null,
      reminderDeliveryEnabled: changes.reminderDeliveryEnabled ?? null,
    });
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "editor", signal);
      const currentRows = await transaction
        .select({
          settings: automationSettings,
          now: sql<string>`current_timestamp::text`,
        })
        .from(automationSettings)
        .where(eq(automationSettings.id, 1))
        .for("update")
        .limit(1);
      const receiptRows = await transaction
        .select({
          requestDigest: mutationReceipts.requestDigest,
          result: mutationReceipts.result,
        })
        .from(mutationReceipts)
        .where(
          and(
            eq(mutationReceipts.operation, "automation_settings_update"),
            eq(mutationReceipts.idempotencyKey, changes.idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);
      const receipt = receiptRows[0];
      if (receipt !== undefined) {
        if (receipt.requestDigest !== requestDigest) {
          throw new Error("The idempotency key was already used with another request.");
        }
        return decodeSettingsResult(receipt.result);
      }
      const currentRow = currentRows[0];
      if (
        currentRow === undefined ||
        currentRow.settings.revision !== changes.expectedRevision
      ) {
        return null;
      }
      const now = validDate(currentRow.now, "current database time");
      const current = currentRow.settings;
      const timeZone = changes.timeZone ?? current.timeZone;
      const dreamLocalTime = changes.dreamLocalTime ?? current.dreamLocalTime.slice(0, 5);
      const dreamingEnabled = changes.dreamingEnabled ?? current.dreamingEnabled;
      const scheduleChanged =
        changes.timeZone !== undefined ||
        changes.dreamLocalTime !== undefined ||
        (changes.dreamingEnabled !== undefined &&
          changes.dreamingEnabled !== current.dreamingEnabled);
      const nextDreamAt = !dreamingEnabled
        ? null
        : scheduleChanged || current.nextDreamAt === null
          ? nextScheduledInstant(now, timeZone, dreamLocalTime)
          : current.nextDreamAt;
      const rows = await transaction
        .update(automationSettings)
        .set({
          ...(changes.timeZone === undefined ? {} : { timeZone: changes.timeZone }),
          ...(changes.dreamingEnabled === undefined
            ? {}
            : { dreamingEnabled: changes.dreamingEnabled }),
          ...(changes.dreamLocalTime === undefined
            ? {}
            : { dreamLocalTime: changes.dreamLocalTime }),
          ...(changes.reminderDeliveryEnabled === undefined
            ? {}
            : { reminderDeliveryEnabled: changes.reminderDeliveryEnabled }),
          nextDreamAt,
          revision: sql`${automationSettings.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(automationSettings.id, 1),
            eq(automationSettings.revision, changes.expectedRevision),
          ),
        )
        .returning();
      signal.throwIfAborted();
      const row = rows[0];
      if (row === undefined) return null;
      const result = mapSettings(row);
      await transaction.insert(mutationReceipts).values({
        operation: "automation_settings_update",
        idempotencyKey: changes.idempotencyKey,
        requestDigest,
        resultEntityType: "automation_settings",
        resultEntityId: null,
        result,
      });
      return result;
    });
  }

  async materializeDueDreamingRuns(
    workerId: string,
    input: { readonly now: string; readonly catchUpLimit: number },
    signal: AbortSignal,
  ): Promise<readonly AutomationJob[]> {
    validateWorker(workerId);
    if (!Number.isInteger(input.catchUpLimit) || input.catchUpLimit < 1) {
      throw new Error("catchUpLimit must be a positive integer.");
    }
    const now = validDate(input.now, "now");
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const dueSettings = await transaction
        .select()
        .from(automationSettings)
        .where(
          and(
            eq(automationSettings.dreamingEnabled, true),
            lte(automationSettings.nextDreamAt, now),
          ),
        )
        .orderBy(asc(automationSettings.nextDreamAt))
        .for("update", { skipLocked: true })
        .limit(1);
      const jobs: AutomationJob[] = [];
      for (const settings of dueSettings) {
        let nextDreamAt = settings.nextDreamAt;
        while (
          jobs.length < input.catchUpLimit &&
          nextDreamAt !== null &&
          nextDreamAt <= now
        ) {
          const scheduledFor = nextDreamAt;
          const localDate = previousLocalDate(
            localDateAt(scheduledFor, settings.timeZone),
          );
          const canonicalKey = `daily_dreaming:${localDate}`;
          const inserted = await transaction
            .insert(automationJobs)
            .values({
              kind: "daily_dreaming",
              canonicalKey,
              scheduledFor,
              payload: { localDate },
            })
            .onConflictDoNothing()
            .returning();
          const jobRows =
            inserted.length > 0
              ? inserted
              : await transaction
                  .select()
                  .from(automationJobs)
                  .where(
                    and(
                      eq(automationJobs.kind, "daily_dreaming"),
                      eq(automationJobs.canonicalKey, canonicalKey),
                    ),
                  )
                  .limit(1);
          if (jobRows[0] !== undefined) jobs.push(mapJob(jobRows[0]));
          nextDreamAt = nextUtcDayAtSameLocalTime(
            scheduledFor,
            settings.timeZone,
            settings.dreamLocalTime,
          );
        }
        await transaction
          .update(automationSettings)
          .set({ nextDreamAt, updatedAt: now })
          .where(eq(automationSettings.id, settings.id));
      }
      signal.throwIfAborted();
      return jobs;
    });
  }

  async claimNextJob(
    workerId: string,
    input: {
      readonly now: string;
      readonly leaseSeconds: number;
      readonly kinds: readonly [AutomationJobKind, ...AutomationJobKind[]];
    },
    signal: AbortSignal,
  ): Promise<ClaimedAutomationJob | null> {
    validateWorker(workerId);
    validateLeaseSeconds(input.leaseSeconds);
    const now = validDate(input.now, "now");
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      // A job that was asked to stop while its worker vanished must not be
      // picked up again; it ends here, exactly as its worker would have ended it.
      await transaction
        .update(automationJobs)
        .set({
          status: "canceled",
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          fencingToken: null,
          sanitizedError: canceledSanitizedError,
          updatedAt: now,
        })
        .where(
          and(
            isNotNull(automationJobs.cancelRequestedAt),
            or(
              inArray(automationJobs.status, ["pending", "retry_wait"]),
              and(eq(automationJobs.status, "running"), lte(automationJobs.leaseExpiresAt, now)),
            ),
          ),
        );
      const rows = await transaction
        .select()
        .from(automationJobs)
        .where(
          and(
            isNull(automationJobs.cancelRequestedAt),
            inArray(automationJobs.kind, [...new Set(input.kinds)]),
            or(
              and(
                eq(automationJobs.status, "pending"),
                lte(automationJobs.scheduledFor, now),
              ),
              and(
                eq(automationJobs.status, "retry_wait"),
                lte(automationJobs.nextAttemptAt, now),
              ),
              and(
                eq(automationJobs.status, "running"),
                lte(automationJobs.leaseExpiresAt, now),
              ),
            ),
          ),
        )
        .orderBy(
          asc(sql`coalesce(${automationJobs.nextAttemptAt}, ${automationJobs.scheduledFor})`),
          asc(automationJobs.id),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      const fencingToken = randomUUID();
      const claimed = await transaction
        .update(automationJobs)
        .set({
          status: "running",
          attemptCount: sql`${automationJobs.attemptCount} + 1`,
          nextAttemptAt: null,
          leaseOwner: workerId,
          leaseExpiresAt: leaseExpiration(now, input.leaseSeconds),
          fencingToken,
          sanitizedError: null,
          updatedAt: now,
        })
        .where(eq(automationJobs.id, row.id))
        .returning();
      signal.throwIfAborted();
      if (claimed[0] === undefined) return null;
      return { job: mapJob(claimed[0]), workerId, fencingToken };
    });
  }

  async renewLease(
    claim: ClaimedAutomationJob,
    input: { readonly now: string; readonly leaseSeconds: number },
    signal: AbortSignal,
  ): Promise<ClaimedAutomationJob | null> {
    validateWorker(claim.workerId);
    validateLeaseSeconds(input.leaseSeconds);
    const now = validDate(input.now, "now");
    signal.throwIfAborted();
    const rows = await this.database
      .update(automationJobs)
      .set({
        leaseExpiresAt: leaseExpiration(now, input.leaseSeconds),
        updatedAt: now,
      })
      .where(this.liveClaimPredicate(claim, now))
      .returning();
    signal.throwIfAborted();
    return rows[0] === undefined
      ? null
      : { job: mapJob(rows[0]), workerId: claim.workerId, fencingToken: claim.fencingToken };
  }

  completeJob(claim: ClaimedAutomationJob, signal: AbortSignal): Promise<boolean> {
    return this.finishJob(claim, { status: "completed", sanitizedError: null }, signal);
  }

  async retryJob(
    claim: ClaimedAutomationJob,
    input: { readonly nextAttemptAt: string; readonly sanitizedError: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    validateSanitizedError(input.sanitizedError);
    const nextAttemptAt = validDate(input.nextAttemptAt, "nextAttemptAt");
    const retried = await this.finishJob(
      claim,
      { status: "retry_wait", nextAttemptAt, sanitizedError: input.sanitizedError },
      signal,
      isNull(automationJobs.cancelRequestedAt),
    );
    if (retried) return true;
    // A cancellation requested during the attempt wins over the retry.
    return this.finishJob(
      claim,
      { status: "canceled", sanitizedError: canceledSanitizedError },
      signal,
      isNotNull(automationJobs.cancelRequestedAt),
    );
  }

  cancelJob(claim: ClaimedAutomationJob, signal: AbortSignal): Promise<boolean> {
    return this.finishJob(claim, { status: "canceled", sanitizedError: canceledSanitizedError }, signal);
  }

  async cancelRequested(claim: ClaimedAutomationJob, signal: AbortSignal): Promise<boolean> {
    validateJobId(claim.job.id);
    signal.throwIfAborted();
    const rows = await this.database
      .select({ cancelRequestedAt: automationJobs.cancelRequestedAt })
      .from(automationJobs)
      .where(eq(automationJobs.id, claim.job.id));
    signal.throwIfAborted();
    return rows[0]?.cancelRequestedAt != null;
  }

  async requestCancel(
    jobId: string,
    input: { readonly requestedBy: string; readonly now: string },
    signal: AbortSignal,
  ): Promise<AutomationJob | null> {
    validateJobId(jobId);
    validateRequestedBy(input.requestedBy);
    const now = validDate(input.now, "now");
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(automationJobs)
        .where(eq(automationJobs.id, jobId))
        .for("update");
      const row = rows[0];
      if (row === undefined) return null;
      const terminal = row.status === "completed" || row.status === "failed" || row.status === "canceled";
      if (terminal || row.cancelRequestedAt !== null) return mapJob(row);
      const waiting = row.status === "pending" || row.status === "retry_wait";
      const updated = await transaction
        .update(automationJobs)
        .set({
          ...(waiting
            ? {
                status: "canceled" as const,
                nextAttemptAt: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                fencingToken: null,
                sanitizedError: canceledSanitizedError,
              }
            : {}),
          cancelRequestedAt: now,
          payload: { ...jobPayload(row.payload), cancelRequestedBy: input.requestedBy },
          updatedAt: now,
        })
        .where(eq(automationJobs.id, row.id))
        .returning();
      signal.throwIfAborted();
      return updated[0] === undefined ? null : mapJob(updated[0]);
    });
  }

  failJob(
    claim: ClaimedAutomationJob,
    input: { readonly sanitizedError: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    validateSanitizedError(input.sanitizedError);
    return this.finishJob(
      claim,
      { status: "failed", sanitizedError: input.sanitizedError },
      signal,
    );
  }

  /**
   * A claim stays live while its lease holds, even after a cancellation was
   * requested: the worker that owns it must be able to renew and to end the job
   * as canceled itself.
   */
  private liveClaimPredicate(claim: ClaimedAutomationJob, now = new Date()) {
    return and(
      eq(automationJobs.id, claim.job.id),
      eq(automationJobs.status, "running"),
      eq(automationJobs.leaseOwner, claim.workerId),
      eq(automationJobs.fencingToken, claim.fencingToken),
      sql`${automationJobs.leaseExpiresAt} > ${now}`,
    );
  }

  private async finishJob(
    claim: ClaimedAutomationJob,
    values: {
      readonly status: "completed" | "retry_wait" | "failed" | "canceled";
      readonly nextAttemptAt?: Date | undefined;
      readonly sanitizedError: string | null;
    },
    signal: AbortSignal,
    guard?: ReturnType<typeof isNull>,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const now = new Date();
    const rows = await this.database
      .update(automationJobs)
      .set({
        status: values.status,
        nextAttemptAt: values.nextAttemptAt ?? null,
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: null,
        sanitizedError: values.sanitizedError,
        updatedAt: now,
      })
      .where(guard === undefined ? this.liveClaimPredicate(claim, now) : and(this.liveClaimPredicate(claim, now), guard))
      .returning({ id: automationJobs.id });
    signal.throwIfAborted();
    return rows.length === 1;
  }
}
