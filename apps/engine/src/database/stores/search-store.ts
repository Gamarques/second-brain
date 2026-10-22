import {
  and,
  asc,
  cosineDistance,
  eq,
  ilike,
  inArray,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
  MEMORY_EMBEDDING_RECIPE_VERSION,
  brainSearchGuidance,
  lexicalMatchScore,
} from "../../domain.js";
import type {
  BrainAccessContext,
  BrainSearchHit,
  BrainSearchResult,
  BrainSearchStore,
  BrainSearchSuggestion,
  ContentEmbedding,
  KnowledgeBaseCatalogEntry,
  PersonIndexEntry,
} from "../../domain.js";
import {
  decisions,
  knowledgeBases,
  knowledgeChunks,
  knowledgeDocumentRevisions,
  knowledgeDocuments,
  memories,
  people,
  personKnowledgeBases,
  personProjects,
  projects,
  tasks,
} from "../schema/content.js";
import {
  knowledgeChunkEmbeddings,
  memoryEmbeddings,
} from "../schema/embeddings.js";
import { goals } from "../schema/temporal.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type { SecondBrainDatabase } from "./database.js";
import { loadPersonRelations } from "./person-store.js";

const SCORE_FLOOR = 0.25;
const MAX_PER_SOURCE = 20;
const excerptLimit = 700;
const successorMemories = alias(memories, "search_memory_successor");

function clipExcerpt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= excerptLimit) return trimmed;
  return `${trimmed.slice(0, excerptLimit - 1)}…`;
}

function requireTitle(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : fallback;
}

function likePattern(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function hit(
  partial: Omit<BrainSearchHit, "personIds" | "tags"> & {
    readonly personIds?: readonly string[];
    readonly tags?: readonly string[];
  },
): BrainSearchHit | null {
  if (partial.score < SCORE_FLOOR) return null;
  const excerpt = clipExcerpt(partial.excerpt);
  const title = requireTitle(partial.title, partial.sourceType);
  if (excerpt.length === 0) return null;
  return {
    ...partial,
    title,
    excerpt,
    score: Math.min(1, Math.max(0, partial.score)),
    personIds: partial.personIds ?? [],
    tags: partial.tags ?? [],
  };
}

function mergeHits(
  groups: readonly (readonly (BrainSearchHit | null)[])[],
  limit: number,
): BrainSearchHit[] {
  const seen = new Set<string>();
  return groups
    .flat()
    .filter((item): item is BrainSearchHit => item !== null)
    .sort(
      (left, right) =>
        right.score - left.score ||
        `${left.sourceType}:${left.id}`.localeCompare(`${right.sourceType}:${right.id}`),
    )
    .filter((item) => {
      const key = `${item.sourceType}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export class DrizzleBrainSearchStore implements BrainSearchStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async search(
    access: BrainAccessContext,
    input: Parameters<BrainSearchStore["search"]>[1],
    signal: AbortSignal,
  ): Promise<BrainSearchResult> {
    signal.throwIfAborted();
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new Error("Search limits must be between 1 and 50.");
    }
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "viewer", signal);
      const subjectPattern = likePattern(input.subject);
      const queryPattern = likePattern(input.query);
      const catalogRows = await transaction
        .select({
          id: knowledgeBases.id,
          name: knowledgeBases.name,
          description: knowledgeBases.description,
        })
        .from(knowledgeBases)
        .orderBy(asc(knowledgeBases.createdAt), asc(knowledgeBases.id));
      const knowledgeBasesCatalog: KnowledgeBaseCatalogEntry[] = catalogRows.map(
        (row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
        }),
      );

      const [personRows, projectRows, goalRows, decisionRows, taskRows, memoryRows, chunkRows] =
        await Promise.all([
          transaction
            .select()
            .from(people)
            .where(
              or(
                ilike(people.name, subjectPattern),
                ilike(people.name, queryPattern),
                sql<boolean>`array_to_string(${people.aliases}, ' ') ilike ${subjectPattern}`,
                sql<boolean>`array_to_string(${people.aliases}, ' ') ilike ${queryPattern}`,
              ),
            )
            .orderBy(asc(people.createdAt), asc(people.id))
            .limit(MAX_PER_SOURCE),
          transaction
            .select()
            .from(projects)
            .where(
              and(
                or(
                  ilike(projects.name, subjectPattern),
                  ilike(projects.description, subjectPattern),
                ),
                input.projectId === null
                  ? undefined
                  : eq(projects.id, input.projectId),
              ),
            )
            .limit(MAX_PER_SOURCE),
          transaction
            .select()
            .from(goals)
            .where(
              and(
                or(
                  ilike(goals.title, subjectPattern),
                  ilike(goals.description, subjectPattern),
                ),
                input.projectId === null
                  ? undefined
                  : eq(goals.projectId, input.projectId),
              ),
            )
            .limit(MAX_PER_SOURCE),
          transaction
            .select()
            .from(decisions)
            .where(
              and(
                or(
                  ilike(decisions.statement, subjectPattern),
                  ilike(decisions.rationale, subjectPattern),
                ),
                input.projectId === null
                  ? undefined
                  : eq(decisions.projectId, input.projectId),
              ),
            )
            .limit(MAX_PER_SOURCE),
          transaction
            .select()
            .from(tasks)
            .where(
              and(
                or(ilike(tasks.title, subjectPattern), ilike(tasks.description, subjectPattern)),
                input.projectId === null ? undefined : eq(tasks.projectId, input.projectId),
              ),
            )
            .limit(MAX_PER_SOURCE),
          transaction
            .select()
            .from(memories)
            .where(
              and(
                or(
                  ilike(memories.content, subjectPattern),
                  sql<boolean>`array_to_string(${memories.tags}, ' ') ilike ${subjectPattern}`,
                ),
                input.projectId === null
                  ? undefined
                  : eq(memories.projectId, input.projectId),
                notExists(
                  transaction
                    .select({ id: successorMemories.id })
                    .from(successorMemories)
                    .where(eq(successorMemories.supersedesId, memories.id)),
                ),
              ),
            )
            .limit(MAX_PER_SOURCE),
          transaction
            .select({
              chunkId: knowledgeChunks.id,
              documentId: knowledgeDocuments.id,
              title: knowledgeDocuments.title,
              content: knowledgeChunks.content,
              knowledgeBaseId: knowledgeBases.id,
              knowledgeBaseName: knowledgeBases.name,
              knowledgeBaseDescription: knowledgeBases.description,
              projectId: knowledgeDocuments.projectId,
              tags: knowledgeDocuments.tags,
            })
            .from(knowledgeChunks)
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
                or(
                  ilike(knowledgeChunks.content, subjectPattern),
                  ilike(knowledgeDocuments.title, subjectPattern),
                  ilike(knowledgeBases.name, subjectPattern),
                  ilike(knowledgeBases.description, subjectPattern),
                ),
                input.projectId === null
                  ? undefined
                  : eq(knowledgeDocuments.projectId, input.projectId),
              ),
            )
            .limit(MAX_PER_SOURCE),
        ]);

      let semanticMemoryHits: BrainSearchHit[] = [];
      if (input.embeddings.memories !== null) {
        const distance = cosineDistance(
          memoryEmbeddings.embedding,
          [...input.embeddings.memories.vector],
        );
        const score = sql<number>`greatest(0, least(1, 1 - (${distance})))`;
        const rows = await transaction
          .select({
            id: memories.id,
            content: memories.content,
            score,
            projectId: memories.projectId,
            tags: memories.tags,
          })
          .from(memoryEmbeddings)
          .innerJoin(memories, eq(memories.id, memoryEmbeddings.memoryId))
          .where(
            and(
              eq(memoryEmbeddings.spaceId, input.embeddings.memories.spaceId),
              eq(memoryEmbeddings.recipeVersion, MEMORY_EMBEDDING_RECIPE_VERSION),
              notExists(
                transaction
                  .select({ id: successorMemories.id })
                  .from(successorMemories)
                  .where(eq(successorMemories.supersedesId, memories.id)),
              ),
              input.projectId === null
                ? undefined
                : eq(memories.projectId, input.projectId),
            ),
          )
          .orderBy(asc(distance), asc(memories.id))
          .limit(MAX_PER_SOURCE);
        semanticMemoryHits = rows
          .map((row) =>
            hit({
              sourceType: "memory",
              id: row.id,
              title: "Memory",
              excerpt: row.content,
              score: Number(row.score),
              knowledgeBaseId: null,
              knowledgeBaseName: null,
              projectId: row.projectId,
              tags: row.tags,
            }),
          )
          .filter((item): item is BrainSearchHit => item !== null);
      }

      let semanticKnowledgeHits: BrainSearchHit[] = [];
      if (input.embeddings.knowledge !== null) {
        const distance = cosineDistance(
          knowledgeChunkEmbeddings.embedding,
          [...input.embeddings.knowledge.vector],
        );
        const score = sql<number>`greatest(0, least(1, 1 - (${distance})))`;
        const rows = await transaction
          .select({
            chunkId: knowledgeChunks.id,
            title: knowledgeDocuments.title,
            content: knowledgeChunks.content,
            score,
            knowledgeBaseId: knowledgeBases.id,
            knowledgeBaseName: knowledgeBases.name,
            projectId: knowledgeDocuments.projectId,
            tags: knowledgeDocuments.tags,
          })
          .from(knowledgeChunkEmbeddings)
          .innerJoin(
            knowledgeChunks,
            eq(knowledgeChunks.id, knowledgeChunkEmbeddings.chunkId),
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
              eq(knowledgeChunkEmbeddings.spaceId, input.embeddings.knowledge.spaceId),
              eq(
                knowledgeChunkEmbeddings.recipeVersion,
                KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
              ),
              input.projectId === null
                ? undefined
                : eq(knowledgeDocuments.projectId, input.projectId),
            ),
          )
          .orderBy(asc(distance), asc(knowledgeChunks.id))
          .limit(MAX_PER_SOURCE);
        semanticKnowledgeHits = rows
          .map((row) =>
            hit({
              sourceType: "knowledge_chunk",
              id: row.chunkId,
              title: row.title,
              excerpt: row.content,
              score:
                input.intent === "lookup_person" || input.intent === "lookup_topic"
                  ? Math.min(1, Number(row.score) + 0.05)
                  : Number(row.score),
              knowledgeBaseId: row.knowledgeBaseId,
              knowledgeBaseName: row.knowledgeBaseName,
              projectId: row.projectId,
              tags: row.tags,
            }),
          )
          .filter((item): item is BrainSearchHit => item !== null);
      }

      const personHits = personRows.map((row) =>
        hit({
          sourceType: "person",
          id: row.id,
          title: row.name,
          excerpt: row.summary ?? row.notes ?? row.name,
          score:
            lexicalMatchScore(row.name, input.subject) ||
            Math.max(
              ...row.aliases.map((alias) => lexicalMatchScore(alias, input.subject)),
              0,
            ),
          knowledgeBaseId: null,
          knowledgeBaseName: null,
          projectId: null,
          tags: row.tags,
        }),
      );
      const hits = mergeHits(
        [
          personHits,
          projectRows.map((row) =>
            hit({
              sourceType: "project",
              id: row.id,
              title: row.name,
              excerpt: row.description ?? row.name,
              score: lexicalMatchScore(`${row.name} ${row.description ?? ""}`, input.subject),
              knowledgeBaseId: null,
              knowledgeBaseName: null,
              projectId: row.id,
            }),
          ),
          goalRows.map((row) =>
            hit({
              sourceType: "goal",
              id: row.id,
              title: row.title,
              excerpt: row.description ?? row.title,
              score: lexicalMatchScore(`${row.title} ${row.description ?? ""}`, input.subject),
              knowledgeBaseId: null,
              knowledgeBaseName: null,
              projectId: row.projectId,
            }),
          ),
          decisionRows.map((row) =>
            hit({
              sourceType: "decision",
              id: row.id,
              title: row.statement,
              excerpt: row.rationale,
              score: lexicalMatchScore(
                `${row.statement} ${row.rationale}`,
                input.subject,
              ),
              knowledgeBaseId: null,
              knowledgeBaseName: null,
              projectId: row.projectId,
            }),
          ),
          taskRows.map((row) =>
            hit({
              sourceType: "task",
              id: row.id,
              title: row.title,
              excerpt: row.description ?? row.title,
              score: lexicalMatchScore(`${row.title} ${row.description ?? ""}`, input.subject),
              knowledgeBaseId: null,
              knowledgeBaseName: null,
              projectId: row.projectId,
            }),
          ),
          memoryRows.map((row) =>
            hit({
              sourceType: "memory",
              id: row.id,
              title: "Memory",
              excerpt: row.content,
              score: Math.max(
                lexicalMatchScore(row.content, input.subject),
                lexicalMatchScore(row.tags.join(" "), input.subject),
              ),
              knowledgeBaseId: null,
              knowledgeBaseName: null,
              projectId: row.projectId,
              tags: row.tags,
            }),
          ),
          chunkRows.map((row) =>
            hit({
              sourceType: "knowledge_chunk",
              id: row.chunkId,
              title: row.title,
              excerpt: row.content,
              score: Math.max(
                lexicalMatchScore(row.content, input.subject),
                lexicalMatchScore(row.title, input.subject),
                lexicalMatchScore(row.knowledgeBaseName, input.subject),
                lexicalMatchScore(row.knowledgeBaseDescription ?? "", input.subject),
              ),
              knowledgeBaseId: row.knowledgeBaseId,
              knowledgeBaseName: row.knowledgeBaseName,
              projectId: row.projectId,
              tags: row.tags,
            }),
          ),
          catalogRows.map((row) =>
            hit({
              sourceType: "knowledge_base",
              id: row.id,
              title: row.name,
              excerpt: row.description ?? row.name,
              score: lexicalMatchScore(
                `${row.name} ${row.description ?? ""}`,
                input.subject,
              ),
              knowledgeBaseId: row.id,
              knowledgeBaseName: row.name,
              projectId: null,
            }),
          ),
          semanticMemoryHits,
          semanticKnowledgeHits,
        ],
        input.limit,
      );

      const personIds = [
        ...new Set([
          ...personRows.map((row) => row.id),
          ...hits.filter((item) => item.sourceType === "person").map((item) => item.id),
        ]),
      ];
      const relations = await loadPersonRelations(transaction, personIds);
      const relatedProjectIds = [
        ...new Set([...relations.values()].flatMap((value) => [...value.projectIds])),
      ];
      const relatedBaseIds = [
        ...new Set(
          [...relations.values()].flatMap((value) => [...value.knowledgeBaseIds]),
        ),
      ];
      const [relatedProjectRows, relatedBaseRows] = await Promise.all([
        relatedProjectIds.length === 0
          ? Promise.resolve([])
          : transaction
              .select({ id: projects.id, name: projects.name })
              .from(projects)
              .where(inArray(projects.id, relatedProjectIds)),
        relatedBaseIds.length === 0
          ? Promise.resolve([])
          : transaction
              .select({
                id: knowledgeBases.id,
                name: knowledgeBases.name,
                description: knowledgeBases.description,
              })
              .from(knowledgeBases)
              .where(inArray(knowledgeBases.id, relatedBaseIds)),
      ]);
      const projectsById = new Map(relatedProjectRows.map((row) => [row.id, row]));
      const basesById = new Map(relatedBaseRows.map((row) => [row.id, row]));
      const peopleById = new Map(personRows.map((row) => [row.id, row]));
      const peopleIndex: PersonIndexEntry[] = personIds.flatMap((id) => {
        const row = peopleById.get(id);
        if (row === undefined) return [];
        const related = relations.get(id);
        return [
          {
            id: row.id,
            name: row.name,
            aliases: [...row.aliases],
            summary: row.summary ?? row.notes,
            tags: [...row.tags],
            relatedProjects: (related?.projectIds ?? []).flatMap((projectId) => {
              const project = projectsById.get(projectId);
              return project === undefined ? [] : [project];
            }),
            relatedKnowledgeBases: (related?.knowledgeBaseIds ?? []).flatMap(
              (knowledgeBaseId) => {
                const base = basesById.get(knowledgeBaseId);
                return base === undefined ? [] : [base];
              },
            ),
          },
        ];
      });

      const suggested = new Map<string, BrainSearchSuggestion>();
      for (const base of knowledgeBasesCatalog) {
        const nameScore = lexicalMatchScore(
          `${base.name} ${base.description ?? ""}`,
          input.subject,
        );
        if (nameScore >= SCORE_FLOOR) {
          suggested.set(base.id, {
            ...base,
            reason: "The knowledge-base name or description matches this query.",
          });
        }
      }
      for (const item of hits) {
        if (item.knowledgeBaseId === null || item.knowledgeBaseName === null) continue;
        if (suggested.has(item.knowledgeBaseId)) continue;
        const catalog = knowledgeBasesCatalog.find(
          (base) => base.id === item.knowledgeBaseId,
        );
        suggested.set(item.knowledgeBaseId, {
          id: item.knowledgeBaseId,
          name: item.knowledgeBaseName,
          description: catalog?.description ?? null,
          reason:
            input.intent === "lookup_person"
              ? "A knowledge document in this base matches the person lookup."
              : "A knowledge document in this base matches the query.",
        });
      }
      for (const person of peopleIndex) {
        for (const base of person.relatedKnowledgeBases) {
          if (suggested.has(base.id)) continue;
          suggested.set(base.id, {
            ...base,
            reason: `Linked from the people index entry for ${person.name}.`,
          });
        }
      }

      signal.throwIfAborted();
      return {
        query: input.query,
        routing: {
          intent: input.intent,
          subject: input.subject,
          guidance: brainSearchGuidance(input.intent),
        },
        hits,
        people: peopleIndex,
        knowledgeBases: knowledgeBasesCatalog,
        suggestedKnowledgeBases: [...suggested.values()].slice(0, 20),
      };
    });
  }
}
