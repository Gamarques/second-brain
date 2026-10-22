import { createHash } from "node:crypto";

import {
  and,
  desc,
  eq,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type {
  AdminAutomationSettings,
  AdminAutomationSettingsChanges,
  AdminAutomationStatus,
  AdminAutomationStore,
} from "../domain.js";
import {
  automationJobKinds,
  automationJobStatuses,
  type AutomationJob,
  type BrainAccessContext,
  type CursorPosition,
  type Page,
} from "@second-brain/engine/domain";
import {
  automationJobs,
  automationSettings,
  automationWorkerHeartbeats,
} from "@second-brain/engine/database/schema/automation";
import { mutationReceipts } from "@second-brain/engine/database/schema/temporal";
import { appendAdminAuditEvent } from "../../shared/audit-store.js";
import { authorizeBrainTransaction } from "@second-brain/engine/database/stores/authorization";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "@second-brain/engine/database/stores/database";

const SETTINGS_UPDATE_OPERATION = "admin_automation_settings_update";
const DREAMING_ENQUEUE_OPERATION = "admin_dreaming_run_enqueue";
const HEARTBEAT_STALE_AFTER_MS = 90_000;

const settingsReceiptSchema = z.object({
  timeZone: z.string().min(1).max(200),
  dreamingEnabled: z.boolean(),
  dreamLocalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  nextDreamAt: z.string().datetime({ offset: true }).nullable(),
  dreamingMode: z.enum(["preview", "apply"]),
  dailyInputTokenLimit: z.number().int().min(1).max(1_000_000),
  dailyOutputTokenLimit: z.number().int().min(1).max(100_000),
  reminderDeliveryEnabled: z.boolean(),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
});

export class AdminAutomationStoreContractError extends Error {
  readonly code = "ADMIN_AUTOMATION_STORE_CONTRACT_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdminAutomationStoreContractError";
  }
}

export class AdminAutomationIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("The idempotency key was already used with another automation request.");
    this.name = "AdminAutomationIdempotencyConflictError";
  }
}

export class AdminDreamingDisabledError extends Error {
  readonly code = "DREAMING_DISABLED";

  constructor() {
    super("Dreaming must be enabled before a run can be enqueued.");
    this.name = "AdminDreamingDisabledError";
  }
}

export class AdminDreamingDateError extends Error {
  readonly code = "DREAMING_DATE_NOT_COMPLETED";

  constructor() {
    super("Dreaming can only process a completed local date.");
    this.name = "AdminDreamingDateError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function idempotencyKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 200) {
    throw new AdminAutomationStoreContractError(
      "idempotencyKey must contain between 1 and 200 characters.",
    );
  }
  return normalized;
}

function validDate(value: string | Date, name: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.valueOf())) {
    throw new AdminAutomationStoreContractError(`${name} must be a valid ISO timestamp.`);
  }
  return result;
}

function validLocalDate(value: string): string {
  if (!z.string().date().safeParse(value).success) {
    throw new AdminAutomationStoreContractError(
      "localDate must be a valid YYYY-MM-DD date.",
    );
  }
  return value;
}

function validTimeZone(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 200) {
    throw new AdminAutomationStoreContractError(
      "timeZone must contain between 1 and 200 characters.",
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch (error) {
    throw new AdminAutomationStoreContractError(
      "timeZone must be a valid IANA time zone.",
      { cause: error },
    );
  }
  return value;
}

function validLocalTime(value: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    throw new AdminAutomationStoreContractError(
      "dreamLocalTime must use 24-hour HH:MM format.",
    );
  }
  return value;
}

function positiveInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new AdminAutomationStoreContractError(
      `${name} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function mapSettings(
  row: typeof automationSettings.$inferSelect,
): AdminAutomationSettings {
  return {
    timeZone: row.timeZone,
    dreamingEnabled: row.dreamingEnabled,
    dreamLocalTime: row.dreamLocalTime.slice(0, 5),
    nextDreamAt: row.nextDreamAt?.toISOString() ?? null,
    dreamingMode: row.dreamingMode,
    dailyInputTokenLimit: row.dailyInputTokenLimit,
    dailyOutputTokenLimit: row.dailyOutputTokenLimit,
    reminderDeliveryEnabled: row.reminderDeliveryEnabled,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function decodeSettingsReceipt(value: unknown): AdminAutomationSettings {
  const result = settingsReceiptSchema.safeParse(value);
  if (!result.success) {
    throw new AdminAutomationStoreContractError(
      "The stored automation settings receipt is invalid.",
      { cause: result.error },
    );
  }
  return result.data;
}

function mapJob(row: typeof automationJobs.$inferSelect): AutomationJob {
  return {
    id: row.id,
    kind: row.kind,
    canonicalKey: row.canonicalKey,
    scheduledFor: row.scheduledFor.toISOString(),
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    fencingToken: row.fencingToken,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    sanitizedError: row.sanitizedError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
    throw new AdminAutomationStoreContractError(
      "The configured time zone could not be formatted.",
    );
  }
  return `${year}-${month}-${day}`;
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
  throw new AdminAutomationStoreContractError(
    `Unable to resolve the next run in time zone ${timeZone}.`,
  );
}

function nextScheduledInstant(now: Date, timeZone: string, localTime: string): Date {
  const today = localDateAt(now, timeZone);
  const todayCandidate = utcForLocalDateTime(today, timeZone, localTime);
  return todayCandidate > now
    ? todayCandidate
    : utcForLocalDateTime(shiftLocalDate(today, 1), timeZone, localTime);
}

function settingsChangedNames(changes: AdminAutomationSettingsChanges): readonly string[] {
  const names = [
    changes.timeZone === undefined ? null : "timeZone",
    changes.dreamingEnabled === undefined ? null : "dreamingEnabled",
    changes.dreamLocalTime === undefined ? null : "dreamLocalTime",
    changes.dreamingMode === undefined ? null : "dreamingMode",
    changes.dailyInputTokenLimit === undefined ? null : "dailyInputTokenLimit",
    changes.dailyOutputTokenLimit === undefined ? null : "dailyOutputTokenLimit",
    changes.reminderDeliveryEnabled === undefined
      ? null
      : "reminderDeliveryEnabled",
  ].filter((name): name is string => name !== null);
  if (names.length === 0) {
    throw new AdminAutomationStoreContractError(
      "At least one automation setting must be provided.",
    );
  }
  return names.sort((left, right) => left.localeCompare(right));
}

function validateSettingsChanges(changes: AdminAutomationSettingsChanges): {
  readonly idempotencyKey: string;
  readonly changedNames: readonly string[];
} {
  positiveInteger(changes.expectedRevision, "expectedRevision", 2_147_483_647);
  if (changes.timeZone !== undefined) validTimeZone(changes.timeZone);
  if (changes.dreamLocalTime !== undefined) validLocalTime(changes.dreamLocalTime);
  if (
    changes.dreamingMode !== undefined &&
    changes.dreamingMode !== "preview" &&
    changes.dreamingMode !== "apply"
  ) {
    throw new AdminAutomationStoreContractError("dreamingMode is invalid.");
  }
  if (changes.dailyInputTokenLimit !== undefined) {
    positiveInteger(
      changes.dailyInputTokenLimit,
      "dailyInputTokenLimit",
      1_000_000,
    );
  }
  if (changes.dailyOutputTokenLimit !== undefined) {
    positiveInteger(
      changes.dailyOutputTokenLimit,
      "dailyOutputTokenLimit",
      100_000,
    );
  }
  return {
    idempotencyKey: idempotencyKey(changes.idempotencyKey),
    changedNames: settingsChangedNames(changes),
  };
}

function requestDigestForSettings(changes: AdminAutomationSettingsChanges): string {
  return digest({
    expectedRevision: changes.expectedRevision,
    timeZone: changes.timeZone ?? null,
    dreamingEnabled: changes.dreamingEnabled ?? null,
    dreamLocalTime: changes.dreamLocalTime ?? null,
    dreamingMode: changes.dreamingMode ?? null,
    dailyInputTokenLimit: changes.dailyInputTokenLimit ?? null,
    dailyOutputTokenLimit: changes.dailyOutputTokenLimit ?? null,
    reminderDeliveryEnabled: changes.reminderDeliveryEnabled ?? null,
  });
}

async function readReceipt(
  transaction: SecondBrainTransaction,
  operation: string,
  key: string,
) {
  const rows = await transaction
    .select({
      requestDigest: mutationReceipts.requestDigest,
      resultEntityId: mutationReceipts.resultEntityId,
      result: mutationReceipts.result,
    })
    .from(mutationReceipts)
    .where(
      and(
        eq(mutationReceipts.operation, operation),
        eq(mutationReceipts.idempotencyKey, key),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function cursorCondition(cursor: CursorPosition | null): SQL | undefined {
  if (cursor === null) return undefined;
  const timestamp = validDate(cursor.ts, "cursor.ts");
  if (!z.string().uuid().safeParse(cursor.id).success) {
    throw new AdminAutomationStoreContractError("cursor.id must be a UUID.");
  }
  return or(
    lt(automationJobs.updatedAt, timestamp),
    and(
      eq(automationJobs.updatedAt, timestamp),
      lt(automationJobs.id, cursor.id),
    ),
  );
}

export class DrizzleAdminAutomationStore implements AdminAutomationStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async getSettings(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<AdminAutomationSettings> {
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      const rows = await transaction
        .select()
        .from(automationSettings)
        .where(eq(automationSettings.id, 1))
        .limit(1);
      signal.throwIfAborted();
      const row = rows[0];
      if (row === undefined) {
        throw new AdminAutomationStoreContractError(
          "Automation settings are not initialized.",
        );
      }
      return mapSettings(row);
    });
  }

  async updateSettings(
    access: BrainAccessContext,
    changes: AdminAutomationSettingsChanges,
    signal: AbortSignal,
  ): Promise<AdminAutomationSettings | null> {
    signal.throwIfAborted();
    const normalized = validateSettingsChanges(changes);
    const requestDigest = requestDigestForSettings(changes);

    return this.database.transaction(async (transaction) => {
      const authorized = await authorizeBrainTransaction(
        transaction,
        access,
        "admin",
        signal,
      );
      const currentRows = await transaction
        .select({
          settings: automationSettings,
          now: sql<string>`current_timestamp::text`,
        })
        .from(automationSettings)
        .where(eq(automationSettings.id, 1))
        .for("update")
        .limit(1);
      const receipt = await readReceipt(
        transaction,
        SETTINGS_UPDATE_OPERATION,
        normalized.idempotencyKey,
      );
      if (receipt !== null) {
        if (receipt.requestDigest !== requestDigest) {
          throw new AdminAutomationIdempotencyConflictError();
        }
        return decodeSettingsReceipt(receipt.result);
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
      const dreamLocalTime =
        changes.dreamLocalTime ?? current.dreamLocalTime.slice(0, 5);
      const dreamingEnabled =
        changes.dreamingEnabled ?? current.dreamingEnabled;
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
          ...(changes.dreamingMode === undefined
            ? {}
            : { dreamingMode: changes.dreamingMode }),
          ...(changes.dailyInputTokenLimit === undefined
            ? {}
            : { dailyInputTokenLimit: changes.dailyInputTokenLimit }),
          ...(changes.dailyOutputTokenLimit === undefined
            ? {}
            : { dailyOutputTokenLimit: changes.dailyOutputTokenLimit }),
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
        operation: SETTINGS_UPDATE_OPERATION,
        idempotencyKey: normalized.idempotencyKey,
        requestDigest,
        resultEntityType: "automation_settings",
        resultEntityId: null,
        result,
      });
      await appendAdminAuditEvent(
        transaction,
        authorized,
        {
          category: "automation",
          action: "automation.settings.updated",
          outcome: "succeeded",
          targetType: "automation_settings",
          targetId: "1",
          errorCode: null,
          metadata: { changedNames: normalized.changedNames },
        },
        signal,
      );
      return result;
    });
  }

  async getStatus(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<AdminAutomationStatus> {
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      const summaryRows = await transaction
        .select({
          observedAt: sql<string>`clock_timestamp()::text`,
          pending: sql<number>`count(*) filter (where ${automationJobs.status} = 'pending')::integer`,
          running: sql<number>`count(*) filter (where ${automationJobs.status} = 'running')::integer`,
          retryWait: sql<number>`count(*) filter (where ${automationJobs.status} = 'retry_wait')::integer`,
          failed: sql<number>`count(*) filter (where ${automationJobs.status} = 'failed')::integer`,
          lastCompletedAt: sql<string | null>`(max(${automationJobs.updatedAt}) filter (where ${automationJobs.status} = 'completed'))::text`,
        })
        .from(automationJobs);
      const heartbeatRows = await transaction
        .select()
        .from(automationWorkerHeartbeats)
        .orderBy(desc(automationWorkerHeartbeats.lastSeenAt))
        .limit(100);
      signal.throwIfAborted();
      const summary = summaryRows[0];
      if (summary === undefined) {
        throw new AdminAutomationStoreContractError(
          "Automation status could not be loaded.",
        );
      }
      const observedAt = validDate(summary.observedAt, "automation status time");
      const staleBefore = observedAt.valueOf() - HEARTBEAT_STALE_AFTER_MS;
      return {
        observedAt: observedAt.toISOString(),
        workers: heartbeatRows.map((row) => ({
          workerId: row.workerId,
          version: row.version,
          startedAt: row.startedAt.toISOString(),
          lastSeenAt: row.lastSeenAt.toISOString(),
          health: row.lastSeenAt.valueOf() >= staleBefore ? "healthy" : "stale",
        })),
        jobs: {
          pending: summary.pending,
          running: summary.running,
          retryWait: summary.retryWait,
          failed: summary.failed,
          lastCompletedAt:
            summary.lastCompletedAt === null
              ? null
              : validDate(
                  summary.lastCompletedAt,
                  "last completed automation job time",
                ).toISOString(),
        },
      };
    });
  }

  async listJobs(
    access: BrainAccessContext,
    input: Parameters<AdminAutomationStore["listJobs"]>[1],
    signal: AbortSignal,
  ): Promise<Page<AutomationJob>> {
    signal.throwIfAborted();
    if (input.kind !== null && !automationJobKinds.includes(input.kind)) {
      throw new AdminAutomationStoreContractError("kind is invalid.");
    }
    if (input.status !== null && !automationJobStatuses.includes(input.status)) {
      throw new AdminAutomationStoreContractError("status is invalid.");
    }
    positiveInteger(input.limit, "limit", 100);
    const cursor = cursorCondition(input.cursor);

    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      const conditions: SQL[] = [];
      if (input.kind !== null) conditions.push(eq(automationJobs.kind, input.kind));
      if (input.status !== null) {
        conditions.push(eq(automationJobs.status, input.status));
      }
      if (cursor !== undefined) conditions.push(cursor);
      const rows = await transaction
        .select()
        .from(automationJobs)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(desc(automationJobs.updatedAt), desc(automationJobs.id))
        .limit(input.limit + 1);
      signal.throwIfAborted();
      const hasNext = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map((row) => mapJob(row));
      const tail = items.at(-1);
      return {
        items,
        nextCursor:
          hasNext && tail !== undefined
            ? { ts: tail.updatedAt, id: tail.id }
            : null,
      };
    });
  }

  async enqueueDreamingRun(
    access: BrainAccessContext,
    input: Parameters<AdminAutomationStore["enqueueDreamingRun"]>[1],
    signal: AbortSignal,
  ): Promise<{ readonly job: AutomationJob; readonly created: boolean }> {
    signal.throwIfAborted();
    const key = idempotencyKey(input.idempotencyKey);
    const requestedLocalDate =
      input.localDate === null ? null : validLocalDate(input.localDate);
    const requestDigest = digest({ localDate: requestedLocalDate });

    return this.database.transaction(async (transaction) => {
      const authorized = await authorizeBrainTransaction(
        transaction,
        access,
        "admin",
        signal,
      );
      const settingsRows = await transaction
        .select({
          settings: automationSettings,
          now: sql<string>`current_timestamp::text`,
        })
        .from(automationSettings)
        .where(eq(automationSettings.id, 1))
        .for("update")
        .limit(1);
      const settingsRow = settingsRows[0];
      if (settingsRow === undefined) {
        throw new AdminAutomationStoreContractError(
          "Automation settings are not initialized.",
        );
      }
      if (!settingsRow.settings.dreamingEnabled) {
        throw new AdminDreamingDisabledError();
      }
      const receipt = await readReceipt(
        transaction,
        DREAMING_ENQUEUE_OPERATION,
        key,
      );
      if (receipt !== null) {
        if (receipt.requestDigest !== requestDigest) {
          throw new AdminAutomationIdempotencyConflictError();
        }
        if (receipt.resultEntityId === null) {
          throw new AdminAutomationStoreContractError(
            "The stored dreaming enqueue receipt is invalid.",
          );
        }
        const replayRows = await transaction
          .select()
          .from(automationJobs)
          .where(eq(automationJobs.id, receipt.resultEntityId))
          .limit(1);
        const replay = replayRows[0];
        if (replay === undefined) {
          throw new AdminAutomationStoreContractError(
            "The stored dreaming enqueue receipt is invalid.",
          );
        }
        return { job: mapJob(replay), created: false };
      }
      const now = validDate(settingsRow.now, "current database time");
      const today = localDateAt(now, settingsRow.settings.timeZone);
      const localDate = requestedLocalDate ?? shiftLocalDate(today, -1);
      if (localDate >= today) throw new AdminDreamingDateError();
      const canonicalKey = `daily_dreaming:${localDate}`;
      const inserted = await transaction
        .insert(automationJobs)
        .values({
          kind: "daily_dreaming",
          canonicalKey,
          scheduledFor: now,
          payload: { localDate },
        })
        .onConflictDoNothing({
          target: [automationJobs.kind, automationJobs.canonicalKey],
        })
        .returning();
      const rows =
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
      const row = rows[0];
      if (row === undefined) {
        throw new AdminAutomationStoreContractError(
          "The dreaming job was not stored.",
        );
      }
      const created = inserted.length === 1;
      const job = mapJob(row);

      await transaction.insert(mutationReceipts).values({
        operation: DREAMING_ENQUEUE_OPERATION,
        idempotencyKey: key,
        requestDigest,
        resultEntityType: "automation_job",
        resultEntityId: job.id,
        result: { localDate },
      });
      await appendAdminAuditEvent(
        transaction,
        authorized,
        {
          category: "automation",
          action: "automation.dreaming.enqueued",
          outcome: "succeeded",
          targetType: "automation_job",
          targetId: job.id,
          errorCode: null,
          metadata: { localDate, created },
        },
        signal,
      );
      return { job, created };
    });
  }
}
