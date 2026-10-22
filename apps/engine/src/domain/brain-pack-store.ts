import type {
  BrainPack,
  BrainPackCollectionMapping,
  BrainPackRepresentation,
  BrainPackErrorCode,
  BrainPackExportReceipt,
  BrainPackImportReceipt,
  BrainPackItemClassification,
  BrainPackItemDecision,
  BrainPackItemReview,
  BrainPackManifest,
  BrainPackPublisher,
  BrainPackRunItemResult,
  BrainPackRunKind,
  BrainPackRunStatus,
} from "./brain-pack.js";
import type { BrainAccessContext, ContentEmbedding } from "./core.js";

/*
 * Persistence contract of Brain Pack runs. The capabilities and the import
 * service talk to this interface; the Drizzle implementation lives in
 * `database/stores/brain-pack-store.ts`.
 */

export type BrainPackContentRepresentation = BrainPackRepresentation;

/** Who published the pack a revision came from; stored with the origin link and surfaced on reads. */
export interface BrainPackOriginAttribution {
  readonly publisher: BrainPackPublisher;
  readonly packId: string;
  readonly packRevision: number;
  readonly packTitle: string;
  readonly itemKey: string;
  readonly authors: readonly { readonly name: string; readonly uri: string | null }[];
}

export interface BrainPackRunProgress {
  readonly stage: string;
  readonly processedItems: number;
  readonly totalItems: number;
}

/** What a review froze: the digest publication presents is computed from these. */
export interface BrainPackFrozenReview {
  readonly collections: readonly BrainPackCollectionMapping[];
  readonly items: readonly BrainPackItemReview[];
  readonly projectId: string | null;
  readonly tags: readonly string[];
}

export interface BrainPackExportSelection {
  readonly knowledgeBaseIds: readonly string[];
  readonly documentIds: readonly string[];
  readonly frozenAt: string;
}

export interface BrainPackRunRecord {
  readonly id: string;
  readonly kind: BrainPackRunKind;
  readonly status: BrainPackRunStatus;
  readonly ownerAccountId: string;
  readonly pack: {
    readonly id: string;
    readonly externalPackId: string;
    readonly publisher: BrainPackPublisher;
    readonly owned: boolean;
  } | null;
  readonly packRevision: {
    readonly id: string;
    readonly number: number;
    readonly title: string;
    readonly manifestSha256: string;
  } | null;
  readonly artifactId: string | null;
  readonly jobId: string | null;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly reviewVersion: number;
  readonly reviewDigest: string | null;
  readonly review: BrainPackFrozenReview | null;
  readonly exportSelection: BrainPackExportSelection | null;
  readonly progress: BrainPackRunProgress | null;
  readonly receipt: BrainPackImportReceipt | BrainPackExportReceipt | null;
  readonly sanitizedError: string | null;
  readonly cancelRequestedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/** Indexing progress kept on a run item so a retry resumes instead of re-embedding. */
export interface BrainPackItemCheckpoint {
  readonly indexed: {
    readonly spaceId: string;
    readonly contentSha256: string;
    readonly chunkCount: number;
  } | null;
}

export interface BrainPackRunItemRecord {
  readonly id: string;
  readonly runId: string;
  readonly itemKey: string;
  readonly packItemId: string | null;
  readonly collectionKey: string;
  readonly title: string;
  readonly classification: BrainPackItemClassification;
  readonly decision: BrainPackItemDecision | null;
  readonly expectedLocalRevision: number | null;
  readonly localDocumentId: string | null;
  readonly localRevision: number | null;
  readonly destinationKnowledgeBaseId: string | null;
  readonly result: BrainPackRunItemResult | null;
  readonly resultDocumentId: string | null;
  readonly resultRevisionId: string | null;
  readonly checkpoint: BrainPackItemCheckpoint;
  readonly sanitizedError: string | null;
}

export interface BrainPackPreviewRecord {
  readonly packId: string;
  readonly packRevision: number;
  readonly publisher: BrainPackPublisher;
  readonly title: string;
  readonly description: string | null;
  readonly language: string | null;
  readonly createdAt: string;
  readonly manifestSha256: string;
  readonly collections: readonly {
    readonly key: string;
    readonly name: string;
    readonly description: string | null;
    readonly documentCount: number;
  }[];
  readonly counts: {
    readonly collections: number;
    readonly documents: number;
    readonly new: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly conflicting: number;
    readonly invalid: number;
  };
  readonly volume: {
    readonly expandedBytes: number;
    readonly documentCharacters: number;
    readonly estimatedChunks: number;
  };
  readonly samples: readonly { readonly itemKey: string; readonly title: string; readonly excerpt: string }[];
}

export interface BrainPackRunCursor {
  readonly ts: string;
  readonly id: string;
}

export interface BrainPackExportSnapshotDocument {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly sourceUri: string | null;
  readonly revision: { readonly id: string; readonly number: number; readonly contentHash: string };
  readonly content: string;
  readonly representation: BrainPackContentRepresentation;
  readonly origin: BrainPackOriginAttribution | null;
}

export interface BrainPackExportSnapshotBase {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly documents: readonly BrainPackExportSnapshotDocument[];
}

export interface BrainPackExportSnapshot {
  readonly frozenAt: string;
  readonly knowledgeBases: readonly BrainPackExportSnapshotBase[];
}

export interface BrainPackItemRecordInput {
  readonly kind: "collection" | "document";
  readonly itemKey: string;
  readonly collectionKey: string | null;
  readonly title: string;
  readonly representation: BrainPackContentRepresentation | null;
  readonly contentSha256: string | null;
  readonly byteSize: number | null;
  readonly characterCount: number | null;
  /** Entry metadata plus, for validated imports, the exact document text. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface BrainPackRevisionRecordInput {
  readonly externalPackId: string;
  readonly packRevision: number;
  readonly publisher: BrainPackPublisher;
  readonly title: string;
  readonly description: string | null;
  readonly language: string | null;
  readonly manifest: BrainPackManifest;
  readonly manifestSha256: string;
  readonly createdAt: string;
  readonly items: readonly BrainPackItemRecordInput[];
}

export interface BrainPackExportRecordInput {
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly revision: BrainPackRevisionRecordInput;
  readonly expectedPackRevision: number | null;
  readonly artifactId: string;
  readonly selection: BrainPackExportSelection;
  readonly receipt: Omit<BrainPackExportReceipt, "runId">;
}

export interface BrainPackImportCreateInput {
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly artifactId: string;
  /** The decoded pack, or `null` when decoding failed and the run must record the failure. */
  readonly pack: {
    readonly decoded: BrainPack;
    readonly manifestSha256: string;
    readonly expandedBytes: number;
  } | null;
  readonly failure: { readonly code: BrainPackErrorCode; readonly message: string } | null;
}

export interface BrainPackImportReviewInput {
  readonly runId: string;
  readonly expectedReviewVersion: number;
  readonly collections: readonly BrainPackCollectionMapping[];
  readonly items: readonly BrainPackItemReview[];
  readonly projectId: string | null;
  readonly tags: readonly string[];
  readonly idempotencyKey: string;
}

/** One document the import worker must index, with the text the validation stored. */
export interface BrainPackImportWorkItem {
  readonly id: string;
  readonly itemKey: string;
  readonly decision: BrainPackItemDecision;
  readonly content: string;
  readonly contentSha256: string;
  readonly checkpoint: BrainPackItemCheckpoint;
}

export interface BrainPackImportWork {
  readonly run: BrainPackRunRecord;
  readonly items: readonly BrainPackImportWorkItem[];
}

export interface BrainPackStagedChunk {
  readonly position: number;
  readonly content: string;
  readonly embedding: ContentEmbedding;
}

/** A worker's proof that it still owns the job; publication is refused when it does not. */
export interface BrainPackPublicationFence {
  readonly jobId: string;
  readonly fencingToken: string;
}

export interface BrainPackStore {
  getRun(access: BrainAccessContext, runId: string, signal: AbortSignal): Promise<BrainPackRunRecord | null>;
  findRunByIdempotencyKey(
    access: BrainAccessContext,
    input: { readonly kind: BrainPackRunKind; readonly idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<BrainPackRunRecord | null>;
  listRuns(
    access: BrainAccessContext,
    input: {
      readonly kind: BrainPackRunKind | null;
      readonly status: BrainPackRunStatus | null;
      readonly cursor: BrainPackRunCursor | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<{ readonly runs: readonly BrainPackRunRecord[]; readonly nextCursor: BrainPackRunCursor | null }>;
  listRunItems(
    access: BrainAccessContext,
    input: { readonly runId: string; readonly cursor: string | null; readonly limit: number },
    signal: AbortSignal,
  ): Promise<{ readonly items: readonly BrainPackRunItemRecord[]; readonly nextCursor: string | null }>;
  getImportPreview(access: BrainAccessContext, runId: string, signal: AbortSignal): Promise<BrainPackPreviewRecord | null>;

  /** Resolves the pack identity an export will write: a new pack, or the next revision of an owned one. */
  prepareExport(
    access: BrainAccessContext,
    input: {
      readonly externalPackId: string | null;
      readonly expectedPackRevision: number | null;
      readonly publisherNamespace: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly externalPackId: string; readonly packRevision: number }>;
  /** Freezes the selected knowledge in one read transaction; exact text where it is known, reconstructed otherwise. */
  snapshotExportSelection(
    access: BrainAccessContext,
    input: {
      readonly knowledgeBaseIds: readonly string[];
      readonly documentIds: readonly string[];
      readonly maxDocuments: number;
    },
    signal: AbortSignal,
  ): Promise<BrainPackExportSnapshot>;
  recordExport(
    access: BrainAccessContext,
    input: BrainPackExportRecordInput,
    signal: AbortSignal,
  ): Promise<{ readonly run: BrainPackRunRecord; readonly replayed: boolean }>;

  createImportRun(
    access: BrainAccessContext,
    input: BrainPackImportCreateInput,
    signal: AbortSignal,
  ): Promise<{ readonly run: BrainPackRunRecord; readonly replayed: boolean }>;
  reviewImportRun(
    access: BrainAccessContext,
    input: BrainPackImportReviewInput,
    signal: AbortSignal,
  ): Promise<{ readonly run: BrainPackRunRecord; readonly reviewDigest: string } | null>;
  queueImportPublication(
    access: BrainAccessContext,
    input: { readonly runId: string; readonly reviewDigest: string; readonly idempotencyKey: string; readonly now: string },
    signal: AbortSignal,
  ): Promise<{ readonly run: BrainPackRunRecord; readonly jobId: string } | null>;
  /** Cancels a run that has not started indexing; flags one that has and returns the job the caller must stop. */
  cancelRun(
    access: BrainAccessContext,
    input: { readonly runId: string; readonly idempotencyKey: string; readonly now: string },
    signal: AbortSignal,
  ): Promise<{ readonly run: BrainPackRunRecord; readonly canceled: boolean; readonly jobToCancel: string | null } | null>;
  retryRun(
    access: BrainAccessContext,
    input: { readonly runId: string; readonly idempotencyKey: string; readonly now: string },
    signal: AbortSignal,
  ): Promise<{ readonly run: BrainPackRunRecord; readonly jobId: string } | null>;

  loadImportWork(runId: string, signal: AbortSignal): Promise<BrainPackImportWork | null>;
  stageItemChunks(
    runItemId: string,
    input: { readonly contentSha256: string; readonly recipeVersion: string; readonly chunks: readonly BrainPackStagedChunk[] },
    signal: AbortSignal,
  ): Promise<void>;
  updateRunProgress(runId: string, progress: BrainPackRunProgress, signal: AbortSignal): Promise<void>;
  markRunFailed(runId: string, input: { readonly sanitizedError: string }, signal: AbortSignal): Promise<void>;
  markRunCanceled(runId: string, signal: AbortSignal): Promise<void>;
  /**
   * Publishes an indexed import in one transaction: documents, revisions,
   * chunks, embeddings, origin links, mappings and exact text. Returns the
   * receipt, or `null` when cancellation was requested before the commit.
   */
  commitImport(
    runId: string,
    input: { readonly now: string; readonly fence: BrainPackPublicationFence | null },
    signal: AbortSignal,
  ): Promise<BrainPackImportReceipt | null>;
}

export class BrainPackStoreConflictError extends Error {
  readonly code = "BRAIN_PACK_STORE_CONFLICT";

  constructor(message = "The idempotency key was already used with different input.") {
    super(message);
    this.name = "BrainPackStoreConflictError";
  }
}
