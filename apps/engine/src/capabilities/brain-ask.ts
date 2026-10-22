import { EngineError } from "@invokta/core";
import { z } from "zod";

import {
  DECISION_EMBEDDING_RECIPE_VERSION,
  MEMORY_EMBEDDING_RECIPE_VERSION,
  evidenceTypes,
  sha256Hex,
} from "../domain.js";
import type {
  AnswerProvider,
  BrainAccessContext,
  BrainAccessStore,
  BrainEvidenceStore,
  ContentEmbedding,
  EmbeddingEntityType,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
  EvidenceItem,
  TemporalCoverage,
} from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  idSchema,
  requireEmbedding,
  temporalCoverageSchema,
  timestampSchema,
} from "./schemas.js";

const evidenceLimits = {
  memories: 12,
  decisions: 8,
  tasks: 8,
  reminders: 5,
  goals: 8,
  priorities: 4,
  activities: 12,
} as const;
const evidenceScoreFloor = 0.25;
const evidenceCharacterBudget = 12_000;
const evidenceExcerptLimit = 700;
const noEvidenceAnswer =
  "Your second brain has no recorded information that answers this.";

const evidenceItemSchema = z.object({
  type: z.enum(evidenceTypes),
  id: idSchema,
  versionId: idSchema.nullable(),
  content: z.string().trim().min(1),
  score: z.number().finite().min(0).max(1),
  effectiveAt: timestampSchema,
  recordedAt: timestampSchema,
  supersededAt: timestampSchema.nullable(),
  sourceIds: z.array(idSchema).max(50),
});

const evidenceCitationSchema = z.object({
  type: z.enum(evidenceTypes),
  id: idSchema,
  versionId: idSchema.nullable(),
  excerpt: z.string().min(1).max(evidenceExcerptLimit),
  score: z.number().min(0).max(1),
  effectiveAt: timestampSchema,
  recordedAt: timestampSchema,
  supersededAt: timestampSchema.nullable(),
  sourceIds: z.array(idSchema).max(50),
});

const brainAskOutputSchema = z.object({
  answer: z.string().trim().min(1).max(20_000),
  confidence: z.enum(["none", "low", "high"]),
  coverage: temporalCoverageSchema,
  citations: z.array(evidenceCitationSchema).max(30),
});
const reasonedAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(20_000),
    answerable: z.boolean(),
    citationIndexes: z.array(z.number()).max(30),
  })
  .strict();
type BrainAskOutput = z.infer<typeof brainAskOutputSchema>;
type BrainAskCoverage = BrainAskOutput["coverage"];

function emptyBrainAnswer(coverage: BrainAskCoverage): BrainAskOutput {
  return {
    answer: noEvidenceAnswer,
    confidence: "none",
    coverage,
    citations: [],
  };
}

function canonicalRequestedAsOf(
  requestedAsOf: string | null,
  referenceTime: string,
): string | null {
  if (requestedAsOf === null) return null;
  const canonical = new Date(requestedAsOf).toISOString();
  if (canonical > referenceTime) {
    throw new EngineError({
      code: "INPUT_INVALID",
      message: "asOf must not be in the future.",
      publicDetails: { field: "asOf" },
    });
  }
  return canonical;
}

function compatibleSpace(
  provider: EmbeddingProvider,
  space: EmbeddingSpace | null,
  entityType: EmbeddingEntityType,
  recipeVersion: string,
): EmbeddingSpace | null {
  if (space === null) return null;
  if (
    space.entityType !== entityType ||
    space.status !== "active" ||
    space.provider !== provider.provider ||
    space.model !== provider.model ||
    space.modelRevision !== provider.modelRevision ||
    space.recipeVersion !== recipeVersion ||
    space.dimensions !== provider.dimensions
  ) {
    throw new Error(
      "An active embedding space is incompatible with the configured provider.",
    );
  }
  return space;
}

async function queryEmbeddings(
  access: BrainAccessContext,
  question: string,
  spaces: EmbeddingSpaceStore,
  provider: EmbeddingProvider,
  signal: AbortSignal,
): Promise<{
  readonly memories: ContentEmbedding | null;
  readonly decisions: ContentEmbedding | null;
  readonly insights: null;
}> {
  const [memorySpace, decisionSpace] = await Promise.all([
    spaces.getActiveSpace(access, "memory", signal),
    spaces.getActiveSpace(access, "decision", signal),
  ]);
  const compatibleMemorySpace = compatibleSpace(
    provider,
    memorySpace,
    "memory",
    MEMORY_EMBEDDING_RECIPE_VERSION,
  );
  const compatibleDecisionSpace = compatibleSpace(
    provider,
    decisionSpace,
    "decision",
    DECISION_EMBEDDING_RECIPE_VERSION,
  );
  if (compatibleMemorySpace === null && compatibleDecisionSpace === null) {
    return { memories: null, decisions: null, insights: null };
  }

  const vectors = await provider.embed([question], signal, "search_query");
  if (vectors.length !== 1) {
    throw new Error("The embedding provider returned an invalid vector batch.");
  }
  const vector = requireEmbedding(vectors[0], provider.dimensions);
  const hash = sha256Hex(question);
  return {
    memories:
      compatibleMemorySpace === null
        ? null
        : { spaceId: compatibleMemorySpace.id, contentHash: hash, vector },
    decisions:
      compatibleDecisionSpace === null
        ? null
        : { spaceId: compatibleDecisionSpace.id, contentHash: hash, vector },
    insights: null,
  };
}

function truncateExcerpt(content: string): string {
  if (content.length <= evidenceExcerptLimit) return content;
  const slice = content.slice(0, evidenceExcerptLimit);
  let boundary = -1;
  for (let index = slice.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(slice[index]!)) {
      boundary = index;
      break;
    }
  }
  return boundary > 0
    ? `${slice.slice(0, boundary)}…`
    : `${content.slice(0, evidenceExcerptLimit - 1)}…`;
}

function compareEvidence(left: EvidenceItem, right: EvidenceItem): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.effectiveAt !== right.effectiveAt) {
    return right.effectiveAt.localeCompare(left.effectiveAt);
  }
  if (left.recordedAt !== right.recordedAt) {
    return right.recordedAt.localeCompare(left.recordedAt);
  }
  return `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`);
}

function isVisibleAt(item: EvidenceItem, cutoff: string): boolean {
  return (
    item.effectiveAt <= cutoff &&
    item.recordedAt <= cutoff &&
    (item.supersededAt === null || item.supersededAt > cutoff)
  );
}

function prepareEvidence(
  untrustedEvidence: readonly EvidenceItem[],
  cutoff: string,
  topK: number,
): readonly EvidenceItem[] {
  const seen = new Set<string>();
  const evidence = untrustedEvidence
    .map((item) => evidenceItemSchema.parse(item))
    .filter(
      (item) => item.score >= evidenceScoreFloor && isVisibleAt(item, cutoff),
    )
    .sort(compareEvidence)
    .filter((item) => {
      const key = `${item.type}:${item.id}:${item.versionId ?? "current"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, topK)
    .map((item): EvidenceItem => ({
      ...item,
      content: truncateExcerpt(item.content),
    }));

  let totalLength = evidence.reduce(
    (sum, item) => sum + item.content.length,
    0,
  );
  while (totalLength > evidenceCharacterBudget) {
    totalLength -= evidence.pop()!.content.length;
  }
  return evidence;
}

function confidenceFor(
  evidence: readonly EvidenceItem[],
  coverage: TemporalCoverage,
): "low" | "high" {
  const strongestScore = evidence.reduce(
    (strongest, item) => Math.max(strongest, item.score),
    0,
  );
  return !coverage.complete || evidence.length < 2 || strongestScore < 0.5
    ? "low"
    : "high";
}

function citedEvidence(
  evidence: readonly EvidenceItem[],
  citationIndexes: readonly number[],
): readonly EvidenceItem[] {
  if (
    !Array.isArray(citationIndexes) ||
    citationIndexes.length === 0 ||
    citationIndexes.some(
      (index) =>
        !Number.isInteger(index) || index < 1 || index > evidence.length,
    )
  ) {
    throw new Error(
      "Answer provider returned invalid one-based citation indexes.",
    );
  }
  const seen = new Set<number>();
  const cited: EvidenceItem[] = [];
  for (const index of citationIndexes) {
    if (seen.has(index)) continue;
    seen.add(index);
    cited.push(evidence[index - 1]!);
  }
  return cited;
}

export function createBrainAskCapabilities(
  accessStore: BrainAccessStore,
  evidenceStore: BrainEvidenceStore,
  embeddingSpaces: EmbeddingSpaceStore,
  embeddings: EmbeddingProvider,
  answers: AnswerProvider,
) {
  const askBrain = defineCapability({
    title: "Ask the second brain",
    description:
      "Answers from temporally valid memories, decisions, open loops, goals, priorities, and recorded activities with grounded citations and explicit coverage. It does not search knowledge bases or the people index. Use brain_search for documents and people, especially who/what questions.",
    input: z.object({
      question: z.string().trim().min(1).max(5_000),
      asOf: timestampSchema.nullable().default(null),
      projectId: idSchema.nullable().default(null),
      topK: z.number().int().min(1).max(30).default(12),
    }),
    output: brainAskOutputSchema,
    access: "authenticated",
    timeoutMs: 120_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    async run({ input, context }) {
      const referenceTime = new Date().toISOString();
      const requestedAsOf = canonicalRequestedAsOf(input.asOf, referenceTime);
      let access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const queryVectors = await queryEmbeddings(
        access,
        input.question,
        embeddingSpaces,
        embeddings,
        context.signal,
      );

      access = await accessStore.revalidateAccess(
        access,
        "viewer",
        context.signal,
      );
      const result = await evidenceStore.searchEvidence(
        access,
        {
          embeddings: queryVectors,
          query: input.question,
          asOf: requestedAsOf,
          projectId: input.projectId,
          limits: evidenceLimits,
        },
        context.signal,
      );
      const coverage = temporalCoverageSchema.parse(result.coverage);
      if (coverage.requestedAsOf !== requestedAsOf) {
        throw new Error(
          "The evidence store returned coverage for a different time.",
        );
      }
      const evidence = prepareEvidence(
        result.evidence,
        requestedAsOf ?? referenceTime,
        input.topK,
      );
      if (evidence.length === 0) return emptyBrainAnswer(coverage);

      access = await accessStore.revalidateAccess(
        access,
        "viewer",
        context.signal,
      );
      const retrievedConfidence = confidenceFor(evidence, coverage);
      const reasoned = reasonedAnswerSchema.parse(
        await answers.reason(
          {
            question: input.question,
            evidence,
            coverage,
            referenceTime,
            asOf: requestedAsOf,
            confidence: retrievedConfidence,
          },
          context.signal,
        ),
      );
      if (!reasoned.answerable) return emptyBrainAnswer(coverage);

      const citations = citedEvidence(evidence, reasoned.citationIndexes);
      return {
        answer: reasoned.answer,
        confidence: confidenceFor(citations, coverage),
        coverage,
        citations: citations.map((item) => ({
          type: item.type,
          id: item.id,
          versionId: item.versionId,
          excerpt: item.content,
          score: item.score,
          effectiveAt: item.effectiveAt,
          recordedAt: item.recordedAt,
          supersededAt: item.supersededAt,
          sourceIds: [...item.sourceIds],
        })),
      };
    },
  });

  return { brain_ask: askBrain } as const;
}
