/**
 * Browser-side mirror of the Brain Pack capability contracts
 * (`apps/engine/src/capabilities/brain-pack-schemas.ts`). The admin does not
 * import engine code, so the shapes are restated here and kept in step with
 * the zod schemas by the API tests.
 */
export type BrainPackRunKind = "import" | "export";

export type BrainPackRunStatus =
  | "uploaded"
  | "validating"
  | "awaiting_review"
  | "reviewed"
  | "indexing"
  | "publishing"
  | "queued"
  | "snapshotting"
  | "encoding"
  | "completed"
  | "failed"
  | "canceled";

export type BrainPackItemClassification = "new" | "updated" | "unchanged" | "conflicting" | "invalid";
export type BrainPackItemDecision = "create" | "update" | "skip" | "separate_copy" | "keep_local";
export type BrainPackRunItemResult = "created" | "updated" | "skipped" | "excluded" | "failed";

export const brainPackErrorCodes = [
  "PACK_FORMAT_UNSUPPORTED",
  "PACK_MANIFEST_INVALID",
  "PACK_INTEGRITY_FAILED",
  "PACK_LIMIT_EXCEEDED",
  "PACK_REFERENCE_INVALID",
  "PACK_REVIEW_STALE",
  "PACK_REVISION_CONFLICT",
] as const;
export type BrainPackErrorCode = (typeof brainPackErrorCodes)[number];

/** The version 1 limits the interface has to state or enforce before a request. */
export const brainPackLimits = {
  compressedBytes: 64 * 1024 * 1024,
  synchronousExportDocuments: 200,
  titleCharacters: 500,
  nameCharacters: 200,
  descriptionCharacters: 10_000,
  namespaceCharacters: 200,
  tagsPerDocument: 20,
  tagCharacters: 100,
} as const;

export const brainPackPublisherNamespacePattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
export const brainPackLanguagePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

export interface BrainPackPublisher {
  namespace: string;
  displayName: string;
}

export interface BrainPackRunProgress {
  stage: string;
  processedItems: number;
  totalItems: number;
}

export interface BrainPackRunSummary {
  id: string;
  kind: BrainPackRunKind;
  status: BrainPackRunStatus;
  packId: string | null;
  packRevision: number | null;
  publisher: BrainPackPublisher | null;
  title: string | null;
  artifactId: string | null;
  reviewVersion: number;
  reviewDigest: string | null;
  progress: BrainPackRunProgress | null;
  sanitizedError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface BrainPackArtifactReference {
  id: string;
  sha256: string;
  byteSize: number;
  expiresAt: string;
}

export interface BrainPackReceiptItem {
  itemKey: string;
  documentId: string;
  revisionId: string;
}

export interface BrainPackReceiptSkip {
  itemKey: string;
  reason: string;
}

export interface BrainPackImportReceipt {
  runId: string;
  packId: string;
  packRevision: number;
  publishedAt: string;
  created: BrainPackReceiptItem[];
  updated: BrainPackReceiptItem[];
  skipped: BrainPackReceiptSkip[];
  excluded: BrainPackReceiptSkip[];
}

export interface BrainPackExportReceipt {
  runId: string;
  packId: string;
  packRevision: number;
  artifactId: string;
  sha256: string;
  byteSize: number;
  collectionCount: number;
  documentCount: number;
  frozenAt: string;
}

export interface BrainPackPreviewCollection {
  key: string;
  name: string;
  description: string | null;
  documentCount: number;
}

export interface BrainPackPreviewCounts {
  collections: number;
  documents: number;
  new: number;
  updated: number;
  unchanged: number;
  conflicting: number;
  invalid: number;
}

export interface BrainPackPreview {
  packId: string;
  packRevision: number;
  publisher: BrainPackPublisher;
  title: string;
  description: string | null;
  language: string | null;
  createdAt: string;
  manifestSha256: string;
  collections: BrainPackPreviewCollection[];
  counts: BrainPackPreviewCounts;
  volume: { expandedBytes: number; documentCharacters: number; estimatedChunks: number };
  samples: Array<{ itemKey: string; title: string; excerpt: string }>;
}

export interface BrainPackRunItem {
  itemKey: string;
  collectionKey: string;
  title: string;
  classification: BrainPackItemClassification;
  decision: BrainPackItemDecision | null;
  expectedLocalRevision: number | null;
  localDocumentId: string | null;
  localRevision: number | null;
  result: BrainPackRunItemResult | null;
  resultDocumentId: string | null;
  resultRevisionId: string | null;
  sanitizedError: string | null;
}

export type BrainPackCollectionDestination =
  | { knowledgeBaseId: string }
  | { createKnowledgeBase: { name: string; description: string | null } };

export interface BrainPackCollectionMapping {
  collectionKey: string;
  destination: BrainPackCollectionDestination;
}

export interface BrainPackItemReview {
  itemKey: string;
  decision: BrainPackItemDecision;
  expectedLocalRevision: number | null;
}

export interface BrainPackExportSelection {
  knowledgeBaseIds: string[];
  documentIds: string[];
}

export interface BrainPackExportMetadata {
  title: string;
  description: string | null;
  publisherNamespace: string;
  publisherDisplayName: string;
  language: string | null;
}

export interface BrainPackExportInput {
  selection: BrainPackExportSelection;
  metadata: BrainPackExportMetadata;
  packId: string | null;
  expectedPackRevision: number | null;
  idempotencyKey: string;
}

export interface BrainPackExportResult {
  runId: string;
  status: BrainPackRunStatus;
  packId: string;
  packRevision: number;
  artifactId: string | null;
  receipt: BrainPackExportReceipt | null;
}

export interface BrainPackExportRun {
  run: BrainPackRunSummary;
  receipt: BrainPackExportReceipt | null;
  artifact: BrainPackArtifactReference | null;
}

export interface BrainPackImportStart {
  runId: string;
  status: BrainPackRunStatus;
}

export interface BrainPackImportRun {
  run: BrainPackRunSummary;
  preview: BrainPackPreview | null;
  items: { items: BrainPackRunItem[]; nextCursor: string | null };
  receipt: BrainPackImportReceipt | null;
}

export interface BrainPackImportReviewInput {
  runId: string;
  expectedReviewVersion: number;
  collections: BrainPackCollectionMapping[];
  items: BrainPackItemReview[];
  projectId: string | null;
  tags: string[];
  idempotencyKey: string;
}

export interface BrainPackImportReviewResult {
  runId: string;
  reviewVersion: number;
  reviewDigest: string;
  status: BrainPackRunStatus;
}

export interface BrainPackImportPublishResult {
  runId: string;
  status: BrainPackRunStatus;
  jobId: string | null;
}

export interface BrainPackRunsQuery {
  kind: BrainPackRunKind | null;
  status: BrainPackRunStatus | null;
  cursor: string | null;
  limit: number;
}

export interface BrainPackRunsPage {
  items: BrainPackRunSummary[];
  nextCursor: string | null;
}
