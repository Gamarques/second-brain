import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type {
  AdminBrainMapCounts,
  AdminBrainMapEdge,
  AdminBrainMapNode,
  AdminBrainMapNodeType,
  AdminBrainMapSeriesPoint,
  AdminBrainMapSnapshot,
  AdminBrainMapStore,
} from "../domain.js";
import {
  knowledgeBases,
  knowledgeDocumentPeople,
  knowledgeDocuments,
  memories,
  memoryPeople,
  people,
  personKnowledgeBases,
  personProjects,
  projects,
} from "@second-brain/engine/database/schema/content";
import { authorizeBrainTransaction } from "@second-brain/engine/database/stores/authorization";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import type { BrainAccessContext } from "@second-brain/engine/domain";

const maximumEdges = 5_000;
const memorySuccessor = alias(memories, "admin_brain_map_memory_successor");
const memoryOrigin = alias(memories, "admin_brain_map_memory_origin");
const nodeTypesForSelection: readonly AdminBrainMapNodeType[] = [
  "memory",
  "knowledge_base",
  "document",
  "person",
  "project",
];

type CountsKey = keyof AdminBrainMapCounts;
type Candidate = {
  readonly node: AdminBrainMapNode;
  readonly knowledgeBaseId?: string | undefined;
  readonly projectId?: string | undefined;
};

function compact(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function bounded(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  const normalized = compact(value);
  if (normalized === "") return null;
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function label(value: string): string {
  const result = bounded(value, 120);
  if (result === null) throw new Error("Stored brain map labels must not be empty.");
  return result;
}

function tags(values: readonly string[]): readonly string[] {
  return values
    .map((value) => compact(value))
    .filter((value) => value !== "")
    .slice(0, 50);
}

function iso(value: Date): string {
  return value.toISOString();
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function shiftUtcDate(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function total(counts: AdminBrainMapCounts): number {
  return counts.memories +
    counts.knowledgeBases +
    counts.documents +
    counts.people +
    counts.projects;
}

function countValue(rows: readonly { readonly value: number }[]): number {
  return Number(rows[0]?.value ?? 0);
}

function dayCountMap(
  rows: readonly { readonly date: string; readonly value: number }[],
): ReadonlyMap<string, number> {
  return new Map(rows.map((row) => [row.date, Number(row.value)]));
}

function makeSeries(
  counts: AdminBrainMapCounts,
  days: number,
  today: Date,
  additions: Readonly<Record<CountsKey, ReadonlyMap<string, number>>>,
): { readonly growth: number; readonly series: readonly AdminBrainMapSeriesPoint[] } {
  const keys: readonly CountsKey[] = [
    "memories",
    "knowledgeBases",
    "documents",
    "people",
    "projects",
  ];
  const periodGrowth = Object.fromEntries(
    keys.map((key) => [
      key,
      [...additions[key].values()].reduce((sum, value) => sum + value, 0),
    ]),
  ) as Record<CountsKey, number>;
  const running = Object.fromEntries(
    keys.map((key) => [key, Math.max(0, counts[key] - periodGrowth[key])]),
  ) as Record<CountsKey, number>;
  const firstDay = shiftUtcDate(today, -(days - 1));
  const series: AdminBrainMapSeriesPoint[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = utcDate(shiftUtcDate(firstDay, offset));
    for (const key of keys) running[key] += additions[key].get(date) ?? 0;
    series.push({ date, ...running, total: total(running) });
  }
  return {
    growth: Object.values(periodGrowth).reduce((sum, value) => sum + value, 0),
    series,
  };
}

/** Builds the bounded graph from explicit database relationships only. */
export class DrizzleAdminBrainMapStore implements AdminBrainMapStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async getBrainMap(
    access: BrainAccessContext,
    input: { readonly days: number; readonly nodeLimit: number },
    signal: AbortSignal,
  ): Promise<AdminBrainMapSnapshot> {
    signal.throwIfAborted();
    if (!Number.isInteger(input.days) || input.days < 7 || input.days > 90) {
      throw new Error("days must be an integer between 7 and 90.");
    }
    if (
      !Number.isInteger(input.nodeLimit) ||
      input.nodeLimit < 25 ||
      input.nodeLimit > 500
    ) {
      throw new Error("nodeLimit must be an integer between 25 and 500.");
    }

    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      const generatedAt = new Date();
      const today = new Date(Date.UTC(
        generatedAt.getUTCFullYear(),
        generatedAt.getUTCMonth(),
        generatedAt.getUTCDate(),
      ));
      const start = shiftUtcDate(today, -(input.days - 1));
      const memoryCountRows = await transaction
        .select({ value: count() })
        .from(memories)
        .leftJoin(memorySuccessor, eq(memorySuccessor.supersedesId, memories.id))
        .where(isNull(memorySuccessor.id));
      const baseCountRows = await transaction.select({ value: count() }).from(knowledgeBases);
      const documentCountRows = await transaction.select({ value: count() }).from(knowledgeDocuments);
      const peopleCountRows = await transaction.select({ value: count() }).from(people);
      const projectCountRows = await transaction.select({ value: count() }).from(projects);
      const counts: AdminBrainMapCounts = {
        memories: countValue(memoryCountRows),
        knowledgeBases: countValue(baseCountRows),
        documents: countValue(documentCountRows),
        people: countValue(peopleCountRows),
        projects: countValue(projectCountRows),
      };

      const memoryRows = await transaction
        .select({
          id: memories.id,
          content: memories.content,
          category: memories.category,
          tags: memories.tags,
          projectId: memories.projectId,
          version: memories.versionNumber,
          createdAt: memoryOrigin.createdAt,
          updatedAt: memories.createdAt,
        })
        .from(memories)
        .innerJoin(memoryOrigin, eq(memoryOrigin.id, memories.lineageId))
        .leftJoin(memorySuccessor, eq(memorySuccessor.supersedesId, memories.id))
        .where(isNull(memorySuccessor.id))
        .orderBy(desc(memories.createdAt), desc(memories.id))
        .limit(input.nodeLimit + 1);
      const baseRows = await transaction
        .select()
        .from(knowledgeBases)
        .orderBy(desc(knowledgeBases.updatedAt), desc(knowledgeBases.id))
        .limit(input.nodeLimit + 1);
      const documentRows = await transaction
        .select()
        .from(knowledgeDocuments)
        .orderBy(desc(knowledgeDocuments.updatedAt), desc(knowledgeDocuments.id))
        .limit(input.nodeLimit + 1);
      const personRows = await transaction
        .select()
        .from(people)
        .orderBy(desc(people.updatedAt), desc(people.id))
        .limit(input.nodeLimit + 1);
      const projectRows = await transaction
        .select()
        .from(projects)
        .orderBy(desc(projects.updatedAt), desc(projects.id))
        .limit(input.nodeLimit + 1);

      const candidates: Candidate[] = [
        ...memoryRows.map((row): Candidate => ({
          node: {
            id: row.id,
            type: "memory",
            label: label(row.content),
            description: bounded(row.content, 2_000),
            tags: tags([
              ...(row.category === null ? [] : [row.category]),
              ...row.tags,
            ]),
            version: row.version,
            createdAt: iso(row.createdAt),
            updatedAt: row.version > 1 ? iso(row.updatedAt) : null,
          },
          ...(row.projectId === null ? {} : { projectId: row.projectId }),
        })),
        ...baseRows.map((row): Candidate => ({
          node: {
            id: row.id,
            type: "knowledge_base",
            label: label(row.name),
            description: bounded(row.description, 2_000),
            tags: [],
            version: null,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
          },
        })),
        ...documentRows.map((row): Candidate => ({
          node: {
            id: row.id,
            type: "document",
            label: label(row.title),
            description: bounded(row.sourceUri, 2_000),
            tags: tags(row.tags),
            version: row.currentRevisionNumber,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
          },
          knowledgeBaseId: row.knowledgeBaseId,
          ...(row.projectId === null ? {} : { projectId: row.projectId }),
        })),
        ...personRows.map((row): Candidate => ({
          node: {
            id: row.id,
            type: "person",
            label: label(row.name),
            description: bounded(row.summary ?? row.notes, 2_000),
            tags: tags(row.tags),
            version: row.version,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
          },
        })),
        ...projectRows.map((row): Candidate => ({
          node: {
            id: row.id,
            type: "project",
            label: label(row.name),
            description: bounded(row.description, 2_000),
            tags: [row.status],
            version: row.version,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
          },
        })),
      ];
      const candidateGroups = new Map(
        nodeTypesForSelection.map((type) => [
          type,
          candidates
            .filter(({ node }) => node.type === type)
            .sort((left, right) =>
              right.node.createdAt.localeCompare(left.node.createdAt) ||
              left.node.id.localeCompare(right.node.id),
            ),
        ]),
      );
      const selected: Candidate[] = [];
      for (let index = 0; selected.length < input.nodeLimit; index += 1) {
        let found = false;
        for (const type of nodeTypesForSelection) {
          const candidate = candidateGroups.get(type)?.[index];
          if (candidate === undefined) continue;
          selected.push(candidate);
          found = true;
          if (selected.length === input.nodeLimit) break;
        }
        if (!found) break;
      }
      const nodes = selected.map(({ node }) => node);
      const visibleIds = new Set(nodes.map(({ id }) => id));
      const edgeIds = new Set<string>();
      const edges: AdminBrainMapEdge[] = [];
      let edgeLimitReached = false;
      const addEdge = (
        type: AdminBrainMapEdge["type"],
        source: string,
        target: string,
      ) => {
        if (!visibleIds.has(source) || !visibleIds.has(target)) return;
        const id = `${type}:${source}:${target}`;
        if (edgeIds.has(id)) return;
        if (edges.length >= maximumEdges) {
          edgeLimitReached = true;
          return;
        }
        edgeIds.add(id);
        edges.push({ id, source, target, type });
      };
      for (const candidate of selected) {
        if (candidate.knowledgeBaseId !== undefined) {
          addEdge("contains", candidate.knowledgeBaseId, candidate.node.id);
        }
        if (candidate.projectId !== undefined) {
          addEdge("belongs_to", candidate.node.id, candidate.projectId);
        }
      }

      const ids = (type: AdminBrainMapNodeType) =>
        nodes.filter((node) => node.type === type).map((node) => node.id);
      const memoryIds = ids("memory");
      const documentIds = ids("document");
      const personIds = ids("person");
      if (memoryIds.length > 0) {
        const rows = await transaction
          .select({ source: memoryPeople.memoryId, target: memoryPeople.personId })
          .from(memoryPeople)
          .where(inArray(memoryPeople.memoryId, memoryIds));
        for (const row of rows) addEdge("mentions", row.source, row.target);
      }
      if (documentIds.length > 0) {
        const rows = await transaction
          .select({ source: knowledgeDocumentPeople.documentId, target: knowledgeDocumentPeople.personId })
          .from(knowledgeDocumentPeople)
          .where(inArray(knowledgeDocumentPeople.documentId, documentIds));
        for (const row of rows) addEdge("mentions", row.source, row.target);
      }
      if (personIds.length > 0) {
        const baseRelations = await transaction
          .select({ source: personKnowledgeBases.knowledgeBaseId, target: personKnowledgeBases.personId })
          .from(personKnowledgeBases)
          .where(inArray(personKnowledgeBases.personId, personIds));
        for (const row of baseRelations) addEdge("covers", row.source, row.target);
        const projectRelations = await transaction
          .select({ source: personProjects.personId, target: personProjects.projectId })
          .from(personProjects)
          .where(inArray(personProjects.personId, personIds));
        for (const row of projectRelations) addEdge("participates_in", row.source, row.target);
      }

      const memoryDay = sql<string>`(${memoryOrigin.createdAt} at time zone 'UTC')::date::text`;
      const memoryGrowthRows = await transaction
        .select({ date: memoryDay, value: count() })
        .from(memories)
        .innerJoin(memoryOrigin, eq(memoryOrigin.id, memories.lineageId))
        .leftJoin(memorySuccessor, eq(memorySuccessor.supersedesId, memories.id))
        .where(and(isNull(memorySuccessor.id), gte(memoryOrigin.createdAt, start)))
        .groupBy(memoryDay);
      const baseDay = sql<string>`(${knowledgeBases.createdAt} at time zone 'UTC')::date::text`;
      const baseGrowthRows = await transaction
        .select({ date: baseDay, value: count() })
        .from(knowledgeBases)
        .where(gte(knowledgeBases.createdAt, start))
        .groupBy(baseDay);
      const documentDay = sql<string>`(${knowledgeDocuments.createdAt} at time zone 'UTC')::date::text`;
      const documentGrowthRows = await transaction
        .select({ date: documentDay, value: count() })
        .from(knowledgeDocuments)
        .where(gte(knowledgeDocuments.createdAt, start))
        .groupBy(documentDay);
      const peopleDay = sql<string>`(${people.createdAt} at time zone 'UTC')::date::text`;
      const peopleGrowthRows = await transaction
        .select({ date: peopleDay, value: count() })
        .from(people)
        .where(gte(people.createdAt, start))
        .groupBy(peopleDay);
      const projectDay = sql<string>`(${projects.createdAt} at time zone 'UTC')::date::text`;
      const projectGrowthRows = await transaction
        .select({ date: projectDay, value: count() })
        .from(projects)
        .where(gte(projects.createdAt, start))
        .groupBy(projectDay);
      signal.throwIfAborted();

      const { growth, series } = makeSeries(counts, input.days, today, {
        memories: dayCountMap(memoryGrowthRows),
        knowledgeBases: dayCountMap(baseGrowthRows),
        documents: dayCountMap(documentGrowthRows),
        people: dayCountMap(peopleGrowthRows),
        projects: dayCountMap(projectGrowthRows),
      });
      const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
      return {
        generatedAt: generatedAt.toISOString(),
        periodDays: input.days,
        counts,
        totalItems: total(counts),
        growth,
        explicitConnections: edges.length,
        connectedItems: connected.size,
        connectedCoverage: nodes.length === 0 ? 0 : connected.size / nodes.length,
        truncated: total(counts) > nodes.length || edgeLimitReached,
        nodes,
        edges,
        series,
      };
    });
  }
}
