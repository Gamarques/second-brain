import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, gt, lt, lte, or, sql } from "drizzle-orm";

import {
  goalStatuses,
  mutationSources,
  versionOperations,
} from "../../domain.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  CursorPosition,
  Goal,
  GoalStatus,
  GoalStore,
  GoalVersion,
  MutationSource,
  TemporalCoverage,
  VersionOperation,
} from "../../domain.js";
import { projects } from "../schema/content.js";
import { accounts } from "../schema/identity.js";
import {
  activityEvents,
  goals,
  goalVersions,
  mutationReceipts,
} from "../schema/temporal.js";

import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";
import { authorizeBrainTransaction } from "./authorization.js";

export type GoalDatabase = SecondBrainDatabase;

export class GoalStoreConflictError extends Error {
  readonly code = "GOAL_STORE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "GoalStoreConflictError";
  }
}

const goalStatusSet = new Set<string>(goalStatuses);
const versionOperationSet = new Set<string>(versionOperations);
const mutationSourceSet = new Set<string>(mutationSources);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function decodeUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return value;
}

function decodeText(
  value: string,
  field: string,
  maximum: number,
  nullable = false,
): string {
  if ((!nullable && value.trim() === "") || value.length > maximum) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return value;
}

function decodeNullableText(
  value: string | null,
  field: string,
  maximum: number,
): string | null {
  return value === null ? null : decodeText(value, field, maximum, true);
}

function decodeDate(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return date.toISOString();
}

function inputDate(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`${field} must be a valid timestamp.`);
  }
  return date;
}

function decodeStatus(value: string): GoalStatus {
  if (!goalStatusSet.has(value)) {
    throw new Error("The database returned an invalid goal status.");
  }
  return value as GoalStatus;
}

function decodeOperation(value: string): VersionOperation {
  if (!versionOperationSet.has(value)) {
    throw new Error("The database returned an invalid goal version operation.");
  }
  return value as VersionOperation;
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
    if (row.actorClientId !== null) {
      throw new Error(
        "The database returned inconsistent account attribution.",
      );
    }
    return {
      kind: "account",
      accountId: row.actorAccountId,
      clientId: null,
      source,
    };
  }
  if (row.actorKind === "oauth_client") {
    if (row.actorAccountId === null && row.actorClientId === null) {
      return {
        kind: "oauth_client",
        accountId: null,
        clientId: null,
        source,
      };
    }
    if (row.actorAccountId === null || row.actorClientId === null) {
      throw new Error("The database returned inconsistent OAuth attribution.");
    }
    decodeUuid(row.actorAccountId, "actor account ID");
    decodeText(row.actorClientId, "actor client ID", 500);
    return {
      kind: "oauth_client",
      accountId: row.actorAccountId,
      clientId: row.actorClientId,
      source,
    };
  }
  if (row.actorClientId !== null) {
    throw new Error(
      "The database returned inconsistent non-client attribution.",
    );
  }
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
  if (row.actorAccountId !== null) {
    throw new Error("The database returned inconsistent internal attribution.");
  }
  return { kind: row.actorKind, accountId: null, clientId: null, source };
}

function stableDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function cursorCondition(
  timestamp: typeof goals.createdAt,
  id: typeof goals.id,
  cursor: CursorPosition | null,
) {
  if (cursor === null) return undefined;
  const cursorDate = inputDate(cursor.ts, "cursor.ts");
  return or(
    lt(timestamp, cursorDate),
    and(eq(timestamp, cursorDate), lt(id, cursor.id)),
  );
}

function currentGoalFromRow(row: typeof goals.$inferSelect): Goal {
  decodeUuid(row.id, "goal ID");
  if (row.projectId !== null) decodeUuid(row.projectId, "goal project ID");
  return {
    id: row.id,
    title: decodeText(row.title, "goal title", 500),
    description: decodeNullableText(
      row.description,
      "goal description",
      10_000,
    ),
    successCriteria: decodeNullableText(
      row.successCriteria,
      "goal success criteria",
      10_000,
    ),
    status: decodeStatus(row.status),
    targetAt:
      row.targetAt === null ? null : decodeDate(row.targetAt, "goal targetAt"),
    projectId: row.projectId,
    version: assertPositiveVersion(row.version, "goal version"),
    historyCompleteFrom: decodeDate(
      row.historyCompleteFrom,
      "goal historyCompleteFrom",
    ),
    provenance: decodeActor(row),
    createdAt: decodeDate(row.createdAt, "goal createdAt"),
    updatedAt: decodeDate(row.updatedAt, "goal updatedAt"),
  };
}

function assertPositiveVersion(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return value;
}

export class DrizzleGoalStore implements GoalStore {
  constructor(private readonly database: GoalDatabase) {}

  async createGoal(
    access: BrainAccessContext,
    input: Parameters<GoalStore["createGoal"]>[1],
    signal: AbortSignal,
  ): Promise<Goal | null> {
    signal.throwIfAborted();
    const normalizedTargetAt =
      input.targetAt === null
        ? null
        : inputDate(input.targetAt, "targetAt").toISOString();
    const digest = stableDigest({
      operation: "create_goal",
      title: input.title,
      description: input.description,
      successCriteria: input.successCriteria,
      targetAt: normalizedTargetAt,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
    });
    const contentHash = stableDigest({
      title: input.title,
      description: input.description,
      successCriteria: input.successCriteria,
      status: "active",
      targetAt: normalizedTargetAt,
      projectId: input.projectId,
    });
    const now = new Date();
    const goalId = randomUUID();
    const eventId = randomUUID();
    const versionId = randomUUID();
    const receiptId = randomUUID();

    const result = await this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "editor", signal);
      const existingReceipt = await tx
        .select({ id: mutationReceipts.id })
        .from(mutationReceipts)
        .where(
          and(
            eq(mutationReceipts.operation, "goals.create"),
            eq(mutationReceipts.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existingReceipt.length === 1) {
        return this.replayCreate(tx, input.idempotencyKey, digest);
      }
      if (
        input.projectId !== null &&
        !(await this.projectExists(tx, input.projectId))
      ) {
        return null;
      }
      const receiptRows = await tx
        .insert(mutationReceipts)
        .values({
          id: receiptId,
          operation: "goals.create",
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
        })
        .onConflictDoNothing({
          target: [mutationReceipts.operation, mutationReceipts.idempotencyKey],
        })
        .returning({ id: mutationReceipts.id });

      if (receiptRows.length === 0) {
        return this.replayCreate(tx, input.idempotencyKey, digest);
      }

      await tx.insert(activityEvents).values({
        id: eventId,
        entityType: "goal",
        entityId: goalId,
        action: "created",
        occurredAt: now,
        effectiveAt: now,
        changedFields: [
          "title",
          "description",
          "successCriteria",
          "status",
          "targetAt",
          "projectId",
        ],
        afterVersionId: versionId,
        contentHash,
        requestDigest: digest,
        analysisAllowed: true,
        idempotencyKey: `goals.create:${input.idempotencyKey}`,
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

      const insertedGoals = await tx
        .insert(goals)
        .values({
          id: goalId,
          title: input.title,
          description: input.description,
          successCriteria: input.successCriteria,
          status: "active",
          targetAt:
            normalizedTargetAt === null ? null : new Date(normalizedTargetAt),
          projectId: input.projectId,
          version: 1,
          historyCompleteFrom: now,
          actorKind: access.actor.kind,
          actorAccountId: access.actor.accountId,
          actorClientId: access.actor.clientId,
          actorSource: access.actor.source,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const row = insertedGoals[0];
      if (row === undefined)
        throw new Error("The goal insert returned no row.");

      await tx.insert(goalVersions).values({
        id: versionId,
        goalId,
        versionNumber: 1,
        operation: "created",
        origin: "native",
        title: input.title,
        description: input.description,
        successCriteria: input.successCriteria,
        status: "active",
        targetAt:
          normalizedTargetAt === null ? null : new Date(normalizedTargetAt),
        projectId: input.projectId,
        effectiveAt: now,
        recordedAt: now,
        changedFields: [
          "title",
          "description",
          "successCriteria",
          "status",
          "targetAt",
          "projectId",
        ],
        activityEventId: eventId,
      });
      await tx
        .update(mutationReceipts)
        .set({
          resultEntityType: "goal",
          resultEntityId: goalId,
          resultVersionId: versionId,
          result: { goalId, version: 1 },
          activityEventId: eventId,
        })
        .where(and(eq(mutationReceipts.id, receiptId)));
      return currentGoalFromRow(row);
    });
    signal.throwIfAborted();
    return result;
  }

  async updateGoal(
    access: BrainAccessContext,
    id: string,
    changes: Parameters<GoalStore["updateGoal"]>[2],
    signal: AbortSignal,
  ): Promise<Goal | null> {
    signal.throwIfAborted();
    const normalizedChanges = {
      ...changes,
      ...(changes.targetAt === undefined
        ? {}
        : {
            targetAt:
              changes.targetAt === null
                ? null
                : inputDate(changes.targetAt, "targetAt").toISOString(),
          }),
    };
    const digest = stableDigest({
      operation: "update_goal",
      id,
      changes: normalizedChanges,
    });
    const now = new Date();
    const eventId = randomUUID();
    const versionId = randomUUID();

    const result = await this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "editor", signal);
      const replay = await tx
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
            eq(mutationReceipts.operation, "goals.update"),
            eq(
              mutationReceipts.idempotencyKey,
              changes.precondition.idempotencyKey,
            ),
          ),
        )
        .limit(1);
      if (replay[0] !== undefined) {
        this.assertReceipt(replay[0], "goal", id, digest);
        if (
          replay[0].versionId === null ||
          replay[0].activityEventId === null
        ) {
          throw new Error("The goal receipt is incomplete.");
        }
        return this.loadVersion(tx, {
          goalId: id,
          versionId: replay[0].versionId,
          activityEventId: replay[0].activityEventId,
          requestDigest: digest,
        });
      }

      const lockedRows = await tx
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .limit(1)
        .for("update");
      const current = lockedRows[0];
      const lockedReplay = await tx
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
            eq(mutationReceipts.operation, "goals.update"),
            eq(
              mutationReceipts.idempotencyKey,
              changes.precondition.idempotencyKey,
            ),
          ),
        )
        .limit(1);
      if (lockedReplay[0] !== undefined) {
        this.assertReceipt(lockedReplay[0], "goal", id, digest);
        if (
          lockedReplay[0].versionId === null ||
          lockedReplay[0].activityEventId === null
        ) {
          throw new Error("The goal receipt is incomplete.");
        }
        return this.loadVersion(tx, {
          goalId: id,
          versionId: lockedReplay[0].versionId,
          activityEventId: lockedReplay[0].activityEventId,
          requestDigest: digest,
        });
      }
      if (
        current === undefined ||
        current.version !== changes.precondition.expectedVersion
      ) {
        return null;
      }

      const next = {
        title: changes.title ?? current.title,
        description:
          changes.description === undefined
            ? current.description
            : changes.description,
        successCriteria:
          changes.successCriteria === undefined
            ? current.successCriteria
            : changes.successCriteria,
        status: changes.status ?? current.status,
        targetAt:
          changes.targetAt === undefined
            ? current.targetAt
            : changes.targetAt === null
              ? null
              : inputDate(changes.targetAt, "targetAt"),
        projectId:
          changes.projectId === undefined
            ? current.projectId
            : changes.projectId,
      };
      const changedFields = (
        [
          ["title", next.title, current.title],
          ["description", next.description, current.description],
          ["successCriteria", next.successCriteria, current.successCriteria],
          ["status", next.status, current.status],
          [
            "targetAt",
            next.targetAt?.valueOf() ?? null,
            current.targetAt?.valueOf() ?? null,
          ],
          ["projectId", next.projectId, current.projectId],
        ] as const
      )
        .filter(([, nextValue, currentValue]) => nextValue !== currentValue)
        .map(([field]) => field);
      const nextVersion = current.version + 1;
      const operation = this.goalOperation(current.status, next.status);
      const contentHash = stableDigest({
        title: next.title,
        description: next.description,
        successCriteria: next.successCriteria,
        status: next.status,
        targetAt: next.targetAt?.toISOString() ?? null,
        projectId: next.projectId,
      });
      if (
        next.projectId !== null &&
        !(await this.projectExists(tx, next.projectId))
      ) {
        return null;
      }

      const receiptId = randomUUID();
      const insertedReceipts = await tx
        .insert(mutationReceipts)
        .values({
          id: receiptId,
          operation: "goals.update",
          idempotencyKey: changes.precondition.idempotencyKey,
          requestDigest: digest,
        })
        .onConflictDoNothing({
          target: [mutationReceipts.operation, mutationReceipts.idempotencyKey],
        })
        .returning({ id: mutationReceipts.id });
      if (insertedReceipts.length === 0) {
        const concurrentReplay = await tx
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
              eq(mutationReceipts.operation, "goals.update"),
              eq(
                mutationReceipts.idempotencyKey,
                changes.precondition.idempotencyKey,
              ),
            ),
          )
          .limit(1);
        if (concurrentReplay[0] === undefined) {
          throw new Error("The idempotency winner could not be loaded.");
        }
        this.assertReceipt(concurrentReplay[0], "goal", id, digest);
        if (
          concurrentReplay[0].versionId === null ||
          concurrentReplay[0].activityEventId === null
        ) {
          throw new Error("The goal receipt is incomplete.");
        }
        return this.loadVersion(tx, {
          goalId: id,
          versionId: concurrentReplay[0].versionId,
          activityEventId: concurrentReplay[0].activityEventId,
          requestDigest: digest,
        });
      }

      await tx.insert(activityEvents).values({
        id: eventId,
        entityType: "goal",
        entityId: id,
        action: operation,
        occurredAt: now,
        effectiveAt: now,
        changedFields,
        afterVersionId: versionId,
        contentHash,
        requestDigest: digest,
        analysisAllowed: true,
        idempotencyKey: `goals.update:${changes.precondition.idempotencyKey}`,
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

      const updatedRows = await tx
        .update(goals)
        .set({
          ...next,
          version: nextVersion,
          actorKind: access.actor.kind,
          actorAccountId: access.actor.accountId,
          actorClientId: access.actor.clientId,
          actorSource: access.actor.source,
          updatedAt: now,
        })
        .where(and(eq(goals.id, id), eq(goals.version, current.version)))
        .returning();
      const updated = updatedRows[0];
      if (updated === undefined) {
        throw new Error("The locked goal projection could not be updated.");
      }

      await tx.insert(goalVersions).values({
        id: versionId,
        goalId: id,
        versionNumber: nextVersion,
        operation,
        origin: "native",
        ...next,
        effectiveAt: now,
        recordedAt: now,
        changedFields,
        activityEventId: eventId,
      });
      await tx
        .update(mutationReceipts)
        .set({
          resultEntityType: "goal",
          resultEntityId: id,
          resultVersionId: versionId,
          result: { goalId: id, version: nextVersion },
          activityEventId: eventId,
        })
        .where(and(eq(mutationReceipts.id, receiptId)));
      return currentGoalFromRow(updated);
    });
    signal.throwIfAborted();
    return result;
  }

  async listGoals(
    access: BrainAccessContext,
    input: Parameters<GoalStore["listGoals"]>[1],
    signal: AbortSignal,
  ): ReturnType<GoalStore["listGoals"]> {
    signal.throwIfAborted();
    const result = await this.database.transaction(
      async (tx) => {
        await authorizeBrainTransaction(tx, access, "viewer", signal);
        if (input.asOf === null) {
          const conditions = [
            input.status === null ? undefined : eq(goals.status, input.status),
            input.projectId === null
              ? undefined
              : eq(goals.projectId, input.projectId),
            cursorCondition(goals.createdAt, goals.id, input.cursor),
          ].filter((condition) => condition !== undefined);
          const rows = await tx
            .select()
            .from(goals)
            .where(and(...conditions))
            .orderBy(desc(goals.createdAt), desc(goals.id))
            .limit(input.limit + 1);
          signal.throwIfAborted();
          const pageRows = rows.slice(0, input.limit);
          const items = pageRows.map(currentGoalFromRow);
          const tail = rows.length > input.limit ? pageRows.at(-1) : undefined;
          return {
            items,
            nextCursor:
              tail === undefined
                ? null
                : {
                    ts: decodeDate(tail.createdAt, "goal cursor"),
                    id: tail.id,
                  },
            coverage: await this.goalCoverage(tx, null, null, false),
          };
        }

        const cutoff = inputDate(input.asOf, "asOf");
        const snapshots = tx
          .selectDistinctOn([goalVersions.goalId], {
            id: goalVersions.goalId,
            title: goalVersions.title,
            description: goalVersions.description,
            successCriteria: goalVersions.successCriteria,
            status: goalVersions.status,
            targetAt: goalVersions.targetAt,
            projectId: goalVersions.projectId,
            version: goalVersions.versionNumber,
            historyCompleteFrom: goals.historyCompleteFrom,
            createdAt: goals.createdAt,
            updatedAt: goalVersions.recordedAt,
            actorKind: activityEvents.actorKind,
            actorAccountId: activityEvents.actorAccountId,
            actorClientId: activityEvents.actorClientId,
            actorSource: activityEvents.actorSource,
          })
          .from(goalVersions)
          .innerJoin(goals, and(eq(goals.id, goalVersions.goalId)))
          .innerJoin(
            activityEvents,
            and(
              eq(activityEvents.id, goalVersions.activityEventId),
              eq(activityEvents.entityType, "goal"),
              eq(activityEvents.entityId, goalVersions.goalId),
              eq(activityEvents.afterVersionId, goalVersions.id),
              // The action and operation columns are distinct PostgreSQL enum
              // types, which have no direct equality operator.
              sql`${activityEvents.action}::text = ${goalVersions.operation}::text`,
            ),
          )
          .where(and(lte(goalVersions.effectiveAt, cutoff)))
          .orderBy(
            goalVersions.goalId,
            desc(goalVersions.effectiveAt),
            desc(goalVersions.versionNumber),
          )
          .as("goal_snapshots");
        const cursor =
          input.cursor === null
            ? null
            : inputDate(input.cursor.ts, "cursor.ts");
        const rows = await tx
          .select()
          .from(snapshots)
          .where(
            and(
              input.status === null
                ? undefined
                : eq(snapshots.status, input.status),
              input.projectId === null
                ? undefined
                : eq(snapshots.projectId, input.projectId),
              cursor === null
                ? undefined
                : or(
                    lt(snapshots.updatedAt, cursor),
                    and(
                      eq(snapshots.updatedAt, cursor),
                      lt(snapshots.id, input.cursor!.id),
                    ),
                  ),
            ),
          )
          .orderBy(desc(snapshots.updatedAt), desc(snapshots.id))
          .limit(input.limit + 1);
        signal.throwIfAborted();
        const pageRows = rows.slice(0, input.limit);
        const items = pageRows.map((row) => currentGoalFromRow(row));
        const tail = rows.length > input.limit ? pageRows.at(-1) : undefined;
        return {
          items,
          nextCursor:
            tail === undefined
              ? null
              : { ts: decodeDate(tail.updatedAt, "goal cursor"), id: tail.id },
          coverage: await this.goalCoverage(tx, input.asOf, null, true),
        };
      },
      { isolationLevel: "repeatable read" },
    );
    signal.throwIfAborted();
    return result;
  }

  async listGoalHistory(
    access: BrainAccessContext,
    input: Parameters<GoalStore["listGoalHistory"]>[1],
    signal: AbortSignal,
  ): ReturnType<GoalStore["listGoalHistory"]> {
    signal.throwIfAborted();
    const result = await this.database.transaction(
      async (tx) => {
        await authorizeBrainTransaction(tx, access, "viewer", signal);
        const cursor =
          input.cursor === null
            ? null
            : inputDate(input.cursor.ts, "cursor.ts");
        const rows = await tx
          .select({
            id: goalVersions.id,
            goalId: goalVersions.goalId,
            version: goalVersions.versionNumber,
            operation: goalVersions.operation,
            title: goalVersions.title,
            description: goalVersions.description,
            successCriteria: goalVersions.successCriteria,
            status: goalVersions.status,
            targetAt: goalVersions.targetAt,
            projectId: goalVersions.projectId,
            effectiveAt: goalVersions.effectiveAt,
            recordedAt: goalVersions.recordedAt,
            changedFields: goalVersions.changedFields,
            activityEventId: goalVersions.activityEventId,
            actorKind: activityEvents.actorKind,
            actorAccountId: activityEvents.actorAccountId,
            actorClientId: activityEvents.actorClientId,
            actorSource: activityEvents.actorSource,
          })
          .from(goalVersions)
          .innerJoin(
            activityEvents,
            and(
              eq(activityEvents.id, goalVersions.activityEventId),
              eq(activityEvents.entityType, "goal"),
              eq(activityEvents.entityId, goalVersions.goalId),
              eq(activityEvents.afterVersionId, goalVersions.id),
              // The action and operation columns are distinct PostgreSQL enum
              // types, which have no direct equality operator.
              sql`${activityEvents.action}::text = ${goalVersions.operation}::text`,
            ),
          )
          .where(
            and(
              eq(goalVersions.goalId, input.goalId),
              cursor === null
                ? undefined
                : or(
                    lt(goalVersions.effectiveAt, cursor),
                    and(
                      eq(goalVersions.effectiveAt, cursor),
                      lt(goalVersions.id, input.cursor!.id),
                    ),
                  ),
            ),
          )
          .orderBy(desc(goalVersions.effectiveAt), desc(goalVersions.id))
          .limit(input.limit + 1);
        signal.throwIfAborted();
        const pageRows = rows.slice(0, input.limit);
        const items: GoalVersion[] = pageRows.map((row) => ({
          id: decodeUuid(row.id, "goal version ID"),
          goalId: decodeUuid(row.goalId, "goal version goal ID"),
          version: assertPositiveVersion(row.version, "goal version"),
          operation: decodeOperation(row.operation),
          snapshot: {
            id: decodeUuid(row.goalId, "goal snapshot ID"),
            title: decodeText(row.title, "goal title", 500),
            description: decodeNullableText(
              row.description,
              "goal description",
              10_000,
            ),
            successCriteria: decodeNullableText(
              row.successCriteria,
              "goal success criteria",
              10_000,
            ),
            status: decodeStatus(row.status),
            targetAt:
              row.targetAt === null
                ? null
                : decodeDate(row.targetAt, "goal targetAt"),
            projectId:
              row.projectId === null
                ? null
                : decodeUuid(row.projectId, "goal project ID"),
          },
          effectiveAt: decodeDate(row.effectiveAt, "goal effectiveAt"),
          recordedAt: decodeDate(row.recordedAt, "goal recordedAt"),
          changedFields: this.decodeChangedFields(row.changedFields),
          provenance: decodeActor(row),
          activityEventId: decodeUuid(
            row.activityEventId,
            "goal activity event ID",
          ),
        }));
        const tail = rows.length > input.limit ? pageRows.at(-1) : undefined;
        return {
          items,
          nextCursor:
            tail === undefined
              ? null
              : {
                  ts: decodeDate(tail.effectiveAt, "goal cursor"),
                  id: tail.id,
                },
          coverage: await this.goalCoverage(tx, null, input.goalId, true),
        };
      },
      { isolationLevel: "repeatable read" },
    );
    signal.throwIfAborted();
    return result;
  }

  private assertReceipt(
    row: {
      readonly entityId: string | null;
      readonly entityType: string | null;
      readonly versionId: string | null;
      readonly activityEventId: string | null;
      readonly requestDigest: string;
    },
    entityType: "goal",
    entityId: string,
    digest: string,
  ): void {
    if (
      row.entityType !== entityType ||
      row.entityId !== entityId ||
      row.versionId === null ||
      row.activityEventId === null ||
      row.requestDigest !== digest
    ) {
      throw new GoalStoreConflictError(
        "The idempotency key was already used for a different goal mutation.",
      );
    }
  }

  private goalOperation(
    current: GoalStatus,
    next: GoalStatus,
  ): VersionOperation {
    if (current === next) return "updated";
    if (next === "achieved") return "completed";
    if (next === "abandoned") return "canceled";
    if (
      (current === "achieved" || current === "abandoned") &&
      next === "active"
    ) {
      return "reopened";
    }
    if (current === "paused" && next === "active") return "started";
    return "updated";
  }

  private decodeChangedFields(value: readonly string[]): readonly string[] {
    if (
      value.length > 100 ||
      value.some((field) => field.trim() === "" || field.length > 100)
    ) {
      throw new Error("The database returned invalid changed fields.");
    }
    return [...value];
  }

  private async replayCreate(
    database: SecondBrainTransaction,
    idempotencyKey: string,
    digest: string,
  ): Promise<Goal> {
    const receiptRows = await database
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
          eq(mutationReceipts.operation, "goals.create"),
          eq(mutationReceipts.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const receipt = receiptRows[0];
    if (
      receipt === undefined ||
      receipt.entityId === null ||
      receipt.versionId === null ||
      receipt.activityEventId === null
    ) {
      throw new Error("The idempotency winner could not be loaded.");
    }
    this.assertReceipt(receipt, "goal", receipt.entityId, digest);
    return this.loadVersion(database, {
      goalId: receipt.entityId,
      versionId: receipt.versionId,
      activityEventId: receipt.activityEventId,
      requestDigest: digest,
    });
  }

  private async loadVersion(
    database: SecondBrainTransaction,
    expected: {
      readonly goalId: string;
      readonly versionId: string;
      readonly activityEventId: string;
      readonly requestDigest: string;
    },
  ): Promise<Goal> {
    const rows = await database
      .select({
        id: goalVersions.goalId,
        title: goalVersions.title,
        description: goalVersions.description,
        successCriteria: goalVersions.successCriteria,
        status: goalVersions.status,
        targetAt: goalVersions.targetAt,
        projectId: goalVersions.projectId,
        version: goalVersions.versionNumber,
        historyCompleteFrom: goals.historyCompleteFrom,
        actorKind: activityEvents.actorKind,
        actorAccountId: activityEvents.actorAccountId,
        actorClientId: activityEvents.actorClientId,
        actorSource: activityEvents.actorSource,
        createdAt: goals.createdAt,
        updatedAt: goalVersions.recordedAt,
        versionId: goalVersions.id,
        versionGoalId: goalVersions.goalId,
        versionOperation: goalVersions.operation,
        versionEventId: goalVersions.activityEventId,
        eventId: activityEvents.id,
        eventEntityType: activityEvents.entityType,
        eventEntityId: activityEvents.entityId,
        eventAction: activityEvents.action,
        eventAfterVersionId: activityEvents.afterVersionId,
        eventRequestDigest: activityEvents.requestDigest,
      })
      .from(goalVersions)
      .innerJoin(goals, and(eq(goals.id, goalVersions.goalId)))
      .innerJoin(
        activityEvents,
        and(eq(activityEvents.id, goalVersions.activityEventId)),
      )
      .where(
        and(
          eq(goalVersions.goalId, expected.goalId),
          eq(goalVersions.id, expected.versionId),
        ),
      )
      .limit(2);
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) {
      throw new Error(
        "The idempotent goal result was permanently erased or is invalid.",
      );
    }
    if (
      row.versionId !== expected.versionId ||
      row.versionGoalId !== expected.goalId ||
      row.versionEventId !== expected.activityEventId ||
      row.eventId !== expected.activityEventId ||
      row.eventEntityType !== "goal" ||
      row.eventEntityId !== expected.goalId ||
      row.eventAction !== row.versionOperation ||
      row.eventAfterVersionId !== expected.versionId ||
      row.eventRequestDigest !== expected.requestDigest
    ) {
      throw new Error("The idempotent goal event and version do not agree.");
    }
    return currentGoalFromRow(row);
  }

  private async goalCoverage(
    database: SecondBrainTransaction,
    requestedAsOf: string | null,
    goalId: string | null = null,
    historical = true,
  ): Promise<TemporalCoverage> {
    const accountRows = await database
      .select({ createdAt: sql<Date | null>`min(${accounts.createdAt})` })
      .from(accounts)
      .limit(1);
    const earliestAccount = accountRows[0];
    if (
      earliestAccount?.createdAt === undefined ||
      earliestAccount.createdAt === null
    ) {
      throw new Error("The authorized account was not found.");
    }
    const historyRows = await database
      .select({
        historyCompleteFrom: goals.historyCompleteFrom,
      })
      .from(goals)
      .where(
        and(
          goalId === null ? undefined : eq(goals.id, goalId),
          gt(goals.historyCompleteFrom, goals.createdAt),
        ),
      )
      .orderBy(desc(goals.historyCompleteFrom))
      .limit(1);
    let boundary = earliestAccount.createdAt;
    for (const row of historyRows) {
      if (row.historyCompleteFrom > boundary)
        boundary = row.historyCompleteFrom;
    }
    const hasGap = historyRows.length > 0;
    const requested =
      requestedAsOf === null ? null : inputDate(requestedAsOf, "asOf");
    const complete =
      !historical || !hasGap || (requested !== null && requested >= boundary);
    return {
      completeFrom: decodeDate(boundary, "goal coverage boundary"),
      requestedAsOf,
      complete,
      warnings: complete
        ? []
        : ["Goal history is incomplete before the reported coverage boundary."],
    };
  }

  private async projectExists(
    database: SecondBrainTransaction,
    projectId: string,
  ): Promise<boolean> {
    const rows = await database
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return rows.length === 1;
  }
}
