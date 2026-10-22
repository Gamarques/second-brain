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
  mutationSources,
  taskPriorities,
  taskRelationKinds,
  taskStatuses,
  versionOperations,
} from "../../domain.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  CursorPosition,
  MutationSource,
  Task,
  TaskGoalLink,
  TaskList,
  TaskPriority,
  TaskRelation,
  TaskStatus,
  TaskStore,
  TaskVersion,
  TemporalCoverage,
  TemporalPage,
  VersionOperation,
} from "../../domain.js";
import { projects, taskLists, tasks } from "../schema/content.js";
import {
  activityEvents,
  goals,
  mutationReceipts,
  taskGoalLinks,
  taskRelations,
  taskVersionGoalLinks,
  taskVersions,
} from "../schema/temporal.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";

const operationNames = {
  createList: "task_list.create",
  createTask: "task.create",
  updateTask: "task.update",
  deleteTask: "task.delete",
  createRelation: "task_relation.create",
} as const;

const actorRowSchema = z.object({
  actorKind: z.enum(["account", "oauth_client", "import", "dreaming", "system"]),
  actorAccountId: z.uuid().nullable(),
  actorClientId: z.string().min(1).max(500).nullable(),
  actorSource: z.enum(mutationSources),
});

const taskListRowSchema = actorRowSchema.extend({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  description: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const taskRowSchema = actorRowSchema.extend({
  id: z.uuid(),
  listId: z.uuid(),
  projectId: z.uuid().nullable(),
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  status: z.enum(taskStatuses),
  priority: z.enum(taskPriorities),
  dueAt: z.date().nullable(),
  completedAt: z.date().nullable(),
  historyVersion: z.number().int().positive(),
  historyCompleteFrom: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const taskVersionRowSchema = actorRowSchema.extend({
  id: z.uuid(),
  taskId: z.uuid(),
  versionNumber: z.number().int().positive(),
  operation: z.enum(versionOperations),
  listId: z.uuid(),
  projectId: z.uuid().nullable(),
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  status: z.enum(taskStatuses),
  priority: z.enum(taskPriorities),
  dueAt: z.date().nullable(),
  completedAt: z.date().nullable(),
  effectiveAt: z.date(),
  recordedAt: z.date(),
  changedFields: z.array(z.string().min(1).max(100)).max(100),
  activityEventId: z.uuid(),
});

const taskRelationRowSchema = actorRowSchema.extend({
  id: z.uuid(),
  fromTaskId: z.uuid(),
  toTaskId: z.uuid(),
  kind: z.enum(taskRelationKinds),
  createdAt: z.date(),
  retractedAt: z.date().nullable(),
});

const goalLinkRowSchema = z.object({
  goalId: z.uuid(),
  basis: z.enum(["explicit", "reviewed_inference", "model_inference"]),
  confidence: z.number().min(0).max(1).nullable(),
});

const receiptRowSchema = z.object({
  operation: z.string(),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  resultEntityType: z.string().nullable(),
  resultEntityId: z.uuid().nullable(),
  resultVersionId: z.uuid().nullable(),
  activityEventId: z.uuid().nullable(),
});

export interface TaskCreateInput {
  readonly listId: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: TaskPriority;
  readonly dueAt: string | null;
  readonly projectId: string | null;
  readonly goalLinks: readonly TaskGoalLink[];
  readonly idempotencyKey: string;
}

export interface CreatedTaskEffect {
  readonly task: Task;
  readonly activityEventId: string;
}

export class TaskStoreContractError extends Error {
  readonly code = "TASK_STORE_CONTRACT_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskStoreContractError";
  }
}

export class TaskStoreIdempotencyConflictError extends Error {
  readonly code = "TASK_STORE_IDEMPOTENCY_CONFLICT";

  constructor() {
    super("The task idempotency key was already used for a different mutation.");
    this.name = "TaskStoreIdempotencyConflictError";
  }
}

function contract(message: string, cause?: unknown): TaskStoreContractError {
  return new TaskStoreContractError(message, {
    ...(cause === undefined ? {} : { cause }),
  });
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

function requiredText(value: string, field: string, maximum: number): string {
  const result = value.trim();
  if (result.length === 0 || result.length > maximum) {
    throw contract(`${field} must contain between 1 and ${maximum} characters.`);
  }
  return result;
}

function optionalText(value: string | null, field: string, maximum: number): string | null {
  if (value !== null && value.length > maximum) {
    throw contract(`${field} must contain at most ${maximum} characters.`);
  }
  return value;
}

function idempotencyKey(value: string): string {
  return requiredText(value, "idempotencyKey", 200);
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

function decodeGoalLinks(rows: readonly unknown[]): readonly TaskGoalLink[] {
  const parsed = z.array(goalLinkRowSchema).safeParse(rows);
  if (!parsed.success) throw contract("Invalid task goal link rows.", parsed.error);
  return parsed.data
    .map((row) => ({ ...row }))
    .sort((left, right) => left.goalId.localeCompare(right.goalId));
}

function decodeTaskList(row: unknown): TaskList {
  const parsed = taskListRowSchema.safeParse(row);
  if (!parsed.success) throw contract("Invalid task list row.", parsed.error);
  const value = parsed.data;
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    provenance: decodeActor(value),
    createdAt: iso(value.createdAt)!,
    updatedAt: iso(value.updatedAt)!,
  };
}

function decodeTask(row: unknown, goalLinks: readonly TaskGoalLink[]): Task {
  const parsed = taskRowSchema.safeParse(row);
  if (!parsed.success) throw contract("Invalid task row.", parsed.error);
  const value = parsed.data;
  return {
    id: value.id,
    listId: value.listId,
    title: value.title,
    description: value.description,
    status: value.status,
    priority: value.priority,
    dueAt: iso(value.dueAt),
    completedAt: iso(value.completedAt),
    projectId: value.projectId,
    goalLinks,
    version: value.historyVersion,
    historyCompleteFrom: iso(value.historyCompleteFrom)!,
    provenance: decodeActor(value),
    createdAt: iso(value.createdAt)!,
    updatedAt: iso(value.updatedAt)!,
  };
}

function decodeRelation(row: unknown): TaskRelation {
  const parsed = taskRelationRowSchema.safeParse(row);
  if (!parsed.success) throw contract("Invalid task relation row.", parsed.error);
  const value = parsed.data;
  return {
    id: value.id,
    fromTaskId: value.fromTaskId,
    toTaskId: value.toTaskId,
    kind: value.kind,
    provenance: decodeActor(value),
    createdAt: iso(value.createdAt)!,
    retractedAt: iso(value.retractedAt),
  };
}

function normalizeGoalLinks(value: readonly TaskGoalLink[]): readonly TaskGoalLink[] {
  if (value.length > 20) throw contract("A task may link to at most 20 goals.");
  const parsed = z.array(goalLinkRowSchema).safeParse(value);
  if (!parsed.success) throw contract("Task goal links are invalid.", parsed.error);
  const sorted = parsed.data
    .map((item) => ({ ...item }))
    .sort((left, right) => left.goalId.localeCompare(right.goalId));
  if (new Set(sorted.map((item) => item.goalId)).size !== sorted.length) {
    throw contract("Task goal IDs must be unique.");
  }
  return sorted;
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
  entityType: string,
): void {
  if (
    receipt.operation !== operation ||
    receipt.requestDigest !== requestDigest ||
    receipt.resultEntityType !== entityType ||
    receipt.resultEntityId === null ||
    receipt.activityEventId === null
  ) {
    throw new TaskStoreIdempotencyConflictError();
  }
}

async function validateUnversionedReceiptEvent(
  tx: SecondBrainTransaction,
  receipt: z.infer<typeof receiptRowSchema>,
  input: {
    readonly requestDigest: string;
    readonly entityType: "task_list" | "task" | "task_relation";
    readonly entityId: string;
    readonly action: "created" | "linked" | "deleted";
  },
): Promise<void> {
  if (receipt.resultVersionId !== null || receipt.activityEventId === null) {
    throw new TaskStoreIdempotencyConflictError();
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
    rows[0]!.entityType !== input.entityType ||
    rows[0]!.entityId !== input.entityId ||
    rows[0]!.action !== input.action ||
    rows[0]!.afterVersionId !== null ||
    rows[0]!.requestDigest !== input.requestDigest
  ) {
    throw contract("The idempotent mutation receipt and activity event do not agree.");
  }
}

async function claimEvent(
  tx: SecondBrainTransaction,
  access: BrainAccessContext,
  input: {
    readonly id: string;
    readonly entityType: "task_list" | "task" | "task_relation";
    readonly entityId: string;
    readonly action: "created" | "updated" | "started" | "completed" | "reopened" | "canceled" | "deleted" | "linked";
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
      entityType: input.entityType,
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
    readonly entityType: string;
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
      resultEntityType: input.entityType,
      resultEntityId: input.entityId,
      resultVersionId: input.versionId,
      result: {},
      activityEventId: input.eventId,
      createdAt: input.now,
    })
    .returning({ id: mutationReceipts.id });
  if (rows.length !== 1) throw contract("The mutation receipt was not persisted.");
}

async function validateTaskReferences(
  tx: SecondBrainTransaction,
  input: {
    readonly listId: string;
    readonly projectId: string | null;
    readonly goalLinks: readonly TaskGoalLink[];
  },
): Promise<boolean> {
  const listRows = await tx
    .select({ id: taskLists.id })
    .from(taskLists)
    .where(eq(taskLists.id, input.listId))
    .limit(1);
  if (listRows.length !== 1) return false;
  if (input.projectId !== null) {
    const projectRows = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (projectRows.length !== 1) return false;
  }
  if (input.goalLinks.length > 0) {
    const goalRows = await tx
      .select({ id: goals.id })
      .from(goals)
      .where(
        inArray(
          goals.id,
          input.goalLinks.map((item) => item.goalId),
        ),
      );
    if (goalRows.length !== input.goalLinks.length) return false;
  }
  return true;
}

async function currentGoalLinks(
  tx: SecondBrainTransaction,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, readonly TaskGoalLink[]>> {
  if (taskIds.length === 0) return new Map();
  const rows = await tx
    .select({
      taskId: taskGoalLinks.taskId,
      goalId: taskGoalLinks.goalId,
      basis: taskGoalLinks.basis,
      confidence: taskGoalLinks.confidence,
    })
    .from(taskGoalLinks)
    .where(inArray(taskGoalLinks.taskId, [...taskIds]));
  const grouped = new Map<string, TaskGoalLink[]>();
  for (const taskId of taskIds) grouped.set(taskId, []);
  for (const row of rows) grouped.get(row.taskId)?.push(...decodeGoalLinks([row]));
  for (const [taskId, links] of grouped) grouped.set(taskId, [...links].sort((a, b) => a.goalId.localeCompare(b.goalId)));
  return grouped;
}

async function versionGoalLinks(
  tx: SecondBrainTransaction,
  versionIds: readonly string[],
): Promise<ReadonlyMap<string, readonly TaskGoalLink[]>> {
  if (versionIds.length === 0) return new Map();
  const rows = await tx
    .select({
      versionId: taskVersionGoalLinks.taskVersionId,
      goalId: taskVersionGoalLinks.goalId,
      basis: taskVersionGoalLinks.basis,
      confidence: taskVersionGoalLinks.confidence,
    })
    .from(taskVersionGoalLinks)
    .where(inArray(taskVersionGoalLinks.taskVersionId, [...versionIds]));
  const grouped = new Map<string, TaskGoalLink[]>();
  for (const versionId of versionIds) grouped.set(versionId, []);
  for (const row of rows) grouped.get(row.versionId)?.push(...decodeGoalLinks([row]));
  for (const [versionId, links] of grouped) grouped.set(versionId, [...links].sort((a, b) => a.goalId.localeCompare(b.goalId)));
  return grouped;
}

async function loadTaskVersionResult(
  tx: SecondBrainTransaction,
  taskId: string,
  versionId: string,
  expectedEventId: string,
  requestDigest: string,
): Promise<Task> {
  const rows = await tx
    .select({
      id: tasks.id,
      listId: taskVersions.listId,
      projectId: taskVersions.projectId,
      title: taskVersions.title,
      description: taskVersions.description,
      status: taskVersions.status,
      priority: taskVersions.priority,
      dueAt: taskVersions.dueAt,
      completedAt: taskVersions.completedAt,
      historyVersion: taskVersions.versionNumber,
      historyCompleteFrom: tasks.historyCompleteFrom,
      actorKind: activityEvents.actorKind,
      actorAccountId: activityEvents.actorAccountId,
      actorClientId: activityEvents.actorClientId,
      actorSource: activityEvents.actorSource,
      createdAt: tasks.createdAt,
      updatedAt: taskVersions.recordedAt,
      versionOperation: taskVersions.operation,
      versionEventId: taskVersions.activityEventId,
      eventEntityType: activityEvents.entityType,
      eventEntityId: activityEvents.entityId,
      eventAction: activityEvents.action,
      eventAfterVersionId: activityEvents.afterVersionId,
      eventRequestDigest: activityEvents.requestDigest,
    })
    .from(taskVersions)
    .innerJoin(tasks, eq(tasks.id, taskVersions.taskId))
    .innerJoin(activityEvents, eq(activityEvents.id, taskVersions.activityEventId))
    .where(and(eq(taskVersions.taskId, taskId), eq(taskVersions.id, versionId)))
    .limit(2);
  if (rows.length !== 1) {
    throw contract("The idempotent task result was permanently erased or is invalid.");
  }
  const row = rows[0]!;
  if (
    row.versionEventId !== expectedEventId ||
    row.eventEntityType !== "task" ||
    row.eventEntityId !== taskId ||
    row.eventAfterVersionId !== versionId ||
    row.eventRequestDigest !== requestDigest ||
    row.eventAction !== row.versionOperation
  ) {
    throw contract("The idempotent task event and version do not agree.");
  }
  const links = await versionGoalLinks(tx, [versionId]);
  return decodeTask(row, links.get(versionId) ?? []);
}

async function replayTaskEffect(
  tx: SecondBrainTransaction,
  operation: string,
  key: string,
  requestDigest: string,
  expectedEntityId: string | null = null,
): Promise<CreatedTaskEffect | null> {
  const receipt = await findReceipt(tx, operation, key);
  if (receipt === null) return null;
  validateReceipt(receipt, operation, requestDigest, "task");
  if (receipt.resultVersionId === null) throw new TaskStoreIdempotencyConflictError();
  if (expectedEntityId !== null && receipt.resultEntityId !== expectedEntityId) {
    throw new TaskStoreIdempotencyConflictError();
  }
  const task = await loadTaskVersionResult(
    tx,
    receipt.resultEntityId!,
    receipt.resultVersionId,
    receipt.activityEventId!,
    requestDigest,
  );
  return { task, activityEventId: receipt.activityEventId! };
}

async function replayTask(
  tx: SecondBrainTransaction,
  operation: string,
  key: string,
  requestDigest: string,
  expectedEntityId: string | null = null,
): Promise<Task | null> {
  return (
    await replayTaskEffect(tx, operation, key, requestDigest, expectedEntityId)
  )?.task ?? null;
}

async function insertTaskGoalLinks(
  tx: SecondBrainTransaction,
  taskId: string,
  versionId: string,
  links: readonly TaskGoalLink[],
  now: Date,
): Promise<void> {
  if (links.length === 0) return;
  await tx.insert(taskGoalLinks).values(
    links.map((link) => ({
      taskId,
      goalId: link.goalId,
      basis: link.basis,
      confidence: link.confidence,
      createdAt: now,
    })),
  );
  await tx.insert(taskVersionGoalLinks).values(
    links.map((link) => ({
      taskVersionId: versionId,
      goalId: link.goalId,
      basis: link.basis,
      confidence: link.confidence,
    })),
  );
}

export async function createTaskInTransaction(
  tx: SecondBrainTransaction,
  access: BrainAccessContext,
  input: TaskCreateInput,
  signal: AbortSignal,
): Promise<CreatedTaskEffect | null> {
  await authorizeBrainTransaction(tx, access, "editor", signal);
  const normalized = {
    listId: input.listId,
    title: requiredText(input.title, "title", 500),
    description: optionalText(input.description, "description", 20_000),
    priority: z.enum(taskPriorities).parse(input.priority),
    dueAt: dateInput(input.dueAt, "dueAt"),
    projectId: input.projectId,
    goalLinks: normalizeGoalLinks(input.goalLinks),
    idempotencyKey: idempotencyKey(input.idempotencyKey),
  } as const;
  const requestDigest = digest({
    operation: operationNames.createTask,
    input: {
      ...normalized,
      dueAt: iso(normalized.dueAt),
      idempotencyKey: undefined,
    },
  });
  const replay = await replayTaskEffect(
    tx,
    operationNames.createTask,
    normalized.idempotencyKey,
    requestDigest,
  );
  if (replay !== null) return replay;
  if (!(await validateTaskReferences(tx, normalized))) return null;
  signal.throwIfAborted();

  const now = await transactionTime(tx);
  const taskId = randomUUID();
  const versionId = randomUUID();
  const eventId = randomUUID();
  const claimed = await claimEvent(tx, access, {
    id: eventId,
    entityType: "task",
    entityId: taskId,
    action: "created",
    now,
    changedFields: [
      "listId",
      "title",
      "description",
      "status",
      "priority",
      "dueAt",
      "projectId",
      "goalLinks",
    ],
    afterVersionId: versionId,
    requestDigest,
    operation: operationNames.createTask,
    idempotencyKey: normalized.idempotencyKey,
  });
  if (!claimed) {
    const concurrentReplay = await replayTaskEffect(
      tx,
      operationNames.createTask,
      normalized.idempotencyKey,
      requestDigest,
    );
    if (concurrentReplay === null) throw new TaskStoreIdempotencyConflictError();
    return concurrentReplay;
  }

  const inserted = await tx
    .insert(tasks)
    .values({
      id: taskId,
      listId: normalized.listId,
      projectId: normalized.projectId,
      title: normalized.title,
      description: normalized.description,
      status: "todo",
      priority: normalized.priority,
      dueAt: normalized.dueAt,
      completedAt: null,
      historyVersion: 1,
      historyCompleteFrom: now,
      ...actorColumns(access),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (inserted.length !== 1) throw contract("The task projection was not persisted.");
  await tx.insert(taskVersions).values({
    id: versionId,
    taskId,
    versionNumber: 1,
    operation: "created",
    origin: "native",
    listId: normalized.listId,
    projectId: normalized.projectId,
    title: normalized.title,
    description: normalized.description,
    status: "todo",
    priority: normalized.priority,
    dueAt: normalized.dueAt,
    completedAt: null,
    effectiveAt: now,
    recordedAt: now,
    changedFields: [
      "listId",
      "title",
      "description",
      "status",
      "priority",
      "dueAt",
      "projectId",
      "goalLinks",
    ],
    activityEventId: eventId,
  });
  await insertTaskGoalLinks(tx, taskId, versionId, normalized.goalLinks, now);
  await saveReceipt(tx, {
    operation: operationNames.createTask,
    idempotencyKey: normalized.idempotencyKey,
    requestDigest,
    entityType: "task",
    entityId: taskId,
    versionId,
    eventId,
    now,
  });
  signal.throwIfAborted();
  return {
    task: decodeTask(inserted[0], normalized.goalLinks),
    activityEventId: eventId,
  };
}

function changedFields(
  current: z.infer<typeof taskRowSchema>,
  next: {
    readonly title: string;
    readonly description: string | null;
    readonly status: TaskStatus;
    readonly priority: TaskPriority;
    readonly dueAt: Date | null;
    readonly projectId: string | null;
  },
  goalLinksChanged: boolean,
): readonly string[] {
  const result: string[] = [];
  if (current.title !== next.title) result.push("title");
  if (current.description !== next.description) result.push("description");
  if (current.status !== next.status) result.push("status");
  if (current.priority !== next.priority) result.push("priority");
  if (iso(current.dueAt) !== iso(next.dueAt)) result.push("dueAt");
  if (current.projectId !== next.projectId) result.push("projectId");
  if (goalLinksChanged) result.push("goalLinks");
  return result;
}

function lifecycle(
  current: TaskStatus,
  next: TaskStatus,
): { readonly action: "updated" | "started" | "completed" | "reopened" | "canceled"; readonly operation: VersionOperation } {
  if (current !== "done" && next === "done") return { action: "completed", operation: "completed" };
  if (current !== "canceled" && next === "canceled") return { action: "canceled", operation: "canceled" };
  if (current === "todo" && next === "in_progress") return { action: "started", operation: "started" };
  if ((current === "done" || current === "canceled") && (next === "todo" || next === "in_progress")) {
    return { action: "reopened", operation: "reopened" };
  }
  return { action: "updated", operation: "updated" };
}

function currentCursor(cursor: CursorPosition | null) {
  if (cursor === null) return undefined;
  const timestamp = dateInput(cursor.ts, "cursor.ts")!;
  return or(
    lt(tasks.updatedAt, timestamp),
    and(eq(tasks.updatedAt, timestamp), lt(tasks.id, cursor.id)),
  );
}

function coverage(asOf: string | null, incomplete = false): TemporalCoverage {
  return {
    completeFrom: null,
    requestedAsOf: asOf,
    complete: !incomplete,
    warnings: incomplete
      ? ["Some task history was permanently erased for privacy, so this historical result is incomplete."]
      : [],
  };
}

export class DrizzleTaskStore implements TaskStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async createTaskList(
    access: BrainAccessContext,
    input: Parameters<TaskStore["createTaskList"]>[1],
    signal: AbortSignal,
  ): Promise<TaskList> {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "editor", signal);
      const name = requiredText(input.name, "name", 200);
      const description = optionalText(input.description, "description", 20_000);
      const key = idempotencyKey(input.idempotencyKey);
      const requestDigest = digest({
        operation: operationNames.createList,
        input: { name, description },
      });
      const receipt = await findReceipt(tx, operationNames.createList, key);
      if (receipt !== null) {
        validateReceipt(receipt, operationNames.createList, requestDigest, "task_list");
        await validateUnversionedReceiptEvent(tx, receipt, {
          requestDigest,
          entityType: "task_list",
          entityId: receipt.resultEntityId!,
          action: "created",
        });
        const rows = await tx
          .select()
          .from(taskLists)
          .where(eq(taskLists.id, receipt.resultEntityId!))
          .limit(2);
        if (rows.length !== 1) throw contract("The idempotent task list result is missing.");
        return decodeTaskList(rows[0]);
      }
      const now = await transactionTime(tx);
      const entityId = randomUUID();
      const eventId = randomUUID();
      if (
        !(await claimEvent(tx, access, {
          id: eventId,
          entityType: "task_list",
          entityId,
          action: "created",
          now,
          changedFields: ["name", "description"],
          afterVersionId: null,
          requestDigest,
          operation: operationNames.createList,
          idempotencyKey: key,
        }))
      ) {
        const concurrent = await findReceipt(
          tx,
          operationNames.createList,
          key,
        );
        if (concurrent === null) throw new TaskStoreIdempotencyConflictError();
        validateReceipt(concurrent, operationNames.createList, requestDigest, "task_list");
        await validateUnversionedReceiptEvent(tx, concurrent, {
          requestDigest,
          entityType: "task_list",
          entityId: concurrent.resultEntityId!,
          action: "created",
        });
        const replayRows = await tx
          .select()
          .from(taskLists)
          .where(eq(taskLists.id, concurrent.resultEntityId!))
          .limit(2);
        if (replayRows.length !== 1) {
          throw contract("The concurrent task list result is missing.");
        }
        return decodeTaskList(replayRows[0]);
      }
      const rows = await tx
        .insert(taskLists)
        .values({
          id: entityId,
          name,
          description,
          ...actorColumns(access),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await saveReceipt(tx, {
        operation: operationNames.createList,
        idempotencyKey: key,
        requestDigest,
        entityType: "task_list",
        entityId,
        versionId: null,
        eventId,
        now,
      });
      if (rows.length !== 1) throw contract("The task list was not persisted.");
      signal.throwIfAborted();
      return decodeTaskList(rows[0]);
    });
  }

  async listTaskLists(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<readonly TaskList[]> {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "viewer", signal);
      const rows = await tx
        .select()
        .from(taskLists)
        .orderBy(taskLists.createdAt, taskLists.id);
      signal.throwIfAborted();
      return rows.map(decodeTaskList);
    });
  }

  async createTask(
    access: BrainAccessContext,
    input: TaskCreateInput,
    signal: AbortSignal,
  ): Promise<Task | null> {
    const effect = await this.database.transaction((tx) =>
      createTaskInTransaction(tx, access, input, signal),
    );
    return effect?.task ?? null;
  }

  async listTasks(
    access: BrainAccessContext,
    input: Parameters<TaskStore["listTasks"]>[1],
    signal: AbortSignal,
  ): Promise<TemporalPage<Task>> {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "viewer", signal);
      if (input.asOf === null) {
        const predicates = [
          input.listId === null ? undefined : eq(tasks.listId, input.listId),
          input.status === null ? undefined : eq(tasks.status, input.status),
          input.projectId === null ? undefined : eq(tasks.projectId, input.projectId),
          currentCursor(input.cursor),
          input.goalId === null
            ? undefined
            : exists(
                tx
                  .select({ id: taskGoalLinks.taskId })
                  .from(taskGoalLinks)
                  .where(
                    and(
                      eq(taskGoalLinks.taskId, tasks.id),
                      eq(taskGoalLinks.goalId, input.goalId),
                    ),
                  ),
              ),
        ].filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
        const rows = await tx
          .select()
          .from(tasks)
          .where(and(...predicates))
          .orderBy(desc(tasks.updatedAt), desc(tasks.id))
          .limit(input.limit + 1);
        const pageRows = rows.slice(0, input.limit);
        const links = await currentGoalLinks(
          tx,
          pageRows.map((row) => row.id),
        );
        const items = pageRows.map((row) => decodeTask(row, links.get(row.id) ?? []));
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
        .selectDistinctOn([taskVersions.taskId], {
          id: tasks.id,
          listId: taskVersions.listId,
          projectId: taskVersions.projectId,
          title: taskVersions.title,
          description: taskVersions.description,
          status: taskVersions.status,
          priority: taskVersions.priority,
          dueAt: taskVersions.dueAt,
          completedAt: taskVersions.completedAt,
          historyVersion: taskVersions.versionNumber,
          historyCompleteFrom: tasks.historyCompleteFrom,
          actorKind: activityEvents.actorKind,
          actorAccountId: activityEvents.actorAccountId,
          actorClientId: activityEvents.actorClientId,
          actorSource: activityEvents.actorSource,
          createdAt: tasks.createdAt,
          updatedAt: taskVersions.recordedAt,
          // Aliased so the subquery output does not carry two "id" columns.
          versionId: sql<string>`${taskVersions.id}`.as("version_id"),
        })
        .from(taskVersions)
        .innerJoin(tasks, eq(tasks.id, taskVersions.taskId))
        .innerJoin(activityEvents, eq(activityEvents.id, taskVersions.activityEventId))
        .where(lte(taskVersions.effectiveAt, asOf))
        .orderBy(taskVersions.taskId, desc(taskVersions.effectiveAt), desc(taskVersions.versionNumber))
        .as("visible_tasks");
      const cursorTime = input.cursor === null ? null : dateInput(input.cursor.ts, "cursor.ts")!;
      const predicates = [
        input.listId === null ? undefined : eq(visible.listId, input.listId),
        input.status === null ? undefined : eq(visible.status, input.status),
        input.projectId === null ? undefined : eq(visible.projectId, input.projectId),
        cursorTime === null
          ? undefined
          : or(
              lt(visible.updatedAt, cursorTime),
              and(eq(visible.updatedAt, cursorTime), lt(visible.id, input.cursor!.id)),
            ),
        input.goalId === null
          ? undefined
          : exists(
              tx
                .select({ id: taskVersionGoalLinks.taskVersionId })
                .from(taskVersionGoalLinks)
                .where(
                  and(
                    eq(taskVersionGoalLinks.taskVersionId, visible.versionId),
                    eq(taskVersionGoalLinks.goalId, input.goalId),
                  ),
                ),
            ),
      ].filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
      const rows = await tx
        .select()
        .from(visible)
        .where(predicates.length === 0 ? undefined : and(...predicates))
        .orderBy(desc(visible.updatedAt), desc(visible.id))
        .limit(input.limit + 1);
      const pageRows = rows.slice(0, input.limit);
      const links = await versionGoalLinks(
        tx,
        pageRows.map((row) => row.versionId),
      );
      const items = pageRows.map((row) => decodeTask(row, links.get(row.versionId) ?? []));
      const erased = await tx
        .select({ id: activityEvents.id })
        .from(activityEvents)
        .where(
          and(
            eq(activityEvents.entityType, "task"),
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

  async updateTask(
    access: BrainAccessContext,
    id: string,
    changes: Parameters<TaskStore["updateTask"]>[2],
    signal: AbortSignal,
  ): Promise<Task | null> {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "editor", signal);
      const key = idempotencyKey(changes.precondition.idempotencyKey);
      const normalizedGoalLinks =
        changes.goalLinks === undefined ? undefined : normalizeGoalLinks(changes.goalLinks);
      const normalizedChanges = {
        title:
          changes.title === undefined
            ? undefined
            : requiredText(changes.title, "title", 500),
        description:
          changes.description === undefined
            ? undefined
            : optionalText(changes.description, "description", 20_000),
        status:
          changes.status === undefined ? undefined : z.enum(taskStatuses).parse(changes.status),
        priority:
          changes.priority === undefined
            ? undefined
            : z.enum(taskPriorities).parse(changes.priority),
        dueAt:
          changes.dueAt === undefined ? undefined : dateInput(changes.dueAt, "dueAt"),
        projectId: changes.projectId,
        goalLinks: normalizedGoalLinks,
      } as const;
      const requestDigest = digest({
        operation: operationNames.updateTask,
        id,
        changes: {
          title:
            normalizedChanges.title === undefined
              ? [false]
              : [true, normalizedChanges.title],
          description:
            normalizedChanges.description === undefined
              ? [false]
              : [true, normalizedChanges.description],
          status:
            normalizedChanges.status === undefined
              ? [false]
              : [true, normalizedChanges.status],
          priority:
            normalizedChanges.priority === undefined
              ? [false]
              : [true, normalizedChanges.priority],
          dueAt:
            normalizedChanges.dueAt === undefined
              ? [false]
              : [true, iso(normalizedChanges.dueAt)],
          projectId:
            normalizedChanges.projectId === undefined
              ? [false]
              : [true, normalizedChanges.projectId],
          goalLinks:
            normalizedChanges.goalLinks === undefined
              ? [false]
              : [true, normalizedChanges.goalLinks],
          expectedVersion: changes.precondition.expectedVersion,
        },
      });
      const replay = await replayTask(
        tx,
        operationNames.updateTask,
        key,
        requestDigest,
        id,
      );
      if (replay !== null) return replay;
      const currentRows = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .limit(2)
        .for("update");
      if (currentRows.length === 0) {
        const concurrentReplay = await replayTask(
          tx,
          operationNames.updateTask,
          key,
          requestDigest,
          id,
        );
        return concurrentReplay;
      }
      if (currentRows.length !== 1) throw contract("Task projection lookup was not unique.");
      const afterLockReplay = await replayTask(
        tx,
        operationNames.updateTask,
        key,
        requestDigest,
        id,
      );
      if (afterLockReplay !== null) return afterLockReplay;
      const parsed = taskRowSchema.safeParse(currentRows[0]);
      if (!parsed.success) throw contract("Invalid task projection row.", parsed.error);
      const current = parsed.data;
      if (current.historyVersion !== changes.precondition.expectedVersion) return null;
      const previousLinks = await currentGoalLinks(tx, [id]);
      const nextLinks = normalizedGoalLinks ?? previousLinks.get(id) ?? [];
      const now = await transactionTime(tx);
      const nextStatus = normalizedChanges.status ?? current.status;
      const next = {
        title:
          normalizedChanges.title === undefined ? current.title : normalizedChanges.title,
        description:
          normalizedChanges.description === undefined
            ? current.description
            : normalizedChanges.description,
        status: nextStatus,
        priority: normalizedChanges.priority ?? current.priority,
        dueAt:
          normalizedChanges.dueAt === undefined ? current.dueAt : normalizedChanges.dueAt,
        projectId:
          normalizedChanges.projectId === undefined
            ? current.projectId
            : normalizedChanges.projectId,
        completedAt:
          nextStatus === "done"
            ? current.status === "done"
              ? current.completedAt
              : now
            : null,
      } as const;
      if (
        !(await validateTaskReferences(tx, {
          listId: current.listId,
          projectId: next.projectId,
          goalLinks: nextLinks,
        }))
      ) {
        return null;
      }
      const fields = changedFields(current, next, normalizedGoalLinks !== undefined);
      const state = lifecycle(current.status, next.status);
      const versionId = randomUUID();
      const eventId = randomUUID();
      if (
        !(await claimEvent(tx, access, {
          id: eventId,
          entityType: "task",
          entityId: id,
          action: state.action,
          now,
          changedFields: fields,
          afterVersionId: versionId,
          requestDigest,
          operation: operationNames.updateTask,
          idempotencyKey: key,
        }))
      ) {
        const concurrentReplay = await replayTask(
          tx,
          operationNames.updateTask,
          key,
          requestDigest,
          id,
        );
        if (concurrentReplay === null) throw new TaskStoreIdempotencyConflictError();
        return concurrentReplay;
      }
      const updatedRows = await tx
        .update(tasks)
        .set({
          title: next.title,
          description: next.description,
          status: next.status,
          priority: next.priority,
          dueAt: next.dueAt,
          projectId: next.projectId,
          completedAt: next.completedAt,
          historyVersion: current.historyVersion + 1,
          ...actorColumns(access),
          updatedAt: now,
        })
        .where(
          and(
            eq(tasks.id, id),
            eq(tasks.historyVersion, changes.precondition.expectedVersion),
          ),
        )
        .returning();
      if (updatedRows.length !== 1) throw contract("The locked task update was lost.");
      if (normalizedGoalLinks !== undefined) {
        await tx
          .delete(taskGoalLinks)
          .where(eq(taskGoalLinks.taskId, id));
      }
      await tx.insert(taskVersions).values({
        id: versionId,
        taskId: id,
        versionNumber: current.historyVersion + 1,
        operation: state.operation,
        origin: "native",
        listId: current.listId,
        projectId: next.projectId,
        title: next.title,
        description: next.description,
        status: next.status,
        priority: next.priority,
        dueAt: next.dueAt,
        completedAt: next.completedAt,
        effectiveAt: now,
        recordedAt: now,
        changedFields: [...fields],
        activityEventId: eventId,
      });
      if (normalizedGoalLinks !== undefined) {
        await insertTaskGoalLinks(tx, id, versionId, nextLinks, now);
      } else if (nextLinks.length > 0) {
        await tx.insert(taskVersionGoalLinks).values(
          nextLinks.map((link) => ({
            taskVersionId: versionId,
            goalId: link.goalId,
            basis: link.basis,
            confidence: link.confidence,
          })),
        );
      }
      await saveReceipt(tx, {
        operation: operationNames.updateTask,
        idempotencyKey: key,
        requestDigest,
        entityType: "task",
        entityId: id,
        versionId,
        eventId,
        now,
      });
      signal.throwIfAborted();
      return decodeTask(updatedRows[0], nextLinks);
    });
  }

  async deleteTask(
    access: BrainAccessContext,
    id: string,
    input: Parameters<TaskStore["deleteTask"]>[2],
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "admin", signal);
      const key = idempotencyKey(input.idempotencyKey);
      const requestDigest = digest({
        operation: operationNames.deleteTask,
        id,
      });
      const receipt = await findReceipt(tx, operationNames.deleteTask, key);
      if (receipt !== null) {
        validateReceipt(receipt, operationNames.deleteTask, requestDigest, "task");
        if (receipt.resultEntityId !== id) throw new TaskStoreIdempotencyConflictError();
        await validateUnversionedReceiptEvent(tx, receipt, {
          requestDigest,
          entityType: "task",
          entityId: id,
          action: "deleted",
        });
        return true;
      }
      const rows = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, id))
        .limit(2)
        .for("update");
      if (rows.length === 0) {
        const concurrent = await findReceipt(tx, operationNames.deleteTask, key);
        if (concurrent === null) return false;
        validateReceipt(concurrent, operationNames.deleteTask, requestDigest, "task");
        await validateUnversionedReceiptEvent(tx, concurrent, {
          requestDigest,
          entityType: "task",
          entityId: id,
          action: "deleted",
        });
        return concurrent.resultEntityId === id;
      }
      if (rows.length !== 1) throw contract("Task delete lookup was not unique.");
      const now = await transactionTime(tx);
      const eventId = randomUUID();
      if (
        !(await claimEvent(tx, access, {
          id: eventId,
          entityType: "task",
          entityId: id,
          action: "deleted",
          now,
          changedFields: ["deleted"],
          afterVersionId: null,
          requestDigest,
          operation: operationNames.deleteTask,
          idempotencyKey: key,
        }))
      ) {
        throw new TaskStoreIdempotencyConflictError();
      }
      const deleted = await tx
        .delete(tasks)
        .where(eq(tasks.id, id))
        .returning({ id: tasks.id });
      if (deleted.length !== 1) throw contract("The locked task delete was lost.");
      await saveReceipt(tx, {
        operation: operationNames.deleteTask,
        idempotencyKey: key,
        requestDigest,
        entityType: "task",
        entityId: id,
        versionId: null,
        eventId,
        now,
      });
      signal.throwIfAborted();
      return true;
    });
  }

  async listTaskHistory(
    access: BrainAccessContext,
    input: Parameters<TaskStore["listTaskHistory"]>[1],
    signal: AbortSignal,
  ): Promise<TemporalPage<TaskVersion>> {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "viewer", signal);
      const from = dateInput(input.from, "from");
      const to = dateInput(input.to, "to");
      const cursorTime = input.cursor === null ? null : dateInput(input.cursor.ts, "cursor.ts")!;
      const predicates = [
        eq(taskVersions.taskId, input.taskId),
        from === null ? undefined : gte(taskVersions.effectiveAt, from),
        to === null ? undefined : lte(taskVersions.effectiveAt, to),
        cursorTime === null
          ? undefined
          : or(
              lt(taskVersions.recordedAt, cursorTime),
              and(eq(taskVersions.recordedAt, cursorTime), lt(taskVersions.id, input.cursor!.id)),
            ),
      ].filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
      const rows = await tx
        .select({
          id: taskVersions.id,
          taskId: taskVersions.taskId,
          versionNumber: taskVersions.versionNumber,
          operation: taskVersions.operation,
          listId: taskVersions.listId,
          projectId: taskVersions.projectId,
          title: taskVersions.title,
          description: taskVersions.description,
          status: taskVersions.status,
          priority: taskVersions.priority,
          dueAt: taskVersions.dueAt,
          completedAt: taskVersions.completedAt,
          effectiveAt: taskVersions.effectiveAt,
          recordedAt: taskVersions.recordedAt,
          changedFields: taskVersions.changedFields,
          activityEventId: taskVersions.activityEventId,
          actorKind: activityEvents.actorKind,
          actorAccountId: activityEvents.actorAccountId,
          actorClientId: activityEvents.actorClientId,
          actorSource: activityEvents.actorSource,
        })
        .from(taskVersions)
        .innerJoin(activityEvents, eq(activityEvents.id, taskVersions.activityEventId))
        .where(and(...predicates))
        .orderBy(desc(taskVersions.recordedAt), desc(taskVersions.id))
        .limit(input.limit + 1);
      const pageRows = rows.slice(0, input.limit);
      const links = await versionGoalLinks(
        tx,
        pageRows.map((row) => row.id),
      );
      const items = pageRows.map((row): TaskVersion => {
        const parsed = taskVersionRowSchema.safeParse(row);
        if (!parsed.success) throw contract("Invalid task version row.", parsed.error);
        const value = parsed.data;
        const goalLinks = links.get(value.id) ?? [];
        return {
          id: value.id,
          taskId: value.taskId,
          version: value.versionNumber,
          operation: value.operation,
          snapshot: {
            id: value.taskId,
            listId: value.listId,
            title: value.title,
            description: value.description,
            status: value.status,
            priority: value.priority,
            dueAt: iso(value.dueAt),
            completedAt: iso(value.completedAt),
            projectId: value.projectId,
            goalLinks,
          },
          goalLinks,
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
            eq(activityEvents.entityType, "task"),
            eq(activityEvents.entityId, input.taskId),
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

  async createTaskRelation(
    access: BrainAccessContext,
    input: Parameters<TaskStore["createTaskRelation"]>[1],
    signal: AbortSignal,
  ): Promise<TaskRelation | null> {
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "editor", signal);
      if (input.fromTaskId === input.toTaskId) throw contract("A task cannot relate to itself.");
      const kind = z.enum(taskRelationKinds).parse(input.kind);
      const key = idempotencyKey(input.idempotencyKey);
      const requestDigest = digest({
        operation: operationNames.createRelation,
        fromTaskId: input.fromTaskId,
        toTaskId: input.toTaskId,
        kind,
      });
      const replay = await findReceipt(tx, operationNames.createRelation, key);
      if (replay !== null) {
        validateReceipt(replay, operationNames.createRelation, requestDigest, "task_relation");
        await validateUnversionedReceiptEvent(tx, replay, {
          requestDigest,
          entityType: "task_relation",
          entityId: replay.resultEntityId!,
          action: "linked",
        });
        const rows = await tx
          .select()
          .from(taskRelations)
          .where(eq(taskRelations.id, replay.resultEntityId!))
          .limit(2);
        if (rows.length !== 1) throw contract("The idempotent task relation is missing.");
        return decodeRelation(rows[0]);
      }
      const taskIds = [input.fromTaskId, input.toTaskId].sort();
      const locked = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(inArray(tasks.id, taskIds))
        .orderBy(tasks.id)
        .for("update");
      if (locked.length !== 2) return null;
      const concurrentReplay = await findReceipt(
        tx,
        operationNames.createRelation,
        key,
      );
      if (concurrentReplay !== null) {
        validateReceipt(
          concurrentReplay,
          operationNames.createRelation,
          requestDigest,
          "task_relation",
        );
        await validateUnversionedReceiptEvent(tx, concurrentReplay, {
          requestDigest,
          entityType: "task_relation",
          entityId: concurrentReplay.resultEntityId!,
          action: "linked",
        });
        const rows = await tx
          .select()
          .from(taskRelations)
          .where(eq(taskRelations.id, concurrentReplay.resultEntityId!))
          .limit(1);
        if (rows.length !== 1) throw contract("The concurrent task relation is missing.");
        return decodeRelation(rows[0]);
      }
      const existing = await tx
        .select()
        .from(taskRelations)
        .where(
          and(
            eq(taskRelations.fromTaskId, input.fromTaskId),
            eq(taskRelations.toTaskId, input.toTaskId),
            eq(taskRelations.kind, kind),
            isNull(taskRelations.retractedAt),
          ),
        )
        .limit(2);
      if (existing.length > 1) throw contract("Active task relation lookup was not unique.");
      const now = await transactionTime(tx);
      const entityId = existing[0]?.id ?? randomUUID();
      const eventId = randomUUID();
      if (
        !(await claimEvent(tx, access, {
          id: eventId,
          entityType: "task_relation",
          entityId,
          action: "linked",
          now,
          changedFields: ["fromTaskId", "toTaskId", "kind"],
          afterVersionId: null,
          requestDigest,
          operation: operationNames.createRelation,
          idempotencyKey: key,
        }))
      ) {
        throw new TaskStoreIdempotencyConflictError();
      }
      let relation: TaskRelation;
      if (existing[0] !== undefined) {
        relation = decodeRelation(existing[0]);
      } else {
        const inserted = await tx
          .insert(taskRelations)
          .values({
            id: entityId,
            fromTaskId: input.fromTaskId,
            toTaskId: input.toTaskId,
            kind,
            ...actorColumns(access),
            createdAt: now,
            retractedAt: null,
          })
          .returning();
        if (inserted.length !== 1) throw contract("The task relation was not persisted.");
        relation = decodeRelation(inserted[0]);
      }
      await saveReceipt(tx, {
        operation: operationNames.createRelation,
        idempotencyKey: key,
        requestDigest,
        entityType: "task_relation",
        entityId,
        versionId: null,
        eventId,
        now,
      });
      signal.throwIfAborted();
      return relation;
    });
  }
}
