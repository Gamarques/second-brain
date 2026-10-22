import { createHash, randomUUID } from "node:crypto";

import {
  and,
  arrayContains,
  cosineDistance,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type {
  ActorAttribution,
  BrainAccessContext,
  BrainRole,
  ContentEmbedding,
  Memory,
  MemoryListResult,
  MemoryMatch,
  MemoryStore,
  MemoryWriteInput,
  MemoryWriteResult,
} from "../../domain.js";
import {
  MEMORY_EMBEDDING_RECIPE_VERSION,
  memoryEmbeddingRecipe,
} from "../../domain.js";
import { memories, memoryPeople, people, projects } from "../schema/content.js";
import { embeddingSpaces, memoryEmbeddings } from "../schema/embeddings.js";
import { accounts } from "../schema/identity.js";
import { activityEvents, mutationReceipts } from "../schema/temporal.js";
import { BrainAccessDeniedError } from "./access-store.js";
import { appendAdministrativeDomainAuditEvent } from "./audit-writer.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";

const WRITE_OPERATION = "memory.write";
const DELETE_OPERATION = "memory.delete";
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type MemoryDatabase = SecondBrainDatabase;
export type MemoryTransaction = SecondBrainTransaction;
type MemoryExecutor = Pick<
  SecondBrainDatabase,
  "delete" | "execute" | "insert" | "select" | "update"
>;

export class MutationReceiptConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("The idempotency key was already used with a different request.");
    this.name = "MutationReceiptConflictError";
  }
}

export class StoredDataIntegrityError extends Error {
  readonly code = "STORED_DATA_INTEGRITY_ERROR";

  constructor(message = "Stored data failed integrity validation.") {
    super(message);
    this.name = "StoredDataIntegrityError";
  }
}

export interface MemoryTransactionWriteResult {
  readonly result: MemoryWriteResult;
  readonly activityEventId: string;
}

function failIntegrity(message?: string): never {
  throw new StoredDataIntegrityError(message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestDigest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function requireIdempotencyKey(value: string): void {
  if (value.trim() === "" || value.length > 500) {
    throw new Error(
      "The idempotency key must contain between 1 and 500 characters.",
    );
  }
}

function requireInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO 8601 timestamp.`);
  }
  return parsed;
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new Error(`${field} must be a UUID.`);
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    failIntegrity(`${field} is invalid.`);
  }
  return value;
}

function requireDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    failIntegrity(`${field} is invalid.`);
  }
  return value;
}

function nullableDate(value: unknown, field: string): Date | null {
  return value === null ? null : requireDate(value, field);
}

function requireFiniteScore(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < -1 ||
    value > 1
  ) {
    failIntegrity("A vector score is invalid.");
  }
  return value;
}

function requireEmbeddingVector(
  embedding: ContentEmbedding,
  dimensions: number,
): readonly number[] {
  requireUuid(embedding.spaceId, "embedding.spaceId");
  if (!SHA256.test(embedding.contentHash)) {
    throw new Error(
      "embedding.contentHash must be a lowercase SHA-256 digest.",
    );
  }
  const norm = Math.hypot(...embedding.vector);
  if (
    embedding.vector.length !== dimensions ||
    embedding.vector.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(norm) ||
    norm === 0
  ) {
    throw new Error(
      `Expected a finite, non-zero ${dimensions}-dimension embedding.`,
    );
  }
  return embedding.vector;
}

function roleValues(required: BrainRole): readonly BrainRole[] {
  switch (required) {
    case "viewer":
      return ["viewer", "editor", "admin", "owner"];
    case "editor":
      return ["editor", "admin", "owner"];
    case "admin":
      return ["admin", "owner"];
    case "owner":
      return ["owner"];
  }
}

function accessGate(
  database: MemoryExecutor,
  access: BrainAccessContext,
  requiredRole: BrainRole,
) {
  return exists(
    database
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, access.accountId),
          eq(accounts.status, "active"),
          inArray(accounts.role, roleValues(requiredRole)),
        ),
      ),
  );
}

async function lock(
  database: MemoryExecutor,
  logicalKey: string,
): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${logicalKey}, 0))`,
  );
}

function actorValues(access: BrainAccessContext) {
  const actor = access.actor;
  return {
    actorKind: actor.kind,
    actorAccountId: actor.accountId,
    actorClientId: actor.kind === "oauth_client" ? actor.clientId : null,
    actorSource: actor.source,
  } as const;
}

function decodeActor(row: Record<string, unknown>): ActorAttribution {
  const kind = row.actorKind;
  const accountId = row.actorAccountId;
  const clientId = row.actorClientId;
  const source = row.actorSource;
  if (
    !["direct", "mcp_http", "automation", "import"].includes(
      typeof source === "string" ? source : "",
    ) ||
    (accountId !== null && typeof accountId !== "string") ||
    (clientId !== null && typeof clientId !== "string")
  ) {
    failIntegrity("Stored actor attribution is invalid.");
  }
  const common = { accountId, clientId, source } as const;
  if (kind === "account" && clientId === null)
    return { ...common, kind } as ActorAttribution;
  if (
    kind === "oauth_client" &&
    ((accountId !== null && typeof clientId === "string" && clientId !== "") ||
      (accountId === null && clientId === null))
  ) {
    return { ...common, kind } as ActorAttribution;
  }
  if (kind === "import" && clientId === null)
    return { ...common, kind } as ActorAttribution;
  if (
    (kind === "dreaming" || kind === "system") &&
    accountId === null &&
    clientId === null
  ) {
    return { ...common, kind } as ActorAttribution;
  }
  failIntegrity("Stored actor attribution is invalid.");
}

const successor = alias(memories, "memory_successor");

function memorySelection() {
  return {
    id: memories.id,
    lineageId: memories.lineageId,
    versionNumber: memories.versionNumber,
    supersedesId: memories.supersedesId,
    content: memories.content,
    contentHash: memories.contentHash,
    category: memories.category,
    tags: memories.tags,
    projectId: memories.projectId,
    sourceExcerpt: memories.sourceExcerpt,
    effectiveAt: memories.effectiveAt,
    capturedAt: memories.capturedAt,
    actorKind: memories.actorKind,
    actorAccountId: memories.actorAccountId,
    actorClientId: memories.actorClientId,
    actorSource: memories.actorSource,
    createdAt: memories.createdAt,
    successorId: successor.id,
    successorEffectiveAt: successor.effectiveAt,
  } as const;
}

function decodeMemory(
  raw: Record<string, unknown>,
  personIds: readonly string[],
  referenceTime: Date | null = null,
): Memory {
  const id = raw.id;
  const lineageId = raw.lineageId;
  const content = raw.content;
  const contentHash = raw.contentHash;
  const version = raw.versionNumber;
  const tags = requireStringArray(raw.tags, "Memory tags");
  const effectiveAt = requireDate(raw.effectiveAt, "Memory effectiveAt");
  const createdAt = requireDate(raw.createdAt, "Memory createdAt");
  const successorEffectiveAt = nullableDate(
    raw.successorEffectiveAt,
    "Memory successor effectiveAt",
  );
  const successorVisible =
    raw.successorId !== null &&
    (referenceTime === null ||
      (successorEffectiveAt !== null && successorEffectiveAt <= referenceTime));
  if (
    typeof id !== "string" ||
    typeof lineageId !== "string" ||
    typeof content !== "string" ||
    typeof contentHash !== "string" ||
    !SHA256.test(contentHash) ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    (raw.supersedesId !== null && typeof raw.supersedesId !== "string") ||
    (raw.category !== null && typeof raw.category !== "string") ||
    (raw.projectId !== null && typeof raw.projectId !== "string") ||
    (raw.sourceExcerpt !== null && typeof raw.sourceExcerpt !== "string") ||
    (raw.successorId !== null && typeof raw.successorId !== "string")
  ) {
    failIntegrity("Stored memory is invalid.");
  }
  return {
    id,
    lineageId,
    version,
    supersedesId: raw.supersedesId as string | null,
    content,
    category: raw.category as string | null,
    tags,
    projectId: raw.projectId as string | null,
    personIds,
    effectiveAt: effectiveAt.toISOString(),
    capturedAt:
      nullableDate(raw.capturedAt, "Memory capturedAt")?.toISOString() ?? null,
    supersededBy: successorVisible ? (raw.successorId as string) : null,
    supersededAt:
      successorVisible && successorEffectiveAt !== null
        ? successorEffectiveAt.toISOString()
        : null,
    provenance: decodeActor(raw),
    sourceExcerpt: raw.sourceExcerpt as string | null,
    contentHash,
    createdAt: createdAt.toISOString(),
  };
}

async function personIdsForMemories(
  database: MemoryExecutor,
  access: BrainAccessContext,
  ids: readonly string[],
  role: BrainRole,
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (ids.length === 0) return new Map();
  const rows = await database
    .select({
      memoryId: memoryPeople.memoryId,
      personId: memoryPeople.personId,
    })
    .from(memoryPeople)
    .where(
      and(
        inArray(memoryPeople.memoryId, ids),
        accessGate(database, access, role),
      ),
    )
    .orderBy(memoryPeople.createdAt, memoryPeople.personId);
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const list = result.get(row.memoryId) ?? [];
    list.push(row.personId);
    result.set(row.memoryId, list);
  }
  return result;
}

async function loadMemory(
  database: MemoryExecutor,
  access: BrainAccessContext,
  id: string,
  role: BrainRole,
  referenceTime: Date | null = null,
): Promise<Memory | null> {
  const rows = await database
    .select(memorySelection())
    .from(memories)
    .leftJoin(
      successor,
      and(
        eq(successor.supersedesId, memories.id),
      ),
    )
    .where(
      and(
        eq(memories.id, id),
        accessGate(database, access, role),
      ),
    )
    .limit(2);
  if (rows.length === 0) return null;
  if (rows.length !== 1) failIntegrity("A memory has more than one successor.");
  const peopleByMemory = await personIdsForMemories(
    database,
    access,
    [id],
    role,
  );
  return decodeMemory(
    rows[0] as unknown as Record<string, unknown>,
    peopleByMemory.get(id) ?? [],
    referenceTime,
  );
}

async function requireActiveSpace(
  database: MemoryExecutor,
  access: BrainAccessContext,
  embedding: ContentEmbedding,
  role: BrainRole,
) {
  const rows = await database
    .select({
      id: embeddingSpaces.id,
      dimensions: embeddingSpaces.dimensions,
      metric: embeddingSpaces.metric,
      recipeVersion: embeddingSpaces.recipeVersion,
    })
    .from(embeddingSpaces)
    .where(
      and(
        eq(embeddingSpaces.id, embedding.spaceId),
        eq(embeddingSpaces.entityType, "memory"),
        eq(embeddingSpaces.status, "active"),
        accessGate(database, access, role),
      ),
    )
    .limit(2)
    .for("share");
  if (rows.length !== 1 || rows[0]!.metric !== "cosine") {
    throw new Error("The memory embedding space is not active for this brain.");
  }
  if (rows[0]!.recipeVersion !== MEMORY_EMBEDDING_RECIPE_VERSION) {
    throw new Error(
      "The active memory embedding space uses an incompatible recipe.",
    );
  }
  requireEmbeddingVector(embedding, rows[0]!.dimensions);
  return rows[0]!;
}

async function requireLinkedContext(
  database: MemoryExecutor,
  access: BrainAccessContext,
  projectId: string | null,
  personIds: readonly string[],
): Promise<boolean> {
  if (new Set(personIds).size !== personIds.length) {
    throw new Error("personIds must not contain duplicates.");
  }
  if (projectId !== null) {
    const projectRows = await database
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          accessGate(database, access, "editor"),
        ),
      )
      .limit(1);
    if (projectRows.length !== 1) return false;
  }
  if (personIds.length > 0) {
    const personRows = await database
      .select({ id: people.id })
      .from(people)
      .where(
        and(
          inArray(people.id, personIds),
          accessGate(database, access, "editor"),
        ),
      );
    if (personRows.length !== personIds.length) return false;
  }
  return true;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

async function readReceipt(
  database: MemoryExecutor,
  access: BrainAccessContext,
  operation: string,
  idempotencyKey: string,
) {
  const rows = await database
    .select({
      requestDigest: mutationReceipts.requestDigest,
      resultEntityId: mutationReceipts.resultEntityId,
      result: mutationReceipts.result,
      activityEventId: mutationReceipts.activityEventId,
    })
    .from(mutationReceipts)
    .where(
      and(
        eq(mutationReceipts.operation, operation),
        eq(mutationReceipts.idempotencyKey, idempotencyKey),
        accessGate(database, access, "editor"),
      ),
    )
    .limit(2);
  if (rows.length > 1)
    failIntegrity("Duplicate mutation receipts were stored.");
  return rows[0] ?? null;
}

async function insertReceipt(
  database: MemoryTransaction,
  access: BrainAccessContext,
  input: {
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly resultEntityType: string | null;
    readonly resultEntityId: string | null;
    readonly resultVersionId: string | null;
    readonly result: Readonly<Record<string, unknown>>;
    readonly activityEventId?: string | undefined;
  },
): Promise<void> {
  const rows = await database
    .insert(mutationReceipts)
    .values({
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      resultEntityType: input.resultEntityType,
      resultEntityId: input.resultEntityId,
      resultVersionId: input.resultVersionId,
      result: input.result,
      activityEventId: input.activityEventId ?? null,
    })
    .returning({ id: mutationReceipts.id });
  if (rows.length !== 1) failIntegrity("A mutation receipt was not written.");
}

async function insertMemoryEvent(
  database: MemoryTransaction,
  access: BrainAccessContext,
  input: {
    readonly entityId: string;
    readonly action: "created" | "superseded" | "deleted";
    readonly effectiveAt: Date;
    readonly afterVersionId: string | null;
    readonly contentHash: string | null;
    readonly changedFields: readonly string[];
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly analysisAllowed?: boolean | undefined;
  },
): Promise<string> {
  const actor = access.actor;
  const rows = await database
    .insert(activityEvents)
    .values({
      entityType: "memory",
      entityId: input.entityId,
      action: input.action,
      occurredAt: input.effectiveAt,
      effectiveAt: input.effectiveAt,
      changedFields: [...input.changedFields],
      afterVersionId: input.afterVersionId,
      contentHash: input.contentHash,
      requestDigest: input.requestDigest,
      analysisAllowed: input.analysisAllowed ?? true,
      idempotencyKey: input.idempotencyKey,
      actorKind: actor.kind,
      actorAccountId: actor.accountId,
      actorClientId: actor.clientId,
      actorSource: actor.source,
      requestId: actor.requestId,
      correlationId: actor.correlationId,
      causationId: actor.causationId,
      dreamingRunId: actor.dreamingRunId,
    })
    .returning({ id: activityEvents.id });
  if (rows.length !== 1)
    failIntegrity("A memory activity event was not written.");
  return rows[0]!.id;
}

async function validateMemoryWriteReceiptEvent(
  database: MemoryTransaction,
  access: BrainAccessContext,
  input: {
    readonly eventId: string;
    readonly memory: Memory;
    readonly requestDigest: string;
    readonly idempotencyKey: string;
  },
): Promise<void> {
  const rows = await database
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.id, input.eventId),
        eq(activityEvents.entityType, "memory"),
        eq(activityEvents.entityId, input.memory.id),
        eq(activityEvents.action, "created"),
        eq(activityEvents.afterVersionId, input.memory.id),
        eq(activityEvents.contentHash, input.memory.contentHash),
        eq(activityEvents.requestDigest, input.requestDigest),
        eq(
          activityEvents.idempotencyKey,
          `${WRITE_OPERATION}:${input.idempotencyKey}:created`,
        ),
        accessGate(database, access, "editor"),
      ),
    )
    .limit(2);
  if (rows.length !== 1) {
    failIntegrity(
      "A memory write receipt points to an invalid activity event.",
    );
  }
}

function decodeWriteReceiptResult(value: unknown): {
  readonly memoryId: string;
  readonly supersededMemoryId: string | null;
  readonly similarity: number | null;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failIntegrity("A memory write receipt is invalid.");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.memoryId !== "string" ||
    (row.supersededMemoryId !== null &&
      typeof row.supersededMemoryId !== "string") ||
    (row.similarity !== null &&
      (typeof row.similarity !== "number" || !Number.isFinite(row.similarity)))
  ) {
    failIntegrity("A memory write receipt is invalid.");
  }
  return row as ReturnType<typeof decodeWriteReceiptResult>;
}

async function insertMemoryRow(
  database: MemoryTransaction,
  access: BrainAccessContext,
  input: MemoryWriteInput,
  values: {
    readonly id: string;
    readonly lineageId: string;
    readonly version: number;
    readonly supersedesId: string | null;
    readonly contentHash: string;
  },
): Promise<boolean> {
  const actor = actorValues(access);
  const rows = await database
    .insert(memories)
    .values({
      id: values.id,
      lineageId: values.lineageId,
      versionNumber: values.version,
      supersedesId: values.supersedesId,
      content: input.content,
      contentHash: values.contentHash,
      category: input.category,
      tags: [...input.tags],
      projectId: input.projectId,
      sourceExcerpt: input.sourceExcerpt,
      effectiveAt: requireInstant(input.effectiveAt, "effectiveAt"),
      capturedAt:
        input.capturedAt === null
          ? null
          : requireInstant(input.capturedAt, "capturedAt"),
      ...actor,
    })
    .returning({ id: memories.id });
  return rows.length === 1;
}

export async function writeMemoryVersionInTransaction(
  database: MemoryTransaction,
  access: BrainAccessContext,
  input: MemoryWriteInput,
  signal: AbortSignal,
  options: { analysisAllowed?: boolean } = {},
): Promise<MemoryTransactionWriteResult | null> {
  signal.throwIfAborted();
  await authorizeBrainTransaction(database, access, "editor", signal);
  requireIdempotencyKey(input.idempotencyKey);
  requireUuid(access.accountId, "access.accountId");
  const contentHash = memoryEmbeddingRecipe(input.content).contentHash;
  const digest = requestDigest({
    ...(options.analysisAllowed === false ? { analysisAllowed: false } : {}),
    content: input.content,
    category: input.category,
    tags: input.tags,
    projectId: input.projectId,
    personIds: input.personIds,
    effectiveAt: input.effectiveAt,
    capturedAt: input.capturedAt,
    sourceExcerpt: input.sourceExcerpt,
    embedding: input.embedding,
    supersedesId: input.supersedesId,
    expectedSupersededHash: input.expectedSupersededHash,
    expectedSupersededVersion: input.expectedSupersededVersion,
  });
  await lock(database, `${WRITE_OPERATION}:${input.idempotencyKey}`);
  const receipt = await readReceipt(
    database,
    access,
    WRITE_OPERATION,
    input.idempotencyKey,
  );
  if (receipt !== null) {
    if (receipt.requestDigest !== digest)
      throw new MutationReceiptConflictError();
    const result = decodeWriteReceiptResult(receipt.result);
    const memory = await loadMemory(
      database,
      access,
      result.memoryId,
      "editor",
    );
    if (memory === null || receipt.resultEntityId !== memory.id) {
      failIntegrity("A memory write receipt points to a missing memory.");
    }
    signal.throwIfAborted();
    if (typeof receipt.activityEventId !== "string") {
      failIntegrity("A memory write receipt is missing its activity event.");
    }
    await validateMemoryWriteReceiptEvent(database, access, {
      eventId: receipt.activityEventId,
      memory,
      requestDigest: digest,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      result: {
        memory,
        created: false,
        supersededMemoryId: result.supersededMemoryId,
        similarity: result.similarity,
      },
      activityEventId: receipt.activityEventId,
    };
  }

  if (input.embedding.contentHash !== contentHash) {
    throw new Error(
      "The memory embedding content hash does not match the memory content.",
    );
  }

  const space = await requireActiveSpace(
    database,
    access,
    input.embedding,
    "editor",
  );
  if (
    !(await requireLinkedContext(
      database,
      access,
      input.projectId,
      input.personIds,
    ))
  ) {
    return null;
  }

  const id = randomUUID();
  let lineageId: string = id;
  let version = 1;
  let similarity: number | null = null;
  if (input.supersedesId !== null) {
    requireUuid(input.supersedesId, "supersedesId");
    const initialTarget = await loadMemory(
      database,
      access,
      input.supersedesId,
      "editor",
    );
    if (initialTarget === null) return null;
    await lock(database, `memory-lineage:${initialTarget.lineageId}`);
    const target = await loadMemory(
      database,
      access,
      input.supersedesId,
      "editor",
    );
    if (
      target === null ||
      target.supersededBy !== null ||
      target.contentHash !== input.expectedSupersededHash ||
      target.version !== input.expectedSupersededVersion ||
      target.projectId !== input.projectId ||
      !sameIds(target.personIds, input.personIds) ||
      requireInstant(input.effectiveAt, "effectiveAt") <=
        new Date(target.effectiveAt)
    ) {
      return null;
    }
    const similarityRows = await database
      .select({
        score: sql<number>`greatest(-1.0, least(1.0, 1 - (${cosineDistance(memoryEmbeddings.embedding, [...input.embedding.vector])})))`,
      })
      .from(memoryEmbeddings)
      .where(
        and(
          eq(memoryEmbeddings.memoryId, target.id),
          eq(memoryEmbeddings.spaceId, input.embedding.spaceId),
          eq(memoryEmbeddings.contentHash, target.contentHash),
          accessGate(database, access, "editor"),
        ),
      )
      .limit(2);
    if (similarityRows.length !== 1) return null;
    similarity = requireFiniteScore(similarityRows[0]!.score);
    lineageId = target.lineageId;
    version = target.version + 1;
  } else if (
    input.expectedSupersededHash !== null ||
    input.expectedSupersededVersion !== null
  ) {
    return null;
  }

  if (
    !(await insertMemoryRow(database, access, input, {
      id,
      lineageId,
      version,
      supersedesId: input.supersedesId,
      contentHash,
    }))
  ) {
    throw new BrainAccessDeniedError();
  }
  for (const personId of input.personIds) {
    const linked = await database
      .insert(memoryPeople)
      .values({ memoryId: id, personId })
      .returning({ memoryId: memoryPeople.memoryId });
    if (linked.length !== 1)
      failIntegrity("A memory-person link was not written.");
  }
  const embedded = await database
    .insert(memoryEmbeddings)
    .values({
      memoryId: id,
      spaceId: input.embedding.spaceId,
      contentHash,
      recipeVersion: space.recipeVersion,
      embedding: [...input.embedding.vector],
    })
    .returning({ id: memoryEmbeddings.id });
  if (embedded.length !== 1)
    failIntegrity("A memory embedding was not written.");

  const result = {
    memoryId: id,
    supersededMemoryId: input.supersedesId,
    similarity,
  } as const;
  const effectiveAt = requireInstant(input.effectiveAt, "effectiveAt");
  if (input.supersedesId !== null) {
    await insertMemoryEvent(database, access, {
      entityId: input.supersedesId,
      action: "superseded",
      effectiveAt,
      afterVersionId: id,
      contentHash,
      changedFields: ["supersededBy"],
      idempotencyKey: `${WRITE_OPERATION}:${input.idempotencyKey}:superseded`,
      requestDigest: digest,
      ...(options.analysisAllowed === false ? { analysisAllowed: false } : {}),
    });
  }
  const activityEventId = await insertMemoryEvent(database, access, {
    entityId: id,
    action: "created",
    effectiveAt,
    afterVersionId: id,
    contentHash,
    changedFields: ["content", "category", "tags", "projectId", "personIds"],
    idempotencyKey: `${WRITE_OPERATION}:${input.idempotencyKey}:created`,
    requestDigest: digest,
    ...(options.analysisAllowed === false ? { analysisAllowed: false } : {}),
  });
  await insertReceipt(database, access, {
    operation: WRITE_OPERATION,
    idempotencyKey: input.idempotencyKey,
    requestDigest: digest,
    resultEntityType: "memory",
    resultEntityId: id,
    resultVersionId: id,
    result,
    activityEventId,
  });
  if (access.administrativeChannel === true) {
    await appendAdministrativeDomainAuditEvent(
      database,
      access,
      {
        category: "domain",
        action: input.supersedesId === null ? "memory.created" : "memory.updated",
        outcome: "succeeded",
        targetType: "memory",
        targetId: id,
        errorCode: null,
        metadata: {},
      },
      signal,
    );
  }
  const memory = await loadMemory(database, access, id, "editor");
  if (memory === null)
    failIntegrity("A newly written memory could not be read.");
  signal.throwIfAborted();
  return {
    result: {
      memory,
      created: true,
      supersededMemoryId: input.supersedesId,
      similarity,
    },
    activityEventId,
  };
}

export class DrizzleMemoryStore implements MemoryStore {
  constructor(private readonly database: MemoryDatabase) {}

  async writeMemoryVersion(
    access: BrainAccessContext,
    input: MemoryWriteInput,
    signal: AbortSignal,
  ): Promise<MemoryWriteResult | null> {
    return this.database.transaction(async (transaction) => {
      const written = await writeMemoryVersionInTransaction(
        transaction,
        access,
        input,
        signal,
      );
      return written?.result ?? null;
    });
  }

  async getMemory(
    access: BrainAccessContext,
    id: string,
    signal: AbortSignal,
  ): Promise<Memory | null> {
    signal.throwIfAborted();
    requireUuid(id, "id");
    return this.database.transaction(
      async (transaction) => {
        await authorizeBrainTransaction(transaction, access, "viewer", signal);
        const memory = await loadMemory(transaction, access, id, "viewer");
        signal.throwIfAborted();
        return memory;
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async searchMemories(
    access: BrainAccessContext,
    input: {
      readonly embedding: ContentEmbedding;
      readonly limit: number;
      readonly minimumScore: number;
      readonly category: string | null;
      readonly tags: readonly string[];
      readonly projectId: string | null;
      readonly personId: string | null;
      readonly createdAfter: string | null;
      readonly createdBefore: string | null;
      readonly asOf: string | null;
      readonly includeSuperseded: boolean;
    },
    signal: AbortSignal,
  ): Promise<readonly MemoryMatch[]> {
    signal.throwIfAborted();
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new Error("limit must be an integer between 1 and 100.");
    }
    if (
      !Number.isFinite(input.minimumScore) ||
      input.minimumScore < -1 ||
      input.minimumScore > 1
    ) {
      throw new Error("minimumScore must be between -1 and 1.");
    }
    return this.database.transaction(
      async (transaction) => {
        await authorizeBrainTransaction(transaction, access, "viewer", signal);
        await requireActiveSpace(
          transaction,
          access,
          input.embedding,
          "viewer",
        );
        const referenceTime =
          input.asOf === null ? new Date() : requireInstant(input.asOf, "asOf");
        const child = alias(memories, "memory_current_successor");
        const distance = cosineDistance(memoryEmbeddings.embedding, [
          ...input.embedding.vector,
        ]);
        const score = sql<number>`greatest(-1.0, least(1.0, 1 - (${distance})))`;
        const predicates = [
          eq(memoryEmbeddings.spaceId, input.embedding.spaceId),
          eq(memoryEmbeddings.contentHash, memories.contentHash),
          lte(memories.effectiveAt, referenceTime),
          gte(score, input.minimumScore),
          accessGate(transaction, access, "viewer"),
        ];
        if (input.category !== null)
          predicates.push(eq(memories.category, input.category));
        if (input.tags.length > 0)
          predicates.push(arrayContains(memories.tags, [...input.tags]));
        if (input.projectId !== null)
          predicates.push(eq(memories.projectId, input.projectId));
        if (input.personId !== null) {
          predicates.push(
            exists(
              transaction
                .select({ memoryId: memoryPeople.memoryId })
                .from(memoryPeople)
                .where(
                  and(
                    eq(memoryPeople.memoryId, memories.id),
                    eq(memoryPeople.personId, input.personId),
                    accessGate(transaction, access, "viewer"),
                  ),
                ),
            ),
          );
        }
        if (input.createdAfter !== null) {
          predicates.push(
            gte(
              memories.createdAt,
              requireInstant(input.createdAfter, "createdAfter"),
            ),
          );
        }
        if (input.createdBefore !== null) {
          predicates.push(
            lt(
              memories.createdAt,
              requireInstant(input.createdBefore, "createdBefore"),
            ),
          );
        }
        if (!input.includeSuperseded) {
          predicates.push(
            notExists(
              transaction
                .select({ id: child.id })
                .from(child)
                .where(
                  and(
                    eq(child.supersedesId, memories.id),
                    lte(child.effectiveAt, referenceTime),
                    accessGate(transaction, access, "viewer"),
                  ),
                ),
            ),
          );
        }
        const rows = await transaction
          .select({ ...memorySelection(), score })
          .from(memories)
          .innerJoin(
            memoryEmbeddings,
            and(
              eq(memoryEmbeddings.memoryId, memories.id),
            ),
          )
          .leftJoin(
            successor,
            and(
              eq(successor.supersedesId, memories.id),
            ),
          )
          .where(and(...predicates))
          .orderBy(distance, memories.id)
          .limit(input.limit);
        const peopleByMemory = await personIdsForMemories(
          transaction,
          access,
          rows.map((row) => row.id),
          "viewer",
        );
        signal.throwIfAborted();
        return rows.map((row) => ({
          memory: decodeMemory(
            row as unknown as Record<string, unknown>,
            peopleByMemory.get(row.id) ?? [],
            referenceTime,
          ),
          score: requireFiniteScore(row.score),
          spaceId: input.embedding.spaceId,
        }));
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async listMemories(
    access: BrainAccessContext,
    input: {
      readonly category: string | null;
      readonly tags: readonly string[];
      readonly projectId: string | null;
      readonly personId: string | null;
      readonly createdAfter: string | null;
      readonly createdBefore: string | null;
      readonly asOf: string | null;
      readonly includeSuperseded: boolean;
      readonly cursor: { readonly ts: string; readonly id: string } | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<MemoryListResult> {
    signal.throwIfAborted();
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new Error("limit must be an integer between 1 and 100.");
    }
    return this.database.transaction(
      async (transaction) => {
        await authorizeBrainTransaction(transaction, access, "viewer", signal);
        const referenceTime =
          input.asOf === null ? new Date() : requireInstant(input.asOf, "asOf");
        const child = alias(memories, "memory_visible_successor");
        const predicates = [
          lte(memories.effectiveAt, referenceTime),
          accessGate(transaction, access, "viewer"),
        ];
        if (input.category !== null)
          predicates.push(eq(memories.category, input.category));
        if (input.tags.length > 0) {
          predicates.push(arrayContains(memories.tags, [...input.tags]));
        }
        if (input.projectId !== null)
          predicates.push(eq(memories.projectId, input.projectId));
        if (input.personId !== null) {
          predicates.push(
            exists(
              transaction
                .select({ memoryId: memoryPeople.memoryId })
                .from(memoryPeople)
                .where(
                  and(
                    eq(memoryPeople.memoryId, memories.id),
                    eq(memoryPeople.personId, input.personId),
                    accessGate(transaction, access, "viewer"),
                  ),
                ),
            ),
          );
        }
        if (input.createdAfter !== null) {
          predicates.push(
            gte(
              memories.createdAt,
              requireInstant(input.createdAfter, "createdAfter"),
            ),
          );
        }
        if (input.createdBefore !== null) {
          predicates.push(
            lt(
              memories.createdAt,
              requireInstant(input.createdBefore, "createdBefore"),
            ),
          );
        }
        if (!input.includeSuperseded) {
          predicates.push(
            notExists(
              transaction
                .select({ id: child.id })
                .from(child)
                .where(
                  and(
                    eq(child.supersedesId, memories.id),
                    lte(child.effectiveAt, referenceTime),
                    accessGate(transaction, access, "viewer"),
                  ),
                ),
            ),
          );
        }
        if (input.cursor !== null) {
          const cursorTime = requireInstant(input.cursor.ts, "cursor.ts");
          requireUuid(input.cursor.id, "cursor.id");
          predicates.push(
            or(
              lt(memories.createdAt, cursorTime),
              and(
                eq(memories.createdAt, cursorTime),
                lt(memories.id, input.cursor.id),
              ),
            )!,
          );
        }
        const rows = await transaction
          .select(memorySelection())
          .from(memories)
          .leftJoin(
            successor,
            and(
              eq(successor.supersedesId, memories.id),
            ),
          )
          .where(and(...predicates))
          .orderBy(desc(memories.createdAt), desc(memories.id))
          .limit(input.limit + 1);
        const hasMore = rows.length > input.limit;
        const pageRows = rows.slice(0, input.limit);
        const peopleByMemory = await personIdsForMemories(
          transaction,
          access,
          pageRows.map((row) => row.id),
          "viewer",
        );
        signal.throwIfAborted();
        const items = pageRows.map((row) =>
          decodeMemory(
            row as unknown as Record<string, unknown>,
            peopleByMemory.get(row.id) ?? [],
            referenceTime,
          ),
        );
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            hasMore && last !== undefined
              ? { ts: last.createdAt, id: last.id }
              : null,
        };
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async deleteMemory(
    access: BrainAccessContext,
    id: string,
    input: { readonly idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    requireUuid(id, "id");
    requireIdempotencyKey(input.idempotencyKey);
    const digest = requestDigest({ id });
    return this.database.transaction(async (transaction) => {
      signal.throwIfAborted();
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      await lock(
        transaction,
        `${DELETE_OPERATION}:${input.idempotencyKey}`,
      );
      const receipt = await readReceipt(
        transaction,
        access,
        DELETE_OPERATION,
        input.idempotencyKey,
      );
      if (receipt !== null) {
        if (receipt.requestDigest !== digest)
          throw new MutationReceiptConflictError();
        const result = receipt.result;
        if (
          typeof result !== "object" ||
          result === null ||
          Array.isArray(result) ||
          typeof (result as Record<string, unknown>).deleted !== "boolean"
        ) {
          failIntegrity("A memory delete receipt is invalid.");
        }
        return (result as { readonly deleted: boolean }).deleted;
      }
      const target = await loadMemory(transaction, access, id, "editor");
      if (target === null) {
        await insertReceipt(transaction, access, {
          operation: DELETE_OPERATION,
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
          resultEntityType: null,
          resultEntityId: null,
          resultVersionId: null,
          result: { deleted: false },
        });
        return false;
      }
      await lock(transaction, `memory-lineage:${target.lineageId}`);
      const lineageRows = await transaction
        .select({ id: memories.id, version: memories.versionNumber })
        .from(memories)
        .where(
          and(
            eq(memories.lineageId, target.lineageId),
            accessGate(transaction, access, "editor"),
          ),
        )
        .orderBy(desc(memories.versionNumber));
      const lineageIds = lineageRows.map((row) => row.id);
      if (lineageIds.length === 0)
        failIntegrity("A locked memory lineage disappeared.");
      await transaction
        .delete(memoryEmbeddings)
        .where(
          and(
            inArray(memoryEmbeddings.memoryId, lineageIds),
            accessGate(transaction, access, "editor"),
          ),
        );
      await transaction
        .delete(memoryPeople)
        .where(
          and(
            inArray(memoryPeople.memoryId, lineageIds),
            accessGate(transaction, access, "editor"),
          ),
        );
      for (const row of lineageRows) {
        const deleted = await transaction
          .delete(memories)
          .where(
            and(
              eq(memories.id, row.id),
              eq(memories.lineageId, target.lineageId),
              eq(memories.versionNumber, row.version),
              accessGate(transaction, access, "editor"),
            ),
          )
          .returning({ id: memories.id });
        if (deleted.length !== 1)
          failIntegrity("A locked memory version disappeared.");
      }
      const deletionEventId = await insertMemoryEvent(transaction, access, {
        entityId: id,
        action: "deleted",
        effectiveAt: new Date(),
        afterVersionId: null,
        contentHash: null,
        changedFields: ["lineage"],
        idempotencyKey: `${DELETE_OPERATION}:${input.idempotencyKey}:deleted`,
        requestDigest: digest,
        analysisAllowed: false,
      });
      await insertReceipt(transaction, access, {
        operation: DELETE_OPERATION,
        idempotencyKey: input.idempotencyKey,
        requestDigest: digest,
        resultEntityType: "memory_lineage",
        resultEntityId: null,
        resultVersionId: null,
        result: { deleted: true },
        activityEventId: deletionEventId,
      });
      if (access.administrativeChannel === true) {
        await appendAdministrativeDomainAuditEvent(
          transaction,
          access,
          {
            category: "domain",
            action: "memory.deleted",
            outcome: "succeeded",
            targetType: "memory",
            targetId: id,
            errorCode: null,
            metadata: {},
          },
          signal,
        );
      }
      signal.throwIfAborted();
      return true;
    });
  }
}
