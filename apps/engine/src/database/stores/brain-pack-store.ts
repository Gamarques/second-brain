import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";

import {
  BrainPackError,
  brainPackLimits,
  brainPackTerminalRunStatuses,
  type BrainPack,
  type BrainPackExportReceipt,
  type BrainPackImportReceipt,
  type BrainPackImportReceiptItem,
  type BrainPackImportReceiptSkip,
  type BrainPackItemDecision,
  type BrainPackManifest,
  type BrainPackRunKind,
  type BrainPackRunStatus,
} from "../../domain/brain-pack.js";
import {
  brainPackDecisionWrites,
  classifyBrainPackImportItem,
  resolveBrainPackReview,
} from "../../domain/brain-pack-import.js";
import {
  BrainPackStoreConflictError,
  type BrainPackExportRecordInput,
  type BrainPackExportSelection,
  type BrainPackExportSnapshot,
  type BrainPackExportSnapshotDocument,
  type BrainPackFrozenReview,
  type BrainPackImportCreateInput,
  type BrainPackImportReviewInput,
  type BrainPackImportWork,
  type BrainPackImportWorkItem,
  type BrainPackItemCheckpoint,
  type BrainPackOriginAttribution,
  type BrainPackPreviewRecord,
  type BrainPackPublicationFence,
  type BrainPackRunCursor,
  type BrainPackRunItemRecord,
  type BrainPackRunProgress,
  type BrainPackRunRecord,
  type BrainPackStagedChunk,
  type BrainPackStore,
} from "../../domain/brain-pack-store.js";
import type { BrainAccessContext } from "../../domain/core.js";
import { sha256Hex } from "../../domain/digests.js";
import { KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION, knowledgeChunkEmbeddingRecipe } from "../../domain/embedding-recipes.js";
import { knowledgeChunkOverlap, knowledgeChunkSize } from "../../domain/knowledge-indexing.js";
import { automationJobs } from "../schema/automation.js";
import {
  knowledgePackItems,
  knowledgePackMappings,
  knowledgePackRevisions,
  knowledgePackRunChunks,
  knowledgePackRunItems,
  knowledgePackRuns,
  knowledgePacks,
  knowledgeRevisionContents,
  knowledgeRevisionOrigins,
} from "../schema/brain-pack.js";
import {
  knowledgeBases,
  knowledgeChunks,
  knowledgeDocumentRevisions,
  knowledgeDocuments,
  projects,
} from "../schema/content.js";
import { embeddingSpaces, knowledgeChunkEmbeddings } from "../schema/embeddings.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type { SecondBrainDatabase, SecondBrainTransaction } from "./database.js";
import { reconstructKnowledgeContent } from "./knowledge-store.js";
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

/*
 * Drizzle persistence for Brain Pack runs. Every capability-facing method
 * authorizes the caller inside its transaction; the worker-facing methods act
 * for the run's owner, whose role the import service re-resolves first.
 */

const IMPORT_OPERATION = "knowledge_packs.import";
const EXPORT_OPERATION = "knowledge_packs.export";
const REVIEW_OPERATION = "knowledge_packs.import_review";
const PUBLISH_OPERATION = "knowledge_packs.import_publish";
const CANCEL_OPERATION = "knowledge_packs.runs_cancel";
const RETRY_OPERATION = "knowledge_packs.runs_retry";
const IMPORT_JOB_KIND = "brain_pack_import" as const;
const MAX_LIST_LIMIT = 100;
const MAX_DOCUMENT_TAGS = 20;
const PREVIEW_SAMPLES = 5;
const EXCERPT_CHARACTERS = 500;

type RunRow = typeof knowledgePackRuns.$inferSelect;
type PackRow = typeof knowledgePacks.$inferSelect;
type RevisionRow = typeof knowledgePackRevisions.$inferSelect;
type RunItemRow = typeof knowledgePackRunItems.$inferSelect;
type PackItemRow = typeof knowledgePackItems.$inferSelect;

const terminalStatuses: readonly BrainPackRunStatus[] = brainPackTerminalRunStatuses;

function importJobKey(runId: string): string {
  return `brain-pack-import:${runId}`;
}

function requireLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`Brain Pack listing limit must be between 1 and ${MAX_LIST_LIMIT}.`);
  }
}

function parseInstant(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be an instant.`);
  return date;
}

function importActor(ownerAccountId: string) {
  return {
    actorKind: "import" as const,
    actorAccountId: ownerAccountId,
    actorClientId: null,
    actorSource: "import" as const,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeProgress(value: unknown): BrainPackRunProgress | null {
  if (!isRecord(value) || typeof value.stage !== "string") return null;
  const processedItems = Number(value.processedItems);
  const totalItems = Number(value.totalItems);
  if (!Number.isInteger(processedItems) || !Number.isInteger(totalItems)) return null;
  return { stage: value.stage, processedItems, totalItems };
}

function decodeCheckpoint(value: unknown): BrainPackItemCheckpoint {
  if (!isRecord(value) || !isRecord(value.indexed)) return { indexed: null };
  const { spaceId, contentSha256, chunkCount } = value.indexed;
  if (typeof spaceId !== "string" || typeof contentSha256 !== "string" || !Number.isInteger(chunkCount)) {
    return { indexed: null };
  }
  return { indexed: { spaceId, contentSha256, chunkCount: chunkCount as number } };
}

function decodeFrozenReview(value: unknown): BrainPackFrozenReview | null {
  if (!isRecord(value) || !Array.isArray(value.collections) || !Array.isArray(value.items)) return null;
  return value as unknown as BrainPackFrozenReview;
}

function decodeExportSelection(value: unknown): BrainPackExportSelection | null {
  if (!isRecord(value) || !Array.isArray(value.knowledgeBaseIds) || typeof value.frozenAt !== "string") return null;
  return value as unknown as BrainPackExportSelection;
}

function decodeOrigin(value: unknown): BrainPackOriginAttribution | null {
  if (!isRecord(value) || !isRecord(value.publisher) || typeof value.packId !== "string") return null;
  return value as unknown as BrainPackOriginAttribution;
}

function manifestOf(row: RevisionRow): BrainPackManifest {
  return row.manifest as BrainPackManifest;
}

function mapRun(row: RunRow, pack: PackRow | null, revision: RevisionRow | null): BrainPackRunRecord {
  const manifest = revision === null ? null : manifestOf(revision);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    ownerAccountId: row.ownerAccountId,
    pack:
      pack === null || revision === null
        ? null
        : {
            id: pack.id,
            externalPackId: pack.externalPackId,
            publisher: { namespace: pack.publisherNamespace, displayName: revision.publisherDisplayName },
            owned: pack.owned,
          },
    packRevision:
      revision === null || manifest === null
        ? null
        : { id: revision.id, number: revision.packRevision, title: manifest.title, manifestSha256: revision.manifestSha256 },
    artifactId: row.artifactId,
    jobId: row.jobId,
    idempotencyKey: row.idempotencyKey,
    requestDigest: row.requestDigest,
    reviewVersion: row.reviewVersion,
    reviewDigest: row.reviewDigest,
    review: row.kind === "import" && row.reviewVersion > 0 ? decodeFrozenReview(row.frozenSelection) : null,
    exportSelection: row.kind === "export" ? decodeExportSelection(row.frozenSelection) : null,
    progress: decodeProgress(row.progress),
    receipt: row.receipt === null ? null : (row.receipt as BrainPackImportReceipt | BrainPackExportReceipt),
    sanitizedError: row.sanitizedError,
    cancelRequestedAt: row.cancelRequestedAt === null ? null : toIso(row.cancelRequestedAt, "cancellation timestamp"),
    createdAt: toIso(row.createdAt, "run creation timestamp"),
    updatedAt: toIso(row.updatedAt, "run update timestamp"),
    completedAt: row.completedAt === null ? null : toIso(row.completedAt, "run completion timestamp"),
  };
}

function mapRunItem(row: RunItemRow): BrainPackRunItemRecord {
  return {
    id: row.id,
    runId: row.runId,
    itemKey: row.itemKey,
    packItemId: row.packItemId,
    collectionKey: row.collectionKey,
    title: row.title,
    classification: row.classification,
    decision: row.decision,
    expectedLocalRevision: row.expectedLocalRevision,
    localDocumentId: row.localDocumentId,
    localRevision: row.localRevision,
    destinationKnowledgeBaseId: row.destinationKnowledgeBaseId,
    result: row.result,
    resultDocumentId: row.resultDocumentId,
    resultRevisionId: row.resultRevisionId,
    checkpoint: decodeCheckpoint(row.checkpoint),
    sanitizedError: row.sanitizedError,
  };
}

function excerptOf(content: string): string {
  const flattened = content.replace(/\s+/gu, " ").trim();
  return flattened.length <= EXCERPT_CHARACTERS ? flattened : flattened.slice(0, EXCERPT_CHARACTERS);
}

function estimateChunks(characterCount: number): number {
  return Math.max(1, Math.ceil(characterCount / (knowledgeChunkSize - knowledgeChunkOverlap)));
}

function packItemContent(row: PackItemRow): string {
  const payload = row.payload;
  if (!isRecord(payload) || typeof payload.content !== "string" || payload.content.length === 0) {
    throw new Error(`Pack item ${row.itemKey} has no stored text.`);
  }
  return payload.content;
}

/** Publication touches many rows at once, so it gets a longer statement budget than a capability read. */
async function workerTimeouts(transaction: SecondBrainTransaction): Promise<void> {
  await transaction.execute(sql`set local statement_timeout = 120000`);
  await transaction.execute(sql`set local lock_timeout = 10000`);
}

async function loadRun(transaction: SecondBrainTransaction, runId: string, lock: boolean) {
  const query = transaction
    .select({ run: knowledgePackRuns, pack: knowledgePacks, revision: knowledgePackRevisions })
    .from(knowledgePackRuns)
    .leftJoin(knowledgePacks, eq(knowledgePacks.id, knowledgePackRuns.packId))
    .leftJoin(knowledgePackRevisions, eq(knowledgePackRevisions.id, knowledgePackRuns.packRevisionId))
    .where(eq(knowledgePackRuns.id, runId))
    .limit(1);
  const rows = lock ? await query.for("update", { of: knowledgePackRuns }) : await query;
  const row = rows[0];
  return row === undefined ? null : mapRun(row.run, row.pack, row.revision);
}

async function loadRunByKey(transaction: SecondBrainTransaction, kind: BrainPackRunKind, idempotencyKey: string) {
  const rows = await transaction
    .select({ run: knowledgePackRuns, pack: knowledgePacks, revision: knowledgePackRevisions })
    .from(knowledgePackRuns)
    .leftJoin(knowledgePacks, eq(knowledgePacks.id, knowledgePackRuns.packId))
    .leftJoin(knowledgePackRevisions, eq(knowledgePackRevisions.id, knowledgePackRuns.packRevisionId))
    .where(and(eq(knowledgePackRuns.kind, kind), eq(knowledgePackRuns.idempotencyKey, idempotencyKey)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : mapRun(row.run, row.pack, row.revision);
}

async function loadRunItems(transaction: SecondBrainTransaction, runId: string): Promise<readonly RunItemRow[]> {
  return transaction
    .select()
    .from(knowledgePackRunItems)
    .where(eq(knowledgePackRunItems.runId, runId))
    .orderBy(asc(knowledgePackRunItems.itemKey));
}

/** Points a run at an import job, reusing the canonical key when an earlier attempt left a finished job behind. */
async function enqueueImportJob(transaction: SecondBrainTransaction, runId: string, now: Date): Promise<string> {
  const existing = await transaction
    .select()
    .from(automationJobs)
    .where(and(eq(automationJobs.kind, IMPORT_JOB_KIND), eq(automationJobs.canonicalKey, importJobKey(runId))))
    .limit(1)
    .for("update");
  const job = existing[0];
  if (job === undefined) {
    const inserted = await transaction
      .insert(automationJobs)
      .values({
        kind: IMPORT_JOB_KIND,
        canonicalKey: importJobKey(runId),
        scheduledFor: now,
        status: "pending",
        payload: { runId },
      })
      .returning({ id: automationJobs.id });
    const row = inserted[0];
    if (row === undefined) throw new Error("The import job was not queued.");
    return row.id;
  }
  if (job.status === "pending" || job.status === "running" || job.status === "retry_wait") return job.id;
  await transaction
    .update(automationJobs)
    .set({
      status: "pending",
      scheduledFor: now,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      fencingToken: null,
      cancelRequestedAt: null,
      sanitizedError: null,
      payload: { runId },
      updatedAt: now,
    })
    .where(eq(automationJobs.id, job.id));
  return job.id;
}

export class DrizzleBrainPackStore implements BrainPackStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async getRun(access: BrainAccessContext, runId: string, signal: AbortSignal): Promise<BrainPackRunRecord | null> {
    signal.throwIfAborted();
    requireUuid(runId, "runId");
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      return loadRun(transaction, runId, false);
    });
  }

  async findRunByIdempotencyKey(
    access: BrainAccessContext,
    input: { readonly kind: BrainPackRunKind; readonly idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<BrainPackRunRecord | null> {
    signal.throwIfAborted();
    requireIdempotencyKey(input.idempotencyKey);
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      return loadRunByKey(transaction, input.kind, input.idempotencyKey);
    });
  }

  async listRuns(
    access: BrainAccessContext,
    input: {
      readonly kind: BrainPackRunKind | null;
      readonly status: BrainPackRunStatus | null;
      readonly cursor: BrainPackRunCursor | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    requireLimit(input.limit);
    const cursorInstant = input.cursor === null ? null : parseInstant(input.cursor.ts, "cursor timestamp");
    if (input.cursor !== null) requireUuid(input.cursor.id, "cursor id");
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      const rows = await transaction
        .select({ run: knowledgePackRuns, pack: knowledgePacks, revision: knowledgePackRevisions })
        .from(knowledgePackRuns)
        .leftJoin(knowledgePacks, eq(knowledgePacks.id, knowledgePackRuns.packId))
        .leftJoin(knowledgePackRevisions, eq(knowledgePackRevisions.id, knowledgePackRuns.packRevisionId))
        .where(
          and(
            input.kind === null ? undefined : eq(knowledgePackRuns.kind, input.kind),
            input.status === null ? undefined : eq(knowledgePackRuns.status, input.status),
            cursorInstant === null || input.cursor === null
              ? undefined
              : or(
                  lt(knowledgePackRuns.createdAt, cursorInstant),
                  and(eq(knowledgePackRuns.createdAt, cursorInstant), lt(knowledgePackRuns.id, input.cursor.id)),
                ),
          ),
        )
        .orderBy(desc(knowledgePackRuns.createdAt), desc(knowledgePackRuns.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit).map((row) => mapRun(row.run, row.pack, row.revision));
      const last = page[page.length - 1];
      return {
        runs: page,
        nextCursor: rows.length > input.limit && last !== undefined ? { ts: last.createdAt, id: last.id } : null,
      };
    });
  }

  async listRunItems(
    access: BrainAccessContext,
    input: { readonly runId: string; readonly cursor: string | null; readonly limit: number },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    requireUuid(input.runId, "runId");
    requireLimit(input.limit);
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      const rows = await transaction
        .select()
        .from(knowledgePackRunItems)
        .where(
          and(
            eq(knowledgePackRunItems.runId, input.runId),
            input.cursor === null ? undefined : gt(knowledgePackRunItems.itemKey, input.cursor),
          ),
        )
        .orderBy(asc(knowledgePackRunItems.itemKey))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit).map(mapRunItem);
      const last = page[page.length - 1];
      return { items: page, nextCursor: rows.length > input.limit && last !== undefined ? last.itemKey : null };
    });
  }

  async getImportPreview(access: BrainAccessContext, runId: string, signal: AbortSignal): Promise<BrainPackPreviewRecord | null> {
    signal.throwIfAborted();
    requireUuid(runId, "runId");
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      const run = await loadRun(transaction, runId, false);
      if (run === null || run.kind !== "import" || run.pack === null || run.packRevision === null) return null;
      const revisionRows = await transaction
        .select()
        .from(knowledgePackRevisions)
        .where(eq(knowledgePackRevisions.id, run.packRevision.id))
        .limit(1);
      const revision = revisionRows[0];
      if (revision === undefined) return null;
      const manifest = manifestOf(revision);
      const items = await transaction
        .select({
          kind: knowledgePackItems.kind,
          itemKey: knowledgePackItems.itemKey,
          title: knowledgePackItems.title,
          characterCount: knowledgePackItems.characterCount,
          payload: knowledgePackItems.payload,
        })
        .from(knowledgePackItems)
        .where(eq(knowledgePackItems.packRevisionId, revision.id))
        .orderBy(asc(knowledgePackItems.kind), asc(knowledgePackItems.itemKey));
      const runItems = await loadRunItems(transaction, runId);
      const counts = { new: 0, updated: 0, unchanged: 0, conflicting: 0, invalid: 0 };
      for (const item of runItems) counts[item.classification] += 1;
      const documents = items.filter((item) => item.kind === "document");
      const collections = items.filter((item) => item.kind === "collection");
      return {
        packId: run.pack.externalPackId,
        packRevision: run.packRevision.number,
        publisher: { ...run.pack.publisher },
        title: manifest.title,
        description: manifest.description,
        language: manifest.language,
        createdAt: manifest.createdAt,
        manifestSha256: revision.manifestSha256,
        collections: collections.map((collection) => {
          const payload = isRecord(collection.payload) ? collection.payload : {};
          return {
            key: collection.itemKey,
            name: collection.title,
            description: typeof payload.description === "string" ? payload.description : null,
            documentCount: Array.isArray(payload.documentKeys) ? payload.documentKeys.length : 0,
          };
        }),
        counts: { collections: collections.length, documents: documents.length, ...counts },
        volume: {
          expandedBytes: manifest.inventory.reduce((sum, entry) => sum + entry.byteSize, 0),
          documentCharacters: documents.reduce((sum, document) => sum + (document.characterCount ?? 0), 0),
          estimatedChunks: documents.reduce((sum, document) => sum + estimateChunks(document.characterCount ?? 0), 0),
        },
        samples: documents.slice(0, PREVIEW_SAMPLES).map((document) => {
          const payload = isRecord(document.payload) ? document.payload : {};
          return {
            itemKey: document.itemKey,
            title: document.title,
            excerpt: typeof payload.excerpt === "string" ? payload.excerpt : "",
          };
        }),
      };
    });
  }

  async prepareExport(
    access: BrainAccessContext,
    input: {
      readonly externalPackId: string | null;
      readonly expectedPackRevision: number | null;
      readonly publisherNamespace: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly externalPackId: string; readonly packRevision: number }> {
    signal.throwIfAborted();
    if (input.externalPackId === null) {
      if (input.expectedPackRevision !== null) {
        throw new Error("expectedPackRevision needs the packId it refers to.");
      }
      return { externalPackId: randomUUID(), packRevision: 1 };
    }
    requireUuid(input.externalPackId, "packId");
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      const rows = await transaction
        .select()
        .from(knowledgePacks)
        .where(
          and(
            eq(knowledgePacks.publisherNamespace, input.publisherNamespace),
            eq(knowledgePacks.externalPackId, input.externalPackId!),
          ),
        )
        .limit(1);
      const pack = rows[0];
      if (pack === undefined || !pack.owned) {
        throw new Error("The pack to re-export was not found among the packs this brain publishes.");
      }
      if (input.expectedPackRevision !== pack.latestRevision) {
        throw new BrainPackError("PACK_REVISION_CONFLICT", "The pack advanced since it was last read.", [
          `latest revision: ${pack.latestRevision}`,
        ]);
      }
      return { externalPackId: pack.externalPackId, packRevision: pack.latestRevision + 1 };
    });
  }

  async snapshotExportSelection(
    access: BrainAccessContext,
    input: {
      readonly knowledgeBaseIds: readonly string[];
      readonly documentIds: readonly string[];
      readonly maxDocuments: number;
    },
    signal: AbortSignal,
  ): Promise<BrainPackExportSnapshot> {
    signal.throwIfAborted();
    for (const id of input.knowledgeBaseIds) requireUuid(id, "knowledgeBaseId");
    for (const id of input.documentIds) requireUuid(id, "documentId");
    if (input.knowledgeBaseIds.length + input.documentIds.length === 0) {
      throw new Error("Choose at least one knowledge base or document to export.");
    }
    return this.database.transaction(
      async (transaction) => {
        await authorizeBrainTransaction(transaction, access, "admin", signal);
        const frozenAt = new Date().toISOString();
        const baseIds = [...new Set(input.knowledgeBaseIds)];
        const documentIds = [...new Set(input.documentIds)];

        const baseRows = baseIds.length === 0 ? [] : await transaction.select().from(knowledgeBases).where(inArray(knowledgeBases.id, baseIds));
        if (baseRows.length !== baseIds.length) throw new Error("A selected knowledge base was not found.");
        const explicitRows =
          documentIds.length === 0
            ? []
            : await transaction.select().from(knowledgeDocuments).where(inArray(knowledgeDocuments.id, documentIds));
        if (explicitRows.length !== documentIds.length) throw new Error("A selected knowledge document was not found.");
        const baseDocumentRows =
          baseIds.length === 0
            ? []
            : await transaction.select().from(knowledgeDocuments).where(inArray(knowledgeDocuments.knowledgeBaseId, baseIds));

        const documentRows = new Map<string, typeof knowledgeDocuments.$inferSelect>();
        for (const row of [...baseDocumentRows, ...explicitRows]) documentRows.set(row.id, row);
        if (documentRows.size > input.maxDocuments) {
          throw new BrainPackError("PACK_LIMIT_EXCEEDED", "The selection holds more documents than one export may carry.", [
            `documents: ${documentRows.size} > ${input.maxDocuments}`,
          ]);
        }
        const extraBaseIds = [...new Set(explicitRows.map((row) => row.knowledgeBaseId))].filter((id) => !baseIds.includes(id));
        const extraBaseRows =
          extraBaseIds.length === 0 ? [] : await transaction.select().from(knowledgeBases).where(inArray(knowledgeBases.id, extraBaseIds));
        const bases = [...baseRows, ...extraBaseRows].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

        const documents: BrainPackExportSnapshotDocument[] = [];
        const orderedDocuments = [...documentRows.values()].sort(
          (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
        );
        for (const document of orderedDocuments) {
          signal.throwIfAborted();
          const revisionRows = await transaction
            .select({ revision: knowledgeDocumentRevisions, content: knowledgeRevisionContents, origin: knowledgeRevisionOrigins })
            .from(knowledgeDocumentRevisions)
            .leftJoin(knowledgeRevisionContents, eq(knowledgeRevisionContents.revisionId, knowledgeDocumentRevisions.id))
            .leftJoin(knowledgeRevisionOrigins, eq(knowledgeRevisionOrigins.revisionId, knowledgeDocumentRevisions.id))
            .where(
              and(
                eq(knowledgeDocumentRevisions.documentId, document.id),
                eq(knowledgeDocumentRevisions.revisionNumber, document.currentRevisionNumber),
              ),
            )
            .limit(1);
          const current = revisionRows[0];
          if (current === undefined) throw new Error(`Document ${document.id} has no current revision.`);
          let content: string;
          let representation: BrainPackExportSnapshotDocument["representation"];
          if (current.content !== null && current.content.representation === "canonical") {
            content = current.content.content;
            representation = "canonical";
          } else {
            const chunkRows = await transaction
              .select({ position: knowledgeChunks.position, content: knowledgeChunks.content })
              .from(knowledgeChunks)
              .where(eq(knowledgeChunks.revisionId, current.revision.id))
              .orderBy(asc(knowledgeChunks.position));
            content = reconstructKnowledgeContent(chunkRows, current.revision.chunkCount);
            representation = "reconstructed";
          }
          documents.push({
            id: document.id,
            title: document.title,
            tags: [...document.tags],
            sourceUri: document.sourceUri,
            revision: { id: current.revision.id, number: current.revision.revisionNumber, contentHash: current.revision.contentHash },
            content,
            representation,
            origin: current.origin === null ? null : decodeOrigin(current.origin.attribution),
          });
        }
        const byBase = new Map<string, BrainPackExportSnapshotDocument[]>();
        for (const document of documents) {
          const baseId = documentRows.get(document.id)!.knowledgeBaseId;
          byBase.set(baseId, [...(byBase.get(baseId) ?? []), document]);
        }
        return {
          frozenAt,
          knowledgeBases: bases.map((base) => ({
            id: base.id,
            name: base.name,
            description: base.description,
            documents: byBase.get(base.id) ?? [],
          })),
        };
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async recordExport(access: BrainAccessContext, input: BrainPackExportRecordInput, signal: AbortSignal) {
    signal.throwIfAborted();
    requireIdempotencyKey(input.idempotencyKey);
    requireHash(input.requestDigest, "Export request digest");
    requireUuid(input.artifactId, "artifactId");
    requireUuid(input.revision.externalPackId, "packId");
    return this.database.transaction(async (transaction) => {
      const authorized = await authorizeBrainTransaction(transaction, access, "admin", signal);
      await lockIdempotencyKey(transaction, EXPORT_OPERATION, input.idempotencyKey);
      const existing = await loadRunByKey(transaction, "export", input.idempotencyKey);
      if (existing !== null) {
        if (existing.requestDigest !== input.requestDigest) throw new BrainPackStoreConflictError();
        return { run: existing, replayed: true };
      }

      const now = new Date();
      const packRows = await transaction
        .select()
        .from(knowledgePacks)
        .where(
          and(
            eq(knowledgePacks.publisherNamespace, input.revision.publisher.namespace),
            eq(knowledgePacks.externalPackId, input.revision.externalPackId),
          ),
        )
        .limit(1)
        .for("update");
      let pack = packRows[0];
      if (pack === undefined) {
        if (input.revision.packRevision !== 1 || input.expectedPackRevision !== null) {
          throw new BrainPackError("PACK_REVISION_CONFLICT", "A new pack starts at revision 1.");
        }
        const inserted = await transaction
          .insert(knowledgePacks)
          .values({
            publisherNamespace: input.revision.publisher.namespace,
            externalPackId: input.revision.externalPackId,
            owned: true,
            title: input.revision.title,
            description: input.revision.description,
            language: input.revision.language,
            latestRevision: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        pack = inserted[0];
        if (pack === undefined) throw new Error("The pack was not stored.");
      } else {
        if (!pack.owned) throw new Error("The pack to re-export was not found among the packs this brain publishes.");
        if (pack.latestRevision !== input.revision.packRevision - 1 || input.expectedPackRevision !== pack.latestRevision) {
          throw new BrainPackError("PACK_REVISION_CONFLICT", "The pack advanced since it was last read.", [
            `latest revision: ${pack.latestRevision}`,
          ]);
        }
        await transaction
          .update(knowledgePacks)
          .set({
            title: input.revision.title,
            description: input.revision.description,
            language: input.revision.language,
            latestRevision: input.revision.packRevision,
            updatedAt: now,
          })
          .where(eq(knowledgePacks.id, pack.id));
      }

      const revisionId = await insertRevision(transaction, pack.id, input.revision, false);
      const runId = randomUUID();
      const receipt: BrainPackExportReceipt = { ...input.receipt, runId };
      const inserted = await transaction
        .insert(knowledgePackRuns)
        .values({
          id: runId,
          kind: "export",
          status: "completed",
          ownerAccountId: authorized.accountId,
          packId: pack.id,
          packRevisionId: revisionId,
          artifactId: input.artifactId,
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
          frozenSelection: input.selection,
          progress: { stage: "completed", processedItems: input.receipt.documentCount, totalItems: input.receipt.documentCount },
          receipt,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: knowledgePackRuns.id });
      if (inserted.length !== 1) throw new Error("The export run was not stored.");
      const run = await loadRun(transaction, runId, false);
      if (run === null) throw new Error("The export run was not stored.");
      return { run, replayed: false };
    });
  }

  async createImportRun(access: BrainAccessContext, input: BrainPackImportCreateInput, signal: AbortSignal) {
    signal.throwIfAborted();
    requireIdempotencyKey(input.idempotencyKey);
    requireHash(input.requestDigest, "Import request digest");
    requireUuid(input.artifactId, "artifactId");
    if ((input.pack === null) === (input.failure === null)) {
      throw new Error("An import run records either a decoded pack or a failure.");
    }
    return this.database.transaction(async (transaction) => {
      const authorized = await authorizeBrainTransaction(transaction, access, "admin", signal);
      await lockIdempotencyKey(transaction, IMPORT_OPERATION, input.idempotencyKey);
      const existing = await loadRunByKey(transaction, "import", input.idempotencyKey);
      if (existing !== null) {
        if (existing.requestDigest !== input.requestDigest) throw new BrainPackStoreConflictError();
        return { run: existing, replayed: true };
      }
      const now = new Date();
      const runId = randomUUID();

      const failRun = async (code: string, message: string, packId: string | null, packRevisionId: string | null) => {
        await transaction.insert(knowledgePackRuns).values({
          id: runId,
          kind: "import",
          status: "failed",
          ownerAccountId: authorized.accountId,
          packId,
          packRevisionId,
          artifactId: input.artifactId,
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
          sanitizedError: `${code}: ${message}`.slice(0, 500),
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        const run = await loadRun(transaction, runId, false);
        if (run === null) throw new Error("The import run was not stored.");
        return { run, replayed: false };
      };

      if (input.pack === null) {
        return failRun(input.failure!.code, input.failure!.message, null, null);
      }
      await assertImportCapacity(transaction, authorized.accountId);

      const decoded = input.pack.decoded;
      const header = decoded.manifest;
      const packRows = await transaction
        .select()
        .from(knowledgePacks)
        .where(
          and(eq(knowledgePacks.publisherNamespace, header.publisher.namespace), eq(knowledgePacks.externalPackId, header.packId)),
        )
        .limit(1)
        .for("update");
      let pack = packRows[0];
      if (pack === undefined) {
        const inserted = await transaction
          .insert(knowledgePacks)
          .values({
            publisherNamespace: header.publisher.namespace,
            externalPackId: header.packId,
            owned: false,
            title: header.title,
            description: header.description,
            language: header.language,
            latestRevision: header.packRevision,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        pack = inserted[0];
        if (pack === undefined) throw new Error("The pack was not stored.");
      } else if (!pack.owned && header.packRevision >= pack.latestRevision) {
        await transaction
          .update(knowledgePacks)
          .set({
            title: header.title,
            description: header.description,
            language: header.language,
            latestRevision: header.packRevision,
            updatedAt: now,
          })
          .where(eq(knowledgePacks.id, pack.id));
      }

      const revisionRows = await transaction
        .select()
        .from(knowledgePackRevisions)
        .where(and(eq(knowledgePackRevisions.packId, pack.id), eq(knowledgePackRevisions.packRevision, header.packRevision)))
        .limit(1);
      let revisionId: string;
      const known = revisionRows[0];
      if (known !== undefined) {
        if (known.manifestSha256 !== input.pack.manifestSha256) {
          return failRun(
            "PACK_INTEGRITY_FAILED",
            "This pack revision was seen before with different content; a publisher must not reuse a revision number.",
            pack.id,
            null,
          );
        }
        revisionId = known.id;
      } else {
        revisionId = await insertRevision(
          transaction,
          pack.id,
          {
            externalPackId: header.packId,
            packRevision: header.packRevision,
            publisher: header.publisher,
            title: header.title,
            description: header.description,
            language: header.language,
            manifest: header,
            manifestSha256: input.pack.manifestSha256,
            createdAt: header.createdAt,
            items: importItems(decoded),
          },
          true,
        );
      }

      const documentKeys = decoded.documents.map((document) => document.key);
      const mappingRows =
        documentKeys.length === 0
          ? []
          : await transaction
              .select({ mapping: knowledgePackMappings, document: knowledgeDocuments })
              .from(knowledgePackMappings)
              .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgePackMappings.documentId))
              .where(and(eq(knowledgePackMappings.packId, pack.id), inArray(knowledgePackMappings.itemKey, documentKeys)));
      const localRevisionIds = new Map<string, string>();
      if (mappingRows.length > 0) {
        const currentRevisions = await transaction
          .select({ id: knowledgeDocumentRevisions.id, documentId: knowledgeDocumentRevisions.documentId })
          .from(knowledgeDocumentRevisions)
          .innerJoin(
            knowledgeDocuments,
            and(
              eq(knowledgeDocuments.id, knowledgeDocumentRevisions.documentId),
              eq(knowledgeDocuments.currentRevisionNumber, knowledgeDocumentRevisions.revisionNumber),
            ),
          )
          .where(inArray(knowledgeDocumentRevisions.documentId, mappingRows.map((row) => row.document.id)));
        for (const row of currentRevisions) localRevisionIds.set(row.documentId, row.id);
      }
      const mappings = new Map(mappingRows.map((row) => [row.mapping.itemKey, row] as const));
      const packItemRows = await transaction
        .select({ id: knowledgePackItems.id, itemKey: knowledgePackItems.itemKey })
        .from(knowledgePackItems)
        .where(and(eq(knowledgePackItems.packRevisionId, revisionId), eq(knowledgePackItems.kind, "document")));
      const packItemIds = new Map(packItemRows.map((row) => [row.itemKey, row.id] as const));

      await transaction.insert(knowledgePackRuns).values({
        id: runId,
        kind: "import",
        status: "awaiting_review",
        ownerAccountId: authorized.accountId,
        packId: pack.id,
        packRevisionId: revisionId,
        artifactId: input.artifactId,
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        progress: { stage: "awaiting_review", processedItems: 0, totalItems: decoded.documents.length },
        createdAt: now,
        updatedAt: now,
      });
      if (decoded.documents.length > 0) {
        await transaction.insert(knowledgePackRunItems).values(
          decoded.documents.map((document) => {
            const mapped = mappings.get(document.key);
            const classified = classifyBrainPackImportItem({
              packRevision: header.packRevision,
              contentSha256: sha256Hex(document.content),
              mapping:
                mapped === undefined || mapped.mapping.localRevisionId === null
                  ? null
                  : {
                      documentId: mapped.document.id,
                      importedPackRevision: mapped.mapping.importedPackRevision,
                      importedContentSha256: mapped.mapping.importedContentSha256,
                      localRevisionId: mapped.mapping.localRevisionId,
                    },
              local:
                mapped === undefined
                  ? null
                  : {
                      documentId: mapped.document.id,
                      currentRevision: mapped.document.currentRevisionNumber,
                      currentRevisionId: localRevisionIds.get(mapped.document.id) ?? "",
                    },
            });
            return {
              id: stableUuid(runId, "brain-pack-run-item", document.key),
              runId,
              packItemId: packItemIds.get(document.key) ?? null,
              itemKey: document.key,
              collectionKey: document.collectionKey,
              title: document.title,
              classification: classified.classification,
              localDocumentId: classified.localDocumentId,
              localRevision: classified.localRevision,
              checkpoint: { indexed: null },
              createdAt: now,
              updatedAt: now,
            };
          }),
        );
      }
      const run = await loadRun(transaction, runId, false);
      if (run === null) throw new Error("The import run was not stored.");
      return { run, replayed: false };
    });
  }

  async reviewImportRun(access: BrainAccessContext, input: BrainPackImportReviewInput, signal: AbortSignal) {
    signal.throwIfAborted();
    requireUuid(input.runId, "runId");
    requireIdempotencyKey(input.idempotencyKey);
    if (input.projectId !== null) requireUuid(input.projectId, "projectId");
    const digest = requestDigest({
      runId: input.runId,
      expectedReviewVersion: input.expectedReviewVersion,
      collections: input.collections,
      items: input.items,
      projectId: input.projectId,
      tags: [...input.tags],
    });
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      await lockIdempotencyKey(transaction, REVIEW_OPERATION, input.idempotencyKey);
      const receipt = await readReceipt(transaction, REVIEW_OPERATION, input.idempotencyKey);
      if (receipt !== null) {
        if (receipt.requestDigest !== digest || receipt.resultEntityId !== input.runId) throw new BrainPackStoreConflictError();
        const replayed = await loadRun(transaction, input.runId, false);
        if (replayed === null || replayed.reviewDigest === null) throw new Error("A review receipt points to a missing run.");
        return { run: replayed, reviewDigest: replayed.reviewDigest };
      }

      const run = await loadRun(transaction, input.runId, true);
      if (run === null || run.kind !== "import") return null;
      if (run.packRevision === null || run.pack === null) {
        throw new Error("The import run has no validated pack to review.");
      }
      if (run.status !== "awaiting_review" && run.status !== "reviewed" && run.status !== "failed") {
        throw new Error(`The import run is ${run.status} and cannot be reviewed.`);
      }
      if (input.expectedReviewVersion !== run.reviewVersion) {
        throw new BrainPackError("PACK_REVIEW_STALE", "The review changed since it was read.", [
          `review version: ${run.reviewVersion}`,
        ]);
      }
      const runItems = await loadRunItems(transaction, input.runId);
      const collectionRows = await transaction
        .select({ itemKey: knowledgePackItems.itemKey })
        .from(knowledgePackItems)
        .where(and(eq(knowledgePackItems.packRevisionId, run.packRevision.id), eq(knowledgePackItems.kind, "collection")));
      const requestedBaseIds = input.collections.flatMap((mapping) =>
        "knowledgeBaseId" in mapping.destination ? [mapping.destination.knowledgeBaseId] : [],
      );
      const baseRows =
        requestedBaseIds.length === 0
          ? []
          : await transaction.select({ id: knowledgeBases.id }).from(knowledgeBases).where(inArray(knowledgeBases.id, requestedBaseIds));
      if (input.projectId !== null) {
        const projectRows = await transaction.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).limit(1);
        if (projectRows.length !== 1) throw new Error("Project was not found.");
      }
      const resolved = resolveBrainPackReview({
        runId: input.runId,
        manifestSha256: run.packRevision.manifestSha256,
        packCollections: collectionRows.map((row) => ({ key: row.itemKey })),
        runItems: runItems.map((item) => ({
          itemKey: item.itemKey,
          collectionKey: item.collectionKey,
          classification: item.classification,
          localDocumentId: item.localDocumentId,
          localRevision: item.localRevision,
        })),
        existingKnowledgeBaseIds: new Set(baseRows.map((row) => row.id)),
        review: { collections: input.collections, items: input.items, projectId: input.projectId, tags: input.tags },
      });

      const now = new Date();
      const decided = new Map(resolved.items.map((item) => [item.itemKey, item] as const));
      for (const item of runItems) {
        const decision = decided.get(item.itemKey);
        await transaction
          .update(knowledgePackRunItems)
          .set({
            decision: decision?.decision ?? null,
            expectedLocalRevision: decision?.expectedLocalRevision ?? null,
            destinationKnowledgeBaseId: decision?.destinationKnowledgeBaseId ?? null,
            result: null,
            resultDocumentId: null,
            resultRevisionId: null,
            sanitizedError: null,
            updatedAt: now,
          })
          .where(eq(knowledgePackRunItems.id, item.id));
      }
      await transaction
        .update(knowledgePackRuns)
        .set({
          status: "reviewed",
          reviewVersion: run.reviewVersion + 1,
          reviewDigest: resolved.reviewDigest,
          frozenSelection: resolved.frozen,
          sanitizedError: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(knowledgePackRuns.id, run.id));
      await writeReceipt(transaction, {
        operation: REVIEW_OPERATION,
        idempotencyKey: input.idempotencyKey,
        requestDigest: digest,
        resultEntityType: "knowledge_pack_run",
        resultEntityId: run.id,
        resultVersionId: null,
      });
      const updated = await loadRun(transaction, run.id, false);
      if (updated === null) throw new Error("The reviewed run disappeared.");
      return { run: updated, reviewDigest: resolved.reviewDigest };
    });
  }

  async queueImportPublication(
    access: BrainAccessContext,
    input: { readonly runId: string; readonly reviewDigest: string; readonly idempotencyKey: string; readonly now: string },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    requireUuid(input.runId, "runId");
    requireHash(input.reviewDigest, "Review digest");
    requireIdempotencyKey(input.idempotencyKey);
    const now = parseInstant(input.now, "now");
    const digest = requestDigest({ runId: input.runId, reviewDigest: input.reviewDigest });
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      await lockIdempotencyKey(transaction, PUBLISH_OPERATION, input.idempotencyKey);
      const receipt = await readReceipt(transaction, PUBLISH_OPERATION, input.idempotencyKey);
      if (receipt !== null) {
        if (receipt.requestDigest !== digest || receipt.resultEntityId !== input.runId) throw new BrainPackStoreConflictError();
        const replayed = await loadRun(transaction, input.runId, false);
        if (replayed === null || receipt.resultVersionId === null) throw new Error("A publish receipt points to a missing run.");
        return { run: replayed, jobId: receipt.resultVersionId };
      }
      const run = await loadRun(transaction, input.runId, true);
      if (run === null || run.kind !== "import") return null;
      if (run.status !== "reviewed") throw new Error(`The import run is ${run.status} and cannot be published.`);
      if (run.reviewDigest !== input.reviewDigest) {
        throw new BrainPackError("PACK_REVIEW_STALE", "The review digest does not match the frozen review.", [
          `review version: ${run.reviewVersion}`,
        ]);
      }
      const jobId = await enqueueImportJob(transaction, run.id, now);
      const total = run.review?.items.filter((item) => brainPackDecisionWrites(item.decision)).length ?? 0;
      await transaction
        .update(knowledgePackRuns)
        .set({
          status: "indexing",
          jobId,
          progress: { stage: "queued", processedItems: 0, totalItems: total },
          sanitizedError: null,
          cancelRequestedAt: null,
          updatedAt: now,
        })
        .where(eq(knowledgePackRuns.id, run.id));
      await writeReceipt(transaction, {
        operation: PUBLISH_OPERATION,
        idempotencyKey: input.idempotencyKey,
        requestDigest: digest,
        resultEntityType: "knowledge_pack_run",
        resultEntityId: run.id,
        resultVersionId: jobId,
      });
      const updated = await loadRun(transaction, run.id, false);
      if (updated === null) throw new Error("The published run disappeared.");
      return { run: updated, jobId };
    });
  }

  async cancelRun(
    access: BrainAccessContext,
    input: { readonly runId: string; readonly idempotencyKey: string; readonly now: string },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    requireUuid(input.runId, "runId");
    requireIdempotencyKey(input.idempotencyKey);
    const now = parseInstant(input.now, "now");
    const digest = requestDigest({ runId: input.runId });
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      await lockIdempotencyKey(transaction, CANCEL_OPERATION, input.idempotencyKey);
      const receipt = await readReceipt(transaction, CANCEL_OPERATION, input.idempotencyKey);
      if (receipt !== null) {
        if (receipt.requestDigest !== digest || receipt.resultEntityId !== input.runId) throw new BrainPackStoreConflictError();
        const replayed = await loadRun(transaction, input.runId, false);
        if (replayed === null) throw new Error("A cancel receipt points to a missing run.");
        return { run: replayed, canceled: replayed.status === "canceled", jobToCancel: null };
      }
      const run = await loadRun(transaction, input.runId, true);
      if (run === null) return null;
      let jobToCancel: string | null = null;
      if (!terminalStatuses.includes(run.status)) {
        const inFlight = run.status === "indexing" || run.status === "publishing";
        await transaction
          .update(knowledgePackRuns)
          .set(
            inFlight
              ? { cancelRequestedAt: run.cancelRequestedAt === null ? now : undefined, updatedAt: now }
              : { status: "canceled", cancelRequestedAt: now, completedAt: now, updatedAt: now },
          )
          .where(eq(knowledgePackRuns.id, run.id));
        if (inFlight) jobToCancel = run.jobId;
      }
      await writeReceipt(transaction, {
        operation: CANCEL_OPERATION,
        idempotencyKey: input.idempotencyKey,
        requestDigest: digest,
        resultEntityType: "knowledge_pack_run",
        resultEntityId: run.id,
        resultVersionId: null,
      });
      const updated = await loadRun(transaction, run.id, false);
      if (updated === null) throw new Error("The canceled run disappeared.");
      return { run: updated, canceled: updated.status === "canceled", jobToCancel };
    });
  }

  async retryRun(
    access: BrainAccessContext,
    input: { readonly runId: string; readonly idempotencyKey: string; readonly now: string },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    requireUuid(input.runId, "runId");
    requireIdempotencyKey(input.idempotencyKey);
    const now = parseInstant(input.now, "now");
    const digest = requestDigest({ runId: input.runId });
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      await lockIdempotencyKey(transaction, RETRY_OPERATION, input.idempotencyKey);
      const receipt = await readReceipt(transaction, RETRY_OPERATION, input.idempotencyKey);
      if (receipt !== null) {
        if (receipt.requestDigest !== digest || receipt.resultEntityId !== input.runId) throw new BrainPackStoreConflictError();
        const replayed = await loadRun(transaction, input.runId, false);
        if (replayed === null || receipt.resultVersionId === null) throw new Error("A retry receipt points to a missing run.");
        return { run: replayed, jobId: receipt.resultVersionId };
      }
      const run = await loadRun(transaction, input.runId, true);
      if (run === null) return null;
      if (run.kind !== "import" || run.status !== "failed" || run.reviewDigest === null || run.review === null) {
        throw new Error("Only import runs that failed while indexing or publishing can be retried.");
      }
      const jobId = await enqueueImportJob(transaction, run.id, now);
      const total = run.review.items.filter((item) => brainPackDecisionWrites(item.decision)).length;
      await transaction
        .update(knowledgePackRuns)
        .set({
          status: "indexing",
          jobId,
          progress: { stage: "queued", processedItems: 0, totalItems: total },
          sanitizedError: null,
          cancelRequestedAt: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(knowledgePackRuns.id, run.id));
      await transaction
        .update(knowledgePackRunItems)
        .set({ result: null, resultDocumentId: null, resultRevisionId: null, sanitizedError: null, updatedAt: now })
        .where(eq(knowledgePackRunItems.runId, run.id));
      await writeReceipt(transaction, {
        operation: RETRY_OPERATION,
        idempotencyKey: input.idempotencyKey,
        requestDigest: digest,
        resultEntityType: "knowledge_pack_run",
        resultEntityId: run.id,
        resultVersionId: jobId,
      });
      const updated = await loadRun(transaction, run.id, false);
      if (updated === null) throw new Error("The retried run disappeared.");
      return { run: updated, jobId };
    });
  }

  async loadImportWork(runId: string, signal: AbortSignal): Promise<BrainPackImportWork | null> {
    signal.throwIfAborted();
    requireUuid(runId, "runId");
    return this.database.transaction(async (transaction) => {
      const run = await loadRun(transaction, runId, false);
      if (run === null || run.kind !== "import") return null;
      const rows = await transaction
        .select({ item: knowledgePackRunItems, packItem: knowledgePackItems })
        .from(knowledgePackRunItems)
        .innerJoin(knowledgePackItems, eq(knowledgePackItems.id, knowledgePackRunItems.packItemId))
        .where(eq(knowledgePackRunItems.runId, runId))
        .orderBy(asc(knowledgePackRunItems.itemKey));
      const items: BrainPackImportWorkItem[] = rows
        .filter((row) => brainPackDecisionWrites(row.item.decision))
        .map((row) => ({
          id: row.item.id,
          itemKey: row.item.itemKey,
          decision: row.item.decision as BrainPackItemDecision,
          content: packItemContent(row.packItem),
          contentSha256: row.packItem.contentSha256 ?? "",
          checkpoint: decodeCheckpoint(row.item.checkpoint),
        }));
      return { run, items };
    });
  }

  async stageItemChunks(
    runItemId: string,
    input: { readonly contentSha256: string; readonly recipeVersion: string; readonly chunks: readonly BrainPackStagedChunk[] },
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    requireUuid(runItemId, "runItemId");
    requireHash(input.contentSha256, "Item content hash");
    if (input.chunks.length < 1 || input.chunks.length > brainPackLimits.chunksPerRevision) {
      throw new Error(`A staged item must hold between 1 and ${brainPackLimits.chunksPerRevision} chunks.`);
    }
    let spaceId: string | null = null;
    for (const [index, chunk] of input.chunks.entries()) {
      if (chunk.position !== index) throw new Error("Staged chunk positions must be contiguous and zero-based.");
      if (chunk.content.length < 1 || chunk.content.length > 10_000) {
        throw new Error("Staged chunks must contain between 1 and 10000 characters.");
      }
      requireHash(chunk.embedding.contentHash, "Chunk embedding content hash");
      if (chunk.embedding.contentHash !== knowledgeChunkEmbeddingRecipe(chunk.content).contentHash) {
        throw new Error("A chunk embedding content hash does not match its chunk.");
      }
      spaceId ??= chunk.embedding.spaceId;
      if (chunk.embedding.spaceId !== spaceId) throw new Error("All staged chunks must use the same embedding space.");
      if (chunk.embedding.vector.some((value) => !Number.isFinite(value))) {
        throw new Error("A staged embedding has invalid values.");
      }
    }
    requireUuid(spaceId!, "spaceId");
    await this.database.transaction(async (transaction) => {
      await workerTimeouts(transaction);
      const items = await transaction
        .select({ id: knowledgePackRunItems.id })
        .from(knowledgePackRunItems)
        .where(eq(knowledgePackRunItems.id, runItemId))
        .limit(1)
        .for("update");
      if (items.length !== 1) throw new Error("The run item does not exist.");
      await transaction.delete(knowledgePackRunChunks).where(eq(knowledgePackRunChunks.runItemId, runItemId));
      await transaction.insert(knowledgePackRunChunks).values(
        input.chunks.map((chunk) => ({
          runItemId,
          position: chunk.position,
          content: chunk.content,
          contentHash: chunk.embedding.contentHash,
          spaceId: spaceId!,
          recipeVersion: input.recipeVersion,
          embedding: [...chunk.embedding.vector],
        })),
      );
      const checkpoint: BrainPackItemCheckpoint = {
        indexed: { spaceId: spaceId!, contentSha256: input.contentSha256, chunkCount: input.chunks.length },
      };
      await transaction
        .update(knowledgePackRunItems)
        .set({ checkpoint, updatedAt: new Date() })
        .where(eq(knowledgePackRunItems.id, runItemId));
    });
  }

  async updateRunProgress(runId: string, progress: BrainPackRunProgress, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    requireUuid(runId, "runId");
    await this.database
      .update(knowledgePackRuns)
      .set({ progress: { ...progress }, updatedAt: new Date() })
      .where(and(eq(knowledgePackRuns.id, runId), inArray(knowledgePackRuns.status, ["indexing", "publishing"])));
  }

  async markRunFailed(runId: string, input: { readonly sanitizedError: string }, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    requireUuid(runId, "runId");
    const now = new Date();
    await this.database
      .update(knowledgePackRuns)
      .set({ status: "failed", sanitizedError: input.sanitizedError.slice(0, 500), completedAt: now, updatedAt: now })
      .where(and(eq(knowledgePackRuns.id, runId), inArray(knowledgePackRuns.status, ["indexing", "publishing"])));
  }

  async markRunCanceled(runId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    requireUuid(runId, "runId");
    const now = new Date();
    await this.database
      .update(knowledgePackRuns)
      .set({ status: "canceled", cancelRequestedAt: sql`coalesce(${knowledgePackRuns.cancelRequestedAt}, ${now})`, completedAt: now, updatedAt: now })
      .where(and(eq(knowledgePackRuns.id, runId), inArray(knowledgePackRuns.status, ["indexing", "publishing"])));
  }

  async commitImport(
    runId: string,
    input: { readonly now: string; readonly fence: BrainPackPublicationFence | null },
    signal: AbortSignal,
  ): Promise<BrainPackImportReceipt | null> {
    signal.throwIfAborted();
    requireUuid(runId, "runId");
    const now = parseInstant(input.now, "now");
    if (input.fence !== null) {
      requireUuid(input.fence.jobId, "fence.jobId");
      requireUuid(input.fence.fencingToken, "fence.fencingToken");
    }
    return this.database.transaction(async (transaction) => {
      await workerTimeouts(transaction);
      const run = await loadRun(transaction, runId, true);
      if (run === null || run.kind !== "import") throw new Error("The import run does not exist.");
      if (run.status === "completed") return run.receipt as BrainPackImportReceipt;
      if (run.status !== "indexing" && run.status !== "publishing") {
        throw new Error(`The import run is ${run.status} and cannot be published.`);
      }
      if (run.cancelRequestedAt !== null) {
        await transaction
          .update(knowledgePackRuns)
          .set({ status: "canceled", completedAt: now, updatedAt: now })
          .where(eq(knowledgePackRuns.id, runId));
        return null;
      }
      if (input.fence !== null) {
        const jobs = await transaction
          .select({ id: automationJobs.id })
          .from(automationJobs)
          .where(
            and(
              eq(automationJobs.id, input.fence.jobId),
              eq(automationJobs.status, "running"),
              eq(automationJobs.fencingToken, input.fence.fencingToken),
              gt(automationJobs.leaseExpiresAt, now),
            ),
          )
          .limit(1)
          .for("share");
        if (jobs.length !== 1) throw new Error("The worker no longer holds the lease on the import job; nothing was published.");
      }
      if (run.pack === null || run.packRevision === null || run.review === null) {
        throw new Error("The import run has no frozen review to publish.");
      }
      await transaction
        .update(knowledgePackRuns)
        .set({ status: "publishing", progress: { stage: "publishing", processedItems: 0, totalItems: 0 }, updatedAt: now })
        .where(eq(knowledgePackRuns.id, runId));

      const spaceRows = await transaction
        .select({ id: embeddingSpaces.id, dimensions: embeddingSpaces.dimensions })
        .from(embeddingSpaces)
        .where(
          and(
            eq(embeddingSpaces.entityType, "knowledge_chunk"),
            eq(embeddingSpaces.status, "active"),
            eq(embeddingSpaces.recipeVersion, KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION),
          ),
        )
        .limit(1)
        .for("share", { of: embeddingSpaces });
      const space = spaceRows[0];
      if (space === undefined) throw new Error("No active knowledge chunk embedding space was found.");

      const actor = importActor(run.ownerAccountId);
      const destinations = new Map<string, string>();
      for (const mapping of run.review.collections) {
        if ("knowledgeBaseId" in mapping.destination) {
          const rows = await transaction
            .select({ id: knowledgeBases.id })
            .from(knowledgeBases)
            .where(eq(knowledgeBases.id, mapping.destination.knowledgeBaseId))
            .limit(1)
            .for("share");
          if (rows.length !== 1) throw new Error(`Knowledge base for collection ${mapping.collectionKey} was not found.`);
          destinations.set(mapping.collectionKey, mapping.destination.knowledgeBaseId);
        } else {
          const id = stableUuid(runId, "brain-pack-knowledge-base", mapping.collectionKey);
          await transaction
            .insert(knowledgeBases)
            .values({
              id,
              name: mapping.destination.createKnowledgeBase.name,
              description: mapping.destination.createKnowledgeBase.description,
              ...actor,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: knowledgeBases.id });
          destinations.set(mapping.collectionKey, id);
        }
      }

      const rows = await transaction
        .select({ item: knowledgePackRunItems, packItem: knowledgePackItems })
        .from(knowledgePackRunItems)
        .leftJoin(knowledgePackItems, eq(knowledgePackItems.id, knowledgePackRunItems.packItemId))
        .where(eq(knowledgePackRunItems.runId, runId))
        .orderBy(asc(knowledgePackRunItems.itemKey));
      const origin = (itemKey: string, authors: BrainPackOriginAttribution["authors"]): BrainPackOriginAttribution => ({
        publisher: { ...run.pack!.publisher },
        packId: run.pack!.externalPackId,
        packRevision: run.packRevision!.number,
        packTitle: run.packRevision!.title,
        itemKey,
        authors,
      });
      const created: BrainPackImportReceiptItem[] = [];
      const updated: BrainPackImportReceiptItem[] = [];
      const skipped: BrainPackImportReceiptSkip[] = [];
      const excluded: BrainPackImportReceiptSkip[] = [];
      const finishItem = async (
        item: RunItemRow,
        result: RunItemRow["result"],
        documentId: string | null,
        revisionId: string | null,
      ) => {
        await transaction
          .update(knowledgePackRunItems)
          .set({ result, resultDocumentId: documentId, resultRevisionId: revisionId, sanitizedError: null, updatedAt: now })
          .where(eq(knowledgePackRunItems.id, item.id));
      };

      for (const { item, packItem } of rows) {
        signal.throwIfAborted();
        if (item.decision === null) {
          excluded.push({ itemKey: item.itemKey, reason: "Not selected in the review." });
          await finishItem(item, "excluded", null, null);
          continue;
        }
        if (item.decision === "skip") {
          skipped.push({ itemKey: item.itemKey, reason: "Skipped by the review." });
          await finishItem(item, "skipped", null, null);
          continue;
        }
        if (item.decision === "keep_local") {
          skipped.push({ itemKey: item.itemKey, reason: "The local revision was kept." });
          await finishItem(item, "skipped", item.localDocumentId, null);
          continue;
        }
        if (packItem === null || packItem.contentSha256 === null) {
          throw new Error(`Pack item ${item.itemKey} is missing from the validated revision.`);
        }
        const checkpoint = decodeCheckpoint(item.checkpoint);
        if (checkpoint.indexed === null || checkpoint.indexed.contentSha256 !== packItem.contentSha256) {
          throw new Error(`Item ${item.itemKey} was not indexed for this content.`);
        }
        if (checkpoint.indexed.spaceId !== space.id) {
          throw new Error(`Item ${item.itemKey} was indexed for an embedding space that is no longer active.`);
        }
        const staged = await transaction
          .select()
          .from(knowledgePackRunChunks)
          .where(eq(knowledgePackRunChunks.runItemId, item.id))
          .orderBy(asc(knowledgePackRunChunks.position));
        if (staged.length !== checkpoint.indexed.chunkCount || staged.length === 0) {
          throw new Error(`Item ${item.itemKey} has incomplete staged chunks.`);
        }
        for (const [index, chunk] of staged.entries()) {
          if (chunk.position !== index || chunk.spaceId !== space.id || chunk.embedding.length !== space.dimensions) {
            throw new Error(`Item ${item.itemKey} has invalid staged chunks.`);
          }
        }
        const content = packItemContent(packItem);
        const payload = isRecord(packItem.payload) ? packItem.payload : {};
        const packTags = Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string") : [];
        const tags = [...new Set([...packTags, ...run.review.tags])].slice(0, MAX_DOCUMENT_TAGS);
        const sourceUri = typeof payload.sourceUri === "string" ? payload.sourceUri : null;
        const attribution = isRecord(payload.attribution) ? payload.attribution : {};
        const authors = Array.isArray(attribution.authors)
          ? attribution.authors.flatMap((author) =>
              isRecord(author) && typeof author.name === "string"
                ? [{ name: author.name, uri: typeof author.uri === "string" ? author.uri : null }]
                : [],
            )
          : [];

        let documentId: string;
        let revisionNumber: number;
        if (item.decision === "update") {
          if (item.localDocumentId === null || item.expectedLocalRevision === null) {
            throw new Error(`Item ${item.itemKey} cannot update without a local document.`);
          }
          const locked = await transaction
            .select()
            .from(knowledgeDocuments)
            .where(eq(knowledgeDocuments.id, item.localDocumentId))
            .limit(1)
            .for("update", { of: knowledgeDocuments });
          const current = locked[0];
          if (current === undefined || current.currentRevisionNumber !== item.expectedLocalRevision) {
            throw new BrainPackError("PACK_REVISION_CONFLICT", "A local document changed after the review; review the import again.", [
              `${item.itemKey}: expected revision ${item.expectedLocalRevision}, found ${current?.currentRevisionNumber ?? "none"}`,
            ]);
          }
          const mappingRows = await transaction
            .select()
            .from(knowledgePackMappings)
            .where(and(eq(knowledgePackMappings.packId, run.pack.id), eq(knowledgePackMappings.itemKey, item.itemKey)))
            .limit(1)
            .for("update");
          const mapping = mappingRows[0];
          if (mapping !== undefined && mapping.importedPackRevision > run.packRevision.number) {
            skipped.push({ itemKey: item.itemKey, reason: "A newer pack revision was already imported." });
            await finishItem(item, "skipped", current.id, null);
            continue;
          }
          if (mapping !== undefined && mapping.importedContentSha256 === packItem.contentSha256) {
            skipped.push({ itemKey: item.itemKey, reason: "The imported text is unchanged." });
            await finishItem(item, "skipped", current.id, null);
            continue;
          }
          documentId = current.id;
          revisionNumber = current.currentRevisionNumber + 1;
          await transaction
            .update(knowledgeDocuments)
            .set({
              title: packItem.title,
              sourceUri,
              tags,
              projectId: run.review.projectId ?? current.projectId,
              currentRevisionNumber: revisionNumber,
              updatedAt: now,
            })
            .where(eq(knowledgeDocuments.id, documentId));
        } else {
          const destination = destinations.get(item.collectionKey);
          if (destination === undefined) throw new Error(`Collection ${item.collectionKey} has no destination.`);
          documentId = stableUuid(runId, "brain-pack-document", item.itemKey);
          revisionNumber = 1;
          const inserted = await transaction
            .insert(knowledgeDocuments)
            .values({
              id: documentId,
              knowledgeBaseId: destination,
              title: packItem.title,
              sourceUri,
              tags,
              projectId: run.review.projectId,
              currentRevisionNumber: 1,
              ...actor,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: knowledgeDocuments.id })
            .returning({ id: knowledgeDocuments.id });
          if (inserted.length !== 1) throw new Error(`Item ${item.itemKey} was already published by another run.`);
        }

        const revisionId = stableUuid(runId, "brain-pack-revision", item.itemKey, String(revisionNumber));
        await transaction.insert(knowledgeDocumentRevisions).values({
          id: revisionId,
          documentId,
          revisionNumber,
          contentHash: packItem.contentSha256,
          chunkCount: staged.length,
          ...actor,
          createdAt: now,
        });
        const chunkRows = staged.map((chunk) => ({
          id: stableUuid(revisionId, "knowledge-chunk", String(chunk.position)),
          revisionId,
          position: chunk.position,
          content: chunk.content,
          contentHash: chunk.contentHash,
          createdAt: now,
        }));
        await transaction.insert(knowledgeChunks).values(chunkRows);
        await transaction.insert(knowledgeChunkEmbeddings).values(
          chunkRows.map((chunkRow, index) => ({
            id: stableUuid(chunkRow.id, "knowledge-chunk-embedding", space.id),
            chunkId: chunkRow.id,
            spaceId: space.id,
            contentHash: chunkRow.contentHash,
            recipeVersion: staged[index]!.recipeVersion,
            embedding: staged[index]!.embedding,
            createdAt: now,
          })),
        );
        await transaction.insert(knowledgeRevisionContents).values({
          revisionId,
          content,
          representation: "canonical",
          contentSha256: packItem.contentSha256,
          byteSize: Buffer.byteLength(content, "utf8"),
          createdAt: now,
        });
        await transaction.insert(knowledgeRevisionOrigins).values({
          revisionId,
          packRevisionId: run.packRevision.id,
          packItemId: packItem.id,
          attribution: origin(item.itemKey, authors),
          importedByAccountId: run.ownerAccountId,
          createdAt: now,
        });
        if (item.decision !== "separate_copy") {
          await transaction
            .insert(knowledgePackMappings)
            .values({
              packId: run.pack.id,
              itemKey: item.itemKey,
              documentId,
              importedPackRevision: run.packRevision.number,
              importedContentSha256: packItem.contentSha256,
              localRevisionId: revisionId,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [knowledgePackMappings.packId, knowledgePackMappings.itemKey],
              set: {
                documentId,
                importedPackRevision: run.packRevision.number,
                importedContentSha256: packItem.contentSha256,
                localRevisionId: revisionId,
                updatedAt: now,
              },
            });
        }
        const receiptItem = { itemKey: item.itemKey, documentId, revisionId };
        if (item.decision === "update") updated.push(receiptItem);
        else created.push(receiptItem);
        await finishItem(item, item.decision === "update" ? "updated" : "created", documentId, revisionId);
      }

      const receipt: BrainPackImportReceipt = {
        runId,
        packId: run.pack.externalPackId,
        packRevision: run.packRevision.number,
        publishedAt: now.toISOString(),
        created,
        updated,
        skipped,
        excluded,
      };
      await transaction
        .delete(knowledgePackRunChunks)
        .where(
          inArray(
            knowledgePackRunChunks.runItemId,
            rows.map((row) => row.item.id),
          ),
        );
      await transaction
        .update(knowledgePackRuns)
        .set({
          status: "completed",
          receipt,
          progress: { stage: "published", processedItems: created.length + updated.length, totalItems: created.length + updated.length },
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(knowledgePackRuns.id, runId));
      return receipt;
    });
  }
}

async function assertImportCapacity(transaction: SecondBrainTransaction, ownerAccountId: string): Promise<void> {
  const active = await transaction
    .select({ ownerAccountId: knowledgePackRuns.ownerAccountId })
    .from(knowledgePackRuns)
    .where(and(eq(knowledgePackRuns.kind, "import"), inArray(knowledgePackRuns.status, ["uploaded", "validating", "awaiting_review", "reviewed", "indexing", "publishing"])));
  const mine = active.filter((row) => row.ownerAccountId === ownerAccountId).length;
  if (mine >= brainPackLimits.activeImportRunsPerAccount) {
    throw new BrainPackError("PACK_LIMIT_EXCEEDED", "Finish or cancel your active import before starting another.", [
      `active imports for this account: ${mine}`,
    ]);
  }
  if (active.length >= brainPackLimits.activeImportRunsPerDeployment) {
    throw new BrainPackError("PACK_LIMIT_EXCEEDED", "This brain already has as many active imports as it allows.", [
      `active imports: ${active.length}`,
    ]);
  }
}

function importItems(pack: BrainPack): BrainPackExportRecordInput["revision"]["items"] {
  return [
    ...pack.collections.map((collection) => ({
      kind: "collection" as const,
      itemKey: collection.key,
      collectionKey: null,
      title: collection.name,
      representation: null,
      contentSha256: null,
      byteSize: null,
      characterCount: null,
      payload: { name: collection.name, description: collection.description, documentKeys: collection.documentKeys },
    })),
    ...pack.documents.map((document) => ({
      kind: "document" as const,
      itemKey: document.key,
      collectionKey: document.collectionKey,
      title: document.title,
      representation: document.representation,
      contentSha256: sha256Hex(document.content),
      byteSize: Buffer.byteLength(document.content, "utf8"),
      characterCount: document.content.length,
      payload: {
        tags: document.tags,
        sourceUri: document.sourceUri,
        attribution: document.attribution,
        references: document.references,
        excerpt: excerptOf(document.content),
        content: document.content,
      },
    })),
  ];
}

async function insertRevision(
  transaction: SecondBrainTransaction,
  packId: string,
  revision: BrainPackExportRecordInput["revision"],
  imported: boolean,
): Promise<string> {
  const inserted = await transaction
    .insert(knowledgePackRevisions)
    .values({
      packId,
      packRevision: revision.packRevision,
      formatVersion: revision.manifest.formatVersion,
      manifest: revision.manifest,
      manifestSha256: revision.manifestSha256,
      publisherDisplayName: revision.publisher.displayName,
      createdAt: new Date(),
    })
    .returning({ id: knowledgePackRevisions.id });
  const row = inserted[0];
  if (row === undefined) throw new Error("The pack revision was not stored.");
  if (revision.items.length > 0) {
    await transaction.insert(knowledgePackItems).values(
      revision.items.map((item) => ({
        packRevisionId: row.id,
        kind: item.kind,
        itemKey: item.itemKey,
        collectionKey: item.collectionKey,
        title: item.title,
        representation: item.representation,
        contentSha256: item.contentSha256,
        byteSize: item.byteSize,
        characterCount: item.characterCount,
        payload: imported ? item.payload : { ...item.payload },
      })),
    );
  }
  return row.id;
}
