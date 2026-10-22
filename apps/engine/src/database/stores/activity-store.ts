import { createHash, randomUUID } from "node:crypto";

import {
  and,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import {
  activityKinds,
  activityTimeBases,
  actorKinds,
  mutationSources,
} from "../../domain.js";
import type {
  Activity,
  ActivityGoalAllocation,
  ActivityKind,
  ActivityStore,
  ActivitySummary,
  ActorAttribution,
  BrainAccessContext,
  CursorPosition,
  MutationSource,
  PriorityPlanItem,
  TemporalCoverage,
} from "../../domain.js";
import { projects, reminders, tasks } from "../schema/content.js";
import { accounts } from "../schema/identity.js";
import {
  activities,
  activityEvents,
  activityGoalAllocations,
  goals,
  mutationReceipts,
  priorityPlanVersionItems,
  priorityPlanVersions,
  reminderVersions,
  taskVersionGoalLinks,
  taskVersions,
} from "../schema/temporal.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";

export type ActivityDatabase = SecondBrainDatabase;

export class ActivityStoreConflictError extends Error {
  readonly code = "ACTIVITY_STORE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "ActivityStoreConflictError";
  }
}

const activityKindSet = new Set<string>(activityKinds);
const mutationSourceSet = new Set<string>(mutationSources);
const minuteMilliseconds = 60_000;
const maximumSummaryEvents = 1_000;
const maximumSummaryIntervals = 1_000;
const maximumPriorityVersions = 500;
const maximumSummaryStateVersions = 1_000;
const maximumSummaryRangeMilliseconds = 366 * 24 * 60 * minuteMilliseconds;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const receiptActorSchema = z.object({
  kind: z.enum(actorKinds),
  accountId: z.uuid().nullable(),
  clientId: z.string().trim().min(1).max(500).nullable(),
  source: z.enum(mutationSources),
});
const activityReceiptSchema = z.object({
  activity: z
    .object({
      id: z.uuid(),
      kind: z.enum(activityKinds),
      occurredAt: z.iso.datetime({ offset: true }),
      endedAt: z.iso.datetime({ offset: true }).nullable(),
      timeBasis: z.enum(activityTimeBases),
      taskId: z.uuid().nullable(),
      projectId: z.uuid().nullable(),
      summary: z.string().max(2_000).nullable(),
      analysisAllowed: z.boolean(),
      allocations: z
        .array(
          z.object({
            goalId: z.uuid(),
            allocationPercent: z.number().positive().max(100),
          }),
        )
        .max(20),
      idempotencyKey: z.string().trim().min(1).max(200),
      provenance: receiptActorSchema,
      recordedAt: z.iso.datetime({ offset: true }),
      retractedAt: z.iso.datetime({ offset: true }).nullable(),
      retractionReason: z.string().trim().min(1).max(500).nullable(),
    })
    .superRefine((activity, context) => {
      if ((activity.endedAt === null) !== (activity.timeBasis === "instant")) {
        context.addIssue({
          code: "custom",
          message: "Invalid activity time basis.",
        });
      }
      if (
        (activity.retractedAt === null) !==
        (activity.retractionReason === null)
      ) {
        context.addIssue({
          code: "custom",
          message: "Invalid activity retraction.",
        });
      }
    }),
});

function decodeUuid(value: string, field: string): string {
  if (!uuidPattern.test(value))
    throw new Error(`The database returned an invalid ${field}.`);
  return value;
}

function inputDate(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`${field} must be a valid timestamp.`);
  }
  return date;
}

function decodeDate(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return date.toISOString();
}

function decodeKind(value: string): ActivityKind {
  if (!activityKindSet.has(value)) {
    throw new Error("The database returned an invalid activity kind.");
  }
  return value as ActivityKind;
}

function decodeActor(row: {
  readonly actorKind:
    "account" | "oauth_client" | "import" | "dreaming" | "system";
  readonly actorAccountId: string | null;
  readonly actorClientId: string | null;
  readonly actorSource: string;
}): ActorAttribution {
  if (!mutationSourceSet.has(row.actorSource)) {
    throw new Error("The database returned an invalid actor source.");
  }
  const source = row.actorSource as MutationSource;
  if (row.actorKind === "account") {
    if (row.actorAccountId !== null)
      decodeUuid(row.actorAccountId, "actor account ID");
    if (row.actorClientId !== null)
      throw new Error("Invalid account attribution.");
    return {
      kind: "account",
      accountId: row.actorAccountId,
      clientId: null,
      source,
    };
  }
  if (row.actorKind === "oauth_client") {
    if (row.actorAccountId === null && row.actorClientId === null) {
      return { kind: "oauth_client", accountId: null, clientId: null, source };
    }
    if (row.actorAccountId === null || row.actorClientId === null) {
      throw new Error("Invalid OAuth attribution.");
    }
    decodeUuid(row.actorAccountId, "actor account ID");
    if (row.actorClientId.trim() === "" || row.actorClientId.length > 500) {
      throw new Error("Invalid OAuth attribution.");
    }
    return {
      kind: "oauth_client",
      accountId: row.actorAccountId,
      clientId: row.actorClientId,
      source,
    };
  }
  if (row.actorClientId !== null)
    throw new Error("Invalid non-client attribution.");
  if (row.actorKind === "import") {
    if (row.actorAccountId !== null)
      decodeUuid(row.actorAccountId, "actor account ID");
    return {
      kind: "import",
      accountId: row.actorAccountId,
      clientId: null,
      source,
    };
  }
  if (row.actorAccountId !== null)
    throw new Error("Invalid internal attribution.");
  return { kind: row.actorKind, accountId: null, clientId: null, source };
}

function stableDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function validateAllocations(
  allocations: readonly ActivityGoalAllocation[],
): readonly ActivityGoalAllocation[] {
  if (allocations.length > 20)
    throw new Error("At most twenty allocations are allowed.");
  const sorted = [...allocations]
    .map((allocation) => ({
      ...allocation,
      goalId: decodeUuid(allocation.goalId, "activity allocation goal ID"),
    }))
    .sort((left, right) => left.goalId.localeCompare(right.goalId));
  if (
    new Set(sorted.map((allocation) => allocation.goalId)).size !==
    sorted.length
  ) {
    throw new Error("An activity may allocate to a goal only once.");
  }
  let total = 0;
  for (const allocation of sorted) {
    if (
      !Number.isFinite(allocation.allocationPercent) ||
      allocation.allocationPercent <= 0 ||
      allocation.allocationPercent > 100 ||
      Math.abs(
        allocation.allocationPercent * 100 -
          Math.round(allocation.allocationPercent * 100),
      ) > 0.000_001
    ) {
      throw new Error(
        "Activity allocations must be greater than zero and at most one hundred.",
      );
    }
    total += allocation.allocationPercent;
  }
  if (total > 100 + 0.000_001) {
    throw new Error(
      "Activity allocations must not total more than one hundred.",
    );
  }
  return sorted;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function temporalCoverage(
  completeFrom: Date,
  requestedAsOf: string | null,
  warnings: readonly string[],
): TemporalCoverage {
  return {
    completeFrom: decodeDate(completeFrom, "earliest account createdAt"),
    requestedAsOf,
    complete: true,
    warnings: [...warnings],
  };
}

type ActivityRow = typeof activities.$inferSelect;

function decodeActivity(
  row: ActivityRow,
  allocations: readonly ActivityGoalAllocation[],
): Activity {
  decodeUuid(row.id, "activity ID");
  if (row.taskId !== null) decodeUuid(row.taskId, "activity task ID");
  if (row.projectId !== null) decodeUuid(row.projectId, "activity project ID");
  if (row.summary !== null && row.summary.length > 2_000) {
    throw new Error("The database returned an invalid activity summary.");
  }
  if (row.idempotencyKey.trim() === "" || row.idempotencyKey.length > 200) {
    throw new Error(
      "The database returned an invalid activity idempotency key.",
    );
  }
  const occurredAt = decodeDate(row.occurredAt, "activity occurredAt");
  const endedAt =
    row.endedAt === null ? null : decodeDate(row.endedAt, "activity endedAt");
  const expectedBasis = endedAt === null ? "instant" : "explicit_interval";
  if (row.timeBasis !== expectedBasis) {
    throw new Error(
      "The database returned an inconsistent activity time basis.",
    );
  }
  if (endedAt !== null && Date.parse(endedAt) <= Date.parse(occurredAt)) {
    throw new Error("The database returned an invalid activity interval.");
  }
  if ((row.retractedAt === null) !== (row.retractionReason === null)) {
    throw new Error(
      "The database returned inconsistent activity retraction metadata.",
    );
  }
  if (row.retractionReason !== null && row.retractionReason.length > 500) {
    throw new Error(
      "The database returned an invalid activity retraction reason.",
    );
  }
  return {
    id: row.id,
    kind: decodeKind(row.kind),
    occurredAt,
    endedAt,
    timeBasis: expectedBasis,
    taskId: row.taskId,
    projectId: row.projectId,
    summary: row.summary,
    analysisAllowed: row.analysisAllowed,
    allocations: validateAllocations(allocations),
    idempotencyKey: row.idempotencyKey,
    provenance: decodeActor(row),
    recordedAt: decodeDate(row.recordedAt, "activity recordedAt"),
    retractedAt:
      row.retractedAt === null
        ? null
        : decodeDate(row.retractedAt, "activity retractedAt"),
    retractionReason: row.retractionReason,
  };
}

function decodeActivityReceipt(value: unknown): Activity {
  const parsed = activityReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("The database returned an invalid activity receipt.");
  }
  const activity = parsed.data.activity;
  return {
    ...activity,
    allocations: validateAllocations(activity.allocations),
    provenance: decodeActor({
      actorKind: activity.provenance.kind,
      actorAccountId: activity.provenance.accountId,
      actorClientId: activity.provenance.clientId,
      actorSource: activity.provenance.source,
    }),
  };
}

interface PriorityVersionSnapshot {
  readonly id: string;
  readonly priorityPlanId: string;
  readonly version: number;
  readonly projectId: string | null;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly effectiveAt: number;
  readonly items: readonly PriorityPlanItem[];
}

export class DrizzleActivityStore implements ActivityStore {
  constructor(private readonly database: ActivityDatabase) {}

  async recordActivity(
    access: BrainAccessContext,
    input: Parameters<ActivityStore["recordActivity"]>[1],
    signal: AbortSignal,
  ): Promise<{
    readonly activity: Activity;
    readonly created: boolean;
  } | null> {
    signal.throwIfAborted();
    const occurredAt = inputDate(input.occurredAt, "occurredAt");
    const endedAt =
      input.endedAt === null ? null : inputDate(input.endedAt, "endedAt");
    if (endedAt !== null && endedAt <= occurredAt) {
      throw new Error("endedAt must be after occurredAt.");
    }
    const allocations = validateAllocations(input.allocations);
    const normalizedInput = {
      ...input,
      occurredAt: occurredAt.toISOString(),
      endedAt: endedAt?.toISOString() ?? null,
      allocations: allocations.map((allocation) => ({ ...allocation })),
    };
    const digest = stableDigest({
      operation: "record_activity",
      ...normalizedInput,
    });
    const contentHash = stableDigest({
      kind: input.kind,
      occurredAt: normalizedInput.occurredAt,
      endedAt: normalizedInput.endedAt,
      taskId: input.taskId,
      projectId: input.projectId,
      summary: input.summary,
      analysisAllowed: input.analysisAllowed,
      allocations: normalizedInput.allocations,
    });
    const activityId = randomUUID();
    const eventId = randomUUID();
    const receiptId = randomUUID();
    const now = new Date();

    const result = await this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "editor", signal);
      const replay = await this.findReplay(
        tx,
        "activities.record",
        input.idempotencyKey,
      );
      if (replay !== null) {
        this.assertReplay(replay, "created", null, digest);
        const activity = decodeActivityReceipt(replay.result);
        return { activity, created: false };
      }
      if (
        !(await this.linksAreValid(
          tx,
          input.taskId,
          input.projectId,
          allocations,
        ))
      ) {
        return null;
      }

      const receiptRows = await tx
        .insert(mutationReceipts)
        .values({
          id: receiptId,
          operation: "activities.record",
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
        })
        .onConflictDoNothing({
          target: [mutationReceipts.operation, mutationReceipts.idempotencyKey],
        })
        .returning({ id: mutationReceipts.id });
      if (receiptRows.length === 0) {
        const concurrentReplay = await this.findReplay(
          tx,
          "activities.record",
          input.idempotencyKey,
        );
        if (concurrentReplay === null)
          throw new Error("The idempotency winner was not found.");
        this.assertReplay(concurrentReplay, "created", null, digest);
        const activity = decodeActivityReceipt(concurrentReplay.result);
        return { activity, created: false };
      }

      await tx.insert(activityEvents).values({
        id: eventId,
        entityType: "activity",
        entityId: activityId,
        action: "created",
        occurredAt,
        effectiveAt: occurredAt,
        changedFields: [
          "kind",
          "occurredAt",
          "endedAt",
          "taskId",
          "projectId",
          "summary",
          "analysisAllowed",
          "allocations",
        ],
        afterVersionId: null,
        contentHash,
        requestDigest: digest,
        analysisAllowed: input.analysisAllowed,
        idempotencyKey: `activities.record:${input.idempotencyKey}`,
        actorKind: access.actor.kind,
        actorAccountId: access.actor.accountId,
        actorClientId: access.actor.clientId,
        actorSource: access.actor.source,
        requestId: access.actor.requestId,
        correlationId: access.actor.correlationId,
        causationId: access.actor.causationId,
        dreamingRunId: access.actor.dreamingRunId,
        recordedAt: now,
      });

      const rows = await tx
        .insert(activities)
        .values({
          id: activityId,
          kind: input.kind,
          occurredAt,
          endedAt,
          timeBasis: endedAt === null ? "instant" : "explicit_interval",
          taskId: input.taskId,
          projectId: input.projectId,
          summary: input.summary,
          analysisAllowed: input.analysisAllowed,
          idempotencyKey: input.idempotencyKey,
          actorKind: access.actor.kind,
          actorAccountId: access.actor.accountId,
          actorClientId: access.actor.clientId,
          actorSource: access.actor.source,
          recordedAt: now,
        })
        .returning();
      const row = rows[0];
      if (row === undefined)
        throw new Error("The activity insert returned no row.");
      if (allocations.length > 0) {
        await tx.insert(activityGoalAllocations).values(
          allocations.map((allocation) => ({
            activityId,
            goalId: allocation.goalId,
            allocationPercent: allocation.allocationPercent,
          })),
        );
      }
      const resultActivity = decodeActivity(row, allocations);
      await tx
        .update(mutationReceipts)
        .set({
          resultEntityType: "activity",
          resultEntityId: activityId,
          result: { activity: resultActivity },
          activityEventId: eventId,
        })
        .where(and(eq(mutationReceipts.id, receiptId)));
      return { activity: resultActivity, created: true };
    });
    signal.throwIfAborted();
    return result;
  }

  async retractActivity(
    access: BrainAccessContext,
    id: string,
    input: Parameters<ActivityStore["retractActivity"]>[2],
    signal: AbortSignal,
  ): Promise<Activity | null> {
    signal.throwIfAborted();
    const digest = stableDigest({
      operation: "retract_activity",
      id,
      ...input,
    });
    const contentHash = stableDigest({
      activityId: id,
      retracted: true,
      reason: input.reason,
    });
    const eventId = randomUUID();
    const now = new Date();
    const result = await this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "editor", signal);
      const replay = await this.findReplay(
        tx,
        "activities.retract",
        input.idempotencyKey,
      );
      if (replay !== null) {
        this.assertReplay(replay, "retracted", id, digest);
        return decodeActivityReceipt(replay.result);
      }
      const currentRows = await tx
        .select()
        .from(activities)
        .where(eq(activities.id, id))
        .limit(1)
        .for("update");
      const current = currentRows[0];
      const lockedReplay = await this.findReplay(
        tx,
        "activities.retract",
        input.idempotencyKey,
      );
      if (lockedReplay !== null) {
        this.assertReplay(lockedReplay, "retracted", id, digest);
        return decodeActivityReceipt(lockedReplay.result);
      }
      if (current === undefined) return null;
      if (current.retractedAt !== null) {
        if (current.retractionReason !== input.reason) {
          throw new ActivityStoreConflictError(
            "The activity was already retracted with a different reason.",
          );
        }
        const receiptId = randomUUID();
        const resultActivity = decodeActivity(
          current,
          await this.loadAllocations(tx, [id]).then(
            (items) => items.get(id) ?? [],
          ),
        );
        await tx.insert(mutationReceipts).values({
          id: receiptId,
          operation: "activities.retract",
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
          resultEntityType: "activity",
          resultEntityId: id,
          result: { activity: resultActivity },
        });
        return resultActivity;
      }

      const receiptId = randomUUID();
      const receiptRows = await tx
        .insert(mutationReceipts)
        .values({
          id: receiptId,
          operation: "activities.retract",
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
        })
        .onConflictDoNothing({
          target: [mutationReceipts.operation, mutationReceipts.idempotencyKey],
        })
        .returning({ id: mutationReceipts.id });
      if (receiptRows.length === 0) {
        const concurrentReplay = await this.findReplay(
          tx,
          "activities.retract",
          input.idempotencyKey,
        );
        if (concurrentReplay === null)
          throw new Error("The idempotency winner was not found.");
        this.assertReplay(concurrentReplay, "retracted", id, digest);
        return decodeActivityReceipt(concurrentReplay.result);
      }
      await tx.insert(activityEvents).values({
        id: eventId,
        entityType: "activity",
        entityId: id,
        action: "retracted",
        occurredAt: now,
        effectiveAt: now,
        changedFields: ["retractedAt", "retractionReason"],
        afterVersionId: null,
        contentHash,
        requestDigest: digest,
        analysisAllowed: current.analysisAllowed,
        idempotencyKey: `activities.retract:${input.idempotencyKey}`,
        actorKind: access.actor.kind,
        actorAccountId: access.actor.accountId,
        actorClientId: access.actor.clientId,
        actorSource: access.actor.source,
        requestId: access.actor.requestId,
        correlationId: access.actor.correlationId,
        causationId: access.actor.causationId,
        dreamingRunId: access.actor.dreamingRunId,
        recordedAt: now,
      });
      const rows = await tx
        .update(activities)
        .set({ retractedAt: now, retractionReason: input.reason })
        .where(and(eq(activities.id, id), isNull(activities.retractedAt)))
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error("The locked activity could not be retracted.");
      }
      const allocations = await this.loadAllocations(tx, [id]);
      const resultActivity = decodeActivity(row, allocations.get(id) ?? []);
      await tx
        .update(mutationReceipts)
        .set({
          resultEntityType: "activity",
          resultEntityId: id,
          result: { activity: resultActivity },
          activityEventId: eventId,
        })
        .where(and(eq(mutationReceipts.id, receiptId)));
      return resultActivity;
    });
    signal.throwIfAborted();
    return result;
  }

  async listActivities(
    access: BrainAccessContext,
    input: Parameters<ActivityStore["listActivities"]>[1],
    signal: AbortSignal,
  ): ReturnType<ActivityStore["listActivities"]> {
    signal.throwIfAborted();
    const from = inputDate(input.from, "from");
    const to = inputDate(input.to, "to");
    if (to <= from) throw new Error("to must be after from.");
    const cursor =
      input.cursor === null ? null : inputDate(input.cursor.ts, "cursor.ts");
    const result = await this.database.transaction(
      async (tx) => {
        await authorizeBrainTransaction(tx, access, "viewer", signal);
        const goalFilter =
          input.goalId === null
            ? undefined
            : exists(
                tx
                  .select({ activityId: activityGoalAllocations.activityId })
                  .from(activityGoalAllocations)
                  .where(
                    and(
                      eq(activityGoalAllocations.activityId, activities.id),
                      eq(activityGoalAllocations.goalId, input.goalId),
                    ),
                  ),
              );
        const rows = await tx
          .select()
          .from(activities)
          .where(
            and(
              lt(activities.occurredAt, to),
              or(
                and(
                  isNull(activities.endedAt),
                  gte(activities.occurredAt, from),
                ),
                gt(activities.endedAt, from),
              ),
              input.kinds.length === 0
                ? undefined
                : inArray(activities.kind, input.kinds),
              input.projectId === null
                ? undefined
                : eq(activities.projectId, input.projectId),
              input.includeRetracted
                ? undefined
                : isNull(activities.retractedAt),
              goalFilter,
              cursor === null
                ? undefined
                : or(
                    lt(activities.occurredAt, cursor),
                    and(
                      eq(activities.occurredAt, cursor),
                      lt(activities.id, input.cursor!.id),
                    ),
                  ),
            ),
          )
          .orderBy(desc(activities.occurredAt), desc(activities.id))
          .limit(input.limit + 1);
        const pageRows = rows.slice(0, input.limit);
        const allocations = await this.loadAllocations(
          tx,
          pageRows.map((row) => row.id),
        );
        const originCreatedAt = await this.earliestAccountCreatedAt(tx);
        signal.throwIfAborted();
        const tail = rows.length > input.limit ? pageRows.at(-1) : undefined;
        return {
          items: pageRows.map((row) =>
            decodeActivity(row, allocations.get(row.id) ?? []),
          ),
          nextCursor:
            tail === undefined
              ? null
              : {
                  ts: decodeDate(tail.occurredAt, "activity cursor"),
                  id: tail.id,
                },
          coverage: temporalCoverage(originCreatedAt, null, []),
        };
      },
      { isolationLevel: "repeatable read" },
    );
    signal.throwIfAborted();
    return result;
  }

  async summarizeActivities(
    access: BrainAccessContext,
    input: Parameters<ActivityStore["summarizeActivities"]>[1],
    signal: AbortSignal,
  ): Promise<ActivitySummary> {
    signal.throwIfAborted();
    const from = inputDate(input.from, "from");
    const to = inputDate(input.to, "to");
    if (to <= from) throw new Error("to must be after from.");
    if (to.valueOf() - from.valueOf() > maximumSummaryRangeMilliseconds) {
      throw new Error("Activity summaries may cover at most 366 days.");
    }
    this.validateTimeZone(input.timeZone);

    const result = await this.database.transaction(
      async (tx) => {
        await authorizeBrainTransaction(tx, access, "viewer", signal);
        const eventRows = await tx
          .select({
            id: activityEvents.id,
            entityType: activityEvents.entityType,
            entityId: activityEvents.entityId,
            action: activityEvents.action,
            effectiveAt: activityEvents.effectiveAt,
            afterVersionId: activityEvents.afterVersionId,
          })
          .from(activityEvents)
          .where(
            and(
              gte(activityEvents.occurredAt, from),
              lt(activityEvents.occurredAt, to),
              eq(activityEvents.analysisAllowed, true),
              isNull(activityEvents.redactedAt),
            ),
          )
          .orderBy(activityEvents.occurredAt, activityEvents.id)
          .limit(maximumSummaryEvents + 1);
        if (eventRows.length > maximumSummaryEvents) {
          throw new Error("The activity summary event limit was exceeded.");
        }
        const completionEvents = eventRows.filter(
          (event) =>
            event.entityType === "task" &&
            event.action === "completed" &&
            event.afterVersionId !== null,
        );
        const completionVersions =
          completionEvents.length === 0
            ? []
            : await tx
                .select({
                  id: taskVersions.id,
                  taskId: taskVersions.taskId,
                  projectId: taskVersions.projectId,
                  effectiveAt: taskVersions.effectiveAt,
                  activityEventId: taskVersions.activityEventId,
                })
                .from(taskVersions)
                .where(
                  and(
                    inArray(
                      taskVersions.id,
                      completionEvents.map((event) => event.afterVersionId!),
                    ),
                  ),
                );
        const completionLinks =
          completionVersions.length === 0
            ? []
            : await tx
                .select({
                  versionId: taskVersionGoalLinks.taskVersionId,
                  goalId: taskVersionGoalLinks.goalId,
                })
                .from(taskVersionGoalLinks)
                .where(
                  and(
                    inArray(
                      taskVersionGoalLinks.taskVersionId,
                      completionVersions.map((version) => version.id),
                    ),
                  ),
                );
        const completionVersionsById = new Map(
          completionVersions.map((version) => [version.id, version] as const),
        );
        if (
          completionVersions.length !== completionEvents.length ||
          completionEvents.some((event) => {
            const version = completionVersionsById.get(event.afterVersionId!);
            return (
              version === undefined ||
              version.taskId !== event.entityId ||
              version.activityEventId !== event.id
            );
          })
        ) {
          throw new Error(
            "A completed task event did not resolve to one task version.",
          );
        }
        const prioritySnapshots = await this.loadPrioritySnapshots(tx, to);
        const linksByVersion = new Map<string, string[]>();
        for (const link of completionLinks) {
          const links = linksByVersion.get(link.versionId) ?? [];
          links.push(link.goalId);
          linksByVersion.set(link.versionId, links);
        }
        let linkedCount = 0;
        let unlinkedCount = 0;
        let alignedLinkedCount = 0;
        for (const version of completionVersions) {
          const linkedGoals = linksByVersion.get(version.id) ?? [];
          if (linkedGoals.length === 0) {
            unlinkedCount += 1;
            continue;
          }
          linkedCount += 1;
          const priorityGoals = this.priorityGoalsAt(
            prioritySnapshots,
            version.effectiveAt.valueOf(),
            version.projectId,
          );
          if (linkedGoals.some((goalId) => priorityGoals.has(goalId))) {
            alignedLinkedCount += 1;
          }
        }

        const intervalRows = await tx
          .select()
          .from(activities)
          .where(
            and(
              eq(activities.kind, "work_session"),
              eq(activities.timeBasis, "explicit_interval"),
              eq(activities.analysisAllowed, true),
              isNull(activities.retractedAt),
              lt(activities.occurredAt, to),
              gt(activities.endedAt, from),
            ),
          )
          .orderBy(activities.occurredAt, activities.id)
          .limit(maximumSummaryIntervals + 1);
        if (intervalRows.length > maximumSummaryIntervals) {
          throw new Error("The activity summary interval limit was exceeded.");
        }
        const intervalAllocations = await this.loadAllocations(
          tx,
          intervalRows.map((row) => row.id),
        );
        let rawRecordedMinutes = 0;
        let overlappingMinutes = 0;
        let allocatedMinutes = 0;
        let priorityAllocatedMinutes = 0;
        for (const interval of intervalRows) {
          if (interval.endedAt === null) {
            throw new Error(
              "The database returned an interval without endedAt.",
            );
          }
          const start = interval.occurredAt.valueOf();
          const end = interval.endedAt.valueOf();
          const clippedStart = Math.max(start, from.valueOf());
          const clippedEnd = Math.min(end, to.valueOf());
          const overlapMinutes =
            (clippedEnd - clippedStart) / minuteMilliseconds;
          rawRecordedMinutes += (end - start) / minuteMilliseconds;
          overlappingMinutes += overlapMinutes;
          const allocations = intervalAllocations.get(interval.id) ?? [];
          allocatedMinutes +=
            overlapMinutes *
            (allocations.reduce(
              (sum, allocation) => sum + allocation.allocationPercent,
              0,
            ) /
              100);
          for (const allocation of allocations) {
            priorityAllocatedMinutes +=
              (this.priorityMillisecondsForGoal(
                prioritySnapshots,
                allocation.goalId,
                interval.projectId,
                clippedStart,
                clippedEnd,
              ) /
                minuteMilliseconds) *
              (allocation.allocationPercent / 100);
          }
        }

        const overdueTasks = await this.overdueTasksAt(tx, to);
        const pastDueReminders = await this.pastDueRemindersAt(tx, to);
        const excludedEvents = await tx
          .select({ id: activityEvents.id })
          .from(activityEvents)
          .where(
            and(
              gte(activityEvents.occurredAt, from),
              lt(activityEvents.occurredAt, to),
              or(
                eq(activityEvents.analysisAllowed, false),
                lt(activityEvents.redactedAt, to),
              ),
            ),
          )
          .limit(1);
        const excludedActivities = await tx
          .select({ id: activities.id })
          .from(activities)
          .where(
            and(
              lt(activities.occurredAt, to),
              or(
                and(
                  isNull(activities.endedAt),
                  gte(activities.occurredAt, from),
                ),
                gt(activities.endedAt, from),
              ),
              eq(activities.analysisAllowed, false),
            ),
          )
          .limit(1);
        const originCreatedAt = await this.earliestAccountCreatedAt(tx);
        const sourceEventIds = eventRows.map((event) => event.id).sort();
        const sourceActivityIds = intervalRows
          .map((activity) => activity.id)
          .sort();
        const warnings = [
          "Recorded interval metrics include only explicit work sessions; no time is inferred from entity events.",
          ...(excludedEvents.length === 0 && excludedActivities.length === 0
            ? []
            : [
                "Records excluded from analysis are not represented in this summary.",
              ]),
          ...(unlinkedCount === 0
            ? []
            : [
                "Some completed tasks had no explicit goal link and were excluded from the alignment rate.",
              ]),
        ];
        const coverage = await this.summaryCoverage(
          tx,
          originCreatedAt,
          from,
          input.to,
          warnings,
        );
        const provenanceHash = stableDigest({
          from: from.toISOString(),
          to: to.toISOString(),
          timeZone: input.timeZone,
          sourceEventIds,
          sourceActivityIds,
          completionTaskVersionIds: completionVersions
            .map((version) => version.id)
            .sort(),
          priorityVersionIds: prioritySnapshots
            .map((version) => version.id)
            .sort(),
          overdueTaskVersionIds: overdueTasks.versionIds,
          pastDueReminderVersionIds: pastDueReminders.versionIds,
          excludedAnalysisRecords:
            excludedEvents.length > 0 || excludedActivities.length > 0,
          coverage,
        });
        signal.throwIfAborted();
        return {
          from: from.toISOString(),
          to: to.toISOString(),
          timeZone: input.timeZone,
          tasksCreated: this.countEvents(eventRows, "task", "created"),
          tasksStarted: this.countEvents(eventRows, "task", "started"),
          tasksCompleted: this.countEvents(eventRows, "task", "completed"),
          tasksReopened: this.countEvents(eventRows, "task", "reopened"),
          tasksCanceled: this.countEvents(eventRows, "task", "canceled"),
          remindersScheduled: this.countEvents(
            eventRows,
            "reminder",
            "created",
          ),
          remindersCompleted: this.countEvents(
            eventRows,
            "reminder",
            "completed",
          ),
          overdueTasksAtEnd: overdueTasks.count,
          pendingPastDueRemindersAtEnd: pastDueReminders.count,
          completedTasks: {
            linkedCount,
            unlinkedCount,
            alignedLinkedCount,
            nonPriorityLinkedCount: linkedCount - alignedLinkedCount,
            rateAmongLinked:
              linkedCount === 0
                ? null
                : rounded(alignedLinkedCount / linkedCount),
          },
          recordedIntervals: {
            sessionCount: intervalRows.length,
            rawRecordedMinutes: rounded(rawRecordedMinutes),
            overlappingMinutes: rounded(overlappingMinutes),
            allocatedMinutes: rounded(allocatedMinutes),
            priorityAllocatedMinutes: rounded(priorityAllocatedMinutes),
            rateAmongAllocated:
              allocatedMinutes === 0
                ? null
                : rounded(priorityAllocatedMinutes / allocatedMinutes),
          },
          sourceEventIds,
          sourceActivityIds,
          provenanceHash,
          coverage,
        } satisfies ActivitySummary;
      },
      { isolationLevel: "repeatable read" },
    );
    signal.throwIfAborted();
    return result;
  }

  private validateTimeZone(value: string): void {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    } catch {
      throw new Error("timeZone must be a valid IANA time zone.");
    }
  }

  private countEvents(
    rows: readonly { readonly entityType: string; readonly action: string }[],
    entityType: string,
    action: string,
  ): number {
    return rows.filter(
      (row) => row.entityType === entityType && row.action === action,
    ).length;
  }

  private async linksAreValid(
    tx: SecondBrainTransaction,
    taskId: string | null,
    projectId: string | null,
    allocations: readonly ActivityGoalAllocation[],
  ): Promise<boolean> {
    if (projectId !== null) {
      const projectRows = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (projectRows.length !== 1) return false;
    }
    if (taskId !== null) {
      const taskRows = await tx
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1);
      const task = taskRows[0];
      if (task === undefined) return false;
      if (
        projectId !== null &&
        task.projectId !== null &&
        projectId !== task.projectId
      ) {
        return false;
      }
    }
    if (allocations.length > 0) {
      const goalRows = await tx
        .select({ id: goals.id })
        .from(goals)
        .where(
          and(
            inArray(
              goals.id,
              allocations.map((allocation) => allocation.goalId),
            ),
          ),
        );
      if (goalRows.length !== allocations.length) return false;
    }
    return true;
  }

  private async findReplay(
    tx: SecondBrainTransaction,
    operation: "activities.record" | "activities.retract",
    idempotencyKey: string,
  ) {
    const rows = await tx
      .select({
        entityId: mutationReceipts.resultEntityId,
        entityType: mutationReceipts.resultEntityType,
        requestDigest: mutationReceipts.requestDigest,
        result: mutationReceipts.result,
      })
      .from(mutationReceipts)
      .where(
        and(
          eq(mutationReceipts.operation, operation),
          eq(mutationReceipts.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private assertReplay(
    row: {
      readonly entityId: string | null;
      readonly entityType: string | null;
      readonly requestDigest: string;
      readonly result: unknown;
    },
    action: "created" | "retracted",
    id: string | null,
    digest: string,
  ): void {
    if (
      row.entityType !== "activity" ||
      (id !== null && row.entityId !== id) ||
      row.requestDigest !== digest
    ) {
      throw new ActivityStoreConflictError(
        "The idempotency key was already used for a different activity mutation.",
      );
    }
  }

  private async loadAllocations(
    tx: SecondBrainTransaction,
    activityIds: readonly string[],
  ): Promise<Map<string, ActivityGoalAllocation[]>> {
    const result = new Map<string, ActivityGoalAllocation[]>();
    if (activityIds.length === 0) return result;
    const rows = await tx
      .select({
        activityId: activityGoalAllocations.activityId,
        goalId: activityGoalAllocations.goalId,
        allocationPercent: activityGoalAllocations.allocationPercent,
      })
      .from(activityGoalAllocations)
      .where(and(inArray(activityGoalAllocations.activityId, activityIds)))
      .orderBy(
        activityGoalAllocations.activityId,
        activityGoalAllocations.goalId,
      );
    for (const row of rows) {
      const items = result.get(row.activityId) ?? [];
      items.push({
        goalId: row.goalId,
        allocationPercent: row.allocationPercent,
      });
      result.set(row.activityId, items);
    }
    return result;
  }

  private async earliestAccountCreatedAt(
    tx: SecondBrainTransaction,
  ): Promise<Date> {
    const rows = await tx
      .select({ createdAt: sql<Date | null>`min(${accounts.createdAt})` })
      .from(accounts)
      .limit(1);
    const createdAt = rows[0]?.createdAt;
    if (createdAt === undefined || createdAt === null) {
      throw new Error("The authorized account was not found.");
    }
    return createdAt;
  }

  private async summaryCoverage(
    tx: SecondBrainTransaction,
    originCreatedAt: Date,
    from: Date,
    requestedAsOf: string,
    warnings: readonly string[],
  ): Promise<TemporalCoverage> {
    const taskRows = await tx
      .select({
        historyCompleteFrom: tasks.historyCompleteFrom,
      })
      .from(tasks)
      .where(and(gt(tasks.historyCompleteFrom, tasks.createdAt)))
      .orderBy(desc(tasks.historyCompleteFrom))
      .limit(1);
    const reminderRows = await tx
      .select({
        historyCompleteFrom: reminders.historyCompleteFrom,
      })
      .from(reminders)
      .where(and(gt(reminders.historyCompleteFrom, reminders.createdAt)))
      .orderBy(desc(reminders.historyCompleteFrom))
      .limit(1);
    let boundary = originCreatedAt;
    for (const row of [...taskRows, ...reminderRows]) {
      if (row.historyCompleteFrom > boundary)
        boundary = row.historyCompleteFrom;
    }
    const hasGap = taskRows.length > 0 || reminderRows.length > 0;
    const complete = !hasGap || from >= boundary;
    return {
      completeFrom: decodeDate(boundary, "activity coverage boundary"),
      requestedAsOf,
      complete,
      warnings: [
        ...warnings,
        ...(complete
          ? []
          : [
              "Task or reminder history is incomplete before the reported coverage boundary.",
            ]),
      ],
    };
  }

  private async loadPrioritySnapshots(
    tx: SecondBrainTransaction,
    before: Date,
  ): Promise<readonly PriorityVersionSnapshot[]> {
    const versions = await tx
      .select()
      .from(priorityPlanVersions)
      .where(and(lte(priorityPlanVersions.effectiveAt, before)))
      .orderBy(
        priorityPlanVersions.priorityPlanId,
        priorityPlanVersions.versionNumber,
      )
      .limit(maximumPriorityVersions + 1);
    if (versions.length > maximumPriorityVersions) {
      throw new Error(
        "The activity summary priority-version limit was exceeded.",
      );
    }
    if (versions.length === 0) return [];
    const itemRows = await tx
      .select({
        versionId: priorityPlanVersionItems.priorityPlanVersionId,
        goalId: priorityPlanVersionItems.goalId,
        rank: priorityPlanVersionItems.rank,
        intendedSharePercent: priorityPlanVersionItems.intendedSharePercent,
      })
      .from(priorityPlanVersionItems)
      .where(
        and(
          inArray(
            priorityPlanVersionItems.priorityPlanVersionId,
            versions.map((version) => version.id),
          ),
        ),
      );
    const items = new Map<string, PriorityPlanItem[]>();
    for (const row of itemRows) {
      const existing = items.get(row.versionId) ?? [];
      existing.push({
        goalId: row.goalId,
        rank: row.rank,
        intendedSharePercent: row.intendedSharePercent,
      });
      items.set(row.versionId, existing);
    }
    return versions.map((version) => ({
      id: version.id,
      priorityPlanId: version.priorityPlanId,
      version: version.versionNumber,
      projectId: version.projectId,
      periodStart: version.periodStart.valueOf(),
      periodEnd: version.periodEnd.valueOf(),
      effectiveAt: version.effectiveAt.valueOf(),
      items: (items.get(version.id) ?? []).sort(
        (left, right) => left.rank - right.rank,
      ),
    }));
  }

  private priorityGoalsAt(
    snapshots: readonly PriorityVersionSnapshot[],
    instant: number,
    projectId: string | null,
  ): ReadonlySet<string> {
    const latest = new Map<string, PriorityVersionSnapshot>();
    for (const snapshot of snapshots) {
      if (snapshot.effectiveAt > instant) continue;
      const current = latest.get(snapshot.priorityPlanId);
      if (current === undefined || snapshot.version > current.version) {
        latest.set(snapshot.priorityPlanId, snapshot);
      }
    }
    const result = new Set<string>();
    for (const snapshot of latest.values()) {
      const relevant =
        snapshot.projectId === null || snapshot.projectId === projectId;
      if (
        relevant &&
        snapshot.periodStart <= instant &&
        snapshot.periodEnd > instant
      ) {
        for (const item of snapshot.items) result.add(item.goalId);
      }
    }
    return result;
  }

  private priorityMillisecondsForGoal(
    snapshots: readonly PriorityVersionSnapshot[],
    goalId: string,
    projectId: string | null,
    start: number,
    end: number,
  ): number {
    if (end <= start) return 0;
    const breakpoints = new Set<number>([start, end]);
    for (const snapshot of snapshots) {
      for (const point of [
        snapshot.effectiveAt,
        snapshot.periodStart,
        snapshot.periodEnd,
      ]) {
        if (point > start && point < end) breakpoints.add(point);
      }
    }
    const ordered = [...breakpoints].sort((left, right) => left - right);
    let total = 0;
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const segmentStart = ordered[index]!;
      const segmentEnd = ordered[index + 1]!;
      const midpoint = segmentStart + (segmentEnd - segmentStart) / 2;
      if (this.priorityGoalsAt(snapshots, midpoint, projectId).has(goalId)) {
        total += segmentEnd - segmentStart;
      }
    }
    return total;
  }

  private async overdueTasksAt(
    tx: SecondBrainTransaction,
    at: Date,
  ): Promise<{
    readonly count: number;
    readonly versionIds: readonly string[];
  }> {
    const snapshots = tx
      .selectDistinctOn([taskVersions.taskId], {
        versionId: taskVersions.id,
        taskId: taskVersions.taskId,
        status: taskVersions.status,
        dueAt: taskVersions.dueAt,
      })
      .from(taskVersions)
      .where(and(lte(taskVersions.effectiveAt, at)))
      .orderBy(
        taskVersions.taskId,
        desc(taskVersions.effectiveAt),
        desc(taskVersions.versionNumber),
      )
      .as("task_state_at_summary_end");
    const rows = await tx
      .select({ versionId: snapshots.versionId })
      .from(snapshots)
      .where(
        and(
          inArray(snapshots.status, ["todo", "in_progress"]),
          lt(snapshots.dueAt, at),
        ),
      )
      .orderBy(snapshots.versionId)
      .limit(maximumSummaryStateVersions + 1);
    if (rows.length > maximumSummaryStateVersions) {
      throw new Error("The activity summary overdue-task limit was exceeded.");
    }
    return { count: rows.length, versionIds: rows.map((row) => row.versionId) };
  }

  private async pastDueRemindersAt(
    tx: SecondBrainTransaction,
    at: Date,
  ): Promise<{
    readonly count: number;
    readonly versionIds: readonly string[];
  }> {
    const snapshots = tx
      .selectDistinctOn([reminderVersions.reminderId], {
        versionId: reminderVersions.id,
        reminderId: reminderVersions.reminderId,
        remindAt: reminderVersions.remindAt,
        completedAt: reminderVersions.completedAt,
      })
      .from(reminderVersions)
      .where(and(lte(reminderVersions.effectiveAt, at)))
      .orderBy(
        reminderVersions.reminderId,
        desc(reminderVersions.effectiveAt),
        desc(reminderVersions.versionNumber),
      )
      .as("reminder_state_at_summary_end");
    const rows = await tx
      .select({ versionId: snapshots.versionId })
      .from(snapshots)
      .where(and(isNull(snapshots.completedAt), lt(snapshots.remindAt, at)))
      .orderBy(snapshots.versionId)
      .limit(maximumSummaryStateVersions + 1);
    if (rows.length > maximumSummaryStateVersions) {
      throw new Error(
        "The activity summary past-due reminder limit was exceeded.",
      );
    }
    return { count: rows.length, versionIds: rows.map((row) => row.versionId) };
  }
}
