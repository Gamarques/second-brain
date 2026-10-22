import { createHash } from "node:crypto";

import { and, eq, exists, inArray, sql } from "drizzle-orm";

import {
  DECISION_EMBEDDING_RECIPE_VERSION,
  KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  MEMORY_EMBEDDING_RECIPE_VERSION,
  embeddingEntityTypes,
  embeddingSpaceStatuses,
  memoryEmbeddingRecipe,
} from "../../domain.js";
import type {
  BrainAccessContext,
  BrainRole,
  EmbeddingEntityType,
  EmbeddingProvider,
  EmbeddingRecipeContent,
  EmbeddingSpace,
  EmbeddingSpaceStore,
  ContentEmbedding,
} from "../../domain.js";
import { decisions, knowledgeChunks, memories } from "../schema/content.js";
import { embeddingSpaces } from "../schema/embeddings.js";
import { accounts } from "../schema/identity.js";
import { mutationReceipts } from "../schema/temporal.js";
import { authorizeBrainTransaction, rolesAtLeast } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";
import {
  MutationReceiptConflictError,
  StoredDataIntegrityError,
} from "./memory-store.js";

const PROMOTE_OPERATION = "embedding_space.promote";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type EmbeddingSpaceDatabase = SecondBrainDatabase;
type EmbeddingExecutor = Pick<
  SecondBrainDatabase,
  "execute" | "insert" | "select" | "update"
>;

export interface EmbeddingProviderFingerprint {
  readonly provider: string;
  readonly model: string;
  readonly modelRevision: string;
  readonly dimensions: number;
}

export class ActiveEmbeddingSpaceMismatchError extends Error {
  readonly code = "ACTIVE_EMBEDDING_SPACE_MISMATCH";

  constructor() {
    super(
      "Active embedding spaces do not match the configured embedding provider.",
    );
    this.name = "ActiveEmbeddingSpaceMismatchError";
  }
}

export class InitialEmbeddingProvisionError extends Error {
  readonly code = "INITIAL_EMBEDDING_PROVISION_FAILED";

  constructor() {
    super("Initial embedding spaces could not be provisioned safely.");
    this.name = "InitialEmbeddingProvisionError";
  }
}

function failIntegrity(message: string): never {
  throw new StoredDataIntegrityError(message);
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new Error(`${field} must be a UUID.`);
}

function requireIdentityText(value: string, field: string): string {
  if (value.trim() === "" || value.length > 500) {
    throw new Error(`${field} must contain between 1 and 500 characters.`);
  }
  return value;
}

function validateFingerprint(input: EmbeddingProviderFingerprint): void {
  requireIdentityText(input.provider, "provider");
  requireIdentityText(input.model, "model");
  requireIdentityText(input.modelRevision, "modelRevision");
  if (!Number.isInteger(input.dimensions) || input.dimensions !== 1536) {
    throw new Error("Embedding dimensions must be exactly 1536.");
  }
}

function recipeFor(entityType: EmbeddingEntityType): string | null {
  switch (entityType) {
    case "memory":
      return MEMORY_EMBEDDING_RECIPE_VERSION;
    case "decision":
      return DECISION_EMBEDDING_RECIPE_VERSION;
    case "knowledge_chunk":
      return KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION;
    case "insight":
      return null;
  }
}

const requiredActiveSpaceRecipes = [
  ["memory", MEMORY_EMBEDDING_RECIPE_VERSION],
  ["decision", DECISION_EMBEDDING_RECIPE_VERSION],
  ["knowledge_chunk", KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION],
] as const;

function accessGate(
  database: EmbeddingExecutor,
  access: BrainAccessContext,
  requiredRole: BrainRole,
) {
  return exists(
    database
      .select({ accountId: accounts.id })
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

async function lock(database: EmbeddingExecutor, key: string): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

function decodeSpace(row: unknown): EmbeddingSpace {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    failIntegrity("An embedding space row is invalid.");
  }
  const value = row as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    !embeddingEntityTypes.includes(value.entityType as EmbeddingEntityType) ||
    typeof value.provider !== "string" ||
    value.provider === "" ||
    typeof value.model !== "string" ||
    value.model === "" ||
    typeof value.modelRevision !== "string" ||
    value.modelRevision === "" ||
    typeof value.recipeVersion !== "string" ||
    value.recipeVersion === "" ||
    typeof value.dimensions !== "number" ||
    !Number.isInteger(value.dimensions) ||
    value.dimensions < 1 ||
    value.metric !== "cosine" ||
    !embeddingSpaceStatuses.includes(
      value.status as EmbeddingSpace["status"],
    ) ||
    !(value.createdAt instanceof Date) ||
    !Number.isFinite(value.createdAt.getTime()) ||
    (value.promotedAt !== null &&
      (!(value.promotedAt instanceof Date) ||
        !Number.isFinite(value.promotedAt.getTime()))) ||
    (value.retiredAt !== null &&
      (!(value.retiredAt instanceof Date) ||
        !Number.isFinite(value.retiredAt.getTime())))
  ) {
    failIntegrity("An embedding space row is invalid.");
  }
  const status = value.status as EmbeddingSpace["status"];
  const promotedAt = value.promotedAt as Date | null;
  const retiredAt = value.retiredAt as Date | null;
  if (
    (status === "preparing" && (promotedAt !== null || retiredAt !== null)) ||
    (status === "active" && (promotedAt === null || retiredAt !== null)) ||
    (status === "retired" && (promotedAt === null || retiredAt === null))
  ) {
    failIntegrity("An embedding space state is invalid.");
  }
  return {
    id: value.id,
    entityType: value.entityType as EmbeddingEntityType,
    provider: value.provider,
    model: value.model,
    modelRevision: value.modelRevision,
    recipeVersion: value.recipeVersion,
    dimensions: value.dimensions,
    metric: "cosine",
    status,
    createdAt: (value.createdAt as Date).toISOString(),
    promotedAt: promotedAt?.toISOString() ?? null,
    retiredAt: retiredAt?.toISOString() ?? null,
  };
}

function spaceSelection() {
  return {
    id: embeddingSpaces.id,
    entityType: embeddingSpaces.entityType,
    provider: embeddingSpaces.provider,
    model: embeddingSpaces.model,
    modelRevision: embeddingSpaces.modelRevision,
    recipeVersion: embeddingSpaces.recipeVersion,
    dimensions: embeddingSpaces.dimensions,
    metric: embeddingSpaces.metric,
    status: embeddingSpaces.status,
    createdAt: embeddingSpaces.createdAt,
    promotedAt: embeddingSpaces.promotedAt,
    retiredAt: embeddingSpaces.retiredAt,
  } as const;
}

function exactFingerprint(
  space: EmbeddingSpace,
  fingerprint: EmbeddingProviderFingerprint,
): boolean {
  return (
    space.provider === fingerprint.provider &&
    space.model === fingerprint.model &&
    space.modelRevision === fingerprint.modelRevision &&
    space.dimensions === fingerprint.dimensions &&
    space.metric === "cosine" &&
    space.recipeVersion === recipeFor(space.entityType)
  );
}

async function loadSpaceById(
  database: EmbeddingExecutor,
  access: BrainAccessContext,
  id: string,
  role: BrainRole,
): Promise<EmbeddingSpace | null> {
  const rows = await database
    .select(spaceSelection())
    .from(embeddingSpaces)
    .where(
      and(
        eq(embeddingSpaces.id, id),
        accessGate(database, access, role),
      ),
    )
    .limit(2);
  if (rows.length > 1) failIntegrity("Duplicate embedding space IDs exist.");
  return rows[0] === undefined ? null : decodeSpace(rows[0]);
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

async function readPromotionReceipt(
  database: EmbeddingExecutor,
  access: BrainAccessContext,
  idempotencyKey: string,
) {
  const rows = await database
    .select({
      requestDigest: mutationReceipts.requestDigest,
      result: mutationReceipts.result,
    })
    .from(mutationReceipts)
    .where(
      and(
        eq(mutationReceipts.operation, PROMOTE_OPERATION),
        eq(mutationReceipts.idempotencyKey, idempotencyKey),
        accessGate(database, access, "editor"),
      ),
    )
    .limit(2);
  if (rows.length > 1)
    failIntegrity("Duplicate embedding promotion receipts exist.");
  return rows[0] ?? null;
}

function receiptSpaceId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failIntegrity("An embedding promotion receipt is invalid.");
  }
  const id = (value as Record<string, unknown>).spaceId;
  if (id !== null && typeof id !== "string") {
    failIntegrity("An embedding promotion receipt is invalid.");
  }
  return id;
}

async function writePromotionReceipt(
  database: SecondBrainTransaction,
  input: {
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly spaceId: string | null;
  },
): Promise<void> {
  const rows = await database
    .insert(mutationReceipts)
    .values({
      operation: PROMOTE_OPERATION,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      resultEntityType: input.spaceId === null ? null : "embedding_space",
      resultEntityId: input.spaceId,
      resultVersionId: null,
      result: { spaceId: input.spaceId },
    })
    .returning({ id: mutationReceipts.id });
  if (rows.length !== 1)
    failIntegrity("An embedding promotion receipt was not written.");
}

export class DrizzleEmbeddingSpaceStore implements EmbeddingSpaceStore {
  constructor(private readonly database: EmbeddingSpaceDatabase) {}

  async getActiveSpace(
    access: BrainAccessContext,
    entityType: EmbeddingEntityType,
    signal: AbortSignal,
  ): Promise<EmbeddingSpace | null> {
    signal.throwIfAborted();
    const rows = await this.database
      .select(spaceSelection())
      .from(embeddingSpaces)
      .where(
        and(
          eq(embeddingSpaces.entityType, entityType),
          eq(embeddingSpaces.status, "active"),
          accessGate(this.database, access, "viewer"),
        ),
      )
      .limit(2);
    signal.throwIfAborted();
    if (rows.length > 1)
      failIntegrity("More than one active embedding space exists.");
    return rows[0] === undefined ? null : decodeSpace(rows[0]);
  }

  async createSpace(
    access: BrainAccessContext,
    input: Omit<
      EmbeddingSpace,
      "id" | "status" | "createdAt" | "promotedAt" | "retiredAt"
    >,
    signal: AbortSignal,
  ): Promise<EmbeddingSpace> {
    const fingerprint: EmbeddingProviderFingerprint = input;
    validateFingerprint(fingerprint);
    requireIdentityText(input.recipeVersion, "recipeVersion");
    if (input.metric !== "cosine")
      throw new Error("Only cosine embedding spaces are supported.");
    const expectedRecipe = recipeFor(input.entityType);
    if (expectedRecipe !== null && input.recipeVersion !== expectedRecipe) {
      throw new Error(
        "The embedding space recipe is incompatible with its entity type.",
      );
    }
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "editor", signal);
      await lock(
        transaction,
        `embedding-identity:${input.entityType}:${input.provider}:${input.model}:${input.modelRevision}:${input.recipeVersion}`,
      );
      const existing = await transaction
        .select(spaceSelection())
        .from(embeddingSpaces)
        .where(
          and(
            eq(embeddingSpaces.entityType, input.entityType),
            eq(embeddingSpaces.provider, input.provider),
            eq(embeddingSpaces.model, input.model),
            eq(embeddingSpaces.modelRevision, input.modelRevision),
            eq(embeddingSpaces.recipeVersion, input.recipeVersion),
            accessGate(transaction, access, "editor"),
          ),
        )
        .limit(2);
      if (existing.length > 1)
        failIntegrity("Duplicate embedding identities exist.");
      if (existing[0] !== undefined) {
        const decoded = decodeSpace(existing[0]);
        if (
          decoded.dimensions !== input.dimensions ||
          decoded.metric !== input.metric
        ) {
          throw new Error(
            "The embedding identity already exists with different settings.",
          );
        }
        return decoded;
      }
      const inserted = await transaction
        .insert(embeddingSpaces)
        .values({
          entityType: input.entityType,
          provider: input.provider,
          model: input.model,
          modelRevision: input.modelRevision,
          recipeVersion: input.recipeVersion,
          dimensions: input.dimensions,
          metric: input.metric,
          status: "preparing",
        })
        .returning(spaceSelection());
      if (inserted.length !== 1)
        failIntegrity("An embedding space was not written.");
      signal.throwIfAborted();
      return decodeSpace(inserted[0]);
    });
  }

  async promoteSpace(
    access: BrainAccessContext,
    id: string,
    input: {
      readonly expectedStatus: "preparing";
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<EmbeddingSpace | null> {
    requireUuid(id, "id");
    if (
      input.idempotencyKey.trim() === "" ||
      input.idempotencyKey.length > 500
    ) {
      throw new Error(
        "The idempotency key must contain between 1 and 500 characters.",
      );
    }
    const requestDigest = digest({ id, expectedStatus: input.expectedStatus });
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "editor", signal);
      await lock(
        transaction,
        `${PROMOTE_OPERATION}:${input.idempotencyKey}`,
      );
      const receipt = await readPromotionReceipt(
        transaction,
        access,
        input.idempotencyKey,
      );
      if (receipt !== null) {
        if (receipt.requestDigest !== requestDigest)
          throw new MutationReceiptConflictError();
        const spaceId = receiptSpaceId(receipt.result);
        return spaceId === null
          ? null
          : loadSpaceById(transaction, access, spaceId, "editor");
      }
      const initial = await loadSpaceById(transaction, access, id, "editor");
      if (initial === null) {
        await writePromotionReceipt(transaction, {
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          spaceId: null,
        });
        return null;
      }
      await lock(
        transaction,
        `embedding-promotion:${initial.entityType}`,
      );
      const target = await loadSpaceById(transaction, access, id, "editor");
      if (target === null || target.status !== input.expectedStatus) {
        await writePromotionReceipt(transaction, {
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          spaceId: null,
        });
        return null;
      }
      const expectedRecipe = recipeFor(target.entityType);
      if (expectedRecipe !== null && target.recipeVersion !== expectedRecipe) {
        throw new Error(
          "The embedding space recipe is incompatible with its entity type.",
        );
      }
      const now = new Date();
      await transaction
        .update(embeddingSpaces)
        .set({ status: "retired", retiredAt: now })
        .where(
          and(
            eq(embeddingSpaces.entityType, target.entityType),
            eq(embeddingSpaces.status, "active"),
            accessGate(transaction, access, "editor"),
          ),
        );
      const promoted = await transaction
        .update(embeddingSpaces)
        .set({
          status: "active",
          promotedAt: now,
          retiredAt: null,
          failureCode: null,
        })
        .where(
          and(
            eq(embeddingSpaces.id, id),
            eq(embeddingSpaces.status, "preparing"),
            accessGate(transaction, access, "editor"),
          ),
        )
        .returning(spaceSelection());
      if (promoted.length !== 1)
        failIntegrity("A locked embedding space changed during promotion.");
      await writePromotionReceipt(transaction, {
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        spaceId: id,
      });
      signal.throwIfAborted();
      return decodeSpace(promoted[0]);
    });
  }
}

/** Internal startup check. It never creates, promotes, or retires a space. */
export async function assertActiveEmbeddingSpacesMatchProvider(
  database: EmbeddingSpaceDatabase,
  fingerprint: EmbeddingProviderFingerprint,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  validateFingerprint(fingerprint);
  const rows = await database
    .select(spaceSelection())
    .from(embeddingSpaces)
    .where(eq(embeddingSpaces.status, "active"));
  signal.throwIfAborted();
  const spaces = rows.map(decodeSpace);
  const exactRequiredSet =
    spaces.length === requiredActiveSpaceRecipes.length &&
    requiredActiveSpaceRecipes.every(([entityType]) => {
      const matches = spaces.filter(
        (space) => space.entityType === entityType,
      );
      return matches.length === 1 && exactFingerprint(matches[0]!, fingerprint);
    });
  if (!exactRequiredSet) {
    throw new ActiveEmbeddingSpaceMismatchError();
  }
}

/** Internal resolver used by scheduled jobs after their own fenced-run validation. */
export async function resolveActiveEmbeddingSpaceForSystem(
  database: EmbeddingSpaceDatabase,
  entityType: EmbeddingEntityType,
  signal: AbortSignal,
): Promise<EmbeddingSpace | null> {
  signal.throwIfAborted();
  const rows = await database
    .select(spaceSelection())
    .from(embeddingSpaces)
    .where(
      and(
        eq(embeddingSpaces.entityType, entityType),
        eq(embeddingSpaces.status, "active"),
      ),
    )
    .limit(2);
  signal.throwIfAborted();
  if (rows.length > 1)
    failIntegrity("More than one active embedding space exists.");
  return rows[0] === undefined ? null : decodeSpace(rows[0]);
}

/** Internal scheduled-job embedder; callers must still hold a fenced dreaming run. */
export function createDreamingMemoryEmbedder(
  database: EmbeddingSpaceDatabase,
  provider: EmbeddingProvider,
): {
  embed(
    recipe: EmbeddingRecipeContent<typeof MEMORY_EMBEDDING_RECIPE_VERSION>,
    signal: AbortSignal,
  ): Promise<ContentEmbedding>;
} {
  const fingerprint = embeddingProviderFingerprint(provider);
  return {
    async embed(recipe, signal) {
      const canonicalRecipe = memoryEmbeddingRecipe(recipe.text);
      if (
        recipe.recipeVersion !== MEMORY_EMBEDDING_RECIPE_VERSION ||
        recipe.text !== canonicalRecipe.text ||
        recipe.contentHash !== canonicalRecipe.contentHash
      ) {
        throw new ActiveEmbeddingSpaceMismatchError();
      }
      const space = await resolveActiveEmbeddingSpaceForSystem(
        database,
        "memory",
        signal,
      );
      if (
        space === null ||
        !exactFingerprint(space, fingerprint) ||
        space.recipeVersion !== recipe.recipeVersion
      ) {
        throw new ActiveEmbeddingSpaceMismatchError();
      }
      const vectors = await provider.embed(
        [recipe.text],
        signal,
        "search_document",
      );
      const vector = vectors[0];
      const norm = vector === undefined ? 0 : Math.hypot(...vector);
      if (
        vector === undefined ||
        vector.length !== space.dimensions ||
        vector.some((value) => !Number.isFinite(value)) ||
        !Number.isFinite(norm) ||
        norm === 0
      ) {
        throw new Error("The embedding provider returned an invalid vector.");
      }
      return { spaceId: space.id, contentHash: recipe.contentHash, vector };
    },
  };
}

/** Called inside account bootstrap's transaction; never starts a nested transaction. */
export async function provisionInitialEmbeddingSpacesInTransaction(
  transaction: SecondBrainTransaction,
  fingerprint: EmbeddingProviderFingerprint,
  signal: AbortSignal,
): Promise<readonly EmbeddingSpace[]> {
  validateFingerprint(fingerprint);
  signal.throwIfAborted();
  await transaction.execute(
    sql`select
      set_config('statement_timeout', '10000', true),
      set_config('lock_timeout', '3000', true)`,
  );
  await lock(transaction, "initial-embedding-provision");

  const existingRows = await transaction
    .select(spaceSelection())
    .from(embeddingSpaces);
  const existing = existingRows.map(decodeSpace);
  if (existing.length > 0) {
    const active = existing.filter((space) => space.status === "active");
    const exact = requiredActiveSpaceRecipes.every(
      ([entityType, recipeVersion]) => {
        const matches = active.filter(
          (space) => space.entityType === entityType,
        );
        return (
          matches.length === 1 &&
          matches[0]!.recipeVersion === recipeVersion &&
          exactFingerprint(matches[0]!, fingerprint)
        );
      },
    );
    if (exact && existing.length === requiredActiveSpaceRecipes.length) {
      return requiredActiveSpaceRecipes.map(([entityType]) =>
        active.find((space) => space.entityType === entityType)!,
      );
    }
    throw new InitialEmbeddingProvisionError();
  }

  const memoryRows = await transaction
    .select({ id: memories.id })
    .from(memories)
    .limit(1);
  const decisionRows = await transaction
    .select({ id: decisions.id })
    .from(decisions)
    .limit(1);
  const chunkRows = await transaction
    .select({ id: knowledgeChunks.id })
    .from(knowledgeChunks)
    .limit(1);
  if (
    memoryRows.length !== 0 ||
    decisionRows.length !== 0 ||
    chunkRows.length !== 0
  ) {
    throw new InitialEmbeddingProvisionError();
  }
  const inserted: EmbeddingSpace[] = [];
  for (const [entityType, recipeVersion] of requiredActiveSpaceRecipes) {
    const preparingRows = await transaction
      .insert(embeddingSpaces)
      .values({
        entityType,
        provider: fingerprint.provider,
        model: fingerprint.model,
        modelRevision: fingerprint.modelRevision,
        recipeVersion,
        dimensions: fingerprint.dimensions,
        metric: "cosine",
        status: "preparing",
      })
      .returning(spaceSelection());
    if (preparingRows.length !== 1) throw new InitialEmbeddingProvisionError();
    const preparing = decodeSpace(preparingRows[0]);
    if (preparing.status !== "preparing")
      throw new InitialEmbeddingProvisionError();
    const promotedRows = await transaction
      .update(embeddingSpaces)
      .set({ status: "active", promotedAt: new Date() })
      .where(
        and(
          eq(embeddingSpaces.id, preparing.id),
          eq(embeddingSpaces.status, "preparing"),
        ),
      )
      .returning(spaceSelection());
    if (promotedRows.length !== 1) throw new InitialEmbeddingProvisionError();
    inserted.push(decodeSpace(promotedRows[0]));
  }
  signal.throwIfAborted();
  return inserted;
}

export function embeddingProviderFingerprint(
  provider: Pick<
    EmbeddingProvider,
    "provider" | "model" | "modelRevision" | "dimensions"
  >,
): EmbeddingProviderFingerprint {
  const fingerprint = {
    provider: provider.provider,
    model: provider.model,
    modelRevision: provider.modelRevision,
    dimensions: provider.dimensions,
  } as const;
  validateFingerprint(fingerprint);
  return fingerprint;
}
