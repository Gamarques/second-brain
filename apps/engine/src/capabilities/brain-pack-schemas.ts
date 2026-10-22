import { z } from "zod";

import {
  brainPackExportRunStatuses,
  brainPackImportRunStatuses,
  brainPackItemClassifications,
  brainPackItemDecisions,
  brainPackItemKeySchema,
  brainPackLanguageSchema,
  brainPackLimits,
  brainPackPublisherNamespaceSchema,
  brainPackPublisherSchema,
  brainPackRunItemResults,
  brainPackRunKinds,
  brainPackRunStatuses,
} from "../domain/brain-pack.js";
import type { BrainRole } from "../domain/core.js";
import { idSchema, idempotencyKeySchema, timestampSchema } from "./schemas.js";

/**
 * Input and output contracts of the Brain Pack capabilities. The capabilities
 * themselves are implemented against these schemas; every one is
 * administrative because the browser panel only signs in `admin` and `owner`
 * accounts, and `owner` satisfies `admin`.
 */
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const cursorSchema = z.string().min(1).max(500).nullable();
const limitSchema = z.number().int().min(1).max(100);
const runStatusSchema = z.enum(brainPackRunStatuses);

export const brainPackRunProgressSchema = z.object({
  stage: z.string().min(1).max(50),
  processedItems: z.number().int().min(0),
  totalItems: z.number().int().min(0),
});

export const brainPackRunSummarySchema = z.object({
  id: idSchema,
  kind: z.enum(brainPackRunKinds),
  status: runStatusSchema,
  packId: idSchema.nullable(),
  packRevision: z.number().int().min(1).nullable(),
  publisher: brainPackPublisherSchema.nullable(),
  title: z.string().max(brainPackLimits.titleCharacters).nullable(),
  artifactId: idSchema.nullable(),
  reviewVersion: z.number().int().min(0),
  reviewDigest: sha256Schema.nullable(),
  progress: brainPackRunProgressSchema.nullable(),
  sanitizedError: z.string().max(500).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});

export const brainPackArtifactReferenceSchema = z.object({
  id: idSchema,
  sha256: sha256Schema,
  byteSize: z.number().int().min(1).max(brainPackLimits.compressedBytes),
  expiresAt: timestampSchema,
});

const receiptItemSchema = z.object({ itemKey: brainPackItemKeySchema, documentId: idSchema, revisionId: idSchema });
const receiptSkipSchema = z.object({ itemKey: brainPackItemKeySchema, reason: z.string().min(1).max(200) });

export const brainPackImportReceiptSchema = z.object({
  runId: idSchema,
  packId: idSchema,
  packRevision: z.number().int().min(1),
  publishedAt: timestampSchema,
  created: z.array(receiptItemSchema),
  updated: z.array(receiptItemSchema),
  skipped: z.array(receiptSkipSchema),
  excluded: z.array(receiptSkipSchema),
});

export const brainPackExportReceiptSchema = z.object({
  runId: idSchema,
  packId: idSchema,
  packRevision: z.number().int().min(1),
  artifactId: idSchema,
  sha256: sha256Schema,
  byteSize: z.number().int().min(1),
  collectionCount: z.number().int().min(0),
  documentCount: z.number().int().min(0),
  frozenAt: timestampSchema,
});

export const brainPackPreviewCollectionSchema = z.object({
  key: brainPackItemKeySchema,
  name: z.string().min(1).max(brainPackLimits.nameCharacters),
  description: z.string().max(brainPackLimits.descriptionCharacters).nullable(),
  documentCount: z.number().int().min(0),
});

/** What the reviewer sees before choosing destinations: attribution, inventory and processing volume. */
export const brainPackPreviewSchema = z.object({
  packId: idSchema,
  packRevision: z.number().int().min(1),
  publisher: brainPackPublisherSchema,
  title: z.string().min(1).max(brainPackLimits.titleCharacters),
  description: z.string().max(brainPackLimits.descriptionCharacters).nullable(),
  language: brainPackLanguageSchema.nullable(),
  createdAt: timestampSchema,
  manifestSha256: sha256Schema,
  collections: z.array(brainPackPreviewCollectionSchema).max(brainPackLimits.collections),
  counts: z.object({
    collections: z.number().int().min(0),
    documents: z.number().int().min(0),
    new: z.number().int().min(0),
    updated: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    conflicting: z.number().int().min(0),
    invalid: z.number().int().min(0),
  }),
  volume: z.object({
    expandedBytes: z.number().int().min(0),
    documentCharacters: z.number().int().min(0),
    estimatedChunks: z.number().int().min(0),
  }),
  samples: z
    .array(z.object({ itemKey: brainPackItemKeySchema, title: z.string().min(1).max(brainPackLimits.titleCharacters), excerpt: z.string().max(500) }))
    .max(5),
});

export const brainPackRunItemSchema = z.object({
  itemKey: brainPackItemKeySchema,
  collectionKey: brainPackItemKeySchema,
  title: z.string().min(1).max(brainPackLimits.titleCharacters),
  classification: z.enum(brainPackItemClassifications),
  decision: z.enum(brainPackItemDecisions).nullable(),
  expectedLocalRevision: z.number().int().min(1).nullable(),
  localDocumentId: idSchema.nullable(),
  localRevision: z.number().int().min(1).nullable(),
  result: z.enum(brainPackRunItemResults).nullable(),
  resultDocumentId: idSchema.nullable(),
  resultRevisionId: idSchema.nullable(),
  sanitizedError: z.string().max(500).nullable(),
});

export const brainPackCollectionDestinationSchema = z.union([
  z.object({ knowledgeBaseId: idSchema }).strict(),
  z
    .object({
      createKnowledgeBase: z
        .object({
          name: z.string().trim().min(1).max(brainPackLimits.nameCharacters),
          description: z.string().max(brainPackLimits.descriptionCharacters).nullable(),
        })
        .strict(),
    })
    .strict(),
]);

export const brainPackCollectionMappingSchema = z.object({
  collectionKey: brainPackItemKeySchema,
  destination: brainPackCollectionDestinationSchema,
});

/** `update`, `keep_local` and `separate_copy` act on an existing local document, so they name the revision they expect. */
export const brainPackItemReviewSchema = z
  .object({
    itemKey: brainPackItemKeySchema,
    decision: z.enum(brainPackItemDecisions),
    expectedLocalRevision: z.number().int().min(1).nullable(),
  })
  .superRefine((item, context) => {
    const needsRevision = item.decision === "update" || item.decision === "keep_local" || item.decision === "separate_copy";
    if (needsRevision && item.expectedLocalRevision === null) {
      context.addIssue({
        code: "custom",
        path: ["expectedLocalRevision"],
        message: `${item.decision} requires the expected local revision.`,
      });
    }
  });

const exportSelectionSchema = z
  .object({
    knowledgeBaseIds: z.array(idSchema).max(brainPackLimits.collections),
    documentIds: z.array(idSchema).max(brainPackLimits.documents),
  })
  .refine((selection) => selection.knowledgeBaseIds.length + selection.documentIds.length > 0, {
    message: "Choose at least one knowledge base or document.",
  });

const exportMetadataSchema = z.object({
  title: z.string().trim().min(1).max(brainPackLimits.titleCharacters),
  description: z.string().max(brainPackLimits.descriptionCharacters).nullable(),
  publisherNamespace: brainPackPublisherNamespaceSchema,
  publisherDisplayName: z.string().trim().min(1).max(brainPackLimits.nameCharacters),
  language: brainPackLanguageSchema.nullable(),
});

export interface BrainPackCapabilityContract<Input extends z.ZodType, Output extends z.ZodType> {
  readonly description: string;
  readonly minimumRole: BrainRole;
  readonly timeoutMs: number;
  readonly annotations: {
    readonly readOnly: boolean;
    readonly destructive: boolean;
    readonly idempotent: boolean;
    readonly openWorld: boolean;
  };
  readonly input: Input;
  readonly output: Output;
}

function contract<Input extends z.ZodType, Output extends z.ZodType>(
  definition: BrainPackCapabilityContract<Input, Output>,
): BrainPackCapabilityContract<Input, Output> {
  return definition;
}

const readAnnotations = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const localMutation = { readOnly: false, destructive: false, idempotent: true, openWorld: false } as const;

export const brainPackCapabilityContracts = {
  knowledge_packs_export: contract({
    description:
      "Export selected knowledge bases and documents as a Brain Pack. Within the synchronous limits the archive is ready when this returns; re-exporting an owned pack advances its revision.",
    minimumRole: "admin",
    timeoutMs: 120_000,
    annotations: localMutation,
    input: z.object({
      selection: exportSelectionSchema,
      metadata: exportMetadataSchema,
      /** An owned pack to re-export with stable keys; null starts a new pack. */
      packId: idSchema.nullable(),
      expectedPackRevision: z.number().int().min(1).nullable(),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: z.object({
      runId: idSchema,
      status: z.enum(brainPackExportRunStatuses),
      packId: idSchema,
      packRevision: z.number().int().min(1),
      artifactId: idSchema.nullable(),
      receipt: brainPackExportReceiptSchema.nullable(),
    }),
  }),
  knowledge_packs_export_get: contract({
    description: "Read an export run: its status, inventory, receipt and the authenticated artifact reference.",
    minimumRole: "admin",
    timeoutMs: 10_000,
    annotations: readAnnotations,
    input: z.object({ runId: idSchema }),
    output: z.object({
      run: brainPackRunSummarySchema,
      receipt: brainPackExportReceiptSchema.nullable(),
      artifact: brainPackArtifactReferenceSchema.nullable(),
    }),
  }),
  knowledge_packs_import: contract({
    description: "Start validating an uploaded Brain Pack artifact. Validation runs in the background and needs no model call.",
    minimumRole: "admin",
    timeoutMs: 10_000,
    annotations: localMutation,
    input: z.object({ artifactId: idSchema, idempotencyKey: idempotencyKeySchema }),
    output: z.object({ runId: idSchema, status: z.enum(brainPackImportRunStatuses) }),
  }),
  knowledge_packs_import_get: contract({
    description: "Read an import run: progress, the validated preview, a page of items with their classification, the review version and the receipt.",
    minimumRole: "admin",
    timeoutMs: 10_000,
    annotations: readAnnotations,
    input: z.object({ runId: idSchema, cursor: cursorSchema, limit: limitSchema }),
    output: z.object({
      run: brainPackRunSummarySchema,
      preview: brainPackPreviewSchema.nullable(),
      items: z.object({ items: z.array(brainPackRunItemSchema), nextCursor: cursorSchema }),
      receipt: brainPackImportReceiptSchema.nullable(),
    }),
  }),
  knowledge_packs_import_review: contract({
    description:
      "Freeze the reviewed selection: map collections to knowledge bases, decide each item, and name the local revisions the decisions expect. Returns the digest publication must present.",
    minimumRole: "admin",
    timeoutMs: 30_000,
    annotations: localMutation,
    input: z.object({
      runId: idSchema,
      expectedReviewVersion: z.number().int().min(0),
      collections: z.array(brainPackCollectionMappingSchema).max(brainPackLimits.collections),
      items: z.array(brainPackItemReviewSchema).max(brainPackLimits.documents),
      projectId: idSchema.nullable(),
      tags: z.array(z.string().trim().min(1).max(brainPackLimits.tagCharacters)).max(brainPackLimits.tagsPerDocument),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: z.object({
      runId: idSchema,
      reviewVersion: z.number().int().min(1),
      reviewDigest: sha256Schema,
      status: z.enum(brainPackImportRunStatuses),
    }),
  }),
  knowledge_packs_import_publish: contract({
    description:
      "Queue indexing and publication of a reviewed import. The review digest must match the current review; a stale digest fails. Embeddings are computed locally, then one bounded transaction publishes everything.",
    minimumRole: "admin",
    timeoutMs: 10_000,
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
    input: z.object({ runId: idSchema, reviewDigest: sha256Schema, idempotencyKey: idempotencyKeySchema }),
    output: z.object({
      runId: idSchema,
      status: z.enum(brainPackImportRunStatuses),
      jobId: idSchema.nullable(),
    }),
  }),
  knowledge_packs_runs_list: contract({
    description: "List import and export runs the account may see, newest first.",
    minimumRole: "admin",
    timeoutMs: 10_000,
    annotations: readAnnotations,
    input: z.object({
      kind: z.enum(brainPackRunKinds).nullable(),
      status: runStatusSchema.nullable(),
      cursor: cursorSchema,
      limit: limitSchema,
    }),
    output: z.object({ items: z.array(brainPackRunSummarySchema), nextCursor: cursorSchema }),
  }),
  knowledge_packs_runs_cancel: contract({
    description: "Request cancellation of an active run. Cancellation stops publication before the final transaction commits; a completed run reports that it already finished.",
    minimumRole: "admin",
    timeoutMs: 10_000,
    annotations: localMutation,
    input: z.object({ runId: idSchema, idempotencyKey: idempotencyKeySchema }),
    output: z.object({ runId: idSchema, status: runStatusSchema, canceled: z.boolean() }),
  }),
  knowledge_packs_runs_retry: contract({
    description: "Resume a failed run from its recorded stage using the same validated snapshot.",
    minimumRole: "admin",
    timeoutMs: 10_000,
    annotations: localMutation,
    input: z.object({ runId: idSchema, idempotencyKey: idempotencyKeySchema }),
    output: z.object({ runId: idSchema, status: runStatusSchema }),
  }),
} as const;

export type BrainPackCapabilityId = keyof typeof brainPackCapabilityContracts;
export type BrainPackCapabilityInput<Id extends BrainPackCapabilityId> = z.infer<(typeof brainPackCapabilityContracts)[Id]["input"]>;
export type BrainPackCapabilityOutput<Id extends BrainPackCapabilityId> = z.infer<(typeof brainPackCapabilityContracts)[Id]["output"]>;
export type BrainPackRunSummary = z.infer<typeof brainPackRunSummarySchema>;
export type BrainPackPreview = z.infer<typeof brainPackPreviewSchema>;
export type BrainPackRunItem = z.infer<typeof brainPackRunItemSchema>;
