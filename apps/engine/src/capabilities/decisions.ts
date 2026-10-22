import { z } from "zod";

import {
  DECISION_EMBEDDING_RECIPE_VERSION,
  decisionEmbeddingRecipe,
  decisionStatuses,
} from "../domain.js";
import type {
  BrainAccessContext,
  BrainAccessStore,
  ContentEmbedding,
  Decision,
  DecisionStore,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
} from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  cursorSchema,
  decisionSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  idSchema,
  rejectedAlternativeSchema,
  requireEmbedding,
  timestampSchema,
  uniqueIdsSchema,
} from "./schemas.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

function writableDecision(decision: Decision) {
  return {
    ...decision,
    rejectedAlternatives: decision.rejectedAlternatives.map((item) => ({
      ...item,
    })),
    personIds: [...decision.personIds],
  };
}

function assertActiveSpace(
  space: EmbeddingSpace | null,
  embeddings: EmbeddingProvider,
): EmbeddingSpace {
  if (
    space === null ||
    space.entityType !== "decision" ||
    space.status !== "active" ||
    space.metric !== "cosine" ||
    space.provider !== embeddings.provider ||
    space.model !== embeddings.model ||
    space.modelRevision !== embeddings.modelRevision ||
    space.recipeVersion !== DECISION_EMBEDDING_RECIPE_VERSION ||
    space.dimensions !== embeddings.dimensions
  ) {
    throw new Error(
      "The active decision embedding space does not match the provider.",
    );
  }
  return space;
}

async function embedDecision(
  access: BrainAccessContext,
  embeddingSpaces: EmbeddingSpaceStore,
  embeddings: EmbeddingProvider,
  input: Parameters<typeof decisionEmbeddingRecipe>[0],
  signal: AbortSignal,
): Promise<ContentEmbedding> {
  const space = assertActiveSpace(
    await embeddingSpaces.getActiveSpace(access, "decision", signal),
    embeddings,
  );
  const recipe = decisionEmbeddingRecipe(input);
  const vectors = await embeddings.embed(
    [recipe.text],
    signal,
    "search_document",
  );
  return {
    spaceId: space.id,
    contentHash: recipe.contentHash,
    vector: requireEmbedding(vectors[0], space.dimensions),
  };
}

const supersessionRefinement = (
  value: {
    readonly supersedes: string | null;
    readonly expectedSupersededHash: string | null;
    readonly expectedSupersededVersion: number | null;
  },
  context: z.RefinementCtx,
): void => {
  const hasTarget = value.supersedes !== null;
  const hasHash = value.expectedSupersededHash !== null;
  const hasVersion = value.expectedSupersededVersion !== null;
  if (!(hasTarget === hasHash && hasHash === hasVersion)) {
    context.addIssue({
      code: "custom",
      message:
        "supersedes, expectedSupersededHash, and expectedSupersededVersion must be provided together.",
    });
  }
};

export function createDecisionCapabilities(
  accessStore: BrainAccessStore,
  decisions: DecisionStore,
  embeddingSpaces: EmbeddingSpaceStore,
  embeddings: EmbeddingProvider,
) {
  const createDecision = defineCapability({
    title: "Record a decision",
    description:
      "Records a decision and its rationale, optionally superseding an exact reviewed version under atomic hash and version preconditions. Omit projectId to record a general decision not tied to a project.",
    input: z
      .object({
        statement: z.string().trim().min(1).max(2_000),
        rationale: z.string().trim().min(1).max(10_000),
        rejectedAlternatives: z
          .array(rejectedAlternativeSchema)
          .max(20)
          .default([]),
        projectId: idSchema.nullable().default(null),
        personIds: uniqueIdsSchema(20).default([]),
        decidedAt: timestampSchema.nullable().default(null),
        supersedes: idSchema.nullable().default(null),
        expectedSupersededHash: sha256Schema.nullable().default(null),
        expectedSupersededVersion: z
          .number()
          .int()
          .positive()
          .nullable()
          .default(null),
        idempotencyKey: idempotencyKeySchema,
      })
      .superRefine(supersessionRefinement),
    output: decisionSchema,
    access: "authenticated",
    timeoutMs: 30_000,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const embedding = await embedDecision(
        access,
        embeddingSpaces,
        embeddings,
        {
          statement: input.statement,
          rationale: input.rationale,
          rejectedAlternatives: input.rejectedAlternatives,
        },
        context.signal,
      );
      const supersession =
        input.supersedes === null
          ? ({
              supersedesId: null,
              expectedSupersededHash: null,
              expectedSupersededVersion: null,
            } as const)
          : ({
              supersedesId: input.supersedes,
              expectedSupersededHash: input.expectedSupersededHash!,
              expectedSupersededVersion: input.expectedSupersededVersion!,
            } as const);
      const decision = await decisions.createDecision(
        access,
        {
          statement: input.statement,
          rationale: input.rationale,
          rejectedAlternatives: input.rejectedAlternatives,
          projectId: input.projectId,
          personIds: input.personIds,
          decidedAt: input.decidedAt ?? new Date().toISOString(),
          sourceExcerpt: null,
          embedding,
          idempotencyKey: input.idempotencyKey,
          ...supersession,
        },
        context.signal,
      );
      if (decision === null) {
        throw new Error(
          "A linked record or superseded decision was not found, or its precondition is stale.",
        );
      }
      return writableDecision(decision);
    },
  });

  const listDecisions = defineCapability({
    title: "List decisions",
    description:
      "Lists decisions with status, context, as-of history, and cursor filters.",
    input: z.object({
      status: z.enum(decisionStatuses).nullable().default(null),
      projectId: idSchema.nullable().default(null),
      personId: idSchema.nullable().default(null),
      asOf: timestampSchema.nullable().default(null),
      includeSuperseded: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: cursorSchema.nullable().default(null),
    }),
    output: z.object({
      decisions: z.array(decisionSchema),
      nextCursor: cursorSchema.nullable(),
    }),
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const result = await decisions.listDecisions(
        access,
        {
          status: input.status,
          projectId: input.projectId,
          personId: input.personId,
          asOf: input.asOf,
          includeSuperseded: input.includeSuperseded,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        decisions: result.items.map(writableDecision),
        nextCursor:
          result.nextCursor === null ? null : encodeCursor(result.nextCursor),
      };
    },
  });

  const revokeDecision = defineCapability({
    title: "Revoke a decision",
    description:
      "Revokes the current active decision version under an optimistic version precondition while retaining as-of history.",
    input: z.object({
      id: idSchema,
      expectedVersion: z.number().int().positive(),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: decisionSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const decision = await decisions.revokeDecision(
        access,
        input.id,
        {
          expectedVersion: input.expectedVersion,
          idempotencyKey: input.idempotencyKey,
        },
        context.signal,
      );
      if (decision === null) {
        throw new Error(
          "Decision was not found, is not active, or its version is stale.",
        );
      }
      return writableDecision(decision);
    },
  });

  return {
    decisions_create: createDecision,
    decisions_list: listDecisions,
    decisions_revoke: revokeDecision,
  } as const;
}
