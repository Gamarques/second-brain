import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";

import type {
  ActorAttribution,
  BrainAccessContext,
  BrainPackOriginAttribution,
  ContentEmbedding,
  KnowledgeBase,
  KnowledgeChunkMatch,
  KnowledgeDocument,
  KnowledgeDocumentRevision,
  KnowledgeRevisionContent,
  KnowledgeStore,
} from "../../domain.js";
import {
  KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  canonicalJson,
  knowledgeChunkEmbeddingRecipe,
  sha256Hex,
} from "../../domain.js";
import {
  knowledgeBases,
  knowledgeChunks,
  knowledgeDocumentPeople,
  knowledgeDocumentRevisions,
  knowledgeDocuments,
  people,
  projects,
} from "../schema/content.js";
import {
  embeddingSpaces,
  knowledgeChunkEmbeddings,
} from "../schema/embeddings.js";
import { knowledgeRevisionContents, knowledgeRevisionOrigins } from "../schema/brain-pack.js";
import { authorizeBrainTransaction } from "./authorization.js";
import { appendAdministrativeDomainAuditEvent } from "./audit-writer.js";
import type { SecondBrainDatabase, SecondBrainTransaction } from "./database.js";
import {
  lockIdempotencyKey,
  readReceipt,
  requestDigest,
  requireHash,
  requireIdempotencyKey,
  requireUuid,
  stableUuid,
  toIso,
  writeReceipt,
} from "./mutation-support.js";

const MAX_CHUNKS_PER_REVISION = 1_000;
const MAX_CHUNK_OVERLAP = 200;
const MAX_DOCUMENT_CONTENT_LENGTH = 1_000_000;
const MAX_SEARCH_LIMIT = 100;
const CREATE_BASE_OPERATION = "knowledge_bases.create";
const CREATE_REVISION_OPERATION = "knowledge_document_revisions.create";

export class KnowledgeStoreConflictError extends Error {
  readonly code = "KNOWLEDGE_STORE_CONFLICT";

  constructor(message = "The idempotency key was already used with different input.") {
    super(message);
    this.name = "KnowledgeStoreConflictError";
  }
}

function requireSearchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new Error(`Knowledge search limit must be between 1 and ${MAX_SEARCH_LIMIT}.`);
  }
}

function requireBrowseLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Knowledge browsing limit must be between 1 and 100.");
  }
}

function requireCursor(
  cursor: { readonly ts: string; readonly id: string } | null,
): Date | null {
  if (cursor === null) return null;
  const timestamp = new Date(cursor.ts);
  if (!Number.isFinite(timestamp.valueOf())) {
    throw new Error("The knowledge browsing cursor timestamp is invalid.");
  }
  requireUuid(cursor.id, "Knowledge browsing cursor ID");
  return timestamp;
}

function decodeOrigin(value: unknown): BrainPackOriginAttribution | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.packId !== "string" || typeof candidate.publisher !== "object") return null;
  return candidate as unknown as BrainPackOriginAttribution;
}

/**
 * The text of each revision: the exact stored text when the revision kept it,
 * otherwise the chunks stitched back together, with its pack origin if any.
 */
async function revisionTexts(
  transaction: SecondBrainTransaction,
  revisions: readonly { readonly id: string; readonly chunkCount: number }[],
): Promise<Map<string, Pick<KnowledgeRevisionContent, "content" | "representation" | "origin">>> {
  const texts = new Map<string, Pick<KnowledgeRevisionContent, "content" | "representation" | "origin">>();
  if (revisions.length === 0) return texts;
  const revisionIds = revisions.map((revision) => revision.id);
  const stored = await transaction
    .select({
      revisionId: knowledgeRevisionContents.revisionId,
      content: knowledgeRevisionContents.content,
      representation: knowledgeRevisionContents.representation,
    })
    .from(knowledgeRevisionContents)
    .where(inArray(knowledgeRevisionContents.revisionId, revisionIds));
  const origins = await transaction
    .select({ revisionId: knowledgeRevisionOrigins.revisionId, attribution: knowledgeRevisionOrigins.attribution })
    .from(knowledgeRevisionOrigins)
    .where(inArray(knowledgeRevisionOrigins.revisionId, revisionIds));
  const originsByRevision = new Map(origins.map((row) => [row.revisionId, decodeOrigin(row.attribution)] as const));
  const canonical = new Map(
    stored.filter((row) => row.representation === "canonical").map((row) => [row.revisionId, row.content] as const),
  );
  const missing = revisions.filter((revision) => !canonical.has(revision.id));
  const chunkRows =
    missing.length === 0
      ? []
      : await transaction
          .select({
            revisionId: knowledgeChunks.revisionId,
            position: knowledgeChunks.position,
            content: knowledgeChunks.content,
          })
          .from(knowledgeChunks)
          .where(inArray(knowledgeChunks.revisionId, missing.map((revision) => revision.id)))
          .orderBy(asc(knowledgeChunks.revisionId), asc(knowledgeChunks.position));
  const chunksByRevision = new Map<string, { readonly position: number; readonly content: string }[]>();
  for (const chunk of chunkRows) {
    const group = chunksByRevision.get(chunk.revisionId) ?? [];
    group.push(chunk);
    chunksByRevision.set(chunk.revisionId, group);
  }
  for (const revision of revisions) {
    const exact = canonical.get(revision.id);
    texts.set(revision.id, {
      content: exact ?? reconstructKnowledgeContent(chunksByRevision.get(revision.id) ?? [], revision.chunkCount),
      representation: exact === undefined ? "reconstructed" : "canonical",
      origin: originsByRevision.get(revision.id) ?? null,
    });
  }
  return texts;
}

export function reconstructKnowledgeContent(
  chunks: readonly { readonly position: number; readonly content: string }[],
  expectedChunkCount: number,
): string {
  if (
    !Number.isInteger(expectedChunkCount) ||
    expectedChunkCount < 1 ||
    chunks.length !== expectedChunkCount
  ) {
    throw new Error("The knowledge revision has incomplete chunks.");
  }
  let content = "";
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.position !== index || chunk.content.length === 0) {
      throw new Error("The knowledge revision has invalid chunk ordering.");
    }
    if (index === 0) {
      content = chunk.content;
      continue;
    }
    const maximumOverlap = Math.min(
      MAX_CHUNK_OVERLAP,
      content.length,
      chunk.content.length,
    );
    let overlap = maximumOverlap;
    while (
      overlap > 0 &&
      content.slice(content.length - overlap) !== chunk.content.slice(0, overlap)
    ) {
      overlap -= 1;
    }
    content += chunk.content.slice(overlap);
    if (content.length > MAX_DOCUMENT_CONTENT_LENGTH) {
      throw new Error("The reconstructed knowledge document is too large.");
    }
  }
  if (content.length < 1 || content.length > MAX_DOCUMENT_CONTENT_LENGTH) {
    throw new Error("The reconstructed knowledge document has an invalid length.");
  }
  return content;
}

function actorColumns(access: BrainAccessContext) {
  return {
    actorKind: access.actor.kind,
    actorAccountId: access.actor.accountId,
    actorClientId: access.actor.kind === "oauth_client" ? access.actor.clientId : null,
    actorSource: access.actor.source,
  } as const;
}

function mapActor(row: {
  readonly actorKind: "account" | "oauth_client" | "import" | "dreaming" | "system";
  readonly actorAccountId: string | null;
  readonly actorClientId: string | null;
  readonly actorSource: ActorAttribution["source"];
}): ActorAttribution {
  const common = { source: row.actorSource } as const;
  if (row.actorKind === "account") {
    if (row.actorClientId !== null) {
      throw new Error("Database returned invalid account attribution.");
    }
    return { ...common, kind: "account", accountId: row.actorAccountId, clientId: null };
  }
  if (row.actorKind === "oauth_client") {
    if (
      (row.actorAccountId === null) !== (row.actorClientId === null)
    ) {
      throw new Error("Database returned invalid OAuth client attribution.");
    }
    if (row.actorAccountId === null || row.actorClientId === null) {
      return {
        ...common,
        kind: "oauth_client",
        accountId: null,
        clientId: null,
      };
    }
    return {
      ...common,
      kind: "oauth_client",
      accountId: row.actorAccountId,
      clientId: row.actorClientId,
    };
  }
  if (row.actorClientId !== null) {
    throw new Error("Database returned invalid internal attribution.");
  }
  if (row.actorKind === "import") {
    return {
      ...common,
      kind: "import",
      accountId: row.actorAccountId,
      clientId: null,
    };
  }
  if (row.actorAccountId !== null) {
    throw new Error("Database returned invalid internal account attribution.");
  }
  return {
    ...common,
    kind: row.actorKind,
    accountId: row.actorAccountId,
    clientId: null,
  };
}

function mapKnowledgeBase(row: typeof knowledgeBases.$inferSelect): KnowledgeBase {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provenance: mapActor(row),
    createdAt: toIso(row.createdAt, "knowledge base creation timestamp"),
    updatedAt: toIso(row.updatedAt, "knowledge base update timestamp"),
  };
}

function mapDocument(
  row: typeof knowledgeDocuments.$inferSelect,
  personIds: readonly string[] = [],
): KnowledgeDocument {
  if (!Number.isInteger(row.currentRevisionNumber) || row.currentRevisionNumber < 1) {
    throw new Error("Database returned an invalid current document revision.");
  }
  return {
    id: row.id,
    knowledgeBaseId: row.knowledgeBaseId,
    currentRevision: row.currentRevisionNumber,
    title: row.title,
    sourceUri: row.sourceUri,
    tags: [...row.tags],
    projectId: row.projectId,
    personIds: [...personIds],
    provenance: mapActor(row),
    createdAt: toIso(row.createdAt, "knowledge document creation timestamp"),
    updatedAt: toIso(row.updatedAt, "knowledge document update timestamp"),
  };
}

function mapRevision(
  row: typeof knowledgeDocumentRevisions.$inferSelect,
): KnowledgeDocumentRevision {
  if (!Number.isInteger(row.revisionNumber) || row.revisionNumber < 1) {
    throw new Error("Database returned an invalid document revision number.");
  }
  if (!Number.isInteger(row.chunkCount) || row.chunkCount < 0) {
    throw new Error("Database returned an invalid document chunk count.");
  }
  requireHash(row.contentHash, "Document content hash");
  return {
    id: row.id,
    documentId: row.documentId,
    version: row.revisionNumber,
    contentHash: row.contentHash,
    chunkCount: row.chunkCount,
    provenance: mapActor(row),
    createdAt: toIso(row.createdAt, "document revision creation timestamp"),
  };
}

function validateChunks(chunks: readonly {
  readonly content: string;
  readonly position: number;
  readonly embedding: ContentEmbedding;
}[]): string {
  if (chunks.length < 1 || chunks.length > MAX_CHUNKS_PER_REVISION) {
    throw new Error(`A document revision must contain between 1 and ${MAX_CHUNKS_PER_REVISION} chunks.`);
  }
  let spaceId: string | null = null;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.position !== index) {
      throw new Error("Document chunk positions must be contiguous and zero-based.");
    }
    if (chunk.content.length < 1 || chunk.content.length > 10_000) {
      throw new Error("Document chunks must contain between 1 and 10000 characters.");
    }
    requireHash(chunk.embedding.contentHash, "Chunk embedding content hash");
    if (
      chunk.embedding.contentHash !==
      knowledgeChunkEmbeddingRecipe(chunk.content).contentHash
    ) {
      throw new Error("A chunk embedding content hash does not match its chunk.");
    }
    if (spaceId === null) spaceId = chunk.embedding.spaceId;
    if (chunk.embedding.spaceId !== spaceId) {
      throw new Error("All chunks in a revision must use the same embedding space.");
    }
  }
  return spaceId!;
}

async function personIdsForDocument(
  transaction: SecondBrainTransaction,
  documentId: string,
): Promise<readonly string[]> {
  const rows = await transaction
    .select({ personId: knowledgeDocumentPeople.personId })
    .from(knowledgeDocumentPeople)
    .where(eq(knowledgeDocumentPeople.documentId, documentId));
  return rows.map((row) => row.personId);
}

async function replaceDocumentPeople(
  transaction: SecondBrainTransaction,
  documentId: string,
  personIds: readonly string[],
): Promise<void> {
  await transaction
    .delete(knowledgeDocumentPeople)
    .where(eq(knowledgeDocumentPeople.documentId, documentId));
  if (personIds.length === 0) return;
  await transaction.insert(knowledgeDocumentPeople).values(
    personIds.map((personId) => ({ documentId, personId })),
  );
}

async function requireDocumentRelations(
  transaction: SecondBrainTransaction,
  projectId: string | null,
  personIds: readonly string[],
): Promise<void> {
  if (new Set(personIds).size !== personIds.length) {
    throw new Error("personIds must not contain duplicates.");
  }
  if (projectId !== null) {
    const rows = await transaction
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (rows.length !== 1) throw new Error("A linked project was not found.");
  }
  if (personIds.length > 0) {
    const rows = await transaction
      .select({ id: people.id })
      .from(people)
      .where(inArray(people.id, [...personIds]));
    if (rows.length !== personIds.length) {
      throw new Error("A linked person was not found.");
    }
  }
}

export class DrizzleKnowledgeStore implements KnowledgeStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async createKnowledgeBase(
    access: BrainAccessContext,
    input: {
      readonly name: string;
      readonly description: string | null;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<KnowledgeBase> {
    signal.throwIfAborted();
    requireIdempotencyKey(input.idempotencyKey);
    const digest = requestDigest({
      name: input.name,
      description: input.description,
    });
    const id = stableUuid("knowledge-base", input.idempotencyKey);
    const result = await this.database.transaction(
      async (transaction) => {
        await authorizeBrainTransaction(transaction, access, "editor", signal);
        await lockIdempotencyKey(
          transaction,
          CREATE_BASE_OPERATION,
          input.idempotencyKey,
        );
        const receipt = await readReceipt(
          transaction,
          CREATE_BASE_OPERATION,
          input.idempotencyKey,
        );
        if (receipt !== null) {
          if (
            receipt.requestDigest !== digest ||
            receipt.resultEntityType !== "knowledge_base" ||
            receipt.resultEntityId === null ||
            receipt.resultVersionId !== null
          ) {
            throw new KnowledgeStoreConflictError();
          }
          const existing = await transaction
            .select()
            .from(knowledgeBases)
            .where(eq(knowledgeBases.id, receipt.resultEntityId))
            .limit(1);
          if (existing[0] === undefined) {
            throw new Error("A knowledge base receipt points to a missing record.");
          }
          return mapKnowledgeBase(existing[0]);
        }
        signal.throwIfAborted();
        const inserted = await transaction
          .insert(knowledgeBases)
          .values({
            id,
            name: input.name,
            description: input.description,
            ...actorColumns(access),
          })
          .onConflictDoNothing({ target: knowledgeBases.id })
          .returning();
        const row = inserted[0] ?? (
          await transaction
            .select()
            .from(knowledgeBases)
            .where(eq(knowledgeBases.id, id))
            .limit(1)
        )[0];
        if (row === undefined) throw new Error("Knowledge base creation failed.");
        if (row.name !== input.name || row.description !== input.description) {
          throw new KnowledgeStoreConflictError();
        }
        await writeReceipt(transaction, {
          operation: CREATE_BASE_OPERATION,
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
          resultEntityType: "knowledge_base",
          resultEntityId: row.id,
          resultVersionId: null,
        });
        if (access.administrativeChannel === true) {
          await appendAdministrativeDomainAuditEvent(
            transaction,
            access,
            {
              category: "domain",
              action: "knowledge_base.created",
              outcome: "succeeded",
              targetType: "knowledge_base",
              targetId: row.id,
              errorCode: null,
              metadata: {},
            },
            signal,
          );
        }
        return mapKnowledgeBase(row);
      },
      { isolationLevel: "read committed" },
    );
    signal.throwIfAborted();
    return result;
  }

  async listKnowledgeBases(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<readonly KnowledgeBase[]> {
    signal.throwIfAborted();
    const rows = await this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "viewer", signal);
      return transaction
        .select()
        .from(knowledgeBases)
        .orderBy(asc(knowledgeBases.createdAt), asc(knowledgeBases.id));
    });
    signal.throwIfAborted();
    return rows.map(mapKnowledgeBase);
  }

  async createDocumentRevision(
    access: BrainAccessContext,
    input: {
      readonly knowledgeBaseId: string;
      readonly documentId: string | null;
      readonly expectedRevision: number | null;
      readonly title: string;
      readonly sourceUri: string | null;
      readonly contentHash: string;
      readonly chunks: readonly {
        readonly content: string;
        readonly position: number;
        readonly embedding: ContentEmbedding;
      }[];
      readonly tags: readonly string[];
      readonly projectId: string | null;
      readonly personIds: readonly string[];
      readonly idempotencyKey: string;
      readonly content?: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly document: KnowledgeDocument;
    readonly revision: KnowledgeDocumentRevision;
  } | null> {
    signal.throwIfAborted();
    requireIdempotencyKey(input.idempotencyKey);
    requireHash(input.contentHash, "Document content hash");
    if (input.content !== undefined) {
      if (input.content.length < 1 || input.content.length > MAX_DOCUMENT_CONTENT_LENGTH) {
        throw new Error(`Document content must contain between 1 and ${MAX_DOCUMENT_CONTENT_LENGTH} characters.`);
      }
      if (sha256Hex(input.content) !== input.contentHash) {
        throw new Error("The document content hash does not match the content.");
      }
    }
    if ((input.documentId === null) !== (input.expectedRevision === null)) {
      throw new Error("documentId and expectedRevision must either both be null or both be provided.");
    }
    if (input.expectedRevision !== null && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)) {
      throw new Error("Expected revision must be a positive integer.");
    }
    const spaceId = validateChunks(input.chunks);
    const documentId = input.documentId ??
      stableUuid("knowledge-document", input.idempotencyKey);
    const revisionNumber = (input.expectedRevision ?? 0) + 1;
    const revisionId = stableUuid(
      documentId,
      "knowledge-document-revision",
      input.idempotencyKey,
    );
    const digest = requestDigest({
      knowledgeBaseId: input.knowledgeBaseId,
      documentId: input.documentId,
      expectedRevision: input.expectedRevision,
      title: input.title,
      sourceUri: input.sourceUri,
      contentHash: input.contentHash,
      tags: [...input.tags],
      projectId: input.projectId,
      personIds: [...input.personIds],
      chunks: input.chunks.map((chunk) => ({
        content: chunk.content,
        position: chunk.position,
        embedding: {
          spaceId: chunk.embedding.spaceId,
          contentHash: chunk.embedding.contentHash,
        },
      })),
    });

    const result = await this.database.transaction(
      async (transaction) => {
        await authorizeBrainTransaction(transaction, access, "editor", signal);
        await lockIdempotencyKey(
          transaction,
          CREATE_REVISION_OPERATION,
          input.idempotencyKey,
        );
        const receipt = await readReceipt(
          transaction,
          CREATE_REVISION_OPERATION,
          input.idempotencyKey,
        );
        if (receipt !== null) {
          if (
            receipt.requestDigest !== digest ||
            receipt.resultEntityType !== "knowledge_document" ||
            receipt.resultEntityId === null ||
            receipt.resultVersionId === null
          ) {
            throw new KnowledgeStoreConflictError();
          }
          const rows = await transaction
            .select({ revision: knowledgeDocumentRevisions, document: knowledgeDocuments })
            .from(knowledgeDocumentRevisions)
            .innerJoin(
              knowledgeDocuments,
              eq(knowledgeDocuments.id, knowledgeDocumentRevisions.documentId),
            )
            .where(
              and(
                eq(knowledgeDocumentRevisions.id, receipt.resultVersionId),
                eq(knowledgeDocuments.id, receipt.resultEntityId),
              ),
            )
            .limit(1);
          const row = rows[0];
          if (row === undefined) {
            throw new Error("A knowledge revision receipt points to a missing record.");
          }
          return {
            document: mapDocument(
              row.document,
              await personIdsForDocument(transaction, row.document.id),
            ),
            revision: mapRevision(row.revision),
          };
        }
        signal.throwIfAborted();

        const base = await transaction
          .select({ id: knowledgeBases.id })
          .from(knowledgeBases)
          .where(eq(knowledgeBases.id, input.knowledgeBaseId))
          .limit(1);
        if (base.length !== 1) return null;
        await requireDocumentRelations(transaction, input.projectId, input.personIds);

        const spaces = await transaction
          .select({
            id: embeddingSpaces.id,
            dimensions: embeddingSpaces.dimensions,
            provider: embeddingSpaces.provider,
            model: embeddingSpaces.model,
            modelRevision: embeddingSpaces.modelRevision,
            recipeVersion: embeddingSpaces.recipeVersion,
          })
          .from(embeddingSpaces)
          .where(
            and(
              eq(embeddingSpaces.id, spaceId),
              eq(embeddingSpaces.entityType, "knowledge_chunk"),
              eq(embeddingSpaces.status, "active"),
              eq(
                embeddingSpaces.recipeVersion,
                KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
              ),
            ),
          )
          .limit(1);
        const space = spaces[0];
        if (space === undefined) {
          throw new Error("No active knowledge chunk embedding space was found.");
        }
        if (
          space.provider.trim() === "" ||
          space.model.trim() === "" ||
          space.modelRevision.trim() === ""
        ) {
          throw new Error("The knowledge chunk embedding space has an invalid provider identity.");
        }
        for (const chunk of input.chunks) {
          if (
            chunk.embedding.vector.length !== space.dimensions ||
            chunk.embedding.vector.some((value) => !Number.isFinite(value))
          ) {
            throw new Error("A chunk embedding has invalid dimensions or values.");
          }
        }

        const previousAttempt = await transaction
          .select({ revision: knowledgeDocumentRevisions, document: knowledgeDocuments })
          .from(knowledgeDocumentRevisions)
          .innerJoin(
            knowledgeDocuments,
            eq(knowledgeDocuments.id, knowledgeDocumentRevisions.documentId),
          )
          .where(
            and(
              eq(knowledgeDocumentRevisions.id, revisionId),
              eq(knowledgeDocumentRevisions.documentId, documentId),
            ),
          )
          .limit(1);
        const previous = previousAttempt[0];
        if (previous !== undefined) {
          throw new Error("A knowledge revision exists without its mutation receipt.");
        }

        let documentRow: typeof knowledgeDocuments.$inferSelect;
        if (input.documentId === null) {
          const inserted = await transaction
            .insert(knowledgeDocuments)
            .values({
              id: documentId,
              knowledgeBaseId: input.knowledgeBaseId,
              title: input.title,
              sourceUri: input.sourceUri,
              tags: [...input.tags],
              projectId: input.projectId,
              currentRevisionNumber: 1,
              ...actorColumns(access),
            })
            .onConflictDoNothing({ target: knowledgeDocuments.id })
            .returning();
          const row = inserted[0];
          if (row === undefined) throw new KnowledgeStoreConflictError();
          documentRow = row;
        } else {
          const documents = await transaction
            .select()
            .from(knowledgeDocuments)
            .where(
              and(
                eq(knowledgeDocuments.id, documentId),
                eq(knowledgeDocuments.knowledgeBaseId, input.knowledgeBaseId),
              ),
            )
            .for("update", { of: knowledgeDocuments })
            .limit(1);
          const current = documents[0];
          if (current === undefined || current.currentRevisionNumber !== input.expectedRevision) {
            return null;
          }
          documentRow = current;
        }

        const lockedSpaces = await transaction
          .select({
            id: embeddingSpaces.id,
            dimensions: embeddingSpaces.dimensions,
            provider: embeddingSpaces.provider,
            model: embeddingSpaces.model,
            modelRevision: embeddingSpaces.modelRevision,
            recipeVersion: embeddingSpaces.recipeVersion,
          })
          .from(embeddingSpaces)
          .where(
            and(
              eq(embeddingSpaces.id, spaceId),
              eq(embeddingSpaces.entityType, "knowledge_chunk"),
              eq(embeddingSpaces.status, "active"),
              eq(
                embeddingSpaces.recipeVersion,
                KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
              ),
            ),
          )
          .limit(1)
          .for("share", { of: embeddingSpaces });
        const lockedSpace = lockedSpaces[0];
        if (
          lockedSpace === undefined ||
          lockedSpace.id !== space.id ||
          lockedSpace.dimensions !== space.dimensions ||
          lockedSpace.provider !== space.provider ||
          lockedSpace.model !== space.model ||
          lockedSpace.modelRevision !== space.modelRevision ||
          lockedSpace.recipeVersion !== space.recipeVersion
        ) {
          throw new Error(
            "The knowledge chunk embedding space changed before the revision could be stored.",
          );
        }
        signal.throwIfAborted();

        const revisions = await transaction
          .insert(knowledgeDocumentRevisions)
          .values({
            id: revisionId,
            documentId,
            revisionNumber,
            contentHash: input.contentHash,
            chunkCount: input.chunks.length,
            ...actorColumns(access),
          })
          .returning();
        const revision = revisions[0];
        if (revision === undefined) throw new Error("Document revision creation failed.");
        if (input.content !== undefined) {
          await transaction.insert(knowledgeRevisionContents).values({
            revisionId,
            content: input.content,
            representation: "canonical",
            contentSha256: input.contentHash,
            byteSize: Buffer.byteLength(input.content, "utf8"),
          });
        }

        const chunkRows = input.chunks.map((chunk) => {
          const id = stableUuid(revisionId, "knowledge-chunk", String(chunk.position));
          return {
            id,
            revisionId,
            position: chunk.position,
            content: chunk.content,
            contentHash: chunk.embedding.contentHash,
          } as const;
        });
        await transaction.insert(knowledgeChunks).values(chunkRows);
        await transaction.insert(knowledgeChunkEmbeddings).values(
          chunkRows.map((chunkRow, index) => ({
            id: stableUuid(chunkRow.id, "knowledge-chunk-embedding", spaceId),
            chunkId: chunkRow.id,
            spaceId,
            contentHash: chunkRow.contentHash,
            recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
            embedding: [...input.chunks[index]!.embedding.vector],
          })),
        );

        if (input.documentId !== null) {
          const updated = await transaction
            .update(knowledgeDocuments)
            .set({
              title: input.title,
              sourceUri: input.sourceUri,
              tags: [...input.tags],
              projectId: input.projectId,
              currentRevisionNumber: revisionNumber,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(knowledgeDocuments.id, documentId),
                eq(knowledgeDocuments.knowledgeBaseId, input.knowledgeBaseId),
                eq(knowledgeDocuments.currentRevisionNumber, input.expectedRevision!),
              ),
            )
            .returning();
          const updatedDocument = updated[0];
          if (updatedDocument === undefined) {
            throw new Error("The document revision precondition changed during the transaction.");
          }
          documentRow = updatedDocument;
        }
        await replaceDocumentPeople(transaction, documentRow.id, input.personIds);

        await writeReceipt(transaction, {
          operation: CREATE_REVISION_OPERATION,
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
          resultEntityType: "knowledge_document",
          resultEntityId: documentRow.id,
          resultVersionId: revision.id,
        });
        if (access.administrativeChannel === true) {
          await appendAdministrativeDomainAuditEvent(
            transaction,
            access,
            {
              category: "domain",
              action: "knowledge_document.revision_created",
              outcome: "succeeded",
              targetType: "knowledge_document",
              targetId: documentRow.id,
              errorCode: null,
              metadata: {},
            },
            signal,
          );
        }
        return {
          document: mapDocument(
            documentRow,
            await personIdsForDocument(transaction, documentRow.id),
          ),
          revision: mapRevision(revision),
        };
      },
      { isolationLevel: "read committed" },
    );
    signal.throwIfAborted();
    return result;
  }

  async listDocuments(
    access: BrainAccessContext,
    input: {
      readonly knowledgeBaseId: string | null;
      readonly cursor: { readonly ts: string; readonly id: string } | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    requireBrowseLimit(input.limit);
    if (input.knowledgeBaseId !== null) {
      requireUuid(input.knowledgeBaseId, "knowledgeBaseId");
    }
    const cursorTimestamp = requireCursor(input.cursor);
    const result = await this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "viewer", signal);
      const rows = await transaction
        .select()
        .from(knowledgeDocuments)
        .where(
          and(
            input.knowledgeBaseId === null
              ? undefined
              : eq(knowledgeDocuments.knowledgeBaseId, input.knowledgeBaseId),
            input.cursor === null
              ? undefined
              : or(
                  lt(knowledgeDocuments.createdAt, cursorTimestamp!),
                  and(
                    eq(knowledgeDocuments.createdAt, cursorTimestamp!),
                    lt(knowledgeDocuments.id, input.cursor.id),
                  ),
                ),
          ),
        )
        .orderBy(desc(knowledgeDocuments.createdAt), desc(knowledgeDocuments.id))
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const pageRows = rows.slice(0, input.limit);
      const relations = pageRows.length === 0
        ? []
        : await transaction
            .select({
              documentId: knowledgeDocumentPeople.documentId,
              personId: knowledgeDocumentPeople.personId,
            })
            .from(knowledgeDocumentPeople)
            .where(inArray(knowledgeDocumentPeople.documentId, pageRows.map((row) => row.id)))
            .orderBy(asc(knowledgeDocumentPeople.personId));
      const peopleByDocument = new Map<string, string[]>();
      for (const relation of relations) {
        const ids = peopleByDocument.get(relation.documentId) ?? [];
        ids.push(relation.personId);
        peopleByDocument.set(relation.documentId, ids);
      }
      const documents = pageRows.map((row) =>
        mapDocument(row, peopleByDocument.get(row.id) ?? []),
      );
      const tail = pageRows.at(-1);
      signal.throwIfAborted();
      return {
        items: documents,
        nextCursor:
          hasMore && tail !== undefined
            ? {
                ts: toIso(tail.createdAt, "knowledge document cursor timestamp"),
                id: tail.id,
              }
            : null,
      };
    });
    signal.throwIfAborted();
    return result;
  }

  async getDocument(
    access: BrainAccessContext,
    input: {
      readonly documentId: string;
      readonly revision: number | null;
    },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    requireUuid(input.documentId, "documentId");
    if (
      input.revision !== null &&
      (!Number.isInteger(input.revision) || input.revision < 1)
    ) {
      throw new Error("revision must be a positive integer.");
    }
    const result = await this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "viewer", signal);
      const documentRows = await transaction
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, input.documentId))
        .limit(1);
      const documentRow = documentRows[0];
      if (documentRow === undefined) return null;
      const revisionNumber = input.revision ?? documentRow.currentRevisionNumber;
      const revisionRows = await transaction
        .select()
        .from(knowledgeDocumentRevisions)
        .where(
          and(
            eq(knowledgeDocumentRevisions.documentId, documentRow.id),
            eq(knowledgeDocumentRevisions.revisionNumber, revisionNumber),
          ),
        )
        .limit(1);
      const revisionRow = revisionRows[0];
      if (revisionRow === undefined) return null;
      const texts = await revisionTexts(transaction, [revisionRow]);
      signal.throwIfAborted();
      return {
        document: mapDocument(
          documentRow,
          await personIdsForDocument(transaction, documentRow.id),
        ),
        revision: mapRevision(revisionRow),
        ...texts.get(revisionRow.id)!,
      };
    });
    signal.throwIfAborted();
    return result;
  }

  async listDocumentRevisions(
    access: BrainAccessContext,
    input: {
      readonly documentId: string;
      readonly cursor: { readonly ts: string; readonly id: string } | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    requireUuid(input.documentId, "documentId");
    requireBrowseLimit(input.limit);
    const cursorTimestamp = requireCursor(input.cursor);
    const result = await this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "viewer", signal);
      const rows = await transaction
        .select()
        .from(knowledgeDocumentRevisions)
        .where(
          and(
            eq(knowledgeDocumentRevisions.documentId, input.documentId),
            input.cursor === null
              ? undefined
              : or(
                  lt(knowledgeDocumentRevisions.createdAt, cursorTimestamp!),
                  and(
                    eq(knowledgeDocumentRevisions.createdAt, cursorTimestamp!),
                    lt(knowledgeDocumentRevisions.id, input.cursor.id),
                  ),
                ),
          ),
        )
        .orderBy(
          desc(knowledgeDocumentRevisions.createdAt),
          desc(knowledgeDocumentRevisions.id),
        )
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const pageRows = rows.slice(0, input.limit);
      const texts = await revisionTexts(transaction, pageRows);
      const tail = pageRows.at(-1);
      signal.throwIfAborted();
      return {
        items: pageRows.map((row) => ({
          revision: mapRevision(row),
          ...texts.get(row.id)!,
        })),
        nextCursor:
          hasMore && tail !== undefined
            ? {
                ts: toIso(tail.createdAt, "knowledge revision cursor timestamp"),
                id: tail.id,
              }
            : null,
      };
    });
    signal.throwIfAborted();
    return result;
  }

  async searchKnowledge(
    access: BrainAccessContext,
    input: {
      readonly knowledgeBaseId: string | null;
      readonly embedding: ContentEmbedding;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<readonly KnowledgeChunkMatch[] | null> {
    signal.throwIfAborted();
    requireSearchLimit(input.limit);
    requireHash(input.embedding.contentHash, "Query embedding content hash");
    const result = await this.database.transaction(
      async (transaction) => {
        await authorizeBrainTransaction(transaction, access, "viewer", signal);
        if (input.knowledgeBaseId !== null) {
          const baseRows = await transaction
            .select({ id: knowledgeBases.id })
            .from(knowledgeBases)
            .where(eq(knowledgeBases.id, input.knowledgeBaseId))
            .limit(1);
          if (baseRows.length !== 1) return null;
        }

        const spaceRows = await transaction
          .select({ dimensions: embeddingSpaces.dimensions })
          .from(embeddingSpaces)
          .where(
            and(
              eq(embeddingSpaces.id, input.embedding.spaceId),
              eq(embeddingSpaces.entityType, "knowledge_chunk"),
              eq(embeddingSpaces.status, "active"),
              eq(
                embeddingSpaces.recipeVersion,
                KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
              ),
            ),
          )
          .limit(1);
        const space = spaceRows[0];
        if (
          space === undefined ||
          input.embedding.vector.length !== space.dimensions ||
          input.embedding.vector.some((value) => !Number.isFinite(value))
        ) {
          return [];
        }

        const distance = cosineDistance(
          knowledgeChunkEmbeddings.embedding,
          [...input.embedding.vector],
        );
        const score = sql<number>`greatest(-1, least(1, 1 - (${distance})))`;
        const rows = await transaction
          .select({
            chunkId: knowledgeChunks.id,
            documentId: knowledgeDocuments.id,
            revisionId: knowledgeDocumentRevisions.id,
            documentTitle: knowledgeDocuments.title,
            content: knowledgeChunks.content,
            score,
            spaceId: knowledgeChunkEmbeddings.spaceId,
            knowledgeBaseId: knowledgeBases.id,
            knowledgeBaseName: knowledgeBases.name,
            originAttribution: knowledgeRevisionOrigins.attribution,
          })
          .from(knowledgeChunkEmbeddings)
          .innerJoin(
            knowledgeChunks,
            eq(knowledgeChunks.id, knowledgeChunkEmbeddings.chunkId),
          )
          .leftJoin(
            knowledgeRevisionOrigins,
            eq(knowledgeRevisionOrigins.revisionId, knowledgeChunks.revisionId),
          )
          .innerJoin(
            knowledgeDocumentRevisions,
            eq(knowledgeDocumentRevisions.id, knowledgeChunks.revisionId),
          )
          .innerJoin(
            knowledgeDocuments,
            and(
              eq(knowledgeDocuments.id, knowledgeDocumentRevisions.documentId),
              eq(
                knowledgeDocuments.currentRevisionNumber,
                knowledgeDocumentRevisions.revisionNumber,
              ),
            ),
          )
          .innerJoin(
            knowledgeBases,
            eq(knowledgeBases.id, knowledgeDocuments.knowledgeBaseId),
          )
          .where(
            and(
              eq(knowledgeChunkEmbeddings.spaceId, input.embedding.spaceId),
              eq(knowledgeChunkEmbeddings.contentHash, knowledgeChunks.contentHash),
              eq(
                knowledgeChunkEmbeddings.recipeVersion,
                KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
              ),
              input.knowledgeBaseId === null
                ? undefined
                : eq(knowledgeDocuments.knowledgeBaseId, input.knowledgeBaseId),
            ),
          )
          .orderBy(asc(distance), asc(knowledgeChunks.id))
          .limit(input.limit);

        return rows.map((row): KnowledgeChunkMatch => {
          const decodedScore = Number(row.score);
          if (!Number.isFinite(decodedScore) || decodedScore < -1 || decodedScore > 1) {
            throw new Error("Database returned an invalid knowledge similarity score.");
          }
          if (
            row.content.length < 1 ||
            row.documentTitle.length < 1 ||
            row.knowledgeBaseName.length < 1
          ) {
            throw new Error("Database returned an invalid knowledge chunk.");
          }
          const { originAttribution, ...match } = row;
          return { ...match, score: decodedScore, origin: decodeOrigin(originAttribution) };
        });
      },
      { isolationLevel: "repeatable read" },
    );
    signal.throwIfAborted();
    return result;
  }
}
