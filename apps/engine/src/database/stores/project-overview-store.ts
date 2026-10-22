import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { BrainAccessContext } from "../../domain.js";
import {
  projectSections,
  type ProjectContextItem,
  type ProjectOverviewStore,
  type ProjectSection,
} from "../../domain/project-overview.js";
import {
  decisions,
  decisionPeople,
  knowledgeDocuments,
  knowledgeDocumentPeople,
  memories,
  memoryPeople,
  people,
  personProjects,
  projects,
  tasks,
} from "../schema/content.js";
import { goals } from "../schema/temporal.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";
const nextMemory = alias(memories, "project_memory_successor");
const nextDecision = alias(decisions, "project_decision_successor");
function selection(
  tx: SecondBrainTransaction,
  projectId: string,
  section: ProjectSection,
) {
  switch (section) {
    case "tasks":
      return { table: tasks, where: eq(tasks.projectId, projectId) };
    case "goals":
      return { table: goals, where: eq(goals.projectId, projectId) };
    case "documents":
      return {
        table: knowledgeDocuments,
        where: eq(knowledgeDocuments.projectId, projectId),
      };
    case "memories":
      return {
        table: memories,
        where: and(
          eq(memories.projectId, projectId),
          notExists(
            tx
              .select({ id: nextMemory.id })
              .from(nextMemory)
              .where(eq(nextMemory.supersedesId, memories.id)),
          ),
        ),
      };
    case "decisions":
      return {
        table: decisions,
        where: and(
          eq(decisions.projectId, projectId),
          isNull(decisions.revokedAt),
          notExists(
            tx
              .select({ id: nextDecision.id })
              .from(nextDecision)
              .where(eq(nextDecision.supersedesId, decisions.id)),
          ),
        ),
      };
    case "people":
      return {
        table: people,
        where: or(
          exists(
            tx
              .select({ id: personProjects.personId })
              .from(personProjects)
              .where(
                and(
                  eq(personProjects.personId, people.id),
                  eq(personProjects.projectId, projectId),
                ),
              ),
          ),
          exists(
            tx
              .select({ id: memoryPeople.personId })
              .from(memoryPeople)
              .innerJoin(memories, eq(memories.id, memoryPeople.memoryId))
              .where(
                and(
                  eq(memoryPeople.personId, people.id),
                  eq(memories.projectId, projectId),
                ),
              ),
          ),
          exists(
            tx
              .select({ id: decisionPeople.personId })
              .from(decisionPeople)
              .innerJoin(decisions, eq(decisions.id, decisionPeople.decisionId))
              .where(
                and(
                  eq(decisionPeople.personId, people.id),
                  eq(decisions.projectId, projectId),
                ),
              ),
          ),
          exists(
            tx
              .select({ id: knowledgeDocumentPeople.personId })
              .from(knowledgeDocumentPeople)
              .innerJoin(
                knowledgeDocuments,
                eq(knowledgeDocuments.id, knowledgeDocumentPeople.documentId),
              )
              .where(
                and(
                  eq(knowledgeDocumentPeople.personId, people.id),
                  eq(knowledgeDocuments.projectId, projectId),
                ),
              ),
          ),
        ),
      };
  }
}
const nullText = sql<string | null>`null::text`;
const nullNumber = sql<number | null>`null::int`;
const nullDate = sql<Date | null>`null::timestamptz`;
const noTags = sql<string[]>`array[]::text[]`;
function projection(section: ProjectSection) {
  const base = {
    body: nullText,
    status: nullText,
    version: nullNumber,
    date: nullDate,
    priority: nullText,
    knowledgeBaseId: nullText,
    tags: noTags,
  };
  switch (section) {
    case "tasks":
      return {
        ...base,
        id: tasks.id,
        title: tasks.title,
        body: tasks.description,
        status: tasks.status,
        version: tasks.historyVersion,
        date: tasks.dueAt,
        priority: tasks.priority,
      };
    case "goals":
      return {
        ...base,
        id: goals.id,
        title: goals.title,
        body: sql<
          string | null
        >`nullif(concat_ws(E'\n\n', ${goals.description}, ${goals.successCriteria}), '')`,
        status: goals.status,
        version: goals.version,
        date: goals.targetAt,
      };
    case "decisions":
      return {
        ...base,
        id: decisions.id,
        title: decisions.statement,
        body: decisions.rationale,
        version: decisions.versionNumber,
        date: decisions.decidedAt,
      };
    case "people":
      return {
        ...base,
        id: people.id,
        title: people.name,
        body: sql<
          string | null
        >`nullif(concat_ws(E'\n\n', ${people.summary}, ${people.notes}), '')`,
        version: people.version,
        tags: people.tags,
      };
    case "documents":
      return {
        ...base,
        id: knowledgeDocuments.id,
        title: knowledgeDocuments.title,
        body: knowledgeDocuments.sourceUri,
        version: knowledgeDocuments.currentRevisionNumber,
        date: knowledgeDocuments.updatedAt,
        knowledgeBaseId: knowledgeDocuments.knowledgeBaseId,
        tags: knowledgeDocuments.tags,
      };
    case "memories":
      return {
        ...base,
        id: memories.id,
        title: sql<string>`left(${memories.content}, 140)`,
        body: memories.content,
        version: memories.versionNumber,
        date: memories.effectiveAt,
        tags: memories.tags,
      };
  }
}

export class DrizzleProjectOverviewStore implements ProjectOverviewStore {
  constructor(private readonly database: SecondBrainDatabase) {}
  async overview(
    access: BrainAccessContext,
    projectId: string,
    signal: AbortSignal,
  ) {
    return this.database.transaction(
      async (tx) => {
        await authorizeBrainTransaction(tx, access, "admin", signal);
        const [project] = await tx
          .select({
            id: projects.id,
            name: projects.name,
            description: projects.description,
            status: projects.status,
            version: projects.version,
          })
          .from(projects)
          .where(eq(projects.id, projectId));
        if (!project) return null;
        const counts = {} as Record<ProjectSection, number>;
        for (const section of projectSections) {
          const query = selection(tx, projectId, section);
          const [row] = await tx
            .select({ value: count() })
            .from(query.table)
            .where(query.where);
          counts[section] = Number(row!.value);
        }
        signal.throwIfAborted();
        return { project, counts };
      },
      { isolationLevel: "repeatable read" },
    );
  }
  async section(
    access: BrainAccessContext,
    input: Parameters<ProjectOverviewStore["section"]>[1],
    signal: AbortSignal,
  ) {
    const limit = input.limit ?? 20;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (input.cursor &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          input.cursor,
        ))
    )
      throw new Error("Invalid project page.");
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "admin", signal);
      const query = selection(tx, input.projectId, input.section);
      const rows = await tx
        .select(projection(input.section))
        .from(query.table)
        .where(
          and(
            query.where,
            input.cursor ? gt(query.table.id, input.cursor) : undefined,
          ),
        )
        .orderBy(asc(query.table.id))
        .limit(limit + 1);
      const items: ProjectContextItem[] = rows
        .slice(0, limit)
        .map((row) => ({
          ...row,
          date: row.date instanceof Date ? row.date.toISOString() : row.date,
        }));
      signal.throwIfAborted();
      return {
        items,
        nextCursor: rows.length > limit ? items.at(-1)!.id : null,
      };
    });
  }
}
