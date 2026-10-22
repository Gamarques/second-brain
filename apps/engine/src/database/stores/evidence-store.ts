import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type {
  BrainAccessContext,
  BrainEvidenceStore,
  ContentEmbedding,
  EvidenceItem,
  EvidenceSearchResult,
  TemporalCoverage,
} from "../../domain.js";
import {
  DECISION_EMBEDDING_RECIPE_VERSION,
  MEMORY_EMBEDDING_RECIPE_VERSION,
} from "../../domain.js";
import { decisions, memories, reminders, tasks } from "../schema/content.js";
import {
  decisionEmbeddings,
  embeddingSpaces,
  memoryEmbeddings,
} from "../schema/embeddings.js";
import { accounts } from "../schema/identity.js";
import {
  activities,
  activityEvents,
  goalVersions,
  goals,
  priorityPlanVersionItems,
  priorityPlanVersions,
  reminderVersions,
  taskVersions,
} from "../schema/temporal.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type { SecondBrainDatabase, SecondBrainTransaction } from "./database.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_QUERY_LENGTH = 5_000;
const MAX_LIMIT_PER_TYPE = 100;
const MAX_PRIORITY_ITEMS_PER_PLAN = 20;

type EvidenceLimits = Parameters<BrainEvidenceStore["searchEvidence"]>[1]["limits"];

function toDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return date;
}

function toIso(value: unknown, field: string): string {
  return toDate(value, field).toISOString();
}

function parseReference(asOf: string | null): Date {
  const now = new Date();
  if (asOf === null) return now;
  const value = new Date(asOf);
  if (!Number.isFinite(value.getTime())) throw new Error("asOf must be a valid timestamp.");
  if (value.getTime() > now.getTime()) {
    throw new Error("asOf must not be in the future.");
  }
  return value;
}

function validateLimits(limits: EvidenceLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_LIMIT_PER_TYPE) {
      throw new Error(`${name} evidence limit must be between 0 and ${MAX_LIMIT_PER_TYPE}.`);
    }
  }
}

function validateQuery(query: string): void {
  if (query.trim() === "" || query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Evidence query must contain between 1 and ${MAX_QUERY_LENGTH} characters.`);
  }
}

function validateEmbedding(embedding: ContentEmbedding): void {
  if (!SHA256.test(embedding.contentHash)) {
    throw new Error("Evidence query embedding must carry a lowercase SHA-256 digest.");
  }
  if (embedding.vector.length < 1 || embedding.vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Evidence query embedding contains invalid values.");
  }
}

function decodeScore(value: unknown, type: EvidenceItem["type"]): number {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(`Database returned an invalid ${type} evidence score.`);
  }
  return score;
}

function nonEmpty(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`Database returned an empty ${field}.`);
  return value;
}

async function requireActiveSpace(
  transaction: SecondBrainTransaction,
  embedding: ContentEmbedding,
  entityType: "memory" | "decision",
): Promise<void> {
  validateEmbedding(embedding);
  const recipeVersion =
    entityType === "memory"
      ? MEMORY_EMBEDDING_RECIPE_VERSION
      : DECISION_EMBEDDING_RECIPE_VERSION;
  const rows = await transaction
    .select({ dimensions: embeddingSpaces.dimensions })
    .from(embeddingSpaces)
    .where(
      and(
        eq(embeddingSpaces.id, embedding.spaceId),
        eq(embeddingSpaces.entityType, entityType),
        eq(embeddingSpaces.status, "active"),
        eq(embeddingSpaces.recipeVersion, recipeVersion),
      ),
    )
    .limit(1);
  const space = rows[0];
  if (space === undefined || space.dimensions !== embedding.vector.length) {
    throw new Error(`The ${entityType} embedding space is not active for this brain.`);
  }
}

function lexicalRank(searchDocument: ReturnType<typeof sql>, query: string) {
  const parsedQuery = sql`websearch_to_tsquery('english', ${query})`;
  const matches = sql<boolean>`${searchDocument} @@ ${parsedQuery}`;
  const score = sql<number>`case
    when ${matches}
      then least(0.8, 0.25 + 0.55 * ts_rank_cd(${searchDocument}, ${parsedQuery}, 32))
    else 0.3
  end`;
  return { matches, score } as const;
}

async function memoryEvidence(
  transaction: SecondBrainTransaction,
  embedding: ContentEmbedding | null,
  cutoff: Date,
  projectId: string | null,
  limit: number,
): Promise<readonly EvidenceItem[]> {
  if (embedding === null || limit === 0) return [];
  await requireActiveSpace(transaction, embedding, "memory");
  const successor = alias(memories, "memory_successor");
  const distance = cosineDistance(memoryEmbeddings.embedding, [...embedding.vector]);
  const score = sql<number>`greatest(0, least(1, 1 - (${distance})))`;
  const supersededAt = sql<Date | null>`case
    when ${successor.id} is null then null
    else greatest(${successor.effectiveAt}, ${successor.createdAt})
  end`;
  const rows = await transaction
    .select({
      id: memories.id,
      versionNumber: memories.versionNumber,
      content: memories.content,
      category: memories.category,
      effectiveAt: memories.effectiveAt,
      recordedAt: memories.createdAt,
      supersededAt,
      score,
    })
    .from(memoryEmbeddings)
    .innerJoin(memories, eq(memories.id, memoryEmbeddings.memoryId))
    .leftJoin(successor, eq(successor.supersedesId, memories.id))
    .where(
      and(
        eq(memoryEmbeddings.spaceId, embedding.spaceId),
        eq(memoryEmbeddings.contentHash, memories.contentHash),
        eq(memoryEmbeddings.recipeVersion, MEMORY_EMBEDDING_RECIPE_VERSION),
        lte(memories.effectiveAt, cutoff),
        lte(memories.createdAt, cutoff),
        projectId === null ? undefined : eq(memories.projectId, projectId),
        or(isNull(successor.id), gt(supersededAt, cutoff)),
      ),
    )
    .orderBy(asc(distance), desc(memories.effectiveAt), asc(memories.id))
    .limit(limit);

  return rows.map((row): EvidenceItem => ({
    type: "memory",
    id: row.id,
    versionId: row.id,
    content:
      row.category === null
        ? nonEmpty(row.content, "memory content")
        : `[${row.category}] ${nonEmpty(row.content, "memory content")}`,
    score: decodeScore(row.score, "memory"),
    effectiveAt: toIso(row.effectiveAt, "memory effective timestamp"),
    recordedAt: toIso(row.recordedAt, "memory recorded timestamp"),
    supersededAt:
      row.supersededAt === null
        ? null
        : toIso(row.supersededAt, "memory supersession timestamp"),
    sourceIds: [row.id],
  }));
}

function decodeAlternatives(
  value: unknown,
): readonly { readonly option: string; readonly reason: string | null }[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Database returned invalid rejected alternatives.");
  }
  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { option?: unknown }).option !== "string" ||
      ((item as { reason?: unknown }).reason !== null &&
        typeof (item as { reason?: unknown }).reason !== "string")
    ) {
      throw new Error("Database returned invalid rejected alternatives.");
    }
    return {
      option: nonEmpty((item as { option: string }).option, "rejected alternative"),
      reason: (item as { reason: string | null }).reason,
    };
  });
}

function renderDecision(
  statement: string,
  rationale: string,
  alternatives: readonly { readonly option: string; readonly reason: string | null }[],
): string {
  const rejected = alternatives.length === 0
    ? ""
    : ` Rejected: ${alternatives
        .map((item) => item.reason === null ? item.option : `${item.option} (${item.reason})`)
        .join("; ")}.`;
  return `Decision: ${nonEmpty(statement, "decision statement")} Rationale: ${nonEmpty(rationale, "decision rationale")}.${rejected}`;
}

async function decisionEvidence(
  transaction: SecondBrainTransaction,
  embedding: ContentEmbedding | null,
  cutoff: Date,
  projectId: string | null,
  limit: number,
): Promise<readonly EvidenceItem[]> {
  if (embedding === null || limit === 0) return [];
  await requireActiveSpace(transaction, embedding, "decision");
  const successor = alias(decisions, "decision_successor");
  const distance = cosineDistance(decisionEmbeddings.embedding, [...embedding.vector]);
  const score = sql<number>`greatest(0, least(1, 1 - (${distance})))`;
  const successorAt = sql<Date | null>`case
    when ${successor.id} is null then null
    else greatest(${successor.decidedAt}, ${successor.createdAt})
  end`;
  const inactiveAt = sql<Date | null>`case
    when ${successorAt} is null then ${decisions.revokedAt}
    when ${decisions.revokedAt} is null then ${successorAt}
    else least(${successorAt}, ${decisions.revokedAt})
  end`;
  const rows = await transaction
    .select({
      id: decisions.id,
      statement: decisions.statement,
      rationale: decisions.rationale,
      alternatives: decisions.rejectedAlternatives,
      decidedAt: decisions.decidedAt,
      recordedAt: decisions.createdAt,
      revokedAt: decisions.revokedAt,
      supersededAt: inactiveAt,
      score,
    })
    .from(decisionEmbeddings)
    .innerJoin(decisions, eq(decisions.id, decisionEmbeddings.decisionId))
    .leftJoin(successor, eq(successor.supersedesId, decisions.id))
    .where(
      and(
        eq(decisionEmbeddings.spaceId, embedding.spaceId),
        eq(decisionEmbeddings.contentHash, decisions.contentHash),
        eq(
          decisionEmbeddings.recipeVersion,
          DECISION_EMBEDDING_RECIPE_VERSION,
        ),
        lte(decisions.decidedAt, cutoff),
        lte(decisions.createdAt, cutoff),
        or(isNull(inactiveAt), gt(inactiveAt, cutoff)),
        projectId === null ? undefined : eq(decisions.projectId, projectId),
      ),
    )
    .orderBy(asc(distance), desc(decisions.decidedAt), asc(decisions.id))
    .limit(limit);

  return rows.map((row): EvidenceItem => ({
    type: "decision",
    id: row.id,
    versionId: row.id,
    content: renderDecision(row.statement, row.rationale, decodeAlternatives(row.alternatives)),
    score: decodeScore(row.score, "decision"),
    effectiveAt: toIso(row.decidedAt, "decision effective timestamp"),
    recordedAt: toIso(row.recordedAt, "decision recorded timestamp"),
    supersededAt:
      row.supersededAt === null
        ? null
        : toIso(row.supersededAt, "decision supersession timestamp"),
    sourceIds: [row.id],
  }));
}

async function taskEvidence(
  transaction: SecondBrainTransaction,
  query: string,
  cutoff: Date,
  projectId: string | null,
  limit: number,
): Promise<readonly EvidenceItem[]> {
  if (limit === 0) return [];
  const states = transaction
    .selectDistinctOn([taskVersions.taskId], {
      id: taskVersions.taskId,
      versionId: taskVersions.id,
      title: taskVersions.title,
      description: taskVersions.description,
      status: taskVersions.status,
      priority: taskVersions.priority,
      dueAt: taskVersions.dueAt,
      completedAt: taskVersions.completedAt,
      effectiveAt: taskVersions.effectiveAt,
      recordedAt: taskVersions.recordedAt,
      activityEventId: taskVersions.activityEventId,
    })
    .from(taskVersions)
    .where(
      and(
        lte(taskVersions.effectiveAt, cutoff),
        lte(taskVersions.recordedAt, cutoff),
        projectId === null ? undefined : eq(taskVersions.projectId, projectId),
      ),
    )
    .orderBy(
      taskVersions.taskId,
      desc(taskVersions.versionNumber),
      desc(taskVersions.effectiveAt),
      desc(taskVersions.recordedAt),
    )
    .as("task_evidence_state");
  const searchDocument = sql`to_tsvector('english', ${states.title} || ' ' || coalesce(${states.description}, ''))`;
  const { matches, score } = lexicalRank(searchDocument, query);
  const rows = await transaction
    .select({ ...states._.selectedFields, score })
    .from(states)
    .where(or(matches, inArray(states.status, ["todo", "in_progress"])))
    .orderBy(desc(score), sql`${states.dueAt} asc nulls last`, desc(states.recordedAt), asc(states.id))
    .limit(limit);

  return rows.map((row): EvidenceItem => {
    const due = row.dueAt === null ? "" : `, due ${toIso(row.dueAt, "task due timestamp")}`;
    const description = row.description === null ? "" : ` — ${row.description}`;
    return {
      type: "task",
      id: row.id,
      versionId: row.versionId,
      content: `Task (${row.status}, ${row.priority}${due}): ${nonEmpty(row.title, "task title")}${description}`,
      score: decodeScore(row.score, "task"),
      effectiveAt: toIso(row.effectiveAt, "task effective timestamp"),
      recordedAt: toIso(row.recordedAt, "task recorded timestamp"),
      supersededAt: null,
      sourceIds: [row.activityEventId],
    };
  });
}

async function reminderEvidence(
  transaction: SecondBrainTransaction,
  query: string,
  cutoff: Date,
  projectId: string | null,
  limit: number,
): Promise<readonly EvidenceItem[]> {
  if (projectId !== null || limit === 0) return [];
  const states = transaction
    .selectDistinctOn([reminderVersions.reminderId], {
      id: reminderVersions.reminderId,
      versionId: reminderVersions.id,
      message: reminderVersions.message,
      remindAt: reminderVersions.remindAt,
      completedAt: reminderVersions.completedAt,
      effectiveAt: reminderVersions.effectiveAt,
      recordedAt: reminderVersions.recordedAt,
      activityEventId: reminderVersions.activityEventId,
    })
    .from(reminderVersions)
    .where(
      and(
        lte(reminderVersions.effectiveAt, cutoff),
        lte(reminderVersions.recordedAt, cutoff),
      ),
    )
    .orderBy(
      reminderVersions.reminderId,
      desc(reminderVersions.versionNumber),
      desc(reminderVersions.effectiveAt),
      desc(reminderVersions.recordedAt),
    )
    .as("reminder_evidence_state");
  const searchDocument = sql`to_tsvector('english', ${states.message})`;
  const { matches, score } = lexicalRank(searchDocument, query);
  const rows = await transaction
    .select({ ...states._.selectedFields, score })
    .from(states)
    .where(or(matches, isNull(states.completedAt)))
    .orderBy(desc(score), asc(states.remindAt), asc(states.id))
    .limit(limit);
  return rows.map((row): EvidenceItem => ({
    type: "reminder",
    id: row.id,
    versionId: row.versionId,
    content: `Reminder (${row.completedAt === null ? "pending" : "completed"}, at ${toIso(row.remindAt, "reminder time")}): ${nonEmpty(row.message, "reminder message")}`,
    score: decodeScore(row.score, "reminder"),
    effectiveAt: toIso(row.effectiveAt, "reminder effective timestamp"),
    recordedAt: toIso(row.recordedAt, "reminder recorded timestamp"),
    supersededAt: null,
    sourceIds: [row.activityEventId],
  }));
}

async function goalEvidence(
  transaction: SecondBrainTransaction,
  query: string,
  cutoff: Date,
  projectId: string | null,
  limit: number,
): Promise<readonly EvidenceItem[]> {
  if (limit === 0) return [];
  const states = transaction
    .selectDistinctOn([goalVersions.goalId], {
      id: goalVersions.goalId,
      versionId: goalVersions.id,
      title: goalVersions.title,
      description: goalVersions.description,
      successCriteria: goalVersions.successCriteria,
      status: goalVersions.status,
      targetAt: goalVersions.targetAt,
      effectiveAt: goalVersions.effectiveAt,
      recordedAt: goalVersions.recordedAt,
      activityEventId: goalVersions.activityEventId,
    })
    .from(goalVersions)
    .where(
      and(
        lte(goalVersions.effectiveAt, cutoff),
        lte(goalVersions.recordedAt, cutoff),
        projectId === null ? undefined : eq(goalVersions.projectId, projectId),
      ),
    )
    .orderBy(
      goalVersions.goalId,
      desc(goalVersions.versionNumber),
      desc(goalVersions.effectiveAt),
      desc(goalVersions.recordedAt),
    )
    .as("goal_evidence_state");
  const searchDocument = sql`to_tsvector('english', ${states.title} || ' ' || coalesce(${states.description}, '') || ' ' || coalesce(${states.successCriteria}, ''))`;
  const { matches, score } = lexicalRank(searchDocument, query);
  const rows = await transaction
    .select({ ...states._.selectedFields, score })
    .from(states)
    .where(or(matches, eq(states.status, "active")))
    .orderBy(desc(score), sql`${states.targetAt} asc nulls last`, asc(states.id))
    .limit(limit);
  return rows.map((row): EvidenceItem => {
    const target = row.targetAt === null ? "" : `, target ${toIso(row.targetAt, "goal target")}`;
    const description = row.description === null ? "" : ` — ${row.description}`;
    const criteria = row.successCriteria === null ? "" : ` Success: ${row.successCriteria}`;
    return {
      type: "goal",
      id: row.id,
      versionId: row.versionId,
      content: `Goal (${row.status}${target}): ${nonEmpty(row.title, "goal title")}${description}${criteria}`,
      score: decodeScore(row.score, "goal"),
      effectiveAt: toIso(row.effectiveAt, "goal effective timestamp"),
      recordedAt: toIso(row.recordedAt, "goal recorded timestamp"),
      supersededAt: null,
      sourceIds: [row.activityEventId],
    };
  });
}

async function priorityEvidence(
  transaction: SecondBrainTransaction,
  query: string,
  cutoff: Date,
  projectId: string | null,
  limit: number,
): Promise<readonly EvidenceItem[]> {
  if (limit === 0) return [];
  const states = transaction
    .selectDistinctOn([priorityPlanVersions.priorityPlanId], {
      id: priorityPlanVersions.priorityPlanId,
      versionId: priorityPlanVersions.id,
      projectId: priorityPlanVersions.projectId,
      periodStart: priorityPlanVersions.periodStart,
      periodEnd: priorityPlanVersions.periodEnd,
      note: priorityPlanVersions.note,
      effectiveAt: priorityPlanVersions.effectiveAt,
      recordedAt: priorityPlanVersions.recordedAt,
    })
    .from(priorityPlanVersions)
    .where(
      and(
        lte(priorityPlanVersions.effectiveAt, cutoff),
        lte(priorityPlanVersions.recordedAt, cutoff),
        lte(priorityPlanVersions.periodStart, cutoff),
        gt(priorityPlanVersions.periodEnd, cutoff),
        projectId === null
          ? isNull(priorityPlanVersions.projectId)
          : or(
              isNull(priorityPlanVersions.projectId),
              eq(priorityPlanVersions.projectId, projectId),
            ),
      ),
    )
    .orderBy(
      priorityPlanVersions.priorityPlanId,
      desc(priorityPlanVersions.versionNumber),
      desc(priorityPlanVersions.effectiveAt),
      desc(priorityPlanVersions.recordedAt),
    )
    .as("priority_evidence_state");
  const searchDocument = sql`to_tsvector('english', coalesce(${states.note}, ''))`;
  const { score } = lexicalRank(searchDocument, query);
  const rows = await transaction
    .select({ ...states._.selectedFields, score })
    .from(states)
    .orderBy(desc(score), desc(states.periodStart), asc(states.id))
    .limit(limit);
  if (rows.length === 0) return [];

  const items = await transaction
    .select({
      versionId: priorityPlanVersionItems.priorityPlanVersionId,
      goalId: priorityPlanVersionItems.goalId,
      rank: priorityPlanVersionItems.rank,
      intendedSharePercent: priorityPlanVersionItems.intendedSharePercent,
    })
    .from(priorityPlanVersionItems)
    .where(
      inArray(priorityPlanVersionItems.priorityPlanVersionId, rows.map((row) => row.versionId)),
    )
    .orderBy(
      priorityPlanVersionItems.priorityPlanVersionId,
      priorityPlanVersionItems.rank,
      priorityPlanVersionItems.goalId,
    )
    .limit(rows.length * MAX_PRIORITY_ITEMS_PER_PLAN);
  const itemsByVersion = new Map<string, typeof items>();
  for (const item of items) {
    const current = itemsByVersion.get(item.versionId) ?? [];
    if (current.length < MAX_PRIORITY_ITEMS_PER_PLAN) {
      itemsByVersion.set(item.versionId, [...current, item]);
    }
  }
  const goalIds = [...new Set(items.map((item) => item.goalId))];
  const goalTitles = new Map<string, string>();
  if (goalIds.length > 0) {
    const titleStates = transaction
      .selectDistinctOn([goalVersions.goalId], {
        id: goalVersions.goalId,
        title: goalVersions.title,
      })
      .from(goalVersions)
      .where(
        and(
          inArray(goalVersions.goalId, goalIds),
          lte(goalVersions.effectiveAt, cutoff),
          lte(goalVersions.recordedAt, cutoff),
        ),
      )
      .orderBy(
        goalVersions.goalId,
        desc(goalVersions.versionNumber),
        desc(goalVersions.effectiveAt),
        desc(goalVersions.recordedAt),
      )
      .as("priority_goal_title_state");
    const titles = await transaction
      .select()
      .from(titleStates)
      .orderBy(titleStates.id)
      .limit(goalIds.length);
    for (const title of titles) {
      goalTitles.set(title.id, nonEmpty(title.title, "priority goal title"));
    }
  }
  return rows.map((row): EvidenceItem => {
    const rankedGoals = (itemsByVersion.get(row.versionId) ?? [])
      .map((item) => {
        if (!Number.isInteger(item.rank) || item.rank < 1) {
          throw new Error("Database returned an invalid priority rank.");
        }
        if (
          item.intendedSharePercent !== null &&
          (!Number.isFinite(item.intendedSharePercent) ||
            item.intendedSharePercent <= 0 ||
            item.intendedSharePercent > 100)
        ) {
          throw new Error("Database returned an invalid intended priority share.");
        }
        const label = goalTitles.get(item.goalId) ?? `goal ${item.goalId}`;
        const share = item.intendedSharePercent === null
          ? ""
          : ` (${item.intendedSharePercent}% intended)`;
        return `#${item.rank} ${label}${share}`;
      })
      .join("; ");
    const note = row.note === null ? "" : ` Note: ${row.note}`;
    return {
      type: "priority_plan",
      id: row.id,
      versionId: row.versionId,
      content: `Priority plan (${row.projectId === null ? "general" : "project"}, ${toIso(row.periodStart, "priority period start")} to ${toIso(row.periodEnd, "priority period end")}): ${rankedGoals || "no ranked goals"}.${note}`,
      score: decodeScore(row.score, "priority_plan"),
      effectiveAt: toIso(row.effectiveAt, "priority effective timestamp"),
      recordedAt: toIso(row.recordedAt, "priority recorded timestamp"),
      supersededAt: null,
      sourceIds: [row.versionId],
    };
  });
}

async function activityEvidence(
  transaction: SecondBrainTransaction,
  query: string,
  cutoff: Date,
  projectId: string | null,
  limit: number,
): Promise<readonly EvidenceItem[]> {
  if (limit === 0) return [];
  const searchDocument = sql`to_tsvector('english', coalesce(${activities.summary}, ''))`;
  const { score } = lexicalRank(searchDocument, query);
  const rows = await transaction
    .select({
      id: activities.id,
      kind: activities.kind,
      occurredAt: activities.occurredAt,
      endedAt: activities.endedAt,
      summary: activities.summary,
      recordedAt: activities.recordedAt,
      retractedAt: activities.retractedAt,
      score,
    })
    .from(activities)
    .where(
      and(
        eq(activities.analysisAllowed, true),
        lte(activities.occurredAt, cutoff),
        lte(activities.recordedAt, cutoff),
        or(isNull(activities.retractedAt), gt(activities.retractedAt, cutoff)),
        projectId === null ? undefined : eq(activities.projectId, projectId),
      ),
    )
    .orderBy(desc(score), desc(activities.occurredAt), asc(activities.id))
    .limit(limit);
  return rows.map((row): EvidenceItem => {
    const end = row.endedAt === null ? "" : ` to ${toIso(row.endedAt, "activity end")}`;
    const summary = row.summary === null ? "No summary recorded." : row.summary;
    return {
      type: "activity",
      id: row.id,
      versionId: null,
      content: `Activity (${row.kind}, ${toIso(row.occurredAt, "activity occurrence")}${end}): ${summary}`,
      score: decodeScore(row.score, "activity"),
      effectiveAt: toIso(row.occurredAt, "activity effective timestamp"),
      recordedAt: toIso(row.recordedAt, "activity recorded timestamp"),
      supersededAt:
        row.retractedAt === null ? null : toIso(row.retractedAt, "activity retraction timestamp"),
      sourceIds: [row.id],
    };
  });
}

async function coverageFor(
  transaction: SecondBrainTransaction,
  cutoff: Date,
  asOf: string | null,
  projectId: string | null,
): Promise<TemporalCoverage> {
  const createdEvent = alias(activityEvents, "purged_entity_created_event");
  const deletionVisibleAt = sql<Date>`greatest(${activityEvents.effectiveAt}, ${activityEvents.recordedAt})`;
  const creationVisibleAt = sql<Date>`greatest(${createdEvent.effectiveAt}, ${createdEvent.recordedAt})`;
  const [originRows, taskRows, reminderRows, goalRows, purgedRows] = await Promise.all([
    transaction
      .select({ value: sql<Date | null>`min(${accounts.createdAt})` })
      .from(accounts)
      .limit(1),
    transaction
      .select({ value: tasks.historyCompleteFrom })
      .from(tasks)
      .where(
        and(
          lte(tasks.createdAt, cutoff),
          projectId === null ? undefined : eq(tasks.projectId, projectId),
        ),
      )
      .orderBy(desc(tasks.historyCompleteFrom))
      .limit(1),
    projectId === null
      ? transaction
          .select({ value: reminders.historyCompleteFrom })
          .from(reminders)
          .where(lte(reminders.createdAt, cutoff))
          .orderBy(desc(reminders.historyCompleteFrom))
          .limit(1)
      : Promise.resolve([]),
    transaction
      .select({ value: goals.historyCompleteFrom })
      .from(goals)
      .where(
        and(
          lte(goals.createdAt, cutoff),
          projectId === null ? undefined : eq(goals.projectId, projectId),
        ),
      )
      .orderBy(desc(goals.historyCompleteFrom))
      .limit(1),
    asOf === null
      ? Promise.resolve([])
      : transaction
          .select({ entityType: activityEvents.entityType })
          .from(activityEvents)
          .innerJoin(
            createdEvent,
            and(
              eq(createdEvent.entityType, activityEvents.entityType),
              eq(createdEvent.entityId, activityEvents.entityId),
              eq(createdEvent.action, "created"),
              lte(creationVisibleAt, cutoff),
            ),
          )
          .where(
            and(
              inArray(activityEvents.entityType, ["task", "reminder"]),
              eq(activityEvents.action, "deleted"),
              gt(deletionVisibleAt, cutoff),
            ),
          )
          .limit(1),
  ]);
  const originValue = originRows[0]?.value;
  if (originValue === undefined || originValue === null) {
    throw new Error("Accounts disappeared during evidence retrieval.");
  }
  const originCreated = toDate(originValue, "earliest account creation timestamp");
  const historyDates = [taskRows[0]?.value, reminderRows[0]?.value, goalRows[0]?.value]
    .flatMap((value, index) =>
      value === undefined
        ? []
        : [toDate(value, ["task", "reminder", "goal"][index] + " history coverage start")],
    )
    .sort((left, right) => right.getTime() - left.getTime());
  const latestHistoryStart = historyDates[0] ?? originCreated;
  const historyComplete =
    asOf === null || cutoff < originCreated || cutoff >= latestHistoryStart;
  const purgeComplete = purgedRows.length === 0;
  const complete = historyComplete && purgeComplete;
  const completeFrom = [originCreated, ...historyDates]
    .sort((left, right) => right.getTime() - left.getTime())[0]!;
  return {
    completeFrom: toIso(completeFrom, "coverage start"),
    requestedAsOf: asOf,
    complete,
    warnings: [
      ...(historyComplete
        ? []
        : [`Historical task, reminder, or goal coverage is incomplete before ${toIso(latestHistoryStart, "history coverage start")}.`]),
      ...(purgeComplete
        ? []
        : ["Historical task or reminder content is unavailable because a later privacy deletion purged its canonical row and versions."]),
    ],
  };
}

export class DrizzleBrainEvidenceStore implements BrainEvidenceStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async searchEvidence(
    access: BrainAccessContext,
    input: Parameters<BrainEvidenceStore["searchEvidence"]>[1],
    signal: AbortSignal,
  ): Promise<EvidenceSearchResult> {
    signal.throwIfAborted();
    validateQuery(input.query);
    validateLimits(input.limits);
    const cutoff = parseReference(input.asOf);
    const result = await this.database.transaction(
      async (transaction) => {
        await authorizeBrainTransaction(transaction, access, "viewer", signal);
        const evidence: EvidenceItem[] = [];

        evidence.push(...await memoryEvidence(
          transaction,
          input.embeddings.memories,
          cutoff,
          input.projectId,
          input.limits.memories,
        ));
        signal.throwIfAborted();
        evidence.push(...await decisionEvidence(
          transaction,
          input.embeddings.decisions,
          cutoff,
          input.projectId,
          input.limits.decisions,
        ));
        signal.throwIfAborted();
        evidence.push(...await taskEvidence(
          transaction,
          input.query,
          cutoff,
          input.projectId,
          input.limits.tasks,
        ));
        signal.throwIfAborted();
        evidence.push(...await reminderEvidence(
          transaction,
          input.query,
          cutoff,
          input.projectId,
          input.limits.reminders,
        ));
        signal.throwIfAborted();
        evidence.push(...await goalEvidence(
          transaction,
          input.query,
          cutoff,
          input.projectId,
          input.limits.goals,
        ));
        signal.throwIfAborted();
        evidence.push(...await priorityEvidence(
          transaction,
          input.query,
          cutoff,
          input.projectId,
          input.limits.priorities,
        ));
        signal.throwIfAborted();
        evidence.push(...await activityEvidence(
          transaction,
          input.query,
          cutoff,
          input.projectId,
          input.limits.activities,
        ));
        const coverage = await coverageFor(
          transaction,
          cutoff,
          input.asOf,
          input.projectId,
        );
        signal.throwIfAborted();
        return { evidence, coverage };
      },
      { isolationLevel: "repeatable read" },
    );
    signal.throwIfAborted();
    return result;
  }
}
