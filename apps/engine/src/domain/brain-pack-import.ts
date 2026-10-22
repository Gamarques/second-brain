import {
  BrainPackError,
  brainPackLimits,
  brainPackReviewDigest,
  type BrainPackCollectionMapping,
  type BrainPackImportReceipt,
  type BrainPackItemClassification,
  type BrainPackItemDecision,
  type BrainPackItemReview,
} from "./brain-pack.js";
import type {
  BrainPackFrozenReview,
  BrainPackPublicationFence,
  BrainPackStore,
} from "./brain-pack-store.js";
import type { BrainAccessContext, EmbeddingProvider } from "./core.js";
import { KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION } from "./embedding-recipes.js";
import {
  activeKnowledgeSpace,
  embedChunksInBatches,
  splitKnowledgeDocument,
} from "./knowledge-indexing.js";
import type { BrainAccessStore, EmbeddingSpaceStore } from "./stores.js";

/*
 * The import side of Brain Packs: how a validated item compares with the
 * local brain, what a review may decide, and the background service that
 * indexes and publishes a reviewed run.
 */

export interface BrainPackImportMappingState {
  readonly documentId: string;
  readonly importedPackRevision: number;
  readonly importedContentSha256: string;
  readonly localRevisionId: string;
}

export interface BrainPackImportLocalState {
  readonly documentId: string;
  readonly currentRevision: number;
  readonly currentRevisionId: string;
}

export interface BrainPackImportClassification {
  readonly classification: BrainPackItemClassification;
  readonly localDocumentId: string | null;
  readonly localRevision: number | null;
}

/**
 * Compares one pack document with what this brain already imported for the
 * same item key. A mapping that points at a newer pack revision cannot be
 * rolled back; identical text is unchanged; a local edit since the last
 * import makes a changed item conflicting rather than a silent update.
 */
export function classifyBrainPackImportItem(input: {
  readonly packRevision: number;
  readonly contentSha256: string;
  readonly mapping: BrainPackImportMappingState | null;
  readonly local: BrainPackImportLocalState | null;
}): BrainPackImportClassification {
  const { mapping, local } = input;
  if (mapping === null || local === null) {
    return { classification: "new", localDocumentId: null, localRevision: null };
  }
  const known = { localDocumentId: local.documentId, localRevision: local.currentRevision };
  if (input.packRevision < mapping.importedPackRevision) {
    return { classification: "invalid", ...known };
  }
  if (input.contentSha256 === mapping.importedContentSha256) {
    return { classification: "unchanged", ...known };
  }
  if (local.currentRevisionId === mapping.localRevisionId) {
    return { classification: "updated", ...known };
  }
  return { classification: "conflicting", ...known };
}

const allowedDecisions: Readonly<Record<BrainPackItemClassification, readonly BrainPackItemDecision[]>> = {
  new: ["create", "skip"],
  updated: ["update", "keep_local", "separate_copy", "skip"],
  conflicting: ["update", "keep_local", "separate_copy", "skip"],
  unchanged: ["skip", "separate_copy"],
  invalid: ["skip"],
};

/** Decisions that write a document and therefore need a destination and indexing. */
export const brainPackWritingDecisions: readonly BrainPackItemDecision[] = ["create", "update", "separate_copy"];

export function brainPackDecisionWrites(decision: BrainPackItemDecision | null): boolean {
  return decision !== null && brainPackWritingDecisions.includes(decision);
}

export interface BrainPackReviewRunItem {
  readonly itemKey: string;
  readonly collectionKey: string;
  readonly classification: BrainPackItemClassification;
  readonly localDocumentId: string | null;
  readonly localRevision: number | null;
}

export interface BrainPackReviewRequest {
  readonly collections: readonly BrainPackCollectionMapping[];
  readonly items: readonly BrainPackItemReview[];
  readonly projectId: string | null;
  readonly tags: readonly string[];
}

export interface BrainPackResolvedReviewItem {
  readonly itemKey: string;
  readonly decision: BrainPackItemDecision;
  readonly expectedLocalRevision: number | null;
  readonly destinationKnowledgeBaseId: string | null;
}

export interface BrainPackResolvedReview {
  readonly reviewDigest: string;
  readonly frozen: BrainPackFrozenReview;
  readonly items: readonly BrainPackResolvedReviewItem[];
  readonly excludedItemKeys: readonly string[];
}

function rejectReview(message: string): never {
  throw new Error(`Invalid Brain Pack review: ${message}`);
}

/**
 * Validates a review against the run's items and freezes it. Unlisted items
 * are excluded; a decision must fit the item's classification; decisions that
 * touch a local document must name the revision the reviewer saw.
 */
export function resolveBrainPackReview(input: {
  readonly runId: string;
  readonly manifestSha256: string;
  readonly packCollections: readonly { readonly key: string }[];
  readonly runItems: readonly BrainPackReviewRunItem[];
  readonly existingKnowledgeBaseIds: ReadonlySet<string>;
  readonly review: BrainPackReviewRequest;
}): BrainPackResolvedReview {
  const packCollectionKeys = new Set(input.packCollections.map((collection) => collection.key));
  const destinations = new Map<string, string | null>();
  for (const mapping of input.review.collections) {
    if (!packCollectionKeys.has(mapping.collectionKey)) {
      rejectReview(`the pack has no collection "${mapping.collectionKey}".`);
    }
    if (destinations.has(mapping.collectionKey)) {
      rejectReview(`collection "${mapping.collectionKey}" is mapped twice.`);
    }
    if ("knowledgeBaseId" in mapping.destination) {
      if (!input.existingKnowledgeBaseIds.has(mapping.destination.knowledgeBaseId)) {
        rejectReview(`collection "${mapping.collectionKey}" targets an unknown knowledge base.`);
      }
      destinations.set(mapping.collectionKey, mapping.destination.knowledgeBaseId);
    } else {
      destinations.set(mapping.collectionKey, null);
    }
  }

  const runItems = new Map(input.runItems.map((item) => [item.itemKey, item] as const));
  const seen = new Set<string>();
  const items: BrainPackResolvedReviewItem[] = [];
  const conflicts: string[] = [];
  for (const review of input.review.items) {
    const item = runItems.get(review.itemKey);
    if (item === undefined) rejectReview(`the run has no item "${review.itemKey}".`);
    if (seen.has(review.itemKey)) rejectReview(`item "${review.itemKey}" is decided twice.`);
    seen.add(review.itemKey);
    if (!allowedDecisions[item.classification].includes(review.decision)) {
      rejectReview(`item "${review.itemKey}" is ${item.classification} and cannot be ${review.decision}.`);
    }
    const touchesLocal =
      review.decision === "update" || review.decision === "keep_local" || review.decision === "separate_copy";
    if (touchesLocal) {
      if (item.localDocumentId === null || item.localRevision === null) {
        rejectReview(`item "${review.itemKey}" has no local document to ${review.decision}.`);
      }
      if (review.expectedLocalRevision !== item.localRevision) {
        conflicts.push(`${review.itemKey}: expected revision ${review.expectedLocalRevision}, found ${item.localRevision}`);
      }
    } else if (review.expectedLocalRevision !== null) {
      rejectReview(`item "${review.itemKey}" names a local revision but ${review.decision} does not use one.`);
    }
    if (brainPackDecisionWrites(review.decision) && !destinations.has(item.collectionKey)) {
      rejectReview(`collection "${item.collectionKey}" has no destination but item "${review.itemKey}" is written.`);
    }
    items.push({
      itemKey: review.itemKey,
      decision: review.decision,
      expectedLocalRevision: touchesLocal ? review.expectedLocalRevision : null,
      destinationKnowledgeBaseId: brainPackDecisionWrites(review.decision)
        ? (destinations.get(item.collectionKey) ?? null)
        : null,
    });
  }
  if (conflicts.length > 0) {
    throw new BrainPackError(
      "PACK_REVISION_CONFLICT",
      "A local document changed since it was reviewed; review the import again.",
      conflicts,
    );
  }

  const frozen: BrainPackFrozenReview = {
    collections: input.review.collections.map((mapping) => ({
      collectionKey: mapping.collectionKey,
      destination: mapping.destination,
    })),
    items: items.map((item) => ({
      itemKey: item.itemKey,
      decision: item.decision,
      expectedLocalRevision: item.expectedLocalRevision,
    })),
    projectId: input.review.projectId,
    tags: [...input.review.tags],
  };
  return {
    reviewDigest: brainPackReviewDigest({
      runId: input.runId,
      manifestSha256: input.manifestSha256,
      collections: frozen.collections,
      items: frozen.items,
    }),
    frozen,
    items,
    excludedItemKeys: input.runItems.map((item) => item.itemKey).filter((key) => !seen.has(key)),
  };
}

/** Sanitized error text a run can carry: a typed code where there is one, never a stack. */
export function brainPackRunErrorText(error: unknown): string {
  const text =
    error instanceof BrainPackError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}`
        : "The import failed.";
  const flattened = text.replace(/\s+/gu, " ").trim();
  return flattened.length > 500 ? `${flattened.slice(0, 497)}...` : flattened === "" ? "The import failed." : flattened;
}

/** The slice of the pack store the background stages need. */
export type BrainPackImportStore = Pick<
  BrainPackStore,
  "loadImportWork" | "stageItemChunks" | "updateRunProgress" | "markRunFailed" | "markRunCanceled" | "commitImport"
>;

export interface BrainPackImportServiceDependencies {
  readonly store: BrainPackImportStore;
  readonly access: BrainAccessStore;
  readonly embeddingSpaces: EmbeddingSpaceStore;
  readonly embeddings: EmbeddingProvider;
  readonly now?: () => string;
}

export interface BrainPackImportIndexOptions {
  readonly signal: AbortSignal;
  /** Throws once the job was asked to stop; called at every item boundary. */
  readonly checkCancelled: () => Promise<void>;
}

export interface BrainPackImportPublishOptions {
  readonly signal: AbortSignal;
  readonly fence?: BrainPackPublicationFence | null;
}

export interface BrainPackImportService {
  /** Splits and embeds every item the review writes, staging chunks per item so a retry resumes. */
  index(runId: string, options: BrainPackImportIndexOptions): Promise<void>;
  /** Publishes the staged import in one transaction; `null` when cancellation arrived first. */
  publish(runId: string, options: BrainPackImportPublishOptions): Promise<BrainPackImportReceipt | null>;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AutomationJobCanceledError";
}

function workerRequestId(runId: string): string {
  return `brain-pack-import:${runId}`;
}

/**
 * The background half of an import. Both stages re-resolve the initiating
 * account's role, so a revoked administrator cannot publish through a job
 * queued while they still had it.
 */
export function createBrainPackImportService(
  dependencies: BrainPackImportServiceDependencies,
): BrainPackImportService {
  const { store } = dependencies;
  const now = dependencies.now ?? (() => new Date().toISOString());

  async function resolveOwner(ownerAccountId: string, runId: string, signal: AbortSignal): Promise<BrainAccessContext> {
    return dependencies.access.resolveAccess(
      {
        principal: { id: ownerAccountId },
        requiredRole: "admin",
        source: "direct",
        requestId: workerRequestId(runId),
        correlationId: null,
      },
      signal,
    );
  }

  async function guarded<T>(runId: string, signal: AbortSignal, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      if (isCancellation(error)) {
        await store.markRunCanceled(runId, signal);
        throw error;
      }
      await store.markRunFailed(runId, { sanitizedError: brainPackRunErrorText(error) }, signal);
      throw error;
    }
  }

  return {
    async index(runId, options) {
      const { signal } = options;
      signal.throwIfAborted();
      const work = await store.loadImportWork(runId, signal);
      if (work === null) throw new Error("The import run does not exist.");
      const { run } = work;
      if (run.status === "completed" || run.status === "canceled" || run.status === "publishing") return;
      if (run.status !== "indexing") throw new Error(`The import run is ${run.status}; nothing to index.`);
      if (run.cancelRequestedAt !== null) {
        await store.markRunCanceled(runId, signal);
        return;
      }

      await guarded(runId, signal, async () => {
        const access = await resolveOwner(run.ownerAccountId, runId, signal);
        const space = await activeKnowledgeSpace(access, dependencies.embeddingSpaces, dependencies.embeddings, signal);
        const items = [...work.items].sort((left, right) => left.itemKey.localeCompare(right.itemKey));
        let processed = 0;
        for (const item of items) {
          await options.checkCancelled();
          const indexed = item.checkpoint.indexed;
          const reusable =
            indexed !== null && indexed.spaceId === space.id && indexed.contentSha256 === item.contentSha256;
          if (!reusable) {
            const chunks = splitKnowledgeDocument(item.content);
            if (chunks.length > brainPackLimits.chunksPerRevision) {
              throw new BrainPackError("PACK_LIMIT_EXCEEDED", "A document splits into more chunks than a revision may hold.", [
                `${item.itemKey}: ${chunks.length} chunks`,
              ]);
            }
            const embeddings = await embedChunksInBatches(dependencies.embeddings, space, chunks, {
              signal,
              batchSize: brainPackLimits.embeddingBatchChunks,
            });
            await store.stageItemChunks(
              item.id,
              {
                contentSha256: item.contentSha256,
                recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
                chunks: chunks.map((content, position) => ({ position, content, embedding: embeddings[position]! })),
              },
              signal,
            );
          }
          processed += 1;
          await store.updateRunProgress(runId, { stage: "indexing", processedItems: processed, totalItems: items.length }, signal);
        }
        await store.updateRunProgress(runId, { stage: "indexed", processedItems: processed, totalItems: items.length }, signal);
      });
    },

    async publish(runId, options) {
      const { signal } = options;
      signal.throwIfAborted();
      const work = await store.loadImportWork(runId, signal);
      if (work === null) throw new Error("The import run does not exist.");
      const { run } = work;
      if (run.status === "completed") return run.receipt as BrainPackImportReceipt | null;
      if (run.status === "canceled") return null;
      if (run.status !== "indexing" && run.status !== "publishing") {
        throw new Error(`The import run is ${run.status}; nothing to publish.`);
      }
      if (run.cancelRequestedAt !== null) {
        await store.markRunCanceled(runId, signal);
        return null;
      }
      const pending = work.items.filter((item) => item.checkpoint.indexed === null);
      if (pending.length > 0) {
        throw new Error(`The import run still has ${pending.length} unindexed items.`);
      }

      return guarded(runId, signal, async () => {
        await resolveOwner(run.ownerAccountId, runId, signal);
        return store.commitImport(runId, { now: now(), fence: options.fence ?? null }, signal);
      });
    },
  };
}
