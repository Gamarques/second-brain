import { createHash, randomUUID } from "node:crypto";

import {
  and,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { mutationSources, versionOperations } from "../../domain.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  CursorPosition,
  MutationSource,
  Reminder,
  ReminderStore,
  ReminderVersion,
  TemporalCoverage,
  TemporalPage,
  VersionOperation,
} from "../../domain.js";
import { reminders } from "../schema/content.js";
import {
  activityEvents,
  mutationReceipts,
  reminderVersions,
} from "../schema/temporal.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";

const operationNames = {
  create: "reminder.create",
  update: "reminder.update",
  delete: "reminder.delete",
} as const;

const actorRowSchema = z.object({
  actorKind: z.enum(["account", "oauth_client", "import", "dreaming", "system"]),
  actorAccountId: z.uuid().nullable(),
  actorClientId: z.string().min(1).max(500).nullable(),
  actorSource: z.enum(mutationSources),
});

const reminderRowSchema = actorRowSchema.extend({
  id: z.uuid(),
  message: z.string().min(1).max(2_000),
  remindAt: z.date(),
  completedAt: z.date().nullable(),
  historyVersion: z.number().int().positive(),
  historyCompleteFrom: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const reminderVersionRowSchema = actorRowSchema.extend({
  id: z.uuid(),
  reminderId: z.uuid(),
  versionNumber: z.number().int().positive(),
  operation: z.enum(versionOperations),
  message: z.string().min(1).max(2_000),
  remindAt: z.date(),
  completedAt: z.date().nullable(),
  effectiveAt: z.date(),
  recordedAt: z.date(),
  changedFields: z.array(z.string().min(1).max(100)).max(100),
  activityEventId: z.uuid(),
});

const receiptRowSchema = z.object({
  operation: z.string(),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  resultEntityType: z.string().nullable(),
  resultEntityId: z.uuid().nullable(),
  resultVersionId: z.uuid().nullable(),
  activityEventId: z.uuid().nullable(),
});

export interface ReminderCreateInput {
  readonly message: string;
  readonly remindAt: string;
  readonly idempotencyKey: string;
}

export interface CreatedReminderEffect {
  readonly reminder: Reminder;
  readonly activityEventId: string;
}

export class ReminderStoreContractError extends Error {
  readonly code = "REMINDER_STORE_CONTRACT_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReminderStoreContractError";
  }
}

export class ReminderStoreIdempotencyConflictError extends Error {
  readonly code = "REMINDER_STORE_IDEMPOTENCY_CONFLICT";

  constructor() {
    super("The reminder idempotency key was already used for a different mutation.");
    this.name = "ReminderStoreIdempotencyConflictError";
  }
}

function contract(message: string, cause?: unknown): ReminderStoreContractError {
  return new ReminderStoreContractError(message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function requiredText(value: string, field: string, maximum: number): string {
  const result = value.trim();
  if (result.length === 0 || result.length > maximum) {
    throw contract(`${field} must contain between 1 and ${maximum} characters.`);
  }
  return result;
}

function dateInput(value: string | null, field: string): Date | null {
  if (value === null) return null;
  const result = new Date(value);
  if (!Number.isFinite(result.valueOf())) {
    throw contract(`${field} must be a valid timestamp.`);
  }
  return result;
}

function iso(value: Date | null): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw contract("The database returned an invalid timestamp.");
  }
  return value.toISOString();
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function eventIdempotencyKey(operation: string, key: string): string {
  return digest(["mutation-event", operation, key]);
}

function actorColumns(access: BrainAccessContext) {
  return {
    actorKind: access.actor.kind,
    actorAccountId: access.actor.accountId,
    actorClientId: access.actor.clientId,
    actorSource: access.actor.source,
  } as const;
}

function eventActorColumns(access: BrainAccessContext) {
  return {
    ...actorColumns(access),
    requestId: access.actor.requestId,
    correlationId: access.actor.correlationId,
    causationId: access.actor.causationId,
    dreamingRunId: access.actor.dreamingRunId,
  } as const;
}

function decodeActor(row: z.infer<typeof actorRowSchema>): ActorAttribution {
  const source = row.actorSource as MutationSource;
  if (row.actorKind === "account") {
    if (row.actorClientId !== null) throw contract("Invalid account attribution.");
    return { kind: "account", accountId: row.actorAccountId, clientId: null, source };
  }
  if (row.actorKind === "oauth_client") {
    if (row.actorAccountId === null && row.actorClientId === null) {
      return { kind: "oauth_client", accountId: null, clientId: null, source };
    }
    if (row.actorAccountId === null || row.actorClientId === null) {
      throw contract("Invalid OAuth attribution.");
    }
    return {
      kind: "oauth_client",
      accountId: row.actorAccountId,
      clientId: row.actorClientId,
      source,
    };
  }
  if (row.actorClientId !== null) throw contract("Invalid non-client attribution.");
  if (row.actorKind === "import") {
    return { kind: "import", accountId: row.actorAccountId, clientId: null, source };
  }
  if (row.actorAccountId !== null) throw contract("Invalid internal attribution.");
  return { kind: row.actorKind, accountId: null, clientId: null, source };
}

function decodeReminder(row: unknown): Reminder {
  const parsed = reminderRowSchema.safeParse(row);
  if (!parsed.success) throw contract("Invalid reminder row.", parsed.error);
  const value = parsed.data;
  return {
    id: value.id,
    message: value.message,
    remindAt: iso(value.remindAt)!,
    completedAt: iso(value.completedAt),
    version: value.historyVersion,
    historyCompleteFrom: iso(value.historyCompleteFrom)!,
    provenance: decodeActor(value),
    createdAt: iso(value.createdAt)!,
    updatedAt: iso(value.updatedAt)!,
  };
}

async function transactionTime(tx: SecondBrainTransaction): Promise<Date> {
  // A one-row VALUES relation anchors the builder; raw SQL fragments bypass
  // the driver's Date mapping, so the timestamp travels as a canonical UTC
  // string and is revived here.
  const rows = await tx
    .select({
      nowIso: sql<string>`to_char(date_trunc('milliseconds', transaction_timestamp()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(sql`(values (1)) as single_row`);
  const parsed = z.array(z.object({ nowIso: z.string() })).length(1).safeParse(rows);
  const time = parsed.success ? new Date(parsed.data[0]!.nowIso) : null;
  if (time === null || Number.isNaN(time.getTime())) {
    throw contract("PostgreSQL returned an invalid transaction time.");
  }
  return time;
}

async function findReceipt(
  tx: SecondBrainTransaction,
  operation: string,
  key: string,
): Promise<z.infer<typeof receiptRowSchema> | null> {
  const rows = await tx
    .select({
      operation: mutationReceipts.operation,
      requestDigest: mutationReceipts.requestDigest,
      resultEntityType: mutationReceipts.resultEntityType,
      resultEntityId: mutationReceipts.resultEntityId,
      resultVersionId: mutationReceipts.resultVersionId,
      activityEventId: mutationReceipts.activityEventId,
    })
    .from(mutationReceipts)
    .where(
      and(
        eq(mutationReceipts.operation, operation),
        eq(mutationReceipts.idempotencyKey, key),
      ),
    )
    .limit(2);
  const parsed = z.array(receiptRowSchema).max(1).safeParse(rows);
  if (!parsed.success) throw contract("Invalid mutation receipt rows.", parsed.error);
  return parsed.data[0] ?? null;
}

function validateReceipt(
  receipt: z.infer<typeof receiptRowSchema>,
  operation: string,
  requestDigest: string,
): void {
  if (
    receipt.operation !== operation ||
    receipt.requestDigest !== requestDigest ||
    receipt.resultEntityType !== "reminder" ||
    receipt.resultEntityId === null ||
    receipt.activityEventId === null
  ) {
    throw new ReminderStoreIdempotencyConflictError();
  }
}

async function validateDeleteReceiptEvent(
  tx: SecondBrainTransaction,
  receipt: z.infer<typeof receiptRowSchema>,
  reminderId: string,
  requestDigest: string,
): Promise<void> {
  if (receipt.resultVersionId !== null || receipt.activityEventId === null) {
    throw new ReminderStoreIdempotencyConflictError();
  }
  const rows = await tx
    .select({
      entityType: activityEvents.entityType,
      entityId: activityEvents.entityId,
      action: activityEvents.action,
      afterVersionId: activityEvents.afterVersionId,
      requestDigest: activityEvents.requestDigest,
    })
    .from(activityEvents)
    .where(eq(activityEvents.id, receipt.activityEventId))
    .limit(2);
  if (
    rows.length !== 1 ||
    rows[0]!.entityType !== "reminder" ||
    rows[0]!.entityId !== reminderId ||
    rows[0]!.action !== "deleted" ||
    rows[0]!.afterVersionId !== null ||
    rows[0]!.requestDigest !== requestDigest
  ) {
    throw contract("The idempotent reminder receipt and delete event do not agree.");
  }
}

async function claimEvent(
  tx: SecondBrainTransaction,
  access: BrainAccessContext,
  input: {
    readonly id: string;
    readonly entityId: string;
    readonly action: "created" | "updated" | "completed" | "reopened" | "deleted";
    readonly now: Date;
    readonly changedFields: readonly string[];
    readonly afterVersionId: string | null;
    readonly requestDigest: string;
    readonly operation: string;
    readonly idempotencyKey: string;
  },
): Promise<boolean> {
  const rows = await tx
    .insert(activityEvents)
    .values({
      id: input.id,
      entityType: "reminder",
      entityId: input.entityId,
      action: input.action,
      occurredAt: input.now,
      effectiveAt: input.now,
      changedFields: [...input.changedFields],
      afterVersionId: input.afterVersionId,
      contentHash: input.requestDigest,
      analysisAllowed: true,
      idempotencyKey: eventIdempotencyKey(input.operation, input.idempotencyKey),
      requestDigest: input.requestDigest,
      ...eventActorColumns(access),
      recordedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: activityEvents.id });
  return rows.length === 1;
}

async function saveReceipt(
  tx: SecondBrainTransaction,
  input: {
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly entityId: string;
    readonly versionId: string | null;
    readonly eventId: string;
    readonly now: Date;
  },
): Promise<void> {
  const rows = await tx
    .insert(mutationReceipts)
    .values({
      id: randomUUID(),
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      resultEntityType: "reminder",
      resultEntityId: input.entityId,
      resultVersionId: input.versionId,
      result: {},
      activityEventId: input.eventId,
      createdAt: input.now,
    })
    .returning({ id: mutationReceipts.id });
  if (rows.length !== 1) throw contract("The mutation receipt was not persisted.");
}

async function loadVersionResult(
  tx: SecondBrainTransaction,
  reminderId: string,
  versionId: string,
  expectedEventId: string,
  requestDigest: string,
): Promise<Reminder> {
  const rows = await tx
    .select({
      id: reminders.id,
      message: reminderVersions.message,
      remindAt: reminderVersions.remindAt,
      completedAt: reminderVersions.completedAt,
      historyVersion: reminderVersions.versionNumber,
      historyCompleteFrom: reminders.historyCompleteFrom,
      actorKind: activityEvents.actorKind,
      actorAccountId: activityEvents.actorAccountId,
      actorClientId: activityEvents.actorClientId,
      actorSource: activityEvents.actorSource,
      createdAt: reminders.createdAt,
      updatedAt: reminderVersions.recordedAt,
      versionOperation: reminderVersions.operation,
      versionEventId: reminderVersions.activityEventId,
      eventEntityType: activityEvents.entityType,
      eventEntityId: activityEvents.entityId,
      eventAction: activityEvents.action,
      eventAfterVersionId: activityEvents.afterVersionId,
      eventRequestDigest: activityEvents.requestDigest,
    })
    .from(reminderVersions)
    .innerJoin(reminders, eq(reminders.id, reminderVersions.reminderId))
    .innerJoin(activityEvents, eq(activityEvents.id, reminderVersions.activityEventId))
    .where(
      and(
        eq(reminderVersions.reminderId, reminderId),
        eq(reminderVersions.id, versionId),
      ),
    )
    .limit(2);
  if (rows.length !== 1) {
    throw contract("The idempotent reminder result was permanently erased or is invalid.");
  }
  const row = rows[0]!;
  if (
    row.versionEventId !== expectedEventId ||
    row.eventEntityType !== "reminder" ||
    row.eventEntityId !== reminderId ||
    row.eventAfterVersionId !== versionId ||
    row.eventRequestDigest !== requestDigest ||
    row.eventAction !== row.versionOperation
  ) {
    throw contract("The idempotent reminder event and version do not agree.");
  }
  return decodeReminder(row);
}

async function replayReminderEffect(
  tx: SecondBrainTransaction,
  operation: string,
  key: string,
  requestDigest: string,
  expectedEntityId: string | null = null,
): Promise<CreatedReminderEffect | null> {
  const receipt = await findReceipt(tx, operation, key);
  if (receipt === null) return null;
  validateReceipt(receipt, operation, requestDigest);
  if (receipt.resultVersionId === null) throw new ReminderStoreIdempotencyConflictError();
  if (expectedEntityId !== null && receipt.resultEntityId !== expectedEntityId) {
    throw new ReminderStoreIdempotencyConflictError();
  }
  const reminder = await loadVersionResult(
    tx,
    receipt.resultEntityId!,
    receipt.resultVersionId,
    receipt.activityEventId!,
    requestDigest,
  );
  return { reminder, activityEventId: receipt.activityEventId! };
}

async function replayReminder(
  tx: SecondBrainTransaction,
  operation: string,
  key: string,
  requestDigest: string,
  expectedEntityId: string | null = null,
): Promise<Reminder | null> {
  return (
    await replayReminderEffect(tx, operation, key, requestDigest, expectedEntityId)
  )?.reminder ?? null;
}

export async function createReminderInTransaction(
  tx: SecondBrainTransaction,
  access: BrainAccessContext,
  input: ReminderCreateInput,
  signal: AbortSignal,
): Promise<CreatedReminderEffect> {
  await authorizeBrainTransaction(tx, access, "editor", signal);
  const normalized = {
    message: requiredText(input.message, "message", 2_000),
    remindAt: dateInput(input.remindAt, "remindAt")!,
    idempotencyKey: requiredText(input.idempotencyKey, "idempotencyKey", 200),
  } as const;
  const requestDigest = digest({
    operation: operationNames.create,
    input: { message: normalized.message, remindAt: iso(normalized.remindAt) },
  });
  const replay = await replayReminderEffect(
    tx,
    operationNames.create,
    normalized.idempotencyKey,
    requestDigest,
  );
  if (replay !== null) return replay;
  const now = await transactionTime(tx);
  const reminderId = randomUUID();
  const versionId = randomUUID();
  const eventId = randomUUID();
  if (
    !(await claimEvent(tx, access, {
      id: eventId,
      entityId: reminderId,
      action: "created",
      now,
      changedFields: ["message", "remindAt", "completedAt"],
      afterVersionId: versionId,
      requestDigest,
      operation: operationNames.create,
      idempotencyKey: normalized.idempotencyKey,
    }))
  ) {
    const concurrent = await replayReminderEffect(
      tx,
      operationNames.create,
      normalized.idempotencyKey,
      requestDigest,
    );
    if (concurrent === null) throw new ReminderStoreIdempotencyConflictError();
    return concurrent;
  }
  const inserted = await tx
    .insert(reminders)
    .values({
      id: reminderId,
      message: normalized.message,
      remindAt: normalized.remindAt,
      completedAt: null,
      historyVersion: 1,
      historyCompleteFrom: now,
      ...actorColumns(access),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (inserted.length !== 1) throw contract("The reminder projection was not persisted.");
  await tx.insert(reminderVersions).values({
    id: versionId,
    reminderId,
    versionNumber: 1,
    operation: "created",
    origin: "native",
    message: normalized.message,
    remindAt: normalized.remindAt,
    completedAt: null,
    effectiveAt: now,
    recordedAt: now,
    changedFields: ["message", "remindAt", "completedAt"],
    activityEventId: eventId,
  });
  await saveReceipt(tx, {
    operation: operationNames.create,
    idempotencyKey: normalized.idempotencyKey,
    requestDigest,
    entityId: reminderId,
    versionId,
    eventId,
    now,
  });
  signal.throwIfAborted();
  return {
    reminder: decodeReminder(inserted[0]),
    activityEventId: eventId,
  };
}

function coverage(asOf: string | null, incomplete = false): TemporalCoverage {
  return {
    completeFrom: null,
    requestedAsOf: asOf,
    complete: !incomplete,
    warnings: incomplete
      ? ["Some reminder history was permanently erased for privacy, so this historical result is incomplete."]
      : [],
  };
}

function currentCursor(cursor: CursorPosition | null) {
  if (cursor === null) return undefined;
  const timestamp = dateInput(cursor.ts, "cursor.ts")!;
  return or(
    lt(reminders.updatedAt, timestamp),
    and(eq(reminders.updatedAt, timestamp), lt(reminders.id, cursor.id)),
  );
}

function lifecycle(
  wasCompleted: boolean,
  completed: boolean,
): { readonly action: "updated" | "completed" | "reopened"; readonly operation: VersionOperation } {
  if (!wasCompleted && completed) return { action: "completed", operation: "completed" };
  if (wasCompleted && !completed) return { action: "reopened", operation: "reopened" };
  return { action: "updated", operation: "updated" };
}

export class DrizzleReminderStore implements ReminderStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async createReminder(
    access: BrainAccessContext,
    input: ReminderCreateInput,
    signal: AbortSignal,
  ): Promise<Reminder> {
    const effect = await this.database.transaction((tx) =>
      createReminderInTransaction(tx, access, input, signal),
    );
    return effect.reminder;
  }

  async listReminders(
    access: BrainAccessContext,
    input: Parameters<ReminderStore["listReminders"]>[1],
    signal: AbortSignal,
  ): Promise<TemporalPage<Reminder>> {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "viewer", signal);
      if (input.asOf === null) {
        const predicates = [
          input.includeCompleted ? undefined : isNull(reminders.completedAt),
          currentCursor(input.cursor),
        ].filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
        const rows = await tx
          .select()
          .from(reminders)
          .where(and(...predicates))
          .orderBy(desc(reminders.updatedAt), desc(reminders.id))
          .limit(input.limit + 1);
        const pageRows = rows.slice(0, input.limit);
        const items = pageRows.map(decodeReminder);
        const last = items.at(-1);
        signal.throwIfAborted();
        return {
          items,
          nextCursor:
            rows.length > input.limit && last !== undefined
              ? { ts: last.updatedAt, id: last.id }
              : null,
          coverage: coverage(null),
        };
      }

      const asOf = dateInput(input.asOf, "asOf")!;
      const visible = tx
        .selectDistinctOn([reminderVersions.reminderId], {
          id: reminders.id,
          message: reminderVersions.message,
          remindAt: reminderVersions.remindAt,
          completedAt: reminderVersions.completedAt,
          historyVersion: reminderVersions.versionNumber,
          historyCompleteFrom: reminders.historyCompleteFrom,
          actorKind: activityEvents.actorKind,
          actorAccountId: activityEvents.actorAccountId,
          actorClientId: activityEvents.actorClientId,
          actorSource: activityEvents.actorSource,
          createdAt: reminders.createdAt,
          updatedAt: reminderVersions.recordedAt,
        })
        .from(reminderVersions)
        .innerJoin(reminders, eq(reminders.id, reminderVersions.reminderId))
        .innerJoin(activityEvents, eq(activityEvents.id, reminderVersions.activityEventId))
        .where(lte(reminderVersions.effectiveAt, asOf))
        .orderBy(
          reminderVersions.reminderId,
          desc(reminderVersions.effectiveAt),
          desc(reminderVersions.versionNumber),
        )
        .as("visible_reminders");
      const cursorTime = input.cursor === null ? null : dateInput(input.cursor.ts, "cursor.ts")!;
      const predicates = [
        input.includeCompleted ? undefined : isNull(visible.completedAt),
        cursorTime === null
          ? undefined
          : or(
              lt(visible.updatedAt, cursorTime),
              and(eq(visible.updatedAt, cursorTime), lt(visible.id, input.cursor!.id)),
            ),
      ].filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
      const rows = await tx
        .select()
        .from(visible)
        .where(predicates.length === 0 ? undefined : and(...predicates))
        .orderBy(desc(visible.updatedAt), desc(visible.id))
        .limit(input.limit + 1);
      const pageRows = rows.slice(0, input.limit);
      const items = pageRows.map(decodeReminder);
      const erased = await tx
        .select({ id: activityEvents.id })
        .from(activityEvents)
        .where(
          and(
            eq(activityEvents.entityType, "reminder"),
            eq(activityEvents.action, "deleted"),
            gt(activityEvents.effectiveAt, asOf),
          ),
        )
        .limit(1);
      const last = items.at(-1);
      signal.throwIfAborted();
      return {
        items,
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? { ts: last.updatedAt, id: last.id }
            : null,
        coverage: coverage(input.asOf, erased.length > 0),
      };
    });
  }

  async updateReminder(
    access: BrainAccessContext,
    id: string,
    changes: Parameters<ReminderStore["updateReminder"]>[2],
    signal: AbortSignal,
  ): Promise<Reminder | null> {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "editor", signal);
      const key = requiredText(
        changes.precondition.idempotencyKey,
        "idempotencyKey",
        200,
      );
      const normalizedChanges = {
        message:
          changes.message === undefined
            ? undefined
            : requiredText(changes.message, "message", 2_000),
        remindAt:
          changes.remindAt === undefined
            ? undefined
            : dateInput(changes.remindAt, "remindAt")!,
        completed: changes.completed,
      } as const;
      const requestDigest = digest({
        operation: operationNames.update,
        id,
        changes: {
          message:
            normalizedChanges.message === undefined
              ? [false]
              : [true, normalizedChanges.message],
          remindAt:
            normalizedChanges.remindAt === undefined
              ? [false]
              : [true, iso(normalizedChanges.remindAt)],
          completed:
            normalizedChanges.completed === undefined
              ? [false]
              : [true, normalizedChanges.completed],
          expectedVersion: changes.precondition.expectedVersion,
        },
      });
      const replay = await replayReminder(tx, operationNames.update, key, requestDigest, id);
      if (replay !== null) return replay;
      const currentRows = await tx
        .select()
        .from(reminders)
        .where(eq(reminders.id, id))
        .limit(2)
        .for("update");
      if (currentRows.length === 0) {
        return replayReminder(tx, operationNames.update, key, requestDigest, id);
      }
      if (currentRows.length !== 1) throw contract("Reminder lookup was not unique.");
      const afterLockReplay = await replayReminder(
        tx,
        operationNames.update,
        key,
        requestDigest,
        id,
      );
      if (afterLockReplay !== null) return afterLockReplay;
      const parsed = reminderRowSchema.safeParse(currentRows[0]);
      if (!parsed.success) throw contract("Invalid reminder projection row.", parsed.error);
      const current = parsed.data;
      if (current.historyVersion !== changes.precondition.expectedVersion) return null;
      const now = await transactionTime(tx);
      const completed = normalizedChanges.completed ?? current.completedAt !== null;
      const next = {
        message:
          normalizedChanges.message === undefined
            ? current.message
            : normalizedChanges.message,
        remindAt:
          normalizedChanges.remindAt === undefined
            ? current.remindAt
            : normalizedChanges.remindAt,
        completedAt:
          completed
            ? current.completedAt ?? now
            : null,
      } as const;
      const fields: string[] = [];
      if (current.message !== next.message) fields.push("message");
      if (iso(current.remindAt) !== iso(next.remindAt)) fields.push("remindAt");
      if (iso(current.completedAt) !== iso(next.completedAt)) fields.push("completedAt");
      const state = lifecycle(current.completedAt !== null, completed);
      const versionId = randomUUID();
      const eventId = randomUUID();
      if (
        !(await claimEvent(tx, access, {
          id: eventId,
          entityId: id,
          action: state.action,
          now,
          changedFields: fields,
          afterVersionId: versionId,
          requestDigest,
          operation: operationNames.update,
          idempotencyKey: key,
        }))
      ) {
        const concurrent = await replayReminder(
          tx,
          operationNames.update,
          key,
          requestDigest,
          id,
        );
        if (concurrent === null) throw new ReminderStoreIdempotencyConflictError();
        return concurrent;
      }
      const updated = await tx
        .update(reminders)
        .set({
          message: next.message,
          remindAt: next.remindAt,
          completedAt: next.completedAt,
          historyVersion: current.historyVersion + 1,
          ...actorColumns(access),
          updatedAt: now,
        })
        .where(
          and(
            eq(reminders.id, id),
            eq(reminders.historyVersion, changes.precondition.expectedVersion),
          ),
        )
        .returning();
      if (updated.length !== 1) throw contract("The locked reminder update was lost.");
      await tx.insert(reminderVersions).values({
        id: versionId,
        reminderId: id,
        versionNumber: current.historyVersion + 1,
        operation: state.operation,
        origin: "native",
        message: next.message,
        remindAt: next.remindAt,
        completedAt: next.completedAt,
        effectiveAt: now,
        recordedAt: now,
        changedFields: fields,
        activityEventId: eventId,
      });
      await saveReceipt(tx, {
        operation: operationNames.update,
        idempotencyKey: key,
        requestDigest,
        entityId: id,
        versionId,
        eventId,
        now,
      });
      signal.throwIfAborted();
      return decodeReminder(updated[0]);
    });
  }

  async deleteReminder(
    access: BrainAccessContext,
    id: string,
    input: Parameters<ReminderStore["deleteReminder"]>[2],
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "admin", signal);
      const key = requiredText(input.idempotencyKey, "idempotencyKey", 200);
      const requestDigest = digest({
        operation: operationNames.delete,
        id,
      });
      const receipt = await findReceipt(tx, operationNames.delete, key);
      if (receipt !== null) {
        validateReceipt(receipt, operationNames.delete, requestDigest);
        if (receipt.resultEntityId !== id) throw new ReminderStoreIdempotencyConflictError();
        await validateDeleteReceiptEvent(tx, receipt, id, requestDigest);
        return true;
      }
      const current = await tx
        .select({ id: reminders.id })
        .from(reminders)
        .where(eq(reminders.id, id))
        .limit(2)
        .for("update");
      if (current.length === 0) {
        const concurrent = await findReceipt(tx, operationNames.delete, key);
        if (concurrent === null) return false;
        validateReceipt(concurrent, operationNames.delete, requestDigest);
        await validateDeleteReceiptEvent(tx, concurrent, id, requestDigest);
        return concurrent.resultEntityId === id;
      }
      if (current.length !== 1) throw contract("Reminder delete lookup was not unique.");
      const now = await transactionTime(tx);
      const eventId = randomUUID();
      if (
        !(await claimEvent(tx, access, {
          id: eventId,
          entityId: id,
          action: "deleted",
          now,
          changedFields: ["deleted"],
          afterVersionId: null,
          requestDigest,
          operation: operationNames.delete,
          idempotencyKey: key,
        }))
      ) {
        throw new ReminderStoreIdempotencyConflictError();
      }
      const deleted = await tx
        .delete(reminders)
        .where(eq(reminders.id, id))
        .returning({ id: reminders.id });
      if (deleted.length !== 1) throw contract("The locked reminder delete was lost.");
      await saveReceipt(tx, {
        operation: operationNames.delete,
        idempotencyKey: key,
        requestDigest,
        entityId: id,
        versionId: null,
        eventId,
        now,
      });
      signal.throwIfAborted();
      return true;
    });
  }

  async listReminderHistory(
    access: BrainAccessContext,
    input: Parameters<ReminderStore["listReminderHistory"]>[1],
    signal: AbortSignal,
  ): Promise<TemporalPage<ReminderVersion>> {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "viewer", signal);
      const from = dateInput(input.from, "from");
      const to = dateInput(input.to, "to");
      const cursorTime = input.cursor === null ? null : dateInput(input.cursor.ts, "cursor.ts")!;
      const predicates = [
        eq(reminderVersions.reminderId, input.reminderId),
        from === null ? undefined : gte(reminderVersions.effectiveAt, from),
        to === null ? undefined : lte(reminderVersions.effectiveAt, to),
        cursorTime === null
          ? undefined
          : or(
              lt(reminderVersions.recordedAt, cursorTime),
              and(
                eq(reminderVersions.recordedAt, cursorTime),
                lt(reminderVersions.id, input.cursor!.id),
              ),
            ),
      ].filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
      const rows = await tx
        .select({
          id: reminderVersions.id,
          reminderId: reminderVersions.reminderId,
          versionNumber: reminderVersions.versionNumber,
          operation: reminderVersions.operation,
          message: reminderVersions.message,
          remindAt: reminderVersions.remindAt,
          completedAt: reminderVersions.completedAt,
          effectiveAt: reminderVersions.effectiveAt,
          recordedAt: reminderVersions.recordedAt,
          changedFields: reminderVersions.changedFields,
          activityEventId: reminderVersions.activityEventId,
          actorKind: activityEvents.actorKind,
          actorAccountId: activityEvents.actorAccountId,
          actorClientId: activityEvents.actorClientId,
          actorSource: activityEvents.actorSource,
        })
        .from(reminderVersions)
        .innerJoin(activityEvents, eq(activityEvents.id, reminderVersions.activityEventId))
        .where(and(...predicates))
        .orderBy(desc(reminderVersions.recordedAt), desc(reminderVersions.id))
        .limit(input.limit + 1);
      const pageRows = rows.slice(0, input.limit);
      const items = pageRows.map((row): ReminderVersion => {
        const parsed = reminderVersionRowSchema.safeParse(row);
        if (!parsed.success) throw contract("Invalid reminder version row.", parsed.error);
        const value = parsed.data;
        return {
          id: value.id,
          reminderId: value.reminderId,
          version: value.versionNumber,
          operation: value.operation,
          snapshot: {
            id: value.reminderId,
            message: value.message,
            remindAt: iso(value.remindAt)!,
            completedAt: iso(value.completedAt),
          },
          effectiveAt: iso(value.effectiveAt)!,
          recordedAt: iso(value.recordedAt)!,
          changedFields: value.changedFields,
          provenance: decodeActor(value),
          activityEventId: value.activityEventId,
        };
      });
      const deleted = await tx
        .select({ id: activityEvents.id })
        .from(activityEvents)
        .where(
          and(
            eq(activityEvents.entityType, "reminder"),
            eq(activityEvents.entityId, input.reminderId),
            eq(activityEvents.action, "deleted"),
          ),
        )
        .limit(1);
      const last = items.at(-1);
      signal.throwIfAborted();
      return {
        items,
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? { ts: last.recordedAt, id: last.id }
            : null,
        coverage: coverage(null, deleted.length > 0),
      };
    });
  }
}
