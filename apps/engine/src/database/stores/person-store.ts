import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import { mutationSources } from "../../domain.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  CursorPosition,
  Page,
  Person,
  PersonStore,
} from "../../domain.js";
import {
  knowledgeBases,
  knowledgeDocumentPeople,
  knowledgeDocuments,
  people,
  personKnowledgeBases,
  personProjects,
  projects,
} from "../schema/content.js";
import { accounts } from "../schema/identity.js";
import { activityEvents, mutationReceipts } from "../schema/temporal.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";

const CREATE_OPERATION = "person.create";
const UPDATE_OPERATION = "person.update";
type PersonMutationOperation = typeof CREATE_OPERATION | typeof UPDATE_OPERATION;
const ALIAS_SEPARATOR = "\u001f";

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

const personResultSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(300),
  aliases: z.array(z.string().refine((value) => !value.includes(ALIAS_SEPARATOR))),
  notes: z.string().max(10_000).nullable(),
  summary: z.string().min(1).max(1_000).nullable(),
  tags: z.array(z.string().min(1).max(100)).max(20),
  projectIds: z.array(z.string().uuid()).max(50),
  knowledgeBaseIds: z.array(z.string().uuid()).max(50),
  version: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const personRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(300),
  aliases: z.array(z.string().refine((value) => !value.includes(ALIAS_SEPARATOR))),
  notes: z.string().max(10_000).nullable(),
  summary: z.string().min(1).max(1_000).nullable(),
  tags: z.array(z.string().min(1).max(100)).max(20),
  version: z.number().int().positive(),
  actorKind: z.enum(["account", "oauth_client", "import", "dreaming", "system"]),
  actorAccountId: z.string().uuid().nullable(),
  actorClientId: z.string().min(1).max(500).nullable(),
  actorSource: z.enum(mutationSources),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PersonDatabase = SecondBrainDatabase;
export type PersonMutationTransaction = SecondBrainTransaction;
export interface PersonMutationResult {
  readonly person: Person;
  readonly activityEventId: string;
}

export class PersonStoreContractError extends Error {
  readonly code = "PERSON_STORE_CONTRACT_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersonStoreContractError";
  }
}

export class PersonStoreIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("The idempotency key was already used with a different person request.");
    this.name = "PersonStoreIdempotencyConflictError";
  }
}

export class PersonNameConflictError extends Error {
  readonly code = "PERSON_NAME_CONFLICT";

  constructor() {
    super("A person with this name already exists in the brain.");
    this.name = "PersonNameConflictError";
  }
}

export class PersonVersionConflictError extends Error {
  readonly code = "PERSON_VERSION_CONFLICT";

  constructor() {
    super("Person version conflict.");
    this.name = "PersonVersionConflictError";
  }
}

function failIntegrity(detail: string, cause?: unknown): never {
  throw new PersonStoreContractError(`Invalid person persistence data: ${detail}.`, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function actorFromRow(row: z.infer<typeof personRowSchema>): ActorAttribution {
  const parsed = actorSchema.safeParse({
    kind: row.actorKind,
    accountId: row.actorAccountId,
    clientId: row.actorClientId,
    source: row.actorSource,
  });
  if (!parsed.success) failIntegrity("actor attribution is inconsistent", parsed.error);
  return parsed.data as ActorAttribution;
}

export function decodePersonRow(row: unknown): Person {
  const parsed = personRowSchema.safeParse(row);
  if (!parsed.success) failIntegrity("row validation failed", parsed.error);
  const value = parsed.data;
  return {
    id: value.id,
    name: value.name,
    aliases: [...value.aliases],
    notes: value.notes,
    summary: value.summary,
    tags: [...value.tags],
    projectIds: [],
    knowledgeBaseIds: [],
    version: value.version,
    provenance: actorFromRow(value),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

type PersonReceiptResult = Omit<Person, "provenance">;

function decodePersonResult(value: unknown): PersonReceiptResult {
  const parsed = personResultSchema.safeParse(value);
  if (!parsed.success) failIntegrity("mutation receipt result is invalid", parsed.error);
  return { ...parsed.data, aliases: [...parsed.data.aliases], tags: [...parsed.data.tags], projectIds: [...parsed.data.projectIds], knowledgeBaseIds: [...parsed.data.knowledgeBaseIds] };
}

function personReceiptResult(person: Person): PersonReceiptResult {
  return {
    id: person.id,
    name: person.name,
    aliases: [...person.aliases],
    notes: person.notes,
    summary: person.summary,
    tags: [...person.tags],
    projectIds: [...person.projectIds],
    knowledgeBaseIds: [...person.knowledgeBaseIds],
    version: person.version,
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
  };
}

function requireName(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 300 ||
    trimmed.includes(ALIAS_SEPARATOR)
  ) {
    throw new PersonStoreContractError("Person names must contain 1 to 300 characters.");
  }
  return trimmed;
}

function requireAliases(value: readonly string[]): readonly string[] {
  if (value.length > 50) {
    throw new PersonStoreContractError("People may have at most 50 aliases.");
  }
  const aliases = value.map((alias) => alias.trim());
  if (
    aliases.some(
      (alias) =>
        alias.length === 0 ||
        alias.length > 300 ||
        alias.includes(ALIAS_SEPARATOR),
    )
  ) {
    throw new PersonStoreContractError("Aliases must contain 1 to 300 characters.");
  }
  const normalized = aliases.map((alias) => alias.toLocaleLowerCase("en-US"));
  if (new Set(normalized).size !== normalized.length) {
    throw new PersonStoreContractError("Aliases must not contain duplicates.");
  }
  return aliases;
}

function requireNotes(value: string | null): string | null {
  if (value !== null && value.length > 10_000) {
    throw new PersonStoreContractError("Person notes must contain at most 10,000 characters.");
  }
  return value;
}

function requireSummary(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 1_000) {
    throw new PersonStoreContractError("Person summaries must contain 1 to 1,000 characters.");
  }
  return trimmed;
}

function requireTags(value: readonly string[]): readonly string[] {
  if (value.length > 20) {
    throw new PersonStoreContractError("People may have at most 20 tags.");
  }
  const tags = value.map((tag) => tag.trim());
  if (tags.some((tag) => tag.length === 0 || tag.length > 100)) {
    throw new PersonStoreContractError("Tags must contain 1 to 100 characters.");
  }
  const normalized = tags.map((tag) => tag.toLocaleLowerCase("en-US"));
  if (new Set(normalized).size !== normalized.length) {
    throw new PersonStoreContractError("Tags must not contain duplicates.");
  }
  return tags;
}

function requireIds(value: readonly string[], field: string, maximum: number): readonly string[] {
  if (value.length > maximum) {
    throw new PersonStoreContractError(`${field} may contain at most ${maximum} IDs.`);
  }
  if (new Set(value).size !== value.length) {
    throw new PersonStoreContractError(`${field} must not contain duplicates.`);
  }
  return value;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function requireIdempotencyKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new PersonStoreContractError(
      "Person idempotency keys must contain 1 to 200 characters.",
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
    throw new PersonStoreContractError("The people cursor is invalid.");
  }
  return or(
    gt(people.createdAt, timestamp),
    and(eq(people.createdAt, timestamp), gt(people.id, cursor.id)),
  );
}

function escapedLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function likePattern(value: string): string {
  return `%${escapedLike(value)}%`;
}

async function requireRelatedEntities(
  tx: SecondBrainTransaction,
  projectIds: readonly string[],
  knowledgeBaseIds: readonly string[],
): Promise<void> {
  if (projectIds.length > 0) {
    const rows = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.id, [...projectIds]));
    if (rows.length !== projectIds.length) {
      throw new PersonStoreContractError("A linked project was not found.");
    }
  }
  if (knowledgeBaseIds.length > 0) {
    const rows = await tx
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(inArray(knowledgeBases.id, [...knowledgeBaseIds]));
    if (rows.length !== knowledgeBaseIds.length) {
      throw new PersonStoreContractError("A linked knowledge base was not found.");
    }
  }
}

async function replacePersonLinks(
  tx: SecondBrainTransaction,
  personId: string,
  projectIds: readonly string[],
  knowledgeBaseIds: readonly string[],
): Promise<void> {
  await tx.delete(personProjects).where(eq(personProjects.personId, personId));
  await tx
    .delete(personKnowledgeBases)
    .where(eq(personKnowledgeBases.personId, personId));
  if (projectIds.length > 0) {
    await tx.insert(personProjects).values(
      projectIds.map((projectId) => ({ personId, projectId })),
    );
  }
  if (knowledgeBaseIds.length > 0) {
    await tx.insert(personKnowledgeBases).values(
      knowledgeBaseIds.map((knowledgeBaseId) => ({ personId, knowledgeBaseId })),
    );
  }
}

export async function loadPersonRelations(
  tx: SecondBrainTransaction,
  personIds: readonly string[],
): Promise<
  Map<string, { readonly projectIds: readonly string[]; readonly knowledgeBaseIds: readonly string[] }>
> {
  const relations = new Map<
    string,
    { projectIds: string[]; knowledgeBaseIds: string[] }
  >();
  const ensure = (id: string) => {
    const current = relations.get(id);
    if (current !== undefined) return current;
    const created = { projectIds: [] as string[], knowledgeBaseIds: [] as string[] };
    relations.set(id, created);
    return created;
  };
  for (const id of personIds) ensure(id);
  if (personIds.length === 0) return relations;

  const [explicitProjects, explicitBases, documentLinks] = await Promise.all([
    tx
      .select({
        personId: personProjects.personId,
        projectId: personProjects.projectId,
      })
      .from(personProjects)
      .where(inArray(personProjects.personId, [...personIds])),
    tx
      .select({
        personId: personKnowledgeBases.personId,
        knowledgeBaseId: personKnowledgeBases.knowledgeBaseId,
      })
      .from(personKnowledgeBases)
      .where(inArray(personKnowledgeBases.personId, [...personIds])),
    tx
      .select({
        personId: knowledgeDocumentPeople.personId,
        knowledgeBaseId: knowledgeDocuments.knowledgeBaseId,
        projectId: knowledgeDocuments.projectId,
      })
      .from(knowledgeDocumentPeople)
      .innerJoin(
        knowledgeDocuments,
        eq(knowledgeDocuments.id, knowledgeDocumentPeople.documentId),
      )
      .where(inArray(knowledgeDocumentPeople.personId, [...personIds])),
  ]);

  for (const row of explicitProjects) {
    const current = ensure(row.personId);
    if (!current.projectIds.includes(row.projectId)) current.projectIds.push(row.projectId);
  }
  for (const row of explicitBases) {
    const current = ensure(row.personId);
    if (!current.knowledgeBaseIds.includes(row.knowledgeBaseId)) {
      current.knowledgeBaseIds.push(row.knowledgeBaseId);
    }
  }
  for (const row of documentLinks) {
    const current = ensure(row.personId);
    if (!current.knowledgeBaseIds.includes(row.knowledgeBaseId)) {
      current.knowledgeBaseIds.push(row.knowledgeBaseId);
    }
    if (row.projectId !== null && !current.projectIds.includes(row.projectId)) {
      current.projectIds.push(row.projectId);
    }
  }
  return relations;
}

async function hydratePeople(
  tx: SecondBrainTransaction,
  peopleRows: readonly Person[],
): Promise<Person[]> {
  const relations = await loadPersonRelations(
    tx,
    peopleRows.map((person) => person.id),
  );
  return peopleRows.map((person) => {
    const related = relations.get(person.id);
    return {
      ...person,
      projectIds: related?.projectIds ?? [],
      knowledgeBaseIds: related?.knowledgeBaseIds ?? [],
    };
  });
}

function exactAliasPattern(value: string): string {
  return `%${ALIAS_SEPARATOR}${escapedLike(value)}${ALIAS_SEPARATOR}%`;
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
  operation: PersonMutationOperation,
  idempotencyKey: string,
  requestDigest: string,
): Promise<PersonMutationResult | null> {
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
    row.resultEntityType !== "person" ||
    row.resultVersionId !== null
  ) {
    throw new PersonStoreIdempotencyConflictError();
  }
  const person = decodePersonResult(row.result);
  if (row.resultEntityId !== person.id) {
    failIntegrity("mutation receipt points to a different person");
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
    event.entityType !== "person" ||
    event.entityId !== person.id ||
    event.action !== expectedAction ||
    event.requestDigest !== requestDigest ||
    event.idempotencyKey !== `${operation}:${idempotencyKey}`
  ) {
    failIntegrity("receipt activity event points to another mutation");
  }
  const actor = actorSchema.safeParse(event);
  if (!actor.success) failIntegrity("receipt actor is invalid", actor.error);
  return {
    person: { ...person, provenance: actor.data as ActorAttribution },
    activityEventId: row.activityEventId,
  };
}

async function writeReceipt(
  tx: SecondBrainTransaction,
  access: BrainAccessContext,
  input: {
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly person: Person;
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
      resultEntityType: "person",
      resultEntityId: input.person.id,
      resultVersionId: null,
      result: personReceiptResult(input.person),
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
    entityType: "person" as const,
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
export async function createPersonInTransaction(
  tx: SecondBrainTransaction,
  access: BrainAccessContext,
  input: Parameters<PersonStore["createPerson"]>[1],
  signal: AbortSignal,
): Promise<PersonMutationResult> {
  await authorizeBrainTransaction(tx, access, "editor", signal);
  const name = requireName(input.name);
  const aliases = requireAliases(input.aliases);
  const notes = requireNotes(input.notes);
  const summary = requireSummary(input.summary);
  const tags = requireTags(input.tags);
  const projectIds = requireIds(input.projectIds, "projectIds", 50);
  const knowledgeBaseIds = requireIds(input.knowledgeBaseIds, "knowledgeBaseIds", 50);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const requestDigest = digest({
    operation: CREATE_OPERATION,
    input: { name, aliases, notes, summary, tags, projectIds, knowledgeBaseIds },
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
  await requireRelatedEntities(tx, projectIds, knowledgeBaseIds);

  const personId = randomUUID();
  const eventId = randomUUID();
  const now = await transactionTime(tx, access);
  const eventRows = await tx
    .insert(activityEvents)
    .values(
      eventValues(access, {
        id: eventId,
        entityId: personId,
        action: "created",
        changedFields: ["name", "aliases", "notes", "summary", "tags", "projectIds", "knowledgeBaseIds"],
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
    .insert(people)
    .values({
      id: personId,
      name,
      aliases: [...aliases],
      notes,
      summary,
      tags: [...tags],
      version: 1,
      actorKind: access.actor.kind,
      actorAccountId: access.actor.accountId,
      actorClientId: access.actor.clientId,
      actorSource: access.actor.source,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (inserted.length !== 1) failIntegrity("person insert did not return one row");
  await replacePersonLinks(tx, personId, projectIds, knowledgeBaseIds);
  const [person] = await hydratePeople(tx, [decodePersonRow(inserted[0])]);
  if (person === undefined) failIntegrity("person insert could not be hydrated");
  await writeReceipt(tx, access, {
    operation: CREATE_OPERATION,
    idempotencyKey,
    requestDigest,
    person,
    activityEventId: eventId,
    createdAt: now,
  });
  return { person, activityEventId: eventId };
}

export class DrizzlePersonStore implements PersonStore {
  constructor(private readonly database: PersonDatabase) {}

  async createPerson(
    access: BrainAccessContext,
    input: Parameters<PersonStore["createPerson"]>[1],
    signal: AbortSignal,
  ): Promise<Person> {
    signal.throwIfAborted();
    try {
      return await this.database.transaction(async (tx) => {
        const result = await createPersonInTransaction(tx, access, input, signal);
        return result.person;
      });
    } catch (error) {
      if (isConstraintViolation(error, "people_name_key")) {
        throw new PersonNameConflictError();
      }
      throw error;
    }
  }

  async listPeople(
    access: BrainAccessContext,
    input: Parameters<PersonStore["listPeople"]>[1],
    signal: AbortSignal,
  ): Promise<Page<Person>> {
    signal.throwIfAborted();
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new PersonStoreContractError("People page limits must be between 1 and 100.");
    }
    const pattern = input.query === null ? null : likePattern(requireName(input.query));
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "viewer", signal);
      const rows = await tx
        .select()
        .from(people)
        .where(
          and(
            pattern === null
              ? undefined
              : or(
                  ilike(people.name, pattern),
                  sql<boolean>`array_to_string(${people.aliases}, ${ALIAS_SEPARATOR}) ilike ${pattern}`,
                ),
            cursorCondition(input.cursor),
          ),
        )
        .orderBy(asc(people.createdAt), asc(people.id))
        .limit(input.limit + 1);
      signal.throwIfAborted();
      const hasMore = rows.length > input.limit;
      const items = await hydratePeople(
        tx,
        rows.slice(0, input.limit).map(decodePersonRow),
      );
      const last = hasMore ? items.at(-1) : undefined;
      return {
        items,
        nextCursor: last === undefined ? null : { ts: last.createdAt, id: last.id },
      };
    });
  }

  async updatePerson(
    access: BrainAccessContext,
    id: string,
    changes: Parameters<PersonStore["updatePerson"]>[2],
    signal: AbortSignal,
  ): Promise<Person | null> {
    signal.throwIfAborted();
    if (
      !Number.isInteger(changes.precondition.expectedVersion) ||
      changes.precondition.expectedVersion < 1
    ) {
      throw new PersonStoreContractError("Expected person versions must be positive integers.");
    }
    const name = changes.name === undefined ? undefined : requireName(changes.name);
    const aliases =
      changes.aliases === undefined ? undefined : requireAliases(changes.aliases);
    const notes = changes.notes === undefined ? undefined : requireNotes(changes.notes);
    const summary =
      changes.summary === undefined ? undefined : requireSummary(changes.summary);
    const tags = changes.tags === undefined ? undefined : requireTags(changes.tags);
    const projectIds =
      changes.projectIds === undefined
        ? undefined
        : requireIds(changes.projectIds, "projectIds", 50);
    const knowledgeBaseIds =
      changes.knowledgeBaseIds === undefined
        ? undefined
        : requireIds(changes.knowledgeBaseIds, "knowledgeBaseIds", 50);
    if (
      name === undefined &&
      aliases === undefined &&
      notes === undefined &&
      summary === undefined &&
      tags === undefined &&
      projectIds === undefined &&
      knowledgeBaseIds === undefined
    ) {
      throw new PersonStoreContractError("At least one person change is required.");
    }
    const idempotencyKey = requireIdempotencyKey(changes.precondition.idempotencyKey);
    const requestDigest = digest({
      operation: UPDATE_OPERATION,
      id,
      expectedVersion: changes.precondition.expectedVersion,
      changes: {
        name: name === undefined ? { set: false } : { set: true, value: name },
        aliases:
          aliases === undefined ? { set: false } : { set: true, value: aliases },
        notes: notes === undefined ? { set: false } : { set: true, value: notes },
        summary:
          summary === undefined ? { set: false } : { set: true, value: summary },
        tags: tags === undefined ? { set: false } : { set: true, value: tags },
        projectIds:
          projectIds === undefined ? { set: false } : { set: true, value: projectIds },
        knowledgeBaseIds:
          knowledgeBaseIds === undefined
            ? { set: false }
            : { set: true, value: knowledgeBaseIds },
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
        if (replay !== null) return replay.person;

        const currentRows = await tx
          .select()
          .from(people)
          .where(
            and(
              eq(people.id, id),
              eq(people.version, changes.precondition.expectedVersion),
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
          if (concurrentReplay !== null) return concurrentReplay.person;
          const existingRows = await tx
            .select({ id: people.id })
            .from(people)
            .where(eq(people.id, id))
            .limit(2);
          if (existingRows.length > 1) failIntegrity("entity lookup is not unique");
          if (existingRows.length === 1) throw new PersonVersionConflictError();
          return null;
        }
        if (currentRows.length !== 1) failIntegrity("optimistic lookup is not unique");
        signal.throwIfAborted();
        const [current] = await hydratePeople(tx, [decodePersonRow(currentRows[0])]);
        if (current === undefined) failIntegrity("optimistic person lookup could not be hydrated");
        const lockedReplay = await readReceipt(
          tx,
          access,
          UPDATE_OPERATION,
          idempotencyKey,
          requestDigest,
        );
        if (lockedReplay !== null) return lockedReplay.person;
        if (projectIds !== undefined || knowledgeBaseIds !== undefined) {
          await requireRelatedEntities(
            tx,
            projectIds ?? current.projectIds,
            knowledgeBaseIds ?? current.knowledgeBaseIds,
          );
        }
        const nameChanged = name !== undefined && name !== current.name;
        const aliasesChanged =
          aliases !== undefined &&
          (aliases.length !== current.aliases.length ||
            aliases.some((alias, index) => alias !== current.aliases[index]));
        const notesChanged = notes !== undefined && notes !== current.notes;
        const summaryChanged = summary !== undefined && summary !== current.summary;
        const tagsChanged =
          tags !== undefined &&
          (tags.length !== current.tags.length ||
            tags.some((tag, index) => tag !== current.tags[index]));
        const projectIdsChanged =
          projectIds !== undefined && !sameIds(projectIds, current.projectIds);
        const knowledgeBaseIdsChanged =
          knowledgeBaseIds !== undefined &&
          !sameIds(knowledgeBaseIds, current.knowledgeBaseIds);
        const now = await transactionTime(tx, access);
        const changedFields = [
          ...(nameChanged ? ["name"] : []),
          ...(aliasesChanged ? ["aliases"] : []),
          ...(notesChanged ? ["notes"] : []),
          ...(summaryChanged ? ["summary"] : []),
          ...(tagsChanged ? ["tags"] : []),
          ...(projectIdsChanged ? ["projectIds"] : []),
          ...(knowledgeBaseIdsChanged ? ["knowledgeBaseIds"] : []),
        ];
        if (changedFields.length === 0) {
          const noOpRows = await tx
            .update(people)
            .set({
              actorKind: access.actor.kind,
              actorAccountId: access.actor.accountId,
              actorClientId: access.actor.clientId,
              actorSource: access.actor.source,
              updatedAt: now,
            })
            .where(
              and(
                eq(people.id, id),
                eq(people.version, changes.precondition.expectedVersion),
              ),
            )
            .returning();
          if (noOpRows.length !== 1) failIntegrity("person no-op did not affect one row");
          const [person] = await hydratePeople(tx, [decodePersonRow(noOpRows[0])]);
          if (person === undefined) failIntegrity("person no-op could not be hydrated");
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
            throw new PersonStoreIdempotencyConflictError();
          }
          await writeReceipt(tx, access, {
            operation: UPDATE_OPERATION,
            idempotencyKey,
            requestDigest,
            person,
            activityEventId: eventId,
            createdAt: now,
          });
          return person;
        }
        const nextProjectIds = projectIds ?? current.projectIds;
        const nextKnowledgeBaseIds = knowledgeBaseIds ?? current.knowledgeBaseIds;
        const updatedRows = await tx
          .update(people)
          .set({
            ...(nameChanged ? { name } : {}),
            ...(aliasesChanged ? { aliases: [...aliases] } : {}),
            ...(notesChanged ? { notes } : {}),
            ...(summaryChanged ? { summary } : {}),
            ...(tagsChanged ? { tags: [...tags] } : {}),
            version: current.version + 1,
            actorKind: access.actor.kind,
            actorAccountId: access.actor.accountId,
            actorClientId: access.actor.clientId,
            actorSource: access.actor.source,
            updatedAt: now,
          })
          .where(
            and(
              eq(people.id, id),
              eq(people.version, changes.precondition.expectedVersion),
            ),
          )
          .returning();
        if (updatedRows.length !== 1) failIntegrity("person update did not affect one row");
        if (projectIdsChanged || knowledgeBaseIdsChanged) {
          await replacePersonLinks(tx, id, nextProjectIds, nextKnowledgeBaseIds);
        }
        const [person] = await hydratePeople(tx, [decodePersonRow(updatedRows[0])]);
        if (person === undefined) failIntegrity("person update could not be hydrated");
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
          throw new PersonStoreIdempotencyConflictError();
        }
        await writeReceipt(tx, access, {
          operation: UPDATE_OPERATION,
          idempotencyKey,
          requestDigest,
          person,
          activityEventId: eventId,
          createdAt: now,
        });
        return person;
      });
    } catch (error) {
      if (isConstraintViolation(error, "people_name_key")) {
        throw new PersonNameConflictError();
      }
      throw error;
    }
  }

  async findPersonByName(
    access: BrainAccessContext,
    name: string,
    signal: AbortSignal,
  ): Promise<Person | null> {
    signal.throwIfAborted();
    const normalizedName = requireName(name);
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "viewer", signal);
      const rows = await tx
        .select()
        .from(people)
        .where(
          and(
            or(
              ilike(people.name, escapedLike(normalizedName)),
              sql<boolean>`(${ALIAS_SEPARATOR} || array_to_string(${people.aliases}, ${ALIAS_SEPARATOR}) || ${ALIAS_SEPARATOR}) ilike ${exactAliasPattern(normalizedName)}`,
            ),
          ),
        )
        .orderBy(asc(people.createdAt), asc(people.id))
        .limit(2);
      signal.throwIfAborted();
      if (rows.length === 0) return null;
      if (rows.length !== 1) failIntegrity("name or alias lookup is ambiguous");
      const [person] = await hydratePeople(tx, [decodePersonRow(rows[0])]);
      return person ?? null;
    });
  }
}
