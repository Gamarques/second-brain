import { z } from "zod";

import { canonicalDigest } from "./digests.js";

/**
 * Brain Pack version 1: a constrained ZIP archive that carries selected
 * knowledge bases and their current document text between installations.
 * This module is the format contract — limits, identity rules, entry schemas,
 * run states, digests and errors. Encoding and decoding live in
 * `brain-pack-codec.ts`; persistence lives under `database/`.
 */
export const BRAIN_PACK_FORMAT_VERSION = 1 as const;
export const BRAIN_PACK_FILE_EXTENSION = ".brainpack";
export const BRAIN_PACK_CONTENT_TYPE = "application/zip";

const mebibyte = 1024 * 1024;

/** Version 1 limits; every one is enforced before a model call. */
export const brainPackLimits = {
  compressedBytes: 64 * mebibyte,
  expandedBytes: 256 * mebibyte,
  entries: 2_000,
  collections: 200,
  /** Entries minus the three metadata files. */
  documents: 1_997,
  documentCharacters: 1_000_000,
  chunksPerRevision: 1_000,
  synchronousExportDocuments: 200,
  synchronousExportExpandedBytes: 16 * mebibyte,
  embeddingBatchChunks: 64,
  activeImportRunsPerAccount: 1,
  activeImportRunsPerDeployment: 2,
  keyCharacters: 120,
  namespaceCharacters: 200,
  titleCharacters: 500,
  nameCharacters: 200,
  descriptionCharacters: 10_000,
  tagsPerDocument: 20,
  tagCharacters: 100,
  authorsPerDocument: 20,
  authorNameCharacters: 200,
  referencesPerDocument: 200,
  uriCharacters: 2_000,
  languageCharacters: 35,
} as const;

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

/** A pack problem the caller can act on; `details` names the offending entries or fields. */
export class BrainPackError extends Error {
  readonly code: BrainPackErrorCode;
  readonly details: readonly string[];

  constructor(code: BrainPackErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "BrainPackError";
    this.code = code;
    this.details = details;
  }
}

/** Stable, path-safe identifiers for collections and documents inside a pack. */
export const brainPackItemKeySchema = z
  .string()
  .max(brainPackLimits.keyCharacters)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/u, "Item keys are lowercase letters, digits and hyphens.");

/** Self-declared publisher identity, reverse-DNS style; never proof of who published. */
export const brainPackPublisherNamespaceSchema = z
  .string()
  .min(1)
  .max(brainPackLimits.namespaceCharacters)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u, "Publisher namespaces are dotted lowercase labels.");

export const brainPackLanguageSchema = z
  .string()
  .max(brainPackLimits.languageCharacters)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u, "Languages are BCP 47 tags.");

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "Hashes are lowercase hex SHA-256.");
const uuidSchema = z.string().uuid();
const instantSchema = z.string().datetime({ offset: true });
const uriSchema = z.string().url().max(brainPackLimits.uriCharacters);
const descriptionSchema = z.string().max(brainPackLimits.descriptionCharacters).nullable();

export const brainPackPublisherSchema = z.object({
  namespace: brainPackPublisherNamespaceSchema,
  displayName: z.string().trim().min(1).max(brainPackLimits.nameCharacters),
});

export const brainPackInventoryEntrySchema = z.object({
  path: z.string().min(1).max(200),
  byteSize: z.number().int().min(0).max(brainPackLimits.expandedBytes),
  sha256: sha256Schema,
});

const manifestHeaderShape = {
  formatVersion: z.literal(BRAIN_PACK_FORMAT_VERSION),
  packId: uuidSchema,
  packRevision: z.number().int().min(1),
  publisher: brainPackPublisherSchema,
  title: z.string().trim().min(1).max(brainPackLimits.titleCharacters),
  description: descriptionSchema,
  createdAt: instantSchema,
  language: brainPackLanguageSchema.nullable(),
} as const;

/** `manifest.json` without the inventory: what an exporter supplies. */
export const brainPackManifestHeaderSchema = z.object(manifestHeaderShape);
/** `manifest.json` as written: the header plus the inventory of every other entry. */
export const brainPackManifestSchema = z.object({
  ...manifestHeaderShape,
  inventory: z.array(brainPackInventoryEntrySchema).max(brainPackLimits.entries),
});

export const brainPackCollectionSchema = z.object({
  key: brainPackItemKeySchema,
  name: z.string().trim().min(1).max(brainPackLimits.nameCharacters),
  description: descriptionSchema,
  documentKeys: z.array(brainPackItemKeySchema).max(brainPackLimits.documents),
});
export const brainPackCollectionsFileSchema = z.object({
  collections: z.array(brainPackCollectionSchema).max(brainPackLimits.collections),
});

export const brainPackAuthorSchema = z.object({
  name: z.string().trim().min(1).max(brainPackLimits.authorNameCharacters),
  uri: uriSchema.nullable(),
});
/** Where an item came from before this pack; preserved on re-export, never trusted for access. */
export const brainPackOriginSchema = z.object({
  publisherNamespace: brainPackPublisherNamespaceSchema,
  packId: uuidSchema,
  itemKey: brainPackItemKeySchema,
  packRevision: z.number().int().min(1),
});
/** The exporting brain's revision, as historical metadata; it does not certify the exported bytes. */
export const brainPackSourceRevisionSchema = z.object({
  number: z.number().int().min(1),
  contentSha256: sha256Schema,
});
export const brainPackAttributionSchema = z.object({
  authors: z.array(brainPackAuthorSchema).max(brainPackLimits.authorsPerDocument),
  origin: brainPackOriginSchema.nullable(),
  sourceRevision: brainPackSourceRevisionSchema.nullable(),
});

export const brainPackReferenceKinds = ["related"] as const;
export type BrainPackReferenceKind = (typeof brainPackReferenceKinds)[number];
export const brainPackReferenceSchema = z.object({
  targetKey: brainPackItemKeySchema,
  kind: z.enum(brainPackReferenceKinds),
});

/** `canonical` is the text as originally written; `reconstructed` was rebuilt from overlapping chunks. */
export const brainPackRepresentations = ["canonical", "reconstructed"] as const;
export type BrainPackRepresentation = (typeof brainPackRepresentations)[number];

const documentShape = {
  key: brainPackItemKeySchema,
  collectionKey: brainPackItemKeySchema,
  title: z.string().trim().min(1).max(brainPackLimits.titleCharacters),
  tags: z.array(z.string().trim().min(1).max(brainPackLimits.tagCharacters)).max(brainPackLimits.tagsPerDocument),
  sourceUri: uriSchema.nullable(),
  attribution: brainPackAttributionSchema,
  references: z.array(brainPackReferenceSchema).max(brainPackLimits.referencesPerDocument),
  representation: z.enum(brainPackRepresentations),
} as const;

/** One entry of `documents.json`. */
export const brainPackDocumentEntrySchema = z.object({
  ...documentShape,
  contentPath: z.string().min(1).max(200),
});
export const brainPackDocumentsFileSchema = z.object({
  documents: z.array(brainPackDocumentEntrySchema).max(brainPackLimits.documents),
});
/**
 * A document with its text, as exporters supply it and importers receive it.
 * The character limit is enforced by `validateBrainPackStructure`, which
 * reports it as `PACK_LIMIT_EXCEEDED` rather than a schema issue.
 */
export const brainPackDocumentSchema = z.object({ ...documentShape, content: z.string() });

/** What an exporter hands the codec: a header and the selected content. */
export const brainPackSourceSchema = z.object({
  manifest: brainPackManifestHeaderSchema,
  collections: z.array(brainPackCollectionSchema).max(brainPackLimits.collections),
  documents: z.array(brainPackDocumentSchema).max(brainPackLimits.documents),
});
/** What the codec returns after every check passed. */
export const brainPackSchema = z.object({
  manifest: brainPackManifestSchema,
  collections: z.array(brainPackCollectionSchema).max(brainPackLimits.collections),
  documents: z.array(brainPackDocumentSchema).max(brainPackLimits.documents),
});

export type BrainPackPublisher = z.infer<typeof brainPackPublisherSchema>;
export type BrainPackInventoryEntry = z.infer<typeof brainPackInventoryEntrySchema>;
export type BrainPackManifestHeader = z.infer<typeof brainPackManifestHeaderSchema>;
export type BrainPackManifest = z.infer<typeof brainPackManifestSchema>;
export type BrainPackCollection = z.infer<typeof brainPackCollectionSchema>;
export type BrainPackAuthor = z.infer<typeof brainPackAuthorSchema>;
export type BrainPackOrigin = z.infer<typeof brainPackOriginSchema>;
export type BrainPackAttribution = z.infer<typeof brainPackAttributionSchema>;
export type BrainPackReference = z.infer<typeof brainPackReferenceSchema>;
export type BrainPackDocumentEntry = z.infer<typeof brainPackDocumentEntrySchema>;
export type BrainPackDocument = z.infer<typeof brainPackDocumentSchema>;
export type BrainPackSource = z.infer<typeof brainPackSourceSchema>;
export type BrainPack = z.infer<typeof brainPackSchema>;

export const brainPackManifestEntryPath = "manifest.json";
export const brainPackCollectionsEntryPath = "collections.json";
export const brainPackDocumentsEntryPath = "documents.json";

export function brainPackDocumentContentPath(itemKey: string): string {
  return `documents/${itemKey}.md`;
}

const documentContentPathPattern = /^documents\/([a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?)\.md$/u;

/** The item key a content path names, or null when the path is not a document entry. */
export function brainPackItemKeyFromContentPath(path: string): string | null {
  return documentContentPathPattern.exec(path)?.[1] ?? null;
}

/** The identity an importer maps to a local document: never the foreign UUID alone. */
export function brainPackItemIdentity(input: {
  readonly publisherNamespace: string;
  readonly packId: string;
  readonly itemKey: string;
}): string {
  return `${input.publisherNamespace}/${input.packId}/${input.itemKey}`;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

/**
 * The rules that hold across entries, shared by encoding and decoding:
 * unique keys, collections and documents that agree with each other,
 * references that point at included documents, content paths that follow
 * the key, and text within the limits.
 */
export function validateBrainPackStructure(input: {
  readonly collections: readonly BrainPackCollection[];
  readonly documents: ReadonlyArray<
    Pick<BrainPackDocument, "key" | "collectionKey" | "references"> & {
      readonly content?: string;
      readonly contentPath?: string;
    }
  >;
}): void {
  const { collections, documents } = input;
  if (collections.length > brainPackLimits.collections) {
    throw new BrainPackError("PACK_LIMIT_EXCEEDED", "The pack has too many collections.", [
      `collections: ${collections.length} > ${brainPackLimits.collections}`,
    ]);
  }
  if (documents.length > brainPackLimits.documents) {
    throw new BrainPackError("PACK_LIMIT_EXCEEDED", "The pack has too many documents.", [
      `documents: ${documents.length} > ${brainPackLimits.documents}`,
    ]);
  }
  const duplicateCollections = duplicates(collections.map((collection) => collection.key));
  if (duplicateCollections.length > 0) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "Collection keys must be unique.", duplicateCollections.map((key) => `collections.${key}`));
  }
  const duplicateDocuments = duplicates(documents.map((document) => document.key));
  if (duplicateDocuments.length > 0) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "Document keys must be unique.", duplicateDocuments.map((key) => `documents.${key}`));
  }

  const collectionKeys = new Set(collections.map((collection) => collection.key));
  const documentKeys = new Set(documents.map((document) => document.key));
  const membership = new Map<string, string>();
  const problems: string[] = [];
  for (const collection of collections) {
    for (const key of collection.documentKeys) {
      if (!documentKeys.has(key)) problems.push(`collections.${collection.key}.documentKeys: ${key} is not in documents.json`);
      const previous = membership.get(key);
      if (previous !== undefined && previous !== collection.key) {
        problems.push(`collections.${collection.key}.documentKeys: ${key} is also listed in ${previous}`);
      }
      membership.set(key, collection.key);
    }
  }
  for (const document of documents) {
    if (!collectionKeys.has(document.collectionKey)) {
      problems.push(`documents.${document.key}.collectionKey: ${document.collectionKey} is not in collections.json`);
    } else if (membership.get(document.key) !== document.collectionKey) {
      problems.push(`documents.${document.key}: not listed in collections.${document.collectionKey}.documentKeys`);
    }
    const expectedPath = brainPackDocumentContentPath(document.key);
    if (document.contentPath !== undefined && document.contentPath !== expectedPath) {
      problems.push(`documents.${document.key}.contentPath: expected ${expectedPath}`);
    }
    if (document.content !== undefined) {
      if (document.content.includes("\0")) problems.push(`${expectedPath}: contains a NUL byte`);
      if (document.content.trim() === "") problems.push(`${expectedPath}: is empty`);
    }
  }
  if (problems.length > 0) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "Collections and documents do not agree.", problems);
  }

  const oversized = documents
    .filter((document) => document.content !== undefined && document.content.length > brainPackLimits.documentCharacters)
    .map((document) => `${brainPackDocumentContentPath(document.key)}: ${document.content!.length} > ${brainPackLimits.documentCharacters} characters`);
  if (oversized.length > 0) {
    throw new BrainPackError("PACK_LIMIT_EXCEEDED", "A document exceeds the character limit.", oversized);
  }

  const badReferences: string[] = [];
  for (const document of documents) {
    document.references.forEach((reference, index) => {
      if (reference.targetKey === document.key) {
        badReferences.push(`documents.${document.key}.references[${index}]: refers to itself`);
      } else if (!documentKeys.has(reference.targetKey)) {
        badReferences.push(`documents.${document.key}.references[${index}]: ${reference.targetKey} is not in this pack`);
      }
    });
  }
  if (badReferences.length > 0) {
    throw new BrainPackError("PACK_REFERENCE_INVALID", "A reference points outside the pack.", badReferences);
  }
}

// ---------------------------------------------------------------------------
// Runs, review, receipts
// ---------------------------------------------------------------------------

export const brainPackRunKinds = ["import", "export"] as const;
export type BrainPackRunKind = (typeof brainPackRunKinds)[number];

export const brainPackImportRunStatuses = [
  "uploaded",
  "validating",
  "awaiting_review",
  "reviewed",
  "indexing",
  "publishing",
  "completed",
  "failed",
  "canceled",
] as const;
export type BrainPackImportRunStatus = (typeof brainPackImportRunStatuses)[number];

export const brainPackExportRunStatuses = [
  "queued",
  "snapshotting",
  "encoding",
  "completed",
  "failed",
  "canceled",
] as const;
export type BrainPackExportRunStatus = (typeof brainPackExportRunStatuses)[number];

/** Every run status, in the order the database enum declares them. */
export const brainPackRunStatuses = [
  "uploaded",
  "validating",
  "awaiting_review",
  "reviewed",
  "indexing",
  "publishing",
  "queued",
  "snapshotting",
  "encoding",
  "completed",
  "failed",
  "canceled",
] as const;
export type BrainPackRunStatus = (typeof brainPackRunStatuses)[number];

export const brainPackTerminalRunStatuses = ["completed", "failed", "canceled"] as const;

export function isBrainPackRunActive(status: BrainPackRunStatus): boolean {
  return !(brainPackTerminalRunStatuses as readonly string[]).includes(status);
}

export const brainPackArtifactKinds = ["upload", "export"] as const;
export type BrainPackArtifactKind = (typeof brainPackArtifactKinds)[number];

export const brainPackItemKinds = ["collection", "document"] as const;
export type BrainPackItemKind = (typeof brainPackItemKinds)[number];

/** How a validated item compares with the local brain during preview. */
export const brainPackItemClassifications = ["new", "updated", "unchanged", "conflicting", "invalid"] as const;
export type BrainPackItemClassification = (typeof brainPackItemClassifications)[number];

/** What the reviewer chose for one item. */
export const brainPackItemDecisions = ["create", "update", "skip", "separate_copy", "keep_local"] as const;
export type BrainPackItemDecision = (typeof brainPackItemDecisions)[number];

export const brainPackRunItemResults = ["created", "updated", "skipped", "excluded", "failed"] as const;
export type BrainPackRunItemResult = (typeof brainPackRunItemResults)[number];

export type BrainPackCollectionDestination =
  | { readonly knowledgeBaseId: string }
  | { readonly createKnowledgeBase: { readonly name: string; readonly description: string | null } };

export interface BrainPackCollectionMapping {
  readonly collectionKey: string;
  readonly destination: BrainPackCollectionDestination;
}

export interface BrainPackItemReview {
  readonly itemKey: string;
  readonly decision: BrainPackItemDecision;
  readonly expectedLocalRevision: number | null;
}

/**
 * The digest a publication request must present. It binds the reviewed
 * manifest, the selected items and their decisions, the destination mapping
 * and the expected local revisions; changing any of them invalidates it.
 */
export function brainPackReviewDigest(input: {
  readonly runId: string;
  readonly manifestSha256: string;
  readonly collections: readonly BrainPackCollectionMapping[];
  readonly items: readonly BrainPackItemReview[];
}): string {
  return canonicalDigest({
    runId: input.runId,
    manifestSha256: input.manifestSha256,
    collections: [...input.collections]
      .sort((left, right) => left.collectionKey.localeCompare(right.collectionKey))
      .map((mapping) => ({ collectionKey: mapping.collectionKey, destination: mapping.destination })),
    items: [...input.items]
      .sort((left, right) => left.itemKey.localeCompare(right.itemKey))
      .map((item) => ({ itemKey: item.itemKey, decision: item.decision, expectedLocalRevision: item.expectedLocalRevision })),
  });
}

/** Canonical digest of a pack request, bound with the idempotency key exactly as `mutation_receipts` does. */
export function brainPackRequestDigest(input: unknown): string {
  return canonicalDigest(input);
}

export interface BrainPackImportReceiptItem {
  readonly itemKey: string;
  readonly documentId: string;
  readonly revisionId: string;
}

export interface BrainPackImportReceiptSkip {
  readonly itemKey: string;
  readonly reason: string;
}

export interface BrainPackImportReceipt {
  readonly runId: string;
  readonly packId: string;
  readonly packRevision: number;
  readonly publishedAt: string;
  readonly created: readonly BrainPackImportReceiptItem[];
  readonly updated: readonly BrainPackImportReceiptItem[];
  readonly skipped: readonly BrainPackImportReceiptSkip[];
  readonly excluded: readonly BrainPackImportReceiptSkip[];
}

export interface BrainPackExportReceipt {
  readonly runId: string;
  readonly packId: string;
  readonly packRevision: number;
  readonly artifactId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly collectionCount: number;
  readonly documentCount: number;
  readonly frozenAt: string;
}
