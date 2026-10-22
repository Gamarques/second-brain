import {
  and,
  desc,
  eq,
  gte,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import {
  adminBoundaryAuditRow,
  type AdminAuditRecorder,
  type AdminBoundaryAuditActor,
  type AdminBoundaryAuditEvent,
} from "../admin/audit.js";
import {
  adminAuditCategories,
  adminAuditOutcomes,
  type AdminAuditCategory,
  type AdminAuditEvent,
  type AdminAuditOutcome,
  type AdminAuditStore,
} from "../admin/domain.js";
import {
  brainRoles,
  type BrainAccessContext,
  type CursorPosition,
  type Page,
} from "@second-brain/engine/domain/core";
import {
  adminAuditActorAliases,
  adminAuditEvents,
} from "@second-brain/engine/database/schema/admin";
import { accounts } from "@second-brain/engine/database/schema/identity";
import type { OAuthInteractionLoginAuditEvent } from "../auth/interaction-server.js";
import { authorizeBrainTransaction } from "@second-brain/engine/database/stores/authorization";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "@second-brain/engine/database/stores/database";

const CONFIGURATION_TARGET = "environment_configuration";
const MAX_METADATA_BYTES = 16_384;
const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_MEMBERS = 100;

export class AdminAuditStoreContractError extends Error {
  readonly code = "ADMIN_AUDIT_STORE_CONTRACT_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdminAuditStoreContractError";
  }
}

export interface AdminAuditAppendInput {
  readonly category: AdminAuditCategory;
  readonly action: string;
  readonly outcome: AdminAuditOutcome;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly errorCode: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly changedNames?: readonly string[] | undefined;
}

export interface NormalizedAdminAuditAppendInput {
  readonly category: AdminAuditCategory;
  readonly action: string;
  readonly outcome: AdminAuditOutcome;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly errorCode: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly changedNames: readonly string[];
}

const auditRowSchema = z.object({
  id: z.string().uuid(),
  category: z.enum(adminAuditCategories),
  action: z.string().min(1).max(200),
  outcome: z.enum(adminAuditOutcomes),
  targetType: z.string().min(1).max(200).nullable(),
  targetId: z.string().min(1).max(500).nullable(),
  actorAliasId: z.string().uuid().nullable(),
  actorAccountId: z.string().uuid().nullable(),
  actorRole: z.enum(brainRoles).nullable(),
  requestId: z.string().min(1).max(500),
  errorCode: z.string().min(1).max(200).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  changedNames: z.array(z.string()).max(100),
  occurredAt: z.date(),
});

function fail(detail: string, cause?: unknown): never {
  throw new AdminAuditStoreContractError(
    `Invalid admin audit persistence data: ${detail}.`,
    cause === undefined ? undefined : { cause },
  );
}

function text(
  value: string,
  name: string,
  maximum: number,
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new AdminAuditStoreContractError(
      `${name} must contain between 1 and ${maximum} characters.`,
    );
  }
  return normalized;
}

function nullableText(
  value: string | null,
  name: string,
  maximum: number,
): string | null {
  return value === null ? null : text(value, name, maximum);
}

function date(value: string, name: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.valueOf())) {
    throw new AdminAuditStoreContractError(`${name} must be a valid ISO timestamp.`);
  }
  return result;
}

function uuid(value: string, name: string): string {
  const decoded = z.string().uuid().safeParse(value);
  if (!decoded.success) {
    throw new AdminAuditStoreContractError(`${name} must be a UUID.`);
  }
  return decoded.data;
}

function limit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new AdminAuditStoreContractError(
      "limit must be an integer between 1 and 100.",
    );
  }
  return value;
}

function assertJsonValue(value: unknown, depth: number): void {
  if (depth > MAX_METADATA_DEPTH) {
    throw new AdminAuditStoreContractError(
      `metadata must be at most ${MAX_METADATA_DEPTH} levels deep.`,
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new AdminAuditStoreContractError("metadata numbers must be finite.");
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_MEMBERS) {
      throw new AdminAuditStoreContractError(
        `metadata arrays may contain at most ${MAX_METADATA_MEMBERS} items.`,
      );
    }
    for (const item of value) assertJsonValue(item, depth + 1);
    return;
  }
  if (typeof value !== "object") {
    throw new AdminAuditStoreContractError("metadata must contain JSON values only.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AdminAuditStoreContractError("metadata must contain JSON values only.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_MEMBERS) {
    throw new AdminAuditStoreContractError(
      `metadata objects may contain at most ${MAX_METADATA_MEMBERS} properties.`,
    );
  }
  for (const [key, member] of entries) {
    text(key, "metadata property names", 200);
    assertJsonValue(member, depth + 1);
  }
}

function metadata(
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const candidate = value ?? {};
  assertJsonValue(candidate, 0);
  const encoded = JSON.stringify(candidate);
  if (Buffer.byteLength(encoded, "utf8") > MAX_METADATA_BYTES) {
    throw new AdminAuditStoreContractError(
      `metadata must encode to at most ${MAX_METADATA_BYTES} bytes.`,
    );
  }
  return JSON.parse(encoded) as Readonly<Record<string, unknown>>;
}

function changedNames(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined || value.length < 1 || value.length > 100) {
    throw new AdminAuditStoreContractError(
      "changedNames must contain between 1 and 100 names.",
    );
  }
  const names = value.map((name) => text(name, "changedNames entries", 200));
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function configurationMetadataIsExact(
  value: Readonly<Record<string, unknown>>,
  names: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === "changedNames" &&
    Array.isArray(value.changedNames) &&
    value.changedNames.every((name) => typeof name === "string") &&
    sameStrings(value.changedNames as string[], names)
  );
}

export function normalizeAdminAuditAppendInput(
  input: AdminAuditAppendInput,
): NormalizedAdminAuditAppendInput {
  if (!adminAuditCategories.includes(input.category)) {
    throw new AdminAuditStoreContractError("category is invalid.");
  }
  if (!adminAuditOutcomes.includes(input.outcome)) {
    throw new AdminAuditStoreContractError("outcome is invalid.");
  }
  const targetType = nullableText(input.targetType, "targetType", 200);
  const targetId = nullableText(input.targetId, "targetId", 500);
  if (targetType === null && targetId !== null) {
    throw new AdminAuditStoreContractError(
      "targetId requires a targetType.",
    );
  }

  if (targetType === CONFIGURATION_TARGET) {
    if (input.metadata !== undefined) {
      throw new AdminAuditStoreContractError(
        "Configuration audit metadata must contain changed names only.",
      );
    }
    const names = changedNames(input.changedNames);
    return {
      category: input.category,
      action: text(input.action, "action", 200),
      outcome: input.outcome,
      targetType,
      targetId,
      errorCode: nullableText(input.errorCode, "errorCode", 200),
      metadata: { changedNames: names },
      changedNames: names,
    };
  }

  if (input.changedNames !== undefined) {
    throw new AdminAuditStoreContractError(
      "changedNames are reserved for environment configuration audit events.",
    );
  }
  return {
    category: input.category,
    action: text(input.action, "action", 200),
    outcome: input.outcome,
    targetType,
    targetId,
    errorCode: nullableText(input.errorCode, "errorCode", 200),
    metadata: metadata(input.metadata),
    changedNames: [],
  };
}

export function decodeAdminAuditRow(row: unknown): AdminAuditEvent {
  const decoded = auditRowSchema.safeParse(row);
  if (!decoded.success) fail("row validation failed", decoded.error);
  const value = decoded.data;
  const decodedMetadata = metadata(value.metadata);

  if (value.targetType === CONFIGURATION_TARGET) {
    const names = changedNames(value.changedNames);
    if (
      !sameStrings(names, value.changedNames) ||
      !configurationMetadataIsExact(decodedMetadata, value.changedNames)
    ) {
      fail("configuration metadata is inconsistent");
    }
  } else if (value.changedNames.length !== 0) {
    fail("changed names exist for a non-configuration event");
  }

  return {
    id: value.id,
    category: value.category,
    action: value.action,
    outcome: value.outcome,
    targetType: value.targetType,
    targetId: value.targetId,
    actorAccountId: value.actorAccountId,
    actorRole: value.actorRole,
    requestId: value.requestId,
    errorCode: value.errorCode,
    metadata: decodedMetadata,
    occurredAt: value.occurredAt.toISOString(),
  };
}

function cursorCondition(cursor: CursorPosition | null): SQL | undefined {
  if (cursor === null) return undefined;
  const occurredAt = date(cursor.ts, "cursor.ts");
  const id = uuid(cursor.id, "cursor.id");
  return or(
    lt(adminAuditEvents.occurredAt, occurredAt),
    and(
      eq(adminAuditEvents.occurredAt, occurredAt),
      lt(adminAuditEvents.id, id),
    ),
  );
}

interface NormalizedListInput {
  readonly category: AdminAuditCategory | null;
  readonly action: string | null;
  readonly outcome: AdminAuditOutcome | null;
  readonly actorAccountId: string | null;
  readonly targetType: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly cursor: SQL | undefined;
  readonly limit: number;
}

function normalizeListInput(
  input: Parameters<AdminAuditStore["listAuditEvents"]>[1],
): NormalizedListInput {
  if (
    input.category !== null &&
    !adminAuditCategories.includes(input.category)
  ) {
    throw new AdminAuditStoreContractError("category is invalid.");
  }
  if (input.outcome !== null && !adminAuditOutcomes.includes(input.outcome)) {
    throw new AdminAuditStoreContractError("outcome is invalid.");
  }
  const from = input.from === null ? null : date(input.from, "from");
  const to = input.to === null ? null : date(input.to, "to");
  if (from !== null && to !== null && from > to) {
    throw new AdminAuditStoreContractError("from must not be after to.");
  }
  return {
    category: input.category,
    action:
      input.action === null ? null : text(input.action, "action", 200),
    outcome: input.outcome,
    actorAccountId:
      input.actorAccountId === null
        ? null
        : uuid(input.actorAccountId, "actorAccountId"),
    targetType:
      input.targetType === null
        ? null
        : text(input.targetType, "targetType", 200),
    from,
    to,
    cursor: cursorCondition(input.cursor),
    limit: limit(input.limit),
  };
}

function eventRowSelection() {
  return {
    id: adminAuditEvents.id,
    category: adminAuditEvents.category,
    action: adminAuditEvents.action,
    outcome: adminAuditEvents.outcome,
    targetType: adminAuditEvents.targetType,
    targetId: adminAuditEvents.targetId,
    actorAliasId: adminAuditEvents.actorAliasId,
    actorRole: adminAuditEvents.actorRole,
    requestId: adminAuditEvents.requestId,
    errorCode: adminAuditEvents.errorCode,
    metadata: adminAuditEvents.metadata,
    changedNames: adminAuditEvents.changedNames,
    occurredAt: adminAuditEvents.occurredAt,
  };
}

const aliasRowsSchema = z
  .array(z.object({ actorAliasId: z.string().uuid() }))
  .min(1)
  .max(1);

async function resolveActorAliasId(
  transaction: SecondBrainTransaction,
  accountId: string,
  signal: AbortSignal,
): Promise<string> {
  const normalizedAccountId = uuid(accountId, "actor.accountId");
  await transaction
    .insert(adminAuditActorAliases)
    .values({ accountId: normalizedAccountId })
    .onConflictDoNothing({ target: adminAuditActorAliases.accountId });
  const rows = await transaction
    .select({ actorAliasId: adminAuditActorAliases.id })
    .from(adminAuditActorAliases)
    .where(eq(adminAuditActorAliases.accountId, normalizedAccountId))
    .limit(2);
  signal.throwIfAborted();
  const decoded = aliasRowsSchema.safeParse(rows);
  if (!decoded.success) fail("actor alias resolution failed", decoded.error);
  return decoded.data[0]!.actorAliasId;
}

export interface ResolvedAdminAuditActorAlias {
  readonly actorAliasId: string;
  readonly access: BrainAccessContext;
}

export async function resolveAdminAuditActorAlias(
  transaction: SecondBrainTransaction,
  access: BrainAccessContext,
  signal: AbortSignal,
): Promise<ResolvedAdminAuditActorAlias> {
  const authorized = await authorizeBrainTransaction(
    transaction,
    access,
    "admin",
    signal,
  );
  return {
    actorAliasId: await resolveActorAliasId(
      transaction,
      authorized.accountId,
      signal,
    ),
    access: authorized,
  };
}

async function appendBoundaryAuditEvent(
  transaction: SecondBrainTransaction,
  actor: AdminBoundaryAuditActor | null,
  requestId: string,
  input: AdminAuditAppendInput,
  signal: AbortSignal,
): Promise<void> {
  const normalized = normalizeAdminAuditAppendInput(input);
  const actorAliasId = actor === null
    ? null
    : await resolveActorAliasId(transaction, actor.accountId, signal);
  const rows = await transaction
    .insert(adminAuditEvents)
    .values({
      category: normalized.category,
      action: normalized.action,
      outcome: normalized.outcome,
      targetType: normalized.targetType,
      targetId: normalized.targetId,
      actorAliasId,
      actorRole: actor?.role ?? null,
      requestId: text(requestId, "requestId", 500),
      errorCode: normalized.errorCode,
      metadata: normalized.metadata,
      changedNames: [...normalized.changedNames],
    })
    .returning({ id: adminAuditEvents.id });
  signal.throwIfAborted();
  if (rows.length !== 1) fail("boundary append did not return exactly one row");
}

async function oauthAuditActor(
  transaction: SecondBrainTransaction,
  accountId: string | null,
  signal: AbortSignal,
): Promise<AdminBoundaryAuditActor | null> {
  if (accountId === null) return null;
  const normalizedAccountId = uuid(accountId, "accountId");
  const rows = await transaction
    .select({ accountId: accounts.id, role: accounts.role })
    .from(accounts)
    .where(eq(accounts.id, normalizedAccountId))
    .limit(2);
  signal.throwIfAborted();
  const decoded = z
    .array(z.object({ accountId: z.string().uuid(), role: z.enum(brainRoles) }))
    .length(1)
    .safeParse(rows);
  if (!decoded.success) fail("OAuth audit actor resolution failed", decoded.error);
  return decoded.data[0]!;
}

/**
 * Appends inside an existing transaction so the audited mutation and its event
 * either commit together or both roll back.
 */
export async function appendAdminAuditEvent(
  transaction: SecondBrainTransaction,
  access: BrainAccessContext,
  input: AdminAuditAppendInput,
  signal: AbortSignal,
): Promise<AdminAuditEvent> {
  const actor = await resolveAdminAuditActorAlias(transaction, access, signal);
  const normalized = normalizeAdminAuditAppendInput(input);
  const rows = await transaction
    .insert(adminAuditEvents)
    .values({
      category: normalized.category,
      action: normalized.action,
      outcome: normalized.outcome,
      targetType: normalized.targetType,
      targetId: normalized.targetId,
      actorAliasId: actor.actorAliasId,
      actorRole: actor.access.role,
      requestId: actor.access.actor.requestId,
      errorCode: normalized.errorCode,
      metadata: normalized.metadata,
      changedNames: [...normalized.changedNames],
    })
    .returning(eventRowSelection());
  signal.throwIfAborted();
  if (rows.length !== 1) fail("append did not return exactly one row");
  return decodeAdminAuditRow({
    ...rows[0],
    actorAccountId: actor.access.accountId,
  });
}

export class DrizzleAdminAuditStore implements AdminAuditStore, AdminAuditRecorder {
  constructor(private readonly database: SecondBrainDatabase) {}

  appendAuditEvent(
    access: BrainAccessContext,
    input: AdminAuditAppendInput,
    signal: AbortSignal,
  ): Promise<AdminAuditEvent> {
    signal.throwIfAborted();
    return this.database.transaction((transaction) =>
      appendAdminAuditEvent(transaction, access, input, signal),
    );
  }

  record(event: AdminBoundaryAuditEvent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const row = adminBoundaryAuditRow(event);
    return this.database.transaction((transaction) =>
      appendBoundaryAuditEvent(
        transaction,
        row.actor,
        row.requestId,
        {
          category: row.category,
          action: row.action,
          outcome: row.outcome,
          targetType: row.targetType,
          targetId: row.targetId,
          errorCode: row.errorCode,
          metadata: row.metadata,
        },
        signal,
      ),
    );
  }

  recordOAuthSignInOutcome(
    event: OAuthInteractionLoginAuditEvent,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const actor = await oauthAuditActor(
        transaction,
        event.accountId,
        signal,
      );
      await appendBoundaryAuditEvent(
        transaction,
        actor,
        event.requestId,
        {
          category: "authentication",
          action: "authentication.oauth_sign_in",
          outcome: event.outcome,
          targetType: "admin_session",
          targetId: null,
          errorCode: event.errorCode,
          metadata: {},
        },
        signal,
      );
    });
  }

  listAuditEvents(
    access: BrainAccessContext,
    input: Parameters<AdminAuditStore["listAuditEvents"]>[1],
    signal: AbortSignal,
  ): Promise<Page<AdminAuditEvent>> {
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      const normalized = normalizeListInput(input);
      const conditions: SQL[] = [];
      if (normalized.category !== null) {
        conditions.push(eq(adminAuditEvents.category, normalized.category));
      }
      if (normalized.action !== null) {
        conditions.push(eq(adminAuditEvents.action, normalized.action));
      }
      if (normalized.outcome !== null) {
        conditions.push(eq(adminAuditEvents.outcome, normalized.outcome));
      }
      if (normalized.actorAccountId !== null) {
        conditions.push(
          eq(adminAuditActorAliases.accountId, normalized.actorAccountId),
        );
      }
      if (normalized.targetType !== null) {
        conditions.push(eq(adminAuditEvents.targetType, normalized.targetType));
      }
      if (normalized.from !== null) {
        conditions.push(gte(adminAuditEvents.occurredAt, normalized.from));
      }
      if (normalized.to !== null) {
        conditions.push(lte(adminAuditEvents.occurredAt, normalized.to));
      }
      if (normalized.cursor !== undefined) conditions.push(normalized.cursor);

      const rows = await transaction
        .select({
          ...eventRowSelection(),
          actorAccountId: adminAuditActorAliases.accountId,
        })
        .from(adminAuditEvents)
        .leftJoin(
          adminAuditActorAliases,
          eq(adminAuditActorAliases.id, adminAuditEvents.actorAliasId),
        )
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(desc(adminAuditEvents.occurredAt), desc(adminAuditEvents.id))
        .limit(normalized.limit + 1);
      signal.throwIfAborted();

      const hasNext = rows.length > normalized.limit;
      const items = rows
        .slice(0, normalized.limit)
        .map((row) => decodeAdminAuditRow(row));
      const tail = items.at(-1);
      return {
        items,
        nextCursor:
          hasNext && tail !== undefined
            ? { ts: tail.occurredAt, id: tail.id }
            : null,
      };
    });
  }
}
