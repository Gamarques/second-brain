import { createHash, randomUUID } from "node:crypto";

import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import { mutationSources } from "../../domain.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  CursorPosition,
  MutationSource,
  PriorityPlan,
  PriorityPlanItem,
  PriorityPlanStore,
  TemporalCoverage,
} from "../../domain.js";
import { projects } from "../schema/content.js";
import { accounts } from "../schema/identity.js";
import {
  activityEvents,
  goals,
  mutationReceipts,
  priorityPlans,
  priorityPlanVersionItems,
  priorityPlanVersions,
} from "../schema/temporal.js";

import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";
import { authorizeBrainTransaction } from "./authorization.js";

export type PriorityDatabase = SecondBrainDatabase;

export class PriorityStoreConflictError extends Error {
  readonly code = "PRIORITY_STORE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "PriorityStoreConflictError";
  }
}

const mutationSourceSet = new Set<string>(mutationSources);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function decodeUuid(value: string, field: string): string {
  if (!uuidPattern.test(value))
    throw new Error(`The database returned an invalid ${field}.`);
  return value;
}

function decodeNullableText(
  value: string | null,
  field: string,
): string | null {
  if (value !== null && value.length > 10_000) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
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

function validateItems(
  items: readonly PriorityPlanItem[],
): readonly PriorityPlanItem[] {
  if (items.length === 0 || items.length > 20) {
    throw new Error(
      "A priority plan must contain between one and twenty items.",
    );
  }
  const sorted = [...items]
    .map((item) => ({
      ...item,
      goalId: decodeUuid(item.goalId, "priority goal ID"),
    }))
    .sort((left, right) => left.rank - right.rank);
  if (
    new Set(sorted.map((item) => item.goalId)).size !== sorted.length ||
    sorted.some((item, index) => item.rank !== index + 1)
  ) {
    throw new Error("Priority ranks must be unique and contiguous from one.");
  }
  let share = 0;
  const specifiedShares = sorted.filter(
    (item) => item.intendedSharePercent !== null,
  ).length;
  for (const item of sorted) {
    if (
      item.intendedSharePercent !== null &&
      (!Number.isFinite(item.intendedSharePercent) ||
        item.intendedSharePercent <= 0 ||
        item.intendedSharePercent > 100 ||
        Math.abs(
          item.intendedSharePercent * 100 -
            Math.round(item.intendedSharePercent * 100),
        ) > 0.000_001)
    ) {
      throw new Error(
        "Priority shares must be greater than zero and at most one hundred.",
      );
    }
    share += item.intendedSharePercent ?? 0;
  }
  if (
    specifiedShares !== 0 &&
    (specifiedShares !== sorted.length || Math.abs(share - 100) > 0.000_001)
  ) {
    throw new Error(
      "Priority shares must either all be omitted or all be specified and total one hundred.",
    );
  }
  return sorted;
}

function hasPostgresCode(error: unknown, code: string): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null) {
    if (seen.has(current)) return false;
    seen.add(current);
    const record = current as Error & { code?: unknown; cause?: unknown };
    if (record.code === code) return true;
    current = record.cause;
  }
  return false;
}

interface PlanWithItemsRow {
  readonly id: string;
  readonly projectId: string | null;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly version: number;
  readonly currentVersionId: string;
  readonly note: string | null;
  readonly actorKind:
    "account" | "oauth_client" | "import" | "dreaming" | "system";
  readonly actorAccountId: string | null;
  readonly actorClientId: string | null;
  readonly actorSource: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function decodePlan(
  row: PlanWithItemsRow,
  items: readonly PriorityPlanItem[],
): PriorityPlan {
  if (!Number.isInteger(row.version) || row.version < 1) {
    throw new Error("The database returned an invalid priority plan version.");
  }
  const decodedItems = validateItems(items).map((item) => ({ ...item }));
  decodeUuid(row.id, "priority plan ID");
  decodeUuid(row.currentVersionId, "priority plan current version ID");
  if (row.projectId !== null)
    decodeUuid(row.projectId, "priority plan project ID");
  if (row.periodEnd <= row.periodStart) {
    throw new Error("The database returned an invalid priority plan period.");
  }
  return {
    id: row.id,
    projectId: row.projectId,
    periodStart: decodeDate(row.periodStart, "priority plan periodStart"),
    periodEnd: decodeDate(row.periodEnd, "priority plan periodEnd"),
    version: row.version,
    currentVersionId: row.currentVersionId,
    items: decodedItems,
    note: decodeNullableText(row.note, "priority plan note"),
    provenance: decodeActor(row),
    createdAt: decodeDate(row.createdAt, "priority plan createdAt"),
    updatedAt: decodeDate(row.updatedAt, "priority plan updatedAt"),
  };
}

export class DrizzlePriorityPlanStore implements PriorityPlanStore {
  constructor(private readonly database: PriorityDatabase) {}

  async createPriorityPlan(
    access: BrainAccessContext,
    input: Parameters<PriorityPlanStore["createPriorityPlan"]>[1],
    signal: AbortSignal,
  ): Promise<PriorityPlan | null> {
    signal.throwIfAborted();
    const items = validateItems(input.items);
    const periodStart = inputDate(input.periodStart, "periodStart");
    const periodEnd = inputDate(input.periodEnd, "periodEnd");
    if (periodEnd <= periodStart)
      throw new Error("periodEnd must be after periodStart.");
    const normalizedInput = {
      ...input,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      items: items.map((item) => ({ ...item })),
    };
    const digest = stableDigest({
      operation: "create_priority_plan",
      ...normalizedInput,
    });
    const contentHash = stableDigest({
      projectId: input.projectId,
      periodStart: normalizedInput.periodStart,
      periodEnd: normalizedInput.periodEnd,
      items: normalizedInput.items,
      note: input.note,
    });
    const now = new Date();
    const planId = randomUUID();
    const versionId = randomUUID();
    const eventId = randomUUID();
    const receiptId = randomUUID();

    try {
      const result = await this.mutateWithDeadlockRetry(signal, async (tx) => {
        await authorizeBrainTransaction(tx, access, "editor", signal);
        const replay = await this.findReplay(
          tx,
          "priorities.create",
          input.idempotencyKey,
        );
        if (replay !== null) {
          if (
            replay.entityId === null ||
            replay.versionId === null ||
            replay.activityEventId === null
          ) {
            throw new Error("The idempotent priority receipt is incomplete.");
          }
          this.assertReplay(replay, replay.entityId, digest);
          return this.loadPlanVersion(tx, {
            planId: replay.entityId,
            versionId: replay.versionId,
            activityEventId: replay.activityEventId,
            requestDigest: digest,
            action: "created",
          });
        }
        if (
          await this.hasOverlap(
            tx,
            input.projectId,
            periodStart,
            periodEnd,
            null,
          )
        ) {
          return null;
        }
        if (!(await this.linksAreValid(tx, input.projectId, items))) {
          return null;
        }
        const receiptRows = await tx
          .insert(mutationReceipts)
          .values({
            id: receiptId,
            operation: "priorities.create",
            idempotencyKey: input.idempotencyKey,
            requestDigest: digest,
          })
          .onConflictDoNothing({
            target: [
              mutationReceipts.operation,
              mutationReceipts.idempotencyKey,
            ],
          })
          .returning({ id: mutationReceipts.id });
        if (receiptRows.length === 0) {
          return this.replayCreate(tx, input.idempotencyKey, digest);
        }

        await tx.insert(activityEvents).values({
          id: eventId,
          entityType: "priority_plan",
          entityId: planId,
          action: "created",
          occurredAt: now,
          effectiveAt: now,
          changedFields: [
            "projectId",
            "periodStart",
            "periodEnd",
            "items",
            "note",
          ],
          afterVersionId: versionId,
          contentHash,
          requestDigest: digest,
          analysisAllowed: true,
          idempotencyKey: `priorities.create:${input.idempotencyKey}`,
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

        const planRows = await tx
          .insert(priorityPlans)
          .values({
            id: planId,
            projectId: input.projectId,
            periodStart,
            periodEnd,
            version: 1,
            currentVersionId: versionId,
            actorKind: access.actor.kind,
            actorAccountId: access.actor.accountId,
            actorClientId: access.actor.clientId,
            actorSource: access.actor.source,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const row = planRows[0];
        if (row === undefined)
          throw new Error("The priority plan insert returned no row.");
        await tx.insert(priorityPlanVersions).values({
          id: versionId,
          priorityPlanId: planId,
          versionNumber: 1,
          projectId: input.projectId,
          periodStart,
          periodEnd,
          note: input.note,
          effectiveAt: now,
          recordedAt: now,
          actorKind: access.actor.kind,
          actorAccountId: access.actor.accountId,
          actorClientId: access.actor.clientId,
          actorSource: access.actor.source,
          activityEventId: eventId,
        });
        await tx.insert(priorityPlanVersionItems).values(
          items.map((item) => ({
            priorityPlanVersionId: versionId,
            goalId: item.goalId,
            rank: item.rank,
            intendedSharePercent: item.intendedSharePercent,
          })),
        );
        const resultPlan = await this.loadPlanVersion(tx, {
          planId,
          versionId,
          activityEventId: eventId,
          requestDigest: digest,
          action: "created",
        });
        await tx
          .update(mutationReceipts)
          .set({
            resultEntityType: "priority_plan",
            resultEntityId: planId,
            resultVersionId: versionId,
            result: { priorityPlanId: planId, version: 1 },
            activityEventId: eventId,
          })
          .where(and(eq(mutationReceipts.id, receiptId)));
        return resultPlan;
      });
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (hasPostgresCode(error, "23P01")) return null;
      throw error;
    }
  }

  async updatePriorityPlan(
    access: BrainAccessContext,
    id: string,
    changes: Parameters<PriorityPlanStore["updatePriorityPlan"]>[2],
    signal: AbortSignal,
  ): Promise<PriorityPlan | null> {
    signal.throwIfAborted();
    const normalizedItems =
      changes.items === undefined ? undefined : validateItems(changes.items);
    const normalizedChanges = {
      ...changes,
      ...(changes.periodStart === undefined
        ? {}
        : {
            periodStart: inputDate(
              changes.periodStart,
              "periodStart",
            ).toISOString(),
          }),
      ...(changes.periodEnd === undefined
        ? {}
        : {
            periodEnd: inputDate(changes.periodEnd, "periodEnd").toISOString(),
          }),
      ...(normalizedItems === undefined
        ? {}
        : { items: normalizedItems.map((item) => ({ ...item })) }),
    };
    const digest = stableDigest({
      operation: "update_priority_plan",
      id,
      changes: normalizedChanges,
    });
    const now = new Date();
    const versionId = randomUUID();
    const eventId = randomUUID();

    try {
      const result = await this.mutateWithDeadlockRetry(signal, async (tx) => {
        await authorizeBrainTransaction(tx, access, "editor", signal);
        const replay = await this.findReplay(
          tx,
          "priorities.update",
          changes.precondition.idempotencyKey,
        );
        if (replay !== null) {
          this.assertReplay(replay, id, digest);
          if (replay.versionId === null || replay.activityEventId === null)
            throw new Error("The priority receipt is incomplete.");
          return this.loadPlanVersion(tx, {
            planId: id,
            versionId: replay.versionId,
            activityEventId: replay.activityEventId,
            requestDigest: digest,
            action: "updated",
          });
        }
        const currentRows = await tx
          .select()
          .from(priorityPlans)
          .where(and(eq(priorityPlans.id, id)))
          .limit(1)
          .for("update");
        const current = currentRows[0];
        const lockedReplay = await this.findReplay(
          tx,
          "priorities.update",
          changes.precondition.idempotencyKey,
        );
        if (lockedReplay !== null) {
          this.assertReplay(lockedReplay, id, digest);
          if (
            lockedReplay.versionId === null ||
            lockedReplay.activityEventId === null
          )
            throw new Error("The priority receipt is incomplete.");
          return this.loadPlanVersion(tx, {
            planId: id,
            versionId: lockedReplay.versionId,
            activityEventId: lockedReplay.activityEventId,
            requestDigest: digest,
            action: "updated",
          });
        }
        if (
          current === undefined ||
          current.version !== changes.precondition.expectedVersion
        ) {
          return null;
        }
        const currentItems = await this.loadItems(tx, current.currentVersionId);
        const items = normalizedItems ?? currentItems;
        if (!(await this.linksAreValid(tx, current.projectId, items))) {
          return null;
        }
        const periodStart =
          changes.periodStart === undefined
            ? current.periodStart
            : inputDate(changes.periodStart, "periodStart");
        const periodEnd =
          changes.periodEnd === undefined
            ? current.periodEnd
            : inputDate(changes.periodEnd, "periodEnd");
        if (periodEnd <= periodStart)
          throw new Error("periodEnd must be after periodStart.");
        if (
          await this.hasOverlap(
            tx,
            current.projectId,
            periodStart,
            periodEnd,
            current.id,
          )
        ) {
          return null;
        }
        const note =
          changes.note === undefined
            ? await this.loadCurrentNote(tx, current.currentVersionId)
            : changes.note;
        const changedFields = [
          ...(periodStart.valueOf() === current.periodStart.valueOf()
            ? []
            : ["periodStart"]),
          ...(periodEnd.valueOf() === current.periodEnd.valueOf()
            ? []
            : ["periodEnd"]),
          ...(normalizedItems === undefined ? [] : ["items"]),
          ...(changes.note === undefined ? [] : ["note"]),
        ];
        const contentHash = stableDigest({
          projectId: current.projectId,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          items: items.map((item) => ({ ...item })),
          note,
        });

        const receiptId = randomUUID();
        const insertedReceipts = await tx
          .insert(mutationReceipts)
          .values({
            id: receiptId,
            operation: "priorities.update",
            idempotencyKey: changes.precondition.idempotencyKey,
            requestDigest: digest,
          })
          .onConflictDoNothing({
            target: [
              mutationReceipts.operation,
              mutationReceipts.idempotencyKey,
            ],
          })
          .returning({ id: mutationReceipts.id });
        if (insertedReceipts.length === 0) {
          const concurrentReplay = await this.findReplay(
            tx,
            "priorities.update",
            changes.precondition.idempotencyKey,
          );
          if (concurrentReplay === null)
            throw new Error("The idempotency winner was not found.");
          this.assertReplay(concurrentReplay, id, digest);
          if (
            concurrentReplay.versionId === null ||
            concurrentReplay.activityEventId === null
          ) {
            throw new Error("The priority receipt is incomplete.");
          }
          return this.loadPlanVersion(tx, {
            planId: id,
            versionId: concurrentReplay.versionId,
            activityEventId: concurrentReplay.activityEventId,
            requestDigest: digest,
            action: "updated",
          });
        }

        await tx.insert(activityEvents).values({
          id: eventId,
          entityType: "priority_plan",
          entityId: id,
          action: "updated",
          occurredAt: now,
          effectiveAt: now,
          changedFields,
          afterVersionId: versionId,
          contentHash,
          requestDigest: digest,
          analysisAllowed: true,
          idempotencyKey: `priorities.update:${changes.precondition.idempotencyKey}`,
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

        const nextVersion = current.version + 1;
        const updatedRows = await tx
          .update(priorityPlans)
          .set({
            periodStart,
            periodEnd,
            version: nextVersion,
            currentVersionId: versionId,
            actorKind: access.actor.kind,
            actorAccountId: access.actor.accountId,
            actorClientId: access.actor.clientId,
            actorSource: access.actor.source,
            updatedAt: now,
          })
          .where(
            and(
              eq(priorityPlans.id, id),
              eq(priorityPlans.version, current.version),
            ),
          )
          .returning();
        const updated = updatedRows[0];
        if (updated === undefined) {
          throw new Error(
            "The locked priority projection could not be updated.",
          );
        }
        await tx.insert(priorityPlanVersions).values({
          id: versionId,
          priorityPlanId: id,
          versionNumber: nextVersion,
          projectId: current.projectId,
          periodStart,
          periodEnd,
          note,
          effectiveAt: now,
          recordedAt: now,
          actorKind: access.actor.kind,
          actorAccountId: access.actor.accountId,
          actorClientId: access.actor.clientId,
          actorSource: access.actor.source,
          activityEventId: eventId,
        });
        await tx.insert(priorityPlanVersionItems).values(
          items.map((item) => ({
            priorityPlanVersionId: versionId,
            goalId: item.goalId,
            rank: item.rank,
            intendedSharePercent: item.intendedSharePercent,
          })),
        );
        const resultPlan = await this.loadPlanVersion(tx, {
          planId: id,
          versionId,
          activityEventId: eventId,
          requestDigest: digest,
          action: "updated",
        });
        await tx
          .update(mutationReceipts)
          .set({
            resultEntityType: "priority_plan",
            resultEntityId: id,
            resultVersionId: versionId,
            result: { priorityPlanId: id, version: nextVersion },
            activityEventId: eventId,
          })
          .where(and(eq(mutationReceipts.id, receiptId)));
        return resultPlan;
      });
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (hasPostgresCode(error, "23P01")) return null;
      throw error;
    }
  }

  async listPriorityPlans(
    access: BrainAccessContext,
    input: Parameters<PriorityPlanStore["listPriorityPlans"]>[1],
    signal: AbortSignal,
  ): ReturnType<PriorityPlanStore["listPriorityPlans"]> {
    signal.throwIfAborted();
    const result = await this.database.transaction(
      async (tx) => {
        await authorizeBrainTransaction(tx, access, "viewer", signal);
        const activeAt =
          input.activeAt === null
            ? null
            : inputDate(input.activeAt, "activeAt");
        const cursor =
          input.cursor === null
            ? null
            : inputDate(input.cursor.ts, "cursor.ts");
        const rows = await tx
          .select({
            plan: priorityPlans,
            note: priorityPlanVersions.note,
          })
          .from(priorityPlans)
          .innerJoin(
            priorityPlanVersions,
            and(
              eq(priorityPlanVersions.id, priorityPlans.currentVersionId),
              eq(priorityPlanVersions.priorityPlanId, priorityPlans.id),
            ),
          )
          .where(
            and(
              input.projectId === null
                ? undefined
                : eq(priorityPlans.projectId, input.projectId),
              activeAt === null
                ? undefined
                : lte(priorityPlans.periodStart, activeAt),
              activeAt === null
                ? undefined
                : gt(priorityPlans.periodEnd, activeAt),
              cursor === null
                ? undefined
                : or(
                    lt(priorityPlans.createdAt, cursor),
                    and(
                      eq(priorityPlans.createdAt, cursor),
                      lt(priorityPlans.id, input.cursor!.id),
                    ),
                  ),
            ),
          )
          .orderBy(desc(priorityPlans.createdAt), desc(priorityPlans.id))
          .limit(input.limit + 1);
        const pageRows = rows.slice(0, input.limit);
        const itemsByVersion = await this.loadItemsForVersions(
          tx,
          pageRows.map(({ plan }) => plan.currentVersionId),
        );
        signal.throwIfAborted();
        const items = pageRows.map(({ plan, note }) =>
          decodePlan(
            { ...plan, note },
            itemsByVersion.get(plan.currentVersionId) ?? [],
          ),
        );
        const tail =
          rows.length > input.limit ? pageRows.at(-1)?.plan : undefined;
        return {
          items,
          nextCursor:
            tail === undefined
              ? null
              : {
                  ts: decodeDate(tail.createdAt, "priority cursor"),
                  id: tail.id,
                },
          coverage: await this.priorityCoverage(tx),
        };
      },
      { isolationLevel: "repeatable read" },
    );
    signal.throwIfAborted();
    return result;
  }

  private async mutateWithDeadlockRetry<T>(
    signal: AbortSignal,
    mutation: (tx: SecondBrainTransaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await this.database.transaction(mutation);
      } catch (error) {
        // PostgreSQL rolls back the deadlock victim. Replay the whole mutation
        // so authorization, overlap checks, and idempotency use a fresh snapshot.
        if (!hasPostgresCode(error, "40P01") || attempt >= 3) throw error;
      }
    }
  }

  private async hasOverlap(
    database: SecondBrainTransaction,
    projectId: string | null,
    periodStart: Date,
    periodEnd: Date,
    excludingId: string | null,
  ): Promise<boolean> {
    const rows = await database
      .select({ id: priorityPlans.id })
      .from(priorityPlans)
      .where(
        and(
          projectId === null
            ? isNull(priorityPlans.projectId)
            : eq(priorityPlans.projectId, projectId),
          lt(priorityPlans.periodStart, periodEnd),
          gt(priorityPlans.periodEnd, periodStart),
          excludingId === null ? undefined : ne(priorityPlans.id, excludingId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private async findReplay(
    database: SecondBrainTransaction,
    operation: "priorities.create" | "priorities.update",
    idempotencyKey: string,
  ) {
    const rows = await database
      .select({
        entityId: mutationReceipts.resultEntityId,
        entityType: mutationReceipts.resultEntityType,
        versionId: mutationReceipts.resultVersionId,
        activityEventId: mutationReceipts.activityEventId,
        requestDigest: mutationReceipts.requestDigest,
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
      readonly versionId: string | null;
      readonly activityEventId: string | null;
      readonly requestDigest: string;
    },
    id: string | null,
    digest: string,
  ): void {
    if (
      row.entityType !== "priority_plan" ||
      (id !== null && row.entityId !== id) ||
      row.requestDigest !== digest
    ) {
      throw new PriorityStoreConflictError(
        "The idempotency key was already used for a different priority mutation.",
      );
    }
  }

  private async replayCreate(
    database: SecondBrainTransaction,
    idempotencyKey: string,
    digest: string,
  ): Promise<PriorityPlan> {
    const replay = await this.findReplay(
      database,
      "priorities.create",
      idempotencyKey,
    );
    if (
      replay === null ||
      replay.entityId === null ||
      replay.versionId === null ||
      replay.activityEventId === null
    ) {
      throw new Error("The idempotency winner was not found.");
    }
    this.assertReplay(replay, null, digest);
    return this.loadPlanVersion(database, {
      planId: replay.entityId,
      versionId: replay.versionId,
      activityEventId: replay.activityEventId,
      requestDigest: digest,
      action: "created",
    });
  }

  private async loadCurrentNote(
    database: SecondBrainTransaction,
    versionId: string,
  ): Promise<string | null> {
    const rows = await database
      .select({ note: priorityPlanVersions.note })
      .from(priorityPlanVersions)
      .where(and(eq(priorityPlanVersions.id, versionId)))
      .limit(1);
    if (rows[0] === undefined)
      throw new Error("The current priority version was not found.");
    return rows[0].note;
  }

  private async loadItems(
    database: SecondBrainTransaction,
    versionId: string,
  ): Promise<readonly PriorityPlanItem[]> {
    const rows = await database
      .select({
        goalId: priorityPlanVersionItems.goalId,
        rank: priorityPlanVersionItems.rank,
        intendedSharePercent: priorityPlanVersionItems.intendedSharePercent,
      })
      .from(priorityPlanVersionItems)
      .where(and(eq(priorityPlanVersionItems.priorityPlanVersionId, versionId)))
      .orderBy(priorityPlanVersionItems.rank);
    return validateItems(rows);
  }

  private async loadItemsForVersions(
    database: SecondBrainTransaction,
    versionIds: readonly string[],
  ): Promise<Map<string, PriorityPlanItem[]>> {
    const result = new Map<string, PriorityPlanItem[]>();
    if (versionIds.length === 0) return result;
    const rows = await database
      .select({
        versionId: priorityPlanVersionItems.priorityPlanVersionId,
        goalId: priorityPlanVersionItems.goalId,
        rank: priorityPlanVersionItems.rank,
        intendedSharePercent: priorityPlanVersionItems.intendedSharePercent,
      })
      .from(priorityPlanVersionItems)
      .where(
        and(
          inArray(priorityPlanVersionItems.priorityPlanVersionId, versionIds),
        ),
      )
      .orderBy(
        priorityPlanVersionItems.priorityPlanVersionId,
        priorityPlanVersionItems.rank,
      );
    for (const row of rows) {
      const items = result.get(row.versionId) ?? [];
      items.push({
        goalId: row.goalId,
        rank: row.rank,
        intendedSharePercent: row.intendedSharePercent,
      });
      result.set(row.versionId, items);
    }
    return result;
  }

  private async loadPlanVersion(
    database: SecondBrainTransaction,
    expected: {
      readonly planId: string;
      readonly versionId: string;
      readonly activityEventId: string;
      readonly requestDigest: string;
      readonly action: "created" | "updated";
    },
  ): Promise<PriorityPlan> {
    const rows = await database
      .select({
        version: priorityPlanVersions,
        createdAt: priorityPlans.createdAt,
        planProjectId: priorityPlans.projectId,
        eventId: activityEvents.id,
        eventEntityType: activityEvents.entityType,
        eventEntityId: activityEvents.entityId,
        eventAction: activityEvents.action,
        eventAfterVersionId: activityEvents.afterVersionId,
        eventRequestDigest: activityEvents.requestDigest,
      })
      .from(priorityPlanVersions)
      .innerJoin(
        priorityPlans,
        and(eq(priorityPlans.id, priorityPlanVersions.priorityPlanId)),
      )
      .innerJoin(
        activityEvents,
        and(eq(activityEvents.id, priorityPlanVersions.activityEventId)),
      )
      .where(
        and(
          eq(priorityPlanVersions.priorityPlanId, expected.planId),
          eq(priorityPlanVersions.id, expected.versionId),
        ),
      )
      .limit(2);
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) {
      throw new Error(
        "The idempotent priority result was permanently erased or is invalid.",
      );
    }
    if (
      row.version.priorityPlanId !== expected.planId ||
      row.version.id !== expected.versionId ||
      row.version.activityEventId !== expected.activityEventId ||
      row.eventId !== expected.activityEventId ||
      row.eventEntityType !== "priority_plan" ||
      row.eventEntityId !== expected.planId ||
      row.eventAction !== expected.action ||
      row.eventAfterVersionId !== expected.versionId ||
      row.eventRequestDigest !== expected.requestDigest ||
      row.version.projectId !== row.planProjectId
    ) {
      throw new Error("The priority event, version, and plan do not agree.");
    }
    const items = await this.loadItems(database, expected.versionId);
    return decodePlan(
      {
        id: row.version.priorityPlanId,
        projectId: row.version.projectId,
        periodStart: row.version.periodStart,
        periodEnd: row.version.periodEnd,
        version: row.version.versionNumber,
        currentVersionId: row.version.id,
        note: row.version.note,
        actorKind: row.version.actorKind,
        actorAccountId: row.version.actorAccountId,
        actorClientId: row.version.actorClientId,
        actorSource: row.version.actorSource,
        createdAt: row.createdAt,
        updatedAt: row.version.recordedAt,
      },
      items,
    );
  }

  private async priorityCoverage(
    database: SecondBrainTransaction,
  ): Promise<TemporalCoverage> {
    const rows = await database
      .select({ createdAt: sql<Date | null>`min(${accounts.createdAt})` })
      .from(accounts)
      .limit(1);
    const row = rows[0];
    if (row?.createdAt === undefined || row.createdAt === null) {
      throw new Error("The authorized account was not found.");
    }
    return {
      completeFrom: decodeDate(row.createdAt, "priority coverage boundary"),
      requestedAsOf: null,
      complete: true,
      warnings: [],
    };
  }

  private async linksAreValid(
    database: SecondBrainTransaction,
    projectId: string | null,
    items: readonly PriorityPlanItem[],
  ): Promise<boolean> {
    if (projectId !== null) {
      const projectRows = await database
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (projectRows.length !== 1) return false;
    }
    const goalRows = await database
      .select({ id: goals.id })
      .from(goals)
      .where(
        and(
          inArray(
            goals.id,
            items.map((item) => item.goalId),
          ),
        ),
      );
    return goalRows.length === items.length;
  }
}
