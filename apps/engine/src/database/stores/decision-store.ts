import { createHash, randomUUID } from "node:crypto";

import {
  and,
  desc,
  eq,
  exists,
  gt,
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
  Decision,
  DecisionStatus,
  DecisionStore,
  DecisionWriteInput,
  VersionPrecondition,
} from "../../domain.js";
import {
  DECISION_EMBEDDING_RECIPE_VERSION,
  decisionEmbeddingRecipe,
} from "../../domain.js";
import {
  decisionPeople,
  decisions,
  people,
  projects,
} from "../schema/content.js";
import { decisionEmbeddings, embeddingSpaces } from "../schema/embeddings.js";
import { accounts } from "../schema/identity.js";
import { activityEvents, mutationReceipts } from "../schema/temporal.js";
import { authorizeBrainTransaction, rolesAtLeast } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";
import {
  MutationReceiptConflictError,
  StoredDataIntegrityError,
} from "./memory-store.js";

const CREATE_OPERATION = "decision.create";
const REVOKE_OPERATION = "decision.revoke";
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type DecisionDatabase = SecondBrainDatabase;
export type DecisionTransaction = SecondBrainTransaction;
type DecisionExecutor = Pick<
  SecondBrainDatabase,
  "execute" | "insert" | "select" | "update"
>;

export interface DecisionTransactionWriteResult {
  readonly decision: Decision;
  readonly activityEventId: string;
}

function failIntegrity(message: string): never {
  throw new StoredDataIntegrityError(message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mutationDigest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new Error(`${field} must be a UUID.`);
}

function requireIdempotencyKey(value: string): void {
  if (value.trim() === "" || value.length > 500) {
    throw new Error(
      "The idempotency key must contain between 1 and 500 characters.",
    );
  }
}

function requireInstant(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO 8601 timestamp.`);
  }
  return date;
}

function accessGate(
  database: DecisionExecutor,
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
          inArray(accounts.role, rolesAtLeast(requiredRole)),
        ),
      ),
  );
}

async function lock(
  database: DecisionExecutor,
  logicalKey: string,
): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${logicalKey}, 0))`,
  );
}

function actorValues(access: BrainAccessContext) {
  return {
    actorKind: access.actor.kind,
    actorAccountId: access.actor.accountId,
    actorClientId: access.actor.clientId,
    actorSource: access.actor.source,
  } as const;
}

function decodeActor(row: Record<string, unknown>): ActorAttribution {
  const source = row.actorSource;
  if (
    !["direct", "mcp_http", "automation", "import"].includes(
      typeof source === "string" ? source : "",
    )
  ) {
    failIntegrity("Stored decision provenance is invalid.");
  }
  if (row.actorKind === "account") {
    if (
      (row.actorAccountId !== null && typeof row.actorAccountId !== "string") ||
      row.actorClientId !== null
    ) {
      failIntegrity("Stored decision provenance is invalid.");
    }
    return {
      kind: "account",
      accountId: row.actorAccountId as string | null,
      clientId: null,
      source: source as ActorAttribution["source"],
    };
  }
  if (row.actorKind === "oauth_client") {
    if (row.actorAccountId === null && row.actorClientId === null) {
      return {
        kind: "oauth_client",
        accountId: null,
        clientId: null,
        source: source as ActorAttribution["source"],
      };
    }
    if (
      typeof row.actorAccountId === "string" &&
      typeof row.actorClientId === "string" &&
      row.actorClientId !== ""
    ) {
      return {
        kind: "oauth_client",
        accountId: row.actorAccountId,
        clientId: row.actorClientId,
        source: source as ActorAttribution["source"],
      };
    }
    failIntegrity("Stored decision provenance is invalid.");
  }
  if (row.actorKind === "import") {
    if (
      (row.actorAccountId !== null && typeof row.actorAccountId !== "string") ||
      row.actorClientId !== null
    ) {
      failIntegrity("Stored decision provenance is invalid.");
    }
    return {
      kind: "import",
      accountId: row.actorAccountId as string | null,
      clientId: null,
      source: source as ActorAttribution["source"],
    };
  }
  if (
    (row.actorKind === "dreaming" || row.actorKind === "system") &&
    row.actorAccountId === null &&
    row.actorClientId === null
  ) {
    return {
      kind: row.actorKind,
      accountId: null,
      clientId: null,
      source: source as ActorAttribution["source"],
    };
  }
  failIntegrity("Stored decision provenance is invalid.");
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

function decodeAlternatives(
  value: unknown,
): readonly { readonly option: string; readonly reason: string | null }[] {
  if (!Array.isArray(value))
    failIntegrity("Stored rejected alternatives are invalid.");
  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      typeof (item as Record<string, unknown>).option !== "string" ||
      ((item as Record<string, unknown>).reason !== null &&
        typeof (item as Record<string, unknown>).reason !== "string")
    ) {
      failIntegrity("Stored rejected alternatives are invalid.");
    }
    return item as { readonly option: string; readonly reason: string | null };
  });
}

const successor = alias(decisions, "decision_successor");

function decisionSelection() {
  return {
    id: decisions.id,
    lineageId: decisions.lineageId,
    versionNumber: decisions.versionNumber,
    supersedesId: decisions.supersedesId,
    statement: decisions.statement,
    rationale: decisions.rationale,
    rejectedAlternatives: decisions.rejectedAlternatives,
    projectId: decisions.projectId,
    decidedAt: decisions.decidedAt,
    revokedAt: decisions.revokedAt,
    contentHash: decisions.contentHash,
    sourceExcerpt: decisions.sourceExcerpt,
    actorKind: decisions.actorKind,
    actorAccountId: decisions.actorAccountId,
    actorClientId: decisions.actorClientId,
    actorSource: decisions.actorSource,
    createdAt: decisions.createdAt,
    updatedAt: decisions.updatedAt,
    successorId: successor.id,
    successorDecidedAt: successor.decidedAt,
  } as const;
}

function decodeDecision(
  raw: Record<string, unknown>,
  personIds: readonly string[],
  referenceTime: Date,
): Decision {
  const decidedAt = requireDate(raw.decidedAt, "Decision decidedAt");
  const revokedAt = nullableDate(raw.revokedAt, "Decision revokedAt");
  const successorDecidedAt = nullableDate(
    raw.successorDecidedAt,
    "Decision successor decidedAt",
  );
  const successorVisible =
    raw.successorId !== null &&
    successorDecidedAt !== null &&
    successorDecidedAt <= referenceTime;
  const status: DecisionStatus = successorVisible
    ? "superseded"
    : revokedAt !== null && revokedAt <= referenceTime
      ? "revoked"
      : "active";
  if (
    typeof raw.id !== "string" ||
    typeof raw.lineageId !== "string" ||
    typeof raw.versionNumber !== "number" ||
    !Number.isInteger(raw.versionNumber) ||
    raw.versionNumber < 1 ||
    (raw.supersedesId !== null && typeof raw.supersedesId !== "string") ||
    typeof raw.statement !== "string" ||
    typeof raw.rationale !== "string" ||
    (raw.projectId !== null && typeof raw.projectId !== "string") ||
    typeof raw.contentHash !== "string" ||
    !SHA256.test(raw.contentHash) ||
    (raw.sourceExcerpt !== null && typeof raw.sourceExcerpt !== "string") ||
    (raw.successorId !== null && typeof raw.successorId !== "string")
  ) {
    failIntegrity("Stored decision is invalid.");
  }
  return {
    id: raw.id,
    lineageId: raw.lineageId,
    version: raw.versionNumber,
    supersedesId: raw.supersedesId as string | null,
    statement: raw.statement,
    rationale: raw.rationale,
    rejectedAlternatives: decodeAlternatives(raw.rejectedAlternatives),
    status,
    projectId: raw.projectId as string | null,
    personIds,
    decidedAt: decidedAt.toISOString(),
    revokedAt: revokedAt?.toISOString() ?? null,
    provenance: decodeActor(raw),
    sourceExcerpt: raw.sourceExcerpt as string | null,
    contentHash: raw.contentHash,
    createdAt: requireDate(raw.createdAt, "Decision createdAt").toISOString(),
    updatedAt: requireDate(raw.updatedAt, "Decision updatedAt").toISOString(),
  };
}

async function peopleForDecisions(
  database: DecisionExecutor,
  access: BrainAccessContext,
  ids: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (ids.length === 0) return new Map();
  const rows = await database
    .select({
      decisionId: decisionPeople.decisionId,
      personId: decisionPeople.personId,
    })
    .from(decisionPeople)
    .where(
      and(
        inArray(decisionPeople.decisionId, ids),
        accessGate(database, access, "viewer"),
      ),
    )
    .orderBy(decisionPeople.createdAt, decisionPeople.personId);
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const values = result.get(row.decisionId) ?? [];
    values.push(row.personId);
    result.set(row.decisionId, values);
  }
  return result;
}

async function loadDecisionRecord(
  database: DecisionExecutor,
  access: BrainAccessContext,
  id: string,
  role: BrainRole,
  referenceTime: Date,
): Promise<{
  readonly decision: Decision;
  readonly successorId: string | null;
} | null> {
  const rows = await database
    .select(decisionSelection())
    .from(decisions)
    .leftJoin(
      successor,
      and(
        eq(successor.supersedesId, decisions.id),
      ),
    )
    .where(
      and(
        eq(decisions.id, id),
        accessGate(database, access, role),
      ),
    )
    .limit(2);
  if (rows.length === 0) return null;
  if (rows.length !== 1)
    failIntegrity("A decision has more than one successor.");
  const peopleByDecision = await peopleForDecisions(database, access, [id]);
  const row = rows[0]!;
  return {
    decision: decodeDecision(
      row as unknown as Record<string, unknown>,
      peopleByDecision.get(id) ?? [],
      referenceTime,
    ),
    successorId: row.successorId,
  };
}

async function readReceipt(
  database: DecisionExecutor,
  access: BrainAccessContext,
  operation: string,
  idempotencyKey: string,
) {
  const rows = await database
    .select({
      requestDigest: mutationReceipts.requestDigest,
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
    .limit(2)
    .for("share");
  if (rows.length > 1)
    failIntegrity("Duplicate decision mutation receipts exist.");
  return rows[0] ?? null;
}

async function insertReceipt(
  database: DecisionTransaction,
  access: BrainAccessContext,
  input: {
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly decisionId: string | null;
    readonly activityEventId?: string | undefined;
  },
): Promise<void> {
  const rows = await database
    .insert(mutationReceipts)
    .values({
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      resultEntityType: input.decisionId === null ? null : "decision",
      resultEntityId: input.decisionId,
      resultVersionId: input.decisionId,
      result: { decisionId: input.decisionId },
      activityEventId: input.activityEventId ?? null,
    })
    .returning({ id: mutationReceipts.id });
  if (rows.length !== 1)
    failIntegrity("A decision mutation receipt was not written.");
}

async function insertDecisionEvent(
  database: DecisionTransaction,
  access: BrainAccessContext,
  input: {
    readonly entityId: string;
    readonly action: "created" | "superseded" | "revoked";
    readonly effectiveAt: Date;
    readonly afterVersionId: string | null;
    readonly contentHash: string;
    readonly changedFields: readonly string[];
    readonly idempotencyKey: string;
    readonly requestDigest: string;
  },
): Promise<string> {
  const actor = access.actor;
  const rows = await database
    .insert(activityEvents)
    .values({
      entityType: "decision",
      entityId: input.entityId,
      action: input.action,
      occurredAt: input.effectiveAt,
      effectiveAt: input.effectiveAt,
      changedFields: [...input.changedFields],
      afterVersionId: input.afterVersionId,
      contentHash: input.contentHash,
      requestDigest: input.requestDigest,
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
    failIntegrity("A decision activity event was not written.");
  return rows[0]!.id;
}

async function validateDecisionCreateReceiptEvent(
  database: DecisionTransaction,
  access: BrainAccessContext,
  input: {
    readonly eventId: string;
    readonly decision: Decision;
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
        eq(activityEvents.entityType, "decision"),
        eq(activityEvents.entityId, input.decision.id),
        eq(activityEvents.action, "created"),
        eq(activityEvents.afterVersionId, input.decision.id),
        eq(activityEvents.contentHash, input.decision.contentHash),
        eq(activityEvents.requestDigest, input.requestDigest),
        eq(
          activityEvents.idempotencyKey,
          `${CREATE_OPERATION}:${input.idempotencyKey}:created`,
        ),
        accessGate(database, access, "editor"),
      ),
    )
    .limit(2);
  if (rows.length !== 1) {
    failIntegrity(
      "A decision create receipt points to an invalid activity event.",
    );
  }
}

function decisionIdFromReceipt(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failIntegrity("A decision mutation receipt is invalid.");
  }
  const decisionId = (value as Record<string, unknown>).decisionId;
  if (decisionId !== null && typeof decisionId !== "string") {
    failIntegrity("A decision mutation receipt is invalid.");
  }
  return decisionId;
}

async function requireActiveSpace(
  database: DecisionExecutor,
  access: BrainAccessContext,
  input: DecisionWriteInput,
) {
  const rows = await database
    .select({
      dimensions: embeddingSpaces.dimensions,
      recipeVersion: embeddingSpaces.recipeVersion,
    })
    .from(embeddingSpaces)
    .where(
      and(
        eq(embeddingSpaces.id, input.embedding.spaceId),
        eq(embeddingSpaces.entityType, "decision"),
        eq(embeddingSpaces.status, "active"),
        eq(embeddingSpaces.metric, "cosine"),
        accessGate(database, access, "editor"),
      ),
    )
    .limit(2)
    .for("share");
  if (rows.length !== 1) {
    throw new Error(
      "The decision embedding space is not active for this brain.",
    );
  }
  if (rows[0]!.recipeVersion !== DECISION_EMBEDDING_RECIPE_VERSION) {
    throw new Error(
      "The active decision embedding space uses an incompatible recipe.",
    );
  }
  const vector = input.embedding.vector;
  const norm = Math.hypot(...vector);
  if (
    vector.length !== rows[0]!.dimensions ||
    vector.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(norm) ||
    norm === 0
  ) {
    throw new Error(
      `Expected a finite, non-zero ${rows[0]!.dimensions}-dimension embedding.`,
    );
  }
  return rows[0]!;
}

async function linkedContextExists(
  database: DecisionExecutor,
  access: BrainAccessContext,
  projectId: string | null,
  personIds: readonly string[],
): Promise<boolean> {
  if (new Set(personIds).size !== personIds.length) {
    throw new Error("personIds must not contain duplicates.");
  }
  if (projectId !== null) {
    const rows = await database
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          accessGate(database, access, "editor"),
        ),
      )
      .limit(1);
    if (rows.length !== 1) return false;
  }
  if (personIds.length > 0) {
    const rows = await database
      .select({ id: people.id })
      .from(people)
      .where(
        and(
          inArray(people.id, personIds),
          accessGate(database, access, "editor"),
        ),
      );
    if (rows.length !== personIds.length) return false;
  }
  return true;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

export async function createDecisionInTransaction(
  database: DecisionTransaction,
  access: BrainAccessContext,
  input: DecisionWriteInput,
  signal: AbortSignal,
): Promise<DecisionTransactionWriteResult | null> {
  signal.throwIfAborted();
  await authorizeBrainTransaction(database, access, "editor", signal);
  requireIdempotencyKey(input.idempotencyKey);
  requireUuid(input.embedding.spaceId, "embedding.spaceId");
  if (!SHA256.test(input.embedding.contentHash)) {
    throw new Error(
      "embedding.contentHash must be a lowercase SHA-256 digest.",
    );
  }
  const contentHash = decisionEmbeddingRecipe({
    statement: input.statement,
    rationale: input.rationale,
    rejectedAlternatives: input.rejectedAlternatives,
  }).contentHash;
  const digest = mutationDigest({
    statement: input.statement,
    rationale: input.rationale,
    rejectedAlternatives: input.rejectedAlternatives,
    projectId: input.projectId,
    personIds: input.personIds,
    decidedAt: input.decidedAt,
    sourceExcerpt: input.sourceExcerpt,
    embedding: input.embedding,
    supersedesId: input.supersedesId,
    expectedSupersededHash: input.expectedSupersededHash,
    expectedSupersededVersion: input.expectedSupersededVersion,
  });
  await lock(database, `${CREATE_OPERATION}:${input.idempotencyKey}`);
  const receipt = await readReceipt(
    database,
    access,
    CREATE_OPERATION,
    input.idempotencyKey,
  );
  if (receipt !== null) {
    if (receipt.requestDigest !== digest)
      throw new MutationReceiptConflictError();
    const decisionId = decisionIdFromReceipt(receipt.result);
    if (decisionId === null) return null;
    const existing = await loadDecisionRecord(
      database,
      access,
      decisionId,
      "editor",
      new Date(),
    );
    if (existing === null)
      failIntegrity("A decision receipt points to a missing decision.");
    if (typeof receipt.activityEventId !== "string") {
      failIntegrity("A decision create receipt is missing its activity event.");
    }
    await validateDecisionCreateReceiptEvent(database, access, {
      eventId: receipt.activityEventId,
      decision: existing.decision,
      requestDigest: digest,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      decision: existing.decision,
      activityEventId: receipt.activityEventId,
    };
  }
  if (contentHash !== input.embedding.contentHash) {
    throw new Error(
      "The decision embedding content hash does not match the decision content.",
    );
  }
  const space = await requireActiveSpace(database, access, input);
  if (
    !(await linkedContextExists(
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
  if (input.supersedesId !== null) {
    requireUuid(input.supersedesId, "supersedesId");
    const initial = await loadDecisionRecord(
      database,
      access,
      input.supersedesId,
      "editor",
      new Date(),
    );
    if (initial === null) return null;
    await lock(
      database,
      `decision-lineage:${initial.decision.lineageId}`,
    );
    const target = await loadDecisionRecord(
      database,
      access,
      input.supersedesId,
      "editor",
      new Date(),
    );
    if (
      target === null ||
      target.successorId !== null ||
      target.decision.status !== "active" ||
      target.decision.contentHash !== input.expectedSupersededHash ||
      target.decision.version !== input.expectedSupersededVersion ||
      target.decision.projectId !== input.projectId ||
      !sameIds(target.decision.personIds, input.personIds) ||
      requireInstant(input.decidedAt, "decidedAt") <=
        new Date(target.decision.decidedAt)
    ) {
      return null;
    }
    lineageId = target.decision.lineageId;
    version = target.decision.version + 1;
  } else if (
    input.expectedSupersededHash !== null ||
    input.expectedSupersededVersion !== null
  ) {
    return null;
  }
  const actor = actorValues(access);
  const inserted = await database
    .insert(decisions)
    .values({
      id,
      lineageId,
      versionNumber: version,
      supersedesId: input.supersedesId,
      statement: input.statement,
      rationale: input.rationale,
      rejectedAlternatives: input.rejectedAlternatives,
      projectId: input.projectId,
      decidedAt: requireInstant(input.decidedAt, "decidedAt"),
      contentHash,
      sourceExcerpt: input.sourceExcerpt,
      ...actor,
    })
    .returning({ id: decisions.id });
  if (inserted.length !== 1) failIntegrity("A decision was not written.");
  for (const personId of input.personIds) {
    const linked = await database
      .insert(decisionPeople)
      .values({ decisionId: id, personId })
      .returning({ id: decisionPeople.decisionId });
    if (linked.length !== 1)
      failIntegrity("A decision-person link was not written.");
  }
  const embedded = await database
    .insert(decisionEmbeddings)
    .values({
      decisionId: id,
      spaceId: input.embedding.spaceId,
      contentHash,
      recipeVersion: space.recipeVersion,
      embedding: [...input.embedding.vector],
    })
    .returning({ id: decisionEmbeddings.id });
  if (embedded.length !== 1)
    failIntegrity("A decision embedding was not written.");
  const decidedAt = requireInstant(input.decidedAt, "decidedAt");
  if (input.supersedesId !== null) {
    await insertDecisionEvent(database, access, {
      entityId: input.supersedesId,
      action: "superseded",
      effectiveAt: decidedAt,
      afterVersionId: id,
      contentHash,
      changedFields: ["supersededBy"],
      idempotencyKey: `${CREATE_OPERATION}:${input.idempotencyKey}:superseded`,
      requestDigest: digest,
    });
  }
  const activityEventId = await insertDecisionEvent(database, access, {
    entityId: id,
    action: "created",
    effectiveAt: decidedAt,
    afterVersionId: id,
    contentHash,
    changedFields: [
      "statement",
      "rationale",
      "rejectedAlternatives",
      "projectId",
      "personIds",
    ],
    idempotencyKey: `${CREATE_OPERATION}:${input.idempotencyKey}:created`,
    requestDigest: digest,
  });
  await insertReceipt(database, access, {
    operation: CREATE_OPERATION,
    idempotencyKey: input.idempotencyKey,
    requestDigest: digest,
    decisionId: id,
    activityEventId,
  });
  const created = await loadDecisionRecord(
    database,
    access,
    id,
    "editor",
    new Date(),
  );
  if (created === null)
    failIntegrity("A newly written decision could not be read.");
  signal.throwIfAborted();
  return { decision: created.decision, activityEventId };
}

export class DrizzleDecisionStore implements DecisionStore {
  constructor(private readonly database: DecisionDatabase) {}

  async createDecision(
    access: BrainAccessContext,
    input: DecisionWriteInput,
    signal: AbortSignal,
  ): Promise<Decision | null> {
    return this.database.transaction(async (transaction) => {
      const written = await createDecisionInTransaction(
        transaction,
        access,
        input,
        signal,
      );
      return written?.decision ?? null;
    });
  }

  async listDecisions(
    access: BrainAccessContext,
    input: {
      readonly status: DecisionStatus | null;
      readonly projectId: string | null;
      readonly personId: string | null;
      readonly asOf: string | null;
      readonly includeSuperseded: boolean;
      readonly cursor: { readonly ts: string; readonly id: string } | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly items: readonly Decision[];
    readonly nextCursor: { readonly ts: string; readonly id: string } | null;
  }> {
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
        const child = alias(decisions, "decision_visible_successor");
        const hasVisibleSuccessor = exists(
          transaction
            .select({ id: child.id })
            .from(child)
            .where(
              and(
                eq(child.supersedesId, decisions.id),
                lte(child.decidedAt, referenceTime),
                accessGate(transaction, access, "viewer"),
              ),
            ),
        );
        const activeAtReference = and(
          notExists(
            transaction
              .select({ id: child.id })
              .from(child)
              .where(
                and(
                  eq(child.supersedesId, decisions.id),
                  lte(child.decidedAt, referenceTime),
                  accessGate(transaction, access, "viewer"),
                ),
              ),
          ),
          or(
            isNull(decisions.revokedAt),
            gt(decisions.revokedAt, referenceTime),
          ),
        )!;
        const revokedAtReference = and(
          lte(decisions.revokedAt, referenceTime),
          notExists(
            transaction
              .select({ id: child.id })
              .from(child)
              .where(
                and(
                  eq(child.supersedesId, decisions.id),
                  lte(child.decidedAt, referenceTime),
                  accessGate(transaction, access, "viewer"),
                ),
              ),
          ),
        )!;
        const predicates = [
          lte(decisions.decidedAt, referenceTime),
          accessGate(transaction, access, "viewer"),
        ];
        if (!input.includeSuperseded) {
          predicates.push(
            notExists(
              transaction
                .select({ id: child.id })
                .from(child)
                .where(
                  and(
                    eq(child.supersedesId, decisions.id),
                    lte(child.decidedAt, referenceTime),
                    accessGate(transaction, access, "viewer"),
                  ),
                ),
            ),
          );
        }
        if (input.status === "active") predicates.push(activeAtReference);
        if (input.status === "superseded") predicates.push(hasVisibleSuccessor);
        if (input.status === "revoked") predicates.push(revokedAtReference);
        if (input.projectId !== null)
          predicates.push(eq(decisions.projectId, input.projectId));
        if (input.personId !== null) {
          predicates.push(
            exists(
              transaction
                .select({ id: decisionPeople.decisionId })
                .from(decisionPeople)
                .where(
                  and(
                    eq(decisionPeople.decisionId, decisions.id),
                    eq(decisionPeople.personId, input.personId),
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
              lt(decisions.decidedAt, cursorTime),
              and(
                eq(decisions.decidedAt, cursorTime),
                lt(decisions.id, input.cursor.id),
              ),
            )!,
          );
        }
        const rows = await transaction
          .select(decisionSelection())
          .from(decisions)
          .leftJoin(
            successor,
            and(
              eq(successor.supersedesId, decisions.id),
            ),
          )
          .where(and(...predicates))
          .orderBy(desc(decisions.decidedAt), desc(decisions.id))
          .limit(input.limit + 1);
        const hasMore = rows.length > input.limit;
        const pageRows = rows.slice(0, input.limit);
        const peopleByDecision = await peopleForDecisions(
          transaction,
          access,
          pageRows.map((row) => row.id),
        );
        signal.throwIfAborted();
        const items = pageRows.map((row) =>
          decodeDecision(
            row as unknown as Record<string, unknown>,
            peopleByDecision.get(row.id) ?? [],
            referenceTime,
          ),
        );
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            hasMore && last !== undefined
              ? { ts: last.decidedAt, id: last.id }
              : null,
        };
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async revokeDecision(
    access: BrainAccessContext,
    id: string,
    precondition: VersionPrecondition,
    signal: AbortSignal,
  ): Promise<Decision | null> {
    requireUuid(id, "id");
    requireIdempotencyKey(precondition.idempotencyKey);
    const digest = mutationDigest({
      id,
      expectedVersion: precondition.expectedVersion,
    });
    return this.database.transaction(async (transaction) => {
      signal.throwIfAborted();
      await authorizeBrainTransaction(transaction, access, "editor", signal);
      await lock(
        transaction,
        `${REVOKE_OPERATION}:${precondition.idempotencyKey}`,
      );
      const receipt = await readReceipt(
        transaction,
        access,
        REVOKE_OPERATION,
        precondition.idempotencyKey,
      );
      if (receipt !== null) {
        if (receipt.requestDigest !== digest)
          throw new MutationReceiptConflictError();
        const decisionId = decisionIdFromReceipt(receipt.result);
        if (decisionId === null) return null;
        const existing = await loadDecisionRecord(
          transaction,
          access,
          decisionId,
          "editor",
          new Date(),
        );
        if (existing === null)
          failIntegrity(
            "A decision revoke receipt points to a missing decision.",
          );
        return existing.decision;
      }
      const initial = await loadDecisionRecord(
        transaction,
        access,
        id,
        "editor",
        new Date(),
      );
      if (initial === null) {
        await insertReceipt(transaction, access, {
          operation: REVOKE_OPERATION,
          idempotencyKey: precondition.idempotencyKey,
          requestDigest: digest,
          decisionId: null,
        });
        return null;
      }
      await lock(
        transaction,
        `decision-lineage:${initial.decision.lineageId}`,
      );
      const target = await loadDecisionRecord(
        transaction,
        access,
        id,
        "editor",
        new Date(),
      );
      if (
        target === null ||
        target.successorId !== null ||
        target.decision.status !== "active" ||
        target.decision.version !== precondition.expectedVersion
      ) {
        await insertReceipt(transaction, access, {
          operation: REVOKE_OPERATION,
          idempotencyKey: precondition.idempotencyKey,
          requestDigest: digest,
          decisionId: null,
        });
        return null;
      }
      const now = new Date();
      const updated = await transaction
        .update(decisions)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(decisions.id, id),
            eq(decisions.versionNumber, precondition.expectedVersion),
            isNull(decisions.revokedAt),
            accessGate(transaction, access, "editor"),
          ),
        )
        .returning({ id: decisions.id });
      if (updated.length !== 1)
        failIntegrity("A locked decision changed during revocation.");
      const activityEventId = await insertDecisionEvent(transaction, access, {
        entityId: id,
        action: "revoked",
        effectiveAt: now,
        afterVersionId: id,
        contentHash: target.decision.contentHash,
        changedFields: ["status", "revokedAt"],
        idempotencyKey: `${REVOKE_OPERATION}:${precondition.idempotencyKey}:revoked`,
        requestDigest: digest,
      });
      await insertReceipt(transaction, access, {
        operation: REVOKE_OPERATION,
        idempotencyKey: precondition.idempotencyKey,
        requestDigest: digest,
        decisionId: id,
        activityEventId,
      });
      const revoked = await loadDecisionRecord(
        transaction,
        access,
        id,
        "editor",
        now,
      );
      if (revoked === null || revoked.decision.status !== "revoked") {
        failIntegrity("A revoked decision could not be read.");
      }
      signal.throwIfAborted();
      return revoked.decision;
    });
  }
}
