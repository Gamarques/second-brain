import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { mutationSources, projectStatuses } from "../../domain.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  CursorPosition,
  Page,
  Project,
  ProjectStatus,
  ProjectStore,
} from "../../domain.js";
import { projects } from "../schema/content.js";
import { accounts } from "../schema/identity.js";
import { activityEvents, mutationReceipts } from "../schema/temporal.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";

const CREATE_OPERATION = "project.create";
const UPDATE_OPERATION = "project.update";
type ProjectMutationOperation = typeof CREATE_OPERATION | typeof UPDATE_OPERATION;

const actorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("account"),
    accountId: z.string().uuid().nullable(),
    clientId: z.null(),
    source: z.enum(mutationSources),
  }),
  z
    .object({
      kind: z.literal("oauth_client"),
      accountId: z.string().uuid().nullable(),
      clientId: z.string().min(1).max(500).nullable(),
      source: z.enum(mutationSources),
    })
    .superRefine((value, context) => {
      if ((value.accountId === null) !== (value.clientId === null)) {
        context.addIssue({
          code: "custom",
          message: "OAuth attribution must retain or redact both identifiers.",
        });
      }
    }),
  z.object({
    kind: z.literal("import"),
    accountId: z.string().uuid().nullable(),
    clientId: z.null(),
    source: z.enum(mutationSources),
  }),
  z.object({
    kind: z.enum(["dreaming", "system"]),
    accountId: z.null(),
    clientId: z.null(),
    source: z.enum(mutationSources),
  }),
]);

const projectResultSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(300),
  description: z.string().max(10_000).nullable(),
  status: z.enum(projectStatuses),
  version: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const projectRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(300),
  description: z.string().max(10_000).nullable(),
  status: z.enum(projectStatuses),
  version: z.number().int().positive(),
  actorKind: z.enum(["account", "oauth_client", "import", "dreaming", "system"]),
  actorAccountId: z.string().uuid().nullable(),
  actorClientId: z.string().min(1).max(500).nullable(),
  actorSource: z.enum(mutationSources),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectDatabase = SecondBrainDatabase;
export type ProjectMutationTransaction = SecondBrainTransaction;

export class ProjectStoreContractError extends Error {
  readonly code = "PROJECT_STORE_CONTRACT_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectStoreContractError";
  }
}

export class ProjectStoreIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("The idempotency key was already used with a different project request.");
    this.name = "ProjectStoreIdempotencyConflictError";
  }
}

export class ProjectNameConflictError extends Error {
  readonly code = "PROJECT_NAME_CONFLICT";

  constructor() {
    super("A project with this name already exists in the brain.");
    this.name = "ProjectNameConflictError";
  }
}

export class ProjectVersionConflictError extends Error {
  readonly code = "PROJECT_VERSION_CONFLICT";

  constructor() {
    super("Project version conflict.");
    this.name = "ProjectVersionConflictError";
  }
}

function failIntegrity(detail: string, cause?: unknown): never {
  throw new ProjectStoreContractError(`Invalid project persistence data: ${detail}.`, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function actorFromRow(row: z.infer<typeof projectRowSchema>): ActorAttribution {
  const parsed = actorSchema.safeParse({
    kind: row.actorKind,
    accountId: row.actorAccountId,
    clientId: row.actorClientId,
    source: row.actorSource,
  });
  if (!parsed.success) failIntegrity("actor attribution is inconsistent", parsed.error);
  return parsed.data as ActorAttribution;
}

export function decodeProjectRow(row: unknown): Project {
  const parsed = projectRowSchema.safeParse(row);
  if (!parsed.success) failIntegrity("row validation failed", parsed.error);
  const value = parsed.data;
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    status: value.status,
    version: value.version,
    provenance: actorFromRow(value),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

type ProjectReceiptResult = Omit<Project, "provenance">;

function decodeProjectResult(value: unknown): ProjectReceiptResult {
  const parsed = projectResultSchema.safeParse(value);
  if (!parsed.success) failIntegrity("mutation receipt result is invalid", parsed.error);
  return parsed.data;
}

function projectReceiptResult(project: Project): ProjectReceiptResult {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    version: project.version,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function requireName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 300) {
    throw new ProjectStoreContractError("Project names must contain 1 to 300 characters.");
  }
  return trimmed;
}

function requireDescription(value: string | null): string | null {
  if (value !== null && value.length > 10_000) {
    throw new ProjectStoreContractError(
      "Project descriptions must contain at most 10,000 characters.",
    );
  }
  return value;
}

function requireIdempotencyKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new ProjectStoreContractError(
      "Project idempotency keys must contain 1 to 200 characters.",
    );
  }
  return trimmed;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isConstraintViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

function cursorCondition(cursor: CursorPosition | null) {
  if (cursor === null) return undefined;
  const timestamp = new Date(cursor.ts);
  if (!Number.isFinite(timestamp.valueOf()) || cursor.id === "") {
    throw new ProjectStoreContractError("The project cursor is invalid.");
  }
  return or(
    gt(projects.createdAt, timestamp),
    and(eq(projects.createdAt, timestamp), gt(projects.id, cursor.id)),
  );
}

async function transactionTime(
  tx: SecondBrainTransaction,
  access: BrainAccessContext,
): Promise<Date> {
  // Raw SQL fragments bypass the driver's Date mapping, so the timestamp
  // travels as a canonical UTC string and is revived here.
  const rows = await tx
    .select({
      nowIso: sql<string>`to_char(date_trunc('milliseconds', transaction_timestamp()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(accounts)
    .where(
      and(eq(accounts.id, access.accountId), eq(accounts.status, "active")),
    )
    .limit(2);
  const time = rows.length === 1 ? new Date(rows[0]!.nowIso) : null;
  if (time === null || Number.isNaN(time.getTime())) {
    failIntegrity("transaction timestamp is invalid");
  }
  return time;
}

async function readReceipt(
  tx: SecondBrainTransaction,
  access: BrainAccessContext,
  operation: ProjectMutationOperation,
  idempotencyKey: string,
  requestDigest: string,
): Promise<Project | null> {
  const rows = await tx
    .select({
      requestDigest: mutationReceipts.requestDigest,
      resultEntityType: mutationReceipts.resultEntityType,
      resultEntityId: mutationReceipts.resultEntityId,
      resultVersionId: mutationReceipts.resultVersionId,
      result: mutationReceipts.result,
      activityEventId: mutationReceipts.activityEventId,
    })
    .from(mutationReceipts)
    .where(
      and(
        eq(mutationReceipts.operation, operation),
        eq(mutationReceipts.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(2);
  if (rows.length === 0) return null;
  if (rows.length !== 1) failIntegrity("mutation receipt is not unique");
  const row = rows[0]!;
  if (
    row.requestDigest !== requestDigest ||
    row.resultEntityType !== "project" ||
    row.resultVersionId !== null
  ) {
    throw new ProjectStoreIdempotencyConflictError();
  }
  const project = decodeProjectResult(row.result);
  if (row.resultEntityId !== project.id) {
    failIntegrity("mutation receipt points to a different project");
  }
  if (row.activityEventId === null) failIntegrity("receipt activity event is missing");
  const eventRows = await tx
    .select({
      kind: activityEvents.actorKind,
      accountId: activityEvents.actorAccountId,
      clientId: activityEvents.actorClientId,
      source: activityEvents.actorSource,
      entityType: activityEvents.entityType,
      entityId: activityEvents.entityId,
      action: activityEvents.action,
      requestDigest: activityEvents.requestDigest,
      idempotencyKey: activityEvents.idempotencyKey,
    })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.id, row.activityEventId),
      ),
    )
    .limit(2);
  if (eventRows.length !== 1) failIntegrity("receipt activity event is invalid");
  const event = eventRows[0]!;
  const expectedAction = operation === CREATE_OPERATION ? "created" : "updated";
  if (
    event.entityType !== "project" ||
    event.entityId !== project.id ||
    event.action !== expectedAction ||
    event.requestDigest !== requestDigest ||
    event.idempotencyKey !== `${operation}:${idempotencyKey}`
  ) {
    failIntegrity("receipt activity event points to another mutation");
  }
  const actor = actorSchema.safeParse(event);
  if (!actor.success) failIntegrity("receipt actor is invalid", actor.error);
  return { ...project, provenance: actor.data as ActorAttribution };
}

async function writeReceipt(
  tx: SecondBrainTransaction,
  access: BrainAccessContext,
  input: {
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly project: Project;
    readonly activityEventId: string | null;
    readonly createdAt: Date;
  },
): Promise<void> {
  const rows = await tx
    .insert(mutationReceipts)
    .values({
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      resultEntityType: "project",
      resultEntityId: input.project.id,
      resultVersionId: null,
      result: projectReceiptResult(input.project),
      activityEventId: input.activityEventId,
      createdAt: input.createdAt,
    })
    .returning({ id: mutationReceipts.id });
  if (rows.length !== 1) failIntegrity("mutation receipt was not persisted");
}

function eventValues(
  access: BrainAccessContext,
  input: {
    readonly id: string;
    readonly entityId: string;
    readonly action: "created" | "updated";
    readonly changedFields: readonly string[];
    readonly requestDigest: string;
    readonly idempotencyKey: string;
    readonly now: Date;
  },
) {
  return {
    id: input.id,
    entityType: "project" as const,
    entityId: input.entityId,
    action: input.action,
    occurredAt: input.now,
    effectiveAt: input.now,
    changedFields: [...input.changedFields],
    afterVersionId: null,
    contentHash: input.requestDigest,
    requestDigest: input.requestDigest,
    analysisAllowed: true,
    idempotencyKey: `${input.action === "created" ? CREATE_OPERATION : UPDATE_OPERATION}:${input.idempotencyKey}`,
    actorKind: access.actor.kind,
    actorAccountId: access.actor.accountId,
    actorClientId: access.actor.clientId,
    actorSource: access.actor.source,
    requestId: access.actor.requestId,
    correlationId: access.actor.correlationId,
    causationId: access.actor.causationId,
    dreamingRunId: access.actor.dreamingRunId,
    recordedAt: input.now,
    redactedAt: null,
  };
}

/** Internal transaction-scoped primitive used by atomic ingestion. */
export async function createProjectInTransaction(
  tx: SecondBrainTransaction,
  access: BrainAccessContext,
  input: Parameters<ProjectStore["createProject"]>[1],
  signal: AbortSignal,
): Promise<Project> {
  await authorizeBrainTransaction(tx, access, "editor", signal);
  const name = requireName(input.name);
  const description = requireDescription(input.description);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const requestDigest = digest({
    operation: CREATE_OPERATION,
    input: { name, description },
  });
  const replay = await readReceipt(
    tx,
    access,
    CREATE_OPERATION,
    idempotencyKey,
    requestDigest,
  );
  if (replay !== null) return replay;
  signal.throwIfAborted();

  const projectId = randomUUID();
  const eventId = randomUUID();
  const now = await transactionTime(tx, access);
  const eventRows = await tx
    .insert(activityEvents)
    .values(
      eventValues(access, {
        id: eventId,
        entityId: projectId,
        action: "created",
        changedFields: ["name", "description", "status"],
        requestDigest,
        idempotencyKey,
        now,
      }),
    )
    .onConflictDoNothing({
      target: [activityEvents.idempotencyKey],
    })
    .returning({ id: activityEvents.id });
  if (eventRows.length === 0) {
    const concurrentReplay = await readReceipt(
      tx,
      access,
      CREATE_OPERATION,
      idempotencyKey,
      requestDigest,
    );
    if (concurrentReplay === null) failIntegrity("idempotency claim has no receipt");
    return concurrentReplay;
  }
  if (eventRows.length !== 1) failIntegrity("activity event claim is not unique");

  const inserted = await tx
    .insert(projects)
    .values({
      id: projectId,
      name,
      description,
      status: "active",
      version: 1,
      actorKind: access.actor.kind,
      actorAccountId: access.actor.accountId,
      actorClientId: access.actor.clientId,
      actorSource: access.actor.source,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (inserted.length !== 1) failIntegrity("project insert did not return one row");
  const project = decodeProjectRow(inserted[0]);
  await writeReceipt(tx, access, {
    operation: CREATE_OPERATION,
    idempotencyKey,
    requestDigest,
    project,
    activityEventId: eventId,
    createdAt: now,
  });
  return project;
}

export class DrizzleProjectStore implements ProjectStore {
  constructor(private readonly database: ProjectDatabase) {}

  async createProject(
    access: BrainAccessContext,
    input: Parameters<ProjectStore["createProject"]>[1],
    signal: AbortSignal,
  ): Promise<Project> {
    signal.throwIfAborted();
    try {
      return await this.database.transaction((tx) =>
        createProjectInTransaction(tx, access, input, signal),
      );
    } catch (error) {
      if (isConstraintViolation(error, "projects_name_key")) {
        throw new ProjectNameConflictError();
      }
      throw error;
    }
  }

  async listProjects(
    access: BrainAccessContext,
    input: Parameters<ProjectStore["listProjects"]>[1],
    signal: AbortSignal,
  ): Promise<Page<Project>> {
    signal.throwIfAborted();
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new ProjectStoreContractError("Project page limits must be between 1 and 100.");
    }
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "viewer", signal);
      const rows = await tx
        .select()
        .from(projects)
        .where(
          and(
            input.status === null ? undefined : eq(projects.status, input.status),
            cursorCondition(input.cursor),
          ),
        )
        .orderBy(asc(projects.createdAt), asc(projects.id))
        .limit(input.limit + 1);
      signal.throwIfAborted();
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map(decodeProjectRow);
      const last = hasMore ? items.at(-1) : undefined;
      return {
        items,
        nextCursor: last === undefined ? null : { ts: last.createdAt, id: last.id },
      };
    });
  }

  async updateProject(
    access: BrainAccessContext,
    id: string,
    changes: Parameters<ProjectStore["updateProject"]>[2],
    signal: AbortSignal,
  ): Promise<Project | null> {
    signal.throwIfAborted();
    if (
      !Number.isInteger(changes.precondition.expectedVersion) ||
      changes.precondition.expectedVersion < 1
    ) {
      throw new ProjectStoreContractError("Expected project versions must be positive integers.");
    }
    const name = changes.name === undefined ? undefined : requireName(changes.name);
    const description =
      changes.description === undefined
        ? undefined
        : requireDescription(changes.description);
    if (name === undefined && description === undefined && changes.status === undefined) {
      throw new ProjectStoreContractError("At least one project change is required.");
    }
    const idempotencyKey = requireIdempotencyKey(changes.precondition.idempotencyKey);
    const requestDigest = digest({
      operation: UPDATE_OPERATION,
      id,
      expectedVersion: changes.precondition.expectedVersion,
      changes: {
        name: name === undefined ? { set: false } : { set: true, value: name },
        description:
          description === undefined
            ? { set: false }
            : { set: true, value: description },
        status:
          changes.status === undefined
            ? { set: false }
            : { set: true, value: changes.status },
      },
    });

    try {
      return await this.database.transaction(async (tx) => {
        await authorizeBrainTransaction(tx, access, "editor", signal);
        const replay = await readReceipt(
          tx,
          access,
          UPDATE_OPERATION,
          idempotencyKey,
          requestDigest,
        );
        if (replay !== null) return replay;

        const currentRows = await tx
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, id),
              eq(projects.version, changes.precondition.expectedVersion),
            ),
          )
          .for("update")
          .limit(2);
        if (currentRows.length === 0) {
          const concurrentReplay = await readReceipt(
            tx,
            access,
            UPDATE_OPERATION,
            idempotencyKey,
            requestDigest,
          );
          if (concurrentReplay !== null) return concurrentReplay;
          const existingRows = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.id, id))
            .limit(2);
          if (existingRows.length > 1) failIntegrity("entity lookup is not unique");
          if (existingRows.length === 1) throw new ProjectVersionConflictError();
          return null;
        }
        if (currentRows.length !== 1) failIntegrity("optimistic lookup is not unique");
        signal.throwIfAborted();
        const current = decodeProjectRow(currentRows[0]);
        const lockedReplay = await readReceipt(
          tx,
          access,
          UPDATE_OPERATION,
          idempotencyKey,
          requestDigest,
        );
        if (lockedReplay !== null) return lockedReplay;
        const nameChanged = name !== undefined && name !== current.name;
        const descriptionChanged =
          description !== undefined && description !== current.description;
        const statusChanged =
          changes.status !== undefined && changes.status !== current.status;
        const now = await transactionTime(tx, access);
        const changedFields = [
          ...(nameChanged ? ["name"] : []),
          ...(descriptionChanged ? ["description"] : []),
          ...(statusChanged ? ["status"] : []),
        ];
        if (changedFields.length === 0) {
          const noOpRows = await tx
            .update(projects)
            .set({
              actorKind: access.actor.kind,
              actorAccountId: access.actor.accountId,
              actorClientId: access.actor.clientId,
              actorSource: access.actor.source,
              updatedAt: now,
            })
            .where(
              and(
                eq(projects.id, id),
                eq(projects.version, changes.precondition.expectedVersion),
              ),
            )
            .returning();
          if (noOpRows.length !== 1) failIntegrity("project no-op did not affect one row");
          const project = decodeProjectRow(noOpRows[0]);
          const eventId = randomUUID();
          const eventRows = await tx
            .insert(activityEvents)
            .values(
              eventValues(access, {
                id: eventId,
                entityId: id,
                action: "updated",
                changedFields: [],
                requestDigest,
                idempotencyKey,
                now,
              }),
            )
            .onConflictDoNothing({
              target: [activityEvents.idempotencyKey],
            })
            .returning({ id: activityEvents.id });
          if (eventRows.length !== 1) {
            throw new ProjectStoreIdempotencyConflictError();
          }
          await writeReceipt(tx, access, {
            operation: UPDATE_OPERATION,
            idempotencyKey,
            requestDigest,
            project,
            activityEventId: eventId,
            createdAt: now,
          });
          return project;
        }
        const updatedRows = await tx
          .update(projects)
          .set({
            ...(nameChanged ? { name } : {}),
            ...(descriptionChanged ? { description } : {}),
            ...(statusChanged ? { status: changes.status } : {}),
            version: current.version + 1,
            actorKind: access.actor.kind,
            actorAccountId: access.actor.accountId,
            actorClientId: access.actor.clientId,
            actorSource: access.actor.source,
            updatedAt: now,
          })
          .where(
            and(
              eq(projects.id, id),
              eq(projects.version, changes.precondition.expectedVersion),
            ),
          )
          .returning();
        if (updatedRows.length !== 1) failIntegrity("project update did not affect one row");
        const project = decodeProjectRow(updatedRows[0]);
        const eventId = randomUUID();
        const eventRows = await tx
          .insert(activityEvents)
          .values(
            eventValues(access, {
              id: eventId,
              entityId: id,
              action: "updated",
              changedFields,
              requestDigest,
              idempotencyKey,
              now,
            }),
          )
          .onConflictDoNothing({
            target: [activityEvents.idempotencyKey],
          })
          .returning({ id: activityEvents.id });
        if (eventRows.length !== 1) {
          throw new ProjectStoreIdempotencyConflictError();
        }
        await writeReceipt(tx, access, {
          operation: UPDATE_OPERATION,
          idempotencyKey,
          requestDigest,
          project,
          activityEventId: eventId,
          createdAt: now,
        });
        return project;
      });
    } catch (error) {
      if (isConstraintViolation(error, "projects_name_key")) {
        throw new ProjectNameConflictError();
      }
      throw error;
    }
  }

  async findProjectByName(
    access: BrainAccessContext,
    name: string,
    signal: AbortSignal,
  ): Promise<Project | null> {
    signal.throwIfAborted();
    const normalizedName = requireName(name);
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "viewer", signal);
      const rows = await tx
        .select()
        .from(projects)
        .where(
          and(
            sql`lower(${projects.name}) = lower(${normalizedName})`,
          ),
        )
        .limit(2);
      signal.throwIfAborted();
      if (rows.length === 0) return null;
      if (rows.length !== 1) failIntegrity("name lookup is not unique");
      return decodeProjectRow(rows[0]);
    });
  }
}
