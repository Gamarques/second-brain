import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  activityEventActions,
  activityEventEntityTypes,
  activityKinds,
  activityTimeBases,
  automationJobKinds,
  automationJobStatuses,
  decisionStatuses,
  dreamingInsightKinds,
  dreamingModes,
  goalStatuses,
  ingestRunStatuses,
  insightConfidences,
  mutationSources,
  projectStatuses,
  taskPriorities,
  taskRelationKinds,
  taskStatuses,
} from "../domain.js";
import type { AuthenticatedPrincipal, CursorPosition } from "../domain.js";

export const idSchema = z.string().uuid();
export const timestampSchema = z.string().datetime({ offset: true });
export const localDateSchema = z.string().date();
export const nullableTextSchema = z.string().trim().max(10_000).nullable();
export const idempotencyKeySchema = z.string().trim().min(1).max(200);

const actorSourceShape = { source: z.enum(mutationSources) } as const;
const nullableClientIdSchema = z.string().min(1).max(500).nullable();

export const actorAttributionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...actorSourceShape,
    kind: z.literal("account"),
    accountId: idSchema.nullable(),
    clientId: z.null(),
  }),
  z
    .object({
      ...actorSourceShape,
      kind: z.literal("oauth_client"),
      accountId: idSchema.nullable(),
      clientId: nullableClientIdSchema,
    })
    .superRefine((actor, context) => {
      if ((actor.accountId === null) !== (actor.clientId === null)) {
        context.addIssue({
          code: "custom",
          message:
            "Historical OAuth attribution must retain or redact both IDs.",
        });
      }
    }),
  z.object({
    ...actorSourceShape,
    kind: z.literal("import"),
    accountId: idSchema.nullable(),
    clientId: z.null(),
  }),
  z.object({
    ...actorSourceShape,
    kind: z.enum(["dreaming", "system"]),
    accountId: z.null(),
    clientId: z.null(),
  }),
]);

const requestProvenanceShape = {
  requestId: z.string().min(1).max(500),
  correlationId: z.string().min(1).max(500).nullable(),
  causationId: z.string().min(1).max(500).nullable(),
  dreamingRunId: idSchema.nullable(),
} as const;

export const actorProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({
    ...actorSourceShape,
    ...requestProvenanceShape,
    kind: z.literal("account"),
    accountId: idSchema,
    clientId: z.null(),
    dreamingRunId: z.null(),
  }),
  z.object({
    ...actorSourceShape,
    ...requestProvenanceShape,
    kind: z.literal("oauth_client"),
    accountId: idSchema,
    clientId: z.string().min(1).max(500),
    dreamingRunId: z.null(),
  }),
  z.object({
    ...actorSourceShape,
    ...requestProvenanceShape,
    kind: z.literal("import"),
    accountId: idSchema,
    clientId: z.null(),
    dreamingRunId: z.null(),
  }),
  z.object({
    ...actorSourceShape,
    ...requestProvenanceShape,
    kind: z.literal("dreaming"),
    accountId: z.null(),
    clientId: z.null(),
    causationId: z.string().min(1).max(500),
    dreamingRunId: idSchema,
  }),
  z.object({
    ...actorSourceShape,
    ...requestProvenanceShape,
    kind: z.literal("system"),
    accountId: z.null(),
    clientId: z.null(),
    dreamingRunId: z.null(),
  }),
]);

export const taskListSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  description: nullableTextSchema,
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const taskGoalLinkSchema = z.object({
  goalId: idSchema,
  basis: z.enum(["explicit", "reviewed_inference", "model_inference"]),
  confidence: z.number().min(0).max(1).nullable(),
});

export const taskSchema = z.object({
  id: idSchema,
  listId: idSchema,
  title: z.string().trim().min(1).max(500),
  description: nullableTextSchema,
  status: z.enum(taskStatuses),
  priority: z.enum(taskPriorities),
  dueAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  projectId: idSchema.nullable(),
  goalLinks: z.array(taskGoalLinkSchema).max(20),
  version: z.number().int().positive(),
  historyCompleteFrom: timestampSchema,
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const taskRelationSchema = z.object({
  id: idSchema,
  fromTaskId: idSchema,
  toTaskId: idSchema,
  kind: z.enum(taskRelationKinds),
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
  retractedAt: timestampSchema.nullable(),
});

export const memorySchema = z.object({
  id: idSchema,
  lineageId: idSchema,
  version: z.number().int().positive(),
  supersedesId: idSchema.nullable(),
  content: z.string().trim().min(1).max(10_000),
  category: z.string().trim().min(1).max(100).nullable(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20),
  projectId: idSchema.nullable(),
  personIds: z.array(idSchema).max(20),
  effectiveAt: timestampSchema,
  capturedAt: timestampSchema.nullable(),
  supersededBy: idSchema.nullable(),
  supersededAt: timestampSchema.nullable(),
  provenance: actorAttributionSchema,
  sourceExcerpt: z.string().max(2_000).nullable(),
  contentHash: z.string().min(1).max(200),
  createdAt: timestampSchema,
});

export const memoryWithDeduplicationSchema = memorySchema.extend({
  deduplication: z
    .object({
      supersededMemoryId: idSchema,
      similarity: z.number().min(-1).max(1),
    })
    .nullable(),
});

export const reminderSchema = z.object({
  id: idSchema,
  message: z.string().trim().min(1).max(2_000),
  remindAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  version: z.number().int().positive(),
  historyCompleteFrom: timestampSchema,
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const rejectedAlternativeSchema = z.object({
  option: z.string().trim().min(1).max(300),
  reason: z.string().trim().min(1).max(500).nullable(),
});

export const decisionSchema = z.object({
  id: idSchema,
  lineageId: idSchema,
  version: z.number().int().positive(),
  supersedesId: idSchema.nullable(),
  statement: z.string().trim().min(1).max(2_000),
  rationale: z.string().trim().min(1).max(10_000),
  rejectedAlternatives: z.array(rejectedAlternativeSchema).max(20),
  status: z.enum(decisionStatuses),
  projectId: idSchema.nullable(),
  personIds: z.array(idSchema).max(20),
  decidedAt: timestampSchema,
  revokedAt: timestampSchema.nullable(),
  provenance: actorAttributionSchema,
  sourceExcerpt: z.string().max(2_000).nullable(),
  contentHash: z.string().min(1).max(200),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const projectSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  description: nullableTextSchema,
  status: z.enum(projectStatuses),
  version: z.number().int().positive(),
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const personSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  aliases: z.array(z.string().trim().min(1).max(300)).max(50),
  notes: nullableTextSchema,
  summary: z.string().trim().min(1).max(1_000).nullable(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20),
  projectIds: z.array(idSchema).max(50),
  knowledgeBaseIds: z.array(idSchema).max(50),
  version: z.number().int().positive(),
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const knowledgeBaseCatalogEntrySchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  description: nullableTextSchema,
});

export const personIndexEntrySchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  aliases: z.array(z.string().trim().min(1).max(300)).max(50),
  summary: z.string().trim().min(1).max(1_000).nullable(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20),
  relatedProjects: z
    .array(
      z.object({
        id: idSchema,
        name: z.string().trim().min(1).max(300),
      }),
    )
    .max(50),
  relatedKnowledgeBases: z.array(knowledgeBaseCatalogEntrySchema).max(50),
});

export const knowledgeBaseSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  description: nullableTextSchema,
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const knowledgeDocumentSchema = z.object({
  id: idSchema,
  knowledgeBaseId: idSchema,
  currentRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(500),
  sourceUri: z.string().url().nullable(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20),
  projectId: idSchema.nullable(),
  personIds: z.array(idSchema).max(20),
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const knowledgeDocumentRevisionSchema = z.object({
  id: idSchema,
  documentId: idSchema,
  version: z.number().int().positive(),
  contentHash: z.string().min(1).max(200),
  chunkCount: z.number().int().nonnegative(),
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
});

/** Where a revision came from when a Brain Pack published it; absent for locally written revisions. */
export const knowledgeRevisionOriginSchema = z.object({
  publisher: z.object({ namespace: z.string().min(1).max(200), displayName: z.string().min(1).max(200) }),
  packId: idSchema,
  packRevision: z.number().int().positive(),
  packTitle: z.string().min(1).max(500),
  itemKey: z.string().min(1).max(120),
  authors: z.array(z.object({ name: z.string().min(1).max(200), uri: z.string().max(2_000).nullable() })).max(20),
});

export const knowledgeContentRepresentationSchema = z.enum(["canonical", "reconstructed"]);

export const knowledgeDocumentRevisionWithContentSchema =
  knowledgeDocumentRevisionSchema.extend({
    content: z.string().min(1).max(1_000_000),
    representation: knowledgeContentRepresentationSchema,
    origin: knowledgeRevisionOriginSchema.nullable(),
  });

export const temporalCoverageSchema = z.object({
  completeFrom: timestampSchema.nullable(),
  requestedAsOf: timestampSchema.nullable(),
  complete: z.boolean(),
  warnings: z.array(z.string().max(500)).max(20),
});

export const ingestRunSchema = z.object({
  id: idSchema,
  sourceId: idSchema,
  status: z.enum(ingestRunStatuses),
  proposalProvider: z.string().trim().min(1).max(200),
  proposalModel: z.string().trim().min(1).max(300),
  schemaVersion: z.string().trim().min(1).max(100),
  proposalCount: z.number().int().nonnegative(),
  proposalDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  responseDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  reviewedDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const activityGoalAllocationSchema = z.object({
  goalId: idSchema,
  allocationPercent: z.number().positive().max(100),
});

export const activityEventSchema = z.object({
  id: idSchema,
  entityType: z.enum(activityEventEntityTypes),
  entityId: idSchema,
  action: z.enum(activityEventActions),
  occurredAt: timestampSchema,
  effectiveAt: timestampSchema,
  changedFields: z.array(z.string().min(1).max(100)).max(100),
  afterVersionId: idSchema.nullable(),
  contentHash: z.string().min(1).max(200).nullable(),
  analysisAllowed: z.boolean(),
  idempotencyKey: idempotencyKeySchema,
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  provenance: actorProvenanceSchema,
  recordedAt: timestampSchema,
});

export const activitySchema = z.object({
  id: idSchema,
  kind: z.enum(activityKinds),
  occurredAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  timeBasis: z.enum(activityTimeBases),
  taskId: idSchema.nullable(),
  projectId: idSchema.nullable(),
  summary: z.string().trim().min(1).max(2_000).nullable(),
  analysisAllowed: z.boolean(),
  allocations: z.array(activityGoalAllocationSchema).max(20),
  idempotencyKey: idempotencyKeySchema,
  provenance: actorAttributionSchema,
  recordedAt: timestampSchema,
  retractedAt: timestampSchema.nullable(),
  retractionReason: z.string().trim().min(1).max(500).nullable(),
});

export const goalSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(500),
  description: nullableTextSchema,
  successCriteria: nullableTextSchema,
  status: z.enum(goalStatuses),
  targetAt: timestampSchema.nullable(),
  projectId: idSchema.nullable(),
  version: z.number().int().positive(),
  historyCompleteFrom: timestampSchema,
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const priorityPlanItemSchema = z.object({
  goalId: idSchema,
  rank: z.number().int().positive(),
  intendedSharePercent: z.number().positive().max(100).nullable(),
});

export const priorityPlanSchema = z.object({
  id: idSchema,
  projectId: idSchema.nullable(),
  periodStart: timestampSchema,
  periodEnd: timestampSchema,
  version: z.number().int().positive(),
  currentVersionId: idSchema,
  items: z.array(priorityPlanItemSchema).min(1).max(20),
  note: nullableTextSchema,
  provenance: actorAttributionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const dreamingReportCitationSchema = z.object({
  type: z.enum([
    "memory",
    "decision",
    "task",
    "reminder",
    "goal",
    "priority_plan",
    "activity",
    "activity_summary",
  ]),
  id: idSchema,
  versionId: idSchema.nullable(),
  excerpt: z.string().max(300),
});

export const dreamingReportInsightSchema = z.object({
  kind: z.enum(dreamingInsightKinds),
  statement: z.string().trim().min(1).max(2_000),
  confidence: z.enum(insightConfidences),
  evidence: z.array(dreamingReportCitationSchema).min(1).max(5),
});

export const dreamingReportSchema = z.object({
  id: idSchema,
  runId: idSchema,
  localDate: localDateSchema,
  generatedAt: timestampSchema,
  mode: z.enum(dreamingModes),
  status: z.enum(["completed", "completed_with_skips"]),
  summary: z.string().max(2_000),
  insights: z.array(dreamingReportInsightSchema).max(10),
  memoriesCreated: z
    .array(z.object({ id: idSchema, content: z.string().min(1).max(10_000) }))
    .max(20),
  memoriesUpdated: z
    .array(
      z.object({
        id: idSchema,
        previousMemoryId: idSchema,
        content: z.string().min(1).max(10_000),
      }),
    )
    .max(20),
  skipped: z.array(z.object({ reason: z.string().min(1).max(500) })).max(20),
  coverageWarnings: z.array(z.string().max(500)).max(20),
});

export const automationJobSchema = z.object({
  id: idSchema,
  kind: z.enum(automationJobKinds),
  canonicalKey: z.string().min(1).max(300),
  scheduledFor: timestampSchema,
  status: z.enum(automationJobStatuses),
  attemptCount: z.number().int().nonnegative(),
  nextAttemptAt: timestampSchema.nullable(),
  leaseOwner: z.string().min(1).max(300).nullable(),
  leaseExpiresAt: timestampSchema.nullable(),
  fencingToken: z.string().min(1).max(300).nullable(),
  cancelRequestedAt: timestampSchema.nullable(),
  sanitizedError: z.string().max(2_000).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const automationJobKindsFilterSchema = z
  .array(z.enum(automationJobKinds))
  .min(1);

export const cursorSchema = z
  .string()
  .min(1)
  .max(500)
  .superRefine((value, context) => {
    if (parseCursor(value) === null) {
      context.addIssue({ code: "custom", message: "The cursor is invalid." });
    }
  });

export function uniqueIdsSchema(maximum: number) {
  return z
    .array(idSchema)
    .max(maximum)
    .superRefine((ids, context) => {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: "custom",
          message: "IDs must not contain duplicates.",
        });
      }
    });
}

export function requireAuthenticatedPrincipal(
  principal: AuthenticatedPrincipal | null,
): AuthenticatedPrincipal {
  if (principal === null)
    throw new Error("An authenticated principal is required.");
  return principal;
}

export function requireFound<T>(value: T | null, resource: string): T {
  if (value === null) throw new Error(`${resource} was not found.`);
  return value;
}

export { requireEmbedding } from "../domain/knowledge-indexing.js";

export function encodeCursor(cursor: CursorPosition): string {
  return Buffer.from(`${cursor.ts}|${cursor.id}`, "utf8").toString("base64url");
}

function parseCursor(value: string): CursorPosition | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== value) return null;
  const separator = decoded.indexOf("|");
  const ts = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (
    separator <= 0 ||
    separator !== decoded.lastIndexOf("|") ||
    !timestampSchema.safeParse(ts).success ||
    !idSchema.safeParse(id).success
  ) {
    return null;
  }
  return { ts, id };
}

export function decodeCursor(value: string): CursorPosition {
  const cursor = parseCursor(value);
  if (cursor === null) throw new Error("The cursor is invalid.");
  return cursor;
}
