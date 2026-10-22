import { createHash } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { mutationSources } from "../../domain.js";
import type {
  ActorAttribution,
  ActorProvenance,
  BrainAccessContext,
  BrainContextSnapshot,
  BrainHandoff,
  ContextStore,
  Decision,
  Goal,
  KnowledgeBaseCatalogEntry,
  Memory,
  PersonIndexEntry,
  PriorityPlan,
  Reminder,
  Task,
} from "../../domain.js";
import {
  decisionPeople,
  decisions,
  knowledgeBases,
  memories,
  memoryPeople,
  people as peopleTable,
  projects,
  reminders,
  tasks,
} from "../schema/content.js";
import { brainHandoffs } from "../schema/context.js";
import {
  goals,
  mutationReceipts,
  priorityPlans,
  priorityPlanVersionItems,
  priorityPlanVersions,
  taskGoalLinks,
} from "../schema/temporal.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type {
  SecondBrainDatabase,
  SecondBrainTransaction,
} from "./database.js";
import { loadPersonRelations } from "./person-store.js";

const handoffEntityTypeSchema = z.enum([
  "memory",
  "decision",
  "task",
  "reminder",
  "goal",
  "project",
]);
const entityRefsSchema = z
  .array(z.object({ type: handoffEntityTypeSchema, id: z.uuid() }))
  .max(50);
const receiptResultSchema = z.object({ handoffId: z.uuid() });
const mutationSourceSchema = z.enum(mutationSources);
const contextMemorySuccessor = alias(memories, "context_memory_successor");
const contextDecisionSuccessor = alias(decisions, "context_decision_successor");

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function attribution(row: {
  actorKind: "account" | "oauth_client" | "import" | "dreaming" | "system";
  actorAccountId: string | null;
  actorClientId: string | null;
  actorSource: string;
}): ActorAttribution {
  const source = mutationSourceSchema.safeParse(row.actorSource);
  if (!source.success) throw new Error("Stored actor attribution is invalid.");
  switch (row.actorKind) {
    case "account":
      if (row.actorClientId === null) {
        return {
          kind: "account",
          accountId: row.actorAccountId,
          clientId: null,
          source: source.data,
        };
      }
      break;
    case "oauth_client":
      if (row.actorAccountId !== null && row.actorClientId !== null) {
        return {
          kind: "oauth_client",
          accountId: row.actorAccountId,
          clientId: row.actorClientId,
          source: source.data,
        };
      }
      if (row.actorAccountId === null && row.actorClientId === null) {
        return {
          kind: "oauth_client",
          accountId: null,
          clientId: null,
          source: source.data,
        };
      }
      break;
    case "import":
      if (row.actorClientId === null) {
        return {
          kind: "import",
          accountId: row.actorAccountId,
          clientId: null,
          source: source.data,
        };
      }
      break;
    case "dreaming":
    case "system":
      if (row.actorAccountId === null && row.actorClientId === null) {
        return {
          kind: row.actorKind,
          accountId: null,
          clientId: null,
          source: source.data,
        };
      }
  }
  throw new Error("Stored actor attribution is invalid.");
}

function mapHandoff(row: typeof brainHandoffs.$inferSelect): BrainHandoff {
  const refs = entityRefsSchema.safeParse(row.entityRefs);
  if (!refs.success) throw new Error("Stored handoff entity references are invalid.");
  if (row.requestId.trim() === "") {
    throw new Error("Stored handoff provenance is invalid.");
  }
  const source = mutationSourceSchema.safeParse(row.actorSource);
  if (!source.success) throw new Error("Stored handoff provenance is invalid.");
  let provenance: ActorProvenance;
  if (
    row.actorKind === "account" &&
    row.actorAccountId !== null &&
    row.actorClientId === null
  ) {
    provenance = {
      kind: "account",
      accountId: row.actorAccountId,
      clientId: null,
      source: source.data,
      requestId: row.requestId,
      correlationId: row.correlationId,
      causationId: row.causationId,
      dreamingRunId: null,
    };
  } else if (
    row.actorKind === "oauth_client" &&
    row.actorAccountId !== null &&
    row.actorClientId !== null
  ) {
    provenance = {
      kind: "oauth_client",
      accountId: row.actorAccountId,
      clientId: row.actorClientId,
      source: source.data,
      requestId: row.requestId,
      correlationId: row.correlationId,
      causationId: row.causationId,
      dreamingRunId: null,
    };
  } else {
    throw new Error("Stored handoff provenance is invalid.");
  }
  return {
    id: row.id,
    fromClientId: row.actorClientId,
    title: row.title,
    summary: row.summary,
    nextActions: row.nextActions,
    entityRefs: refs.data,
    provenance,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

async function peopleByEntity(
  transaction: SecondBrainTransaction,
  memoryIds: readonly string[],
  decisionIds: readonly string[],
) {
  const memoryRows =
    memoryIds.length === 0
      ? []
      : await transaction
          .select({ entityId: memoryPeople.memoryId, personId: memoryPeople.personId })
          .from(memoryPeople)
          .where(
            and(
              inArray(memoryPeople.memoryId, [...memoryIds]),
            ),
          );
  const decisionRows =
    decisionIds.length === 0
      ? []
      : await transaction
          .select({ entityId: decisionPeople.decisionId, personId: decisionPeople.personId })
          .from(decisionPeople)
          .where(
            and(
              inArray(decisionPeople.decisionId, [...decisionIds]),
            ),
          );
  const collect = (rows: readonly { entityId: string; personId: string }[]) => {
    const result = new Map<string, string[]>();
    for (const row of rows) {
      const current = result.get(row.entityId) ?? [];
      current.push(row.personId);
      result.set(row.entityId, current);
    }
    return result;
  };
  return { memories: collect(memoryRows), decisions: collect(decisionRows) };
}

export class DrizzleContextStore implements ContextStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async loadContext(
    access: BrainAccessContext,
    input: {
      readonly purpose: string | null;
      readonly asOf: string;
      readonly limits: {
        readonly memories: number;
        readonly decisions: number;
        readonly tasks: number;
        readonly reminders: number;
        readonly goals: number;
      };
    },
    signal: AbortSignal,
  ): Promise<BrainContextSnapshot> {
    const asOf = new Date(input.asOf);
    if (!Number.isFinite(asOf.valueOf())) throw new Error("asOf must be a valid timestamp.");
    for (const [name, value] of Object.entries(input.limits)) {
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        throw new Error(`${name} limit must be an integer between 0 and 100.`);
      }
    }
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "viewer", signal);
      const memoryRows =
        input.limits.memories === 0
          ? []
          : await transaction
              .select()
              .from(memories)
              .where(
                and(
                  lte(memories.effectiveAt, asOf),
                  notExists(
                    transaction
                      .select({ id: contextMemorySuccessor.id })
                      .from(contextMemorySuccessor)
                      .where(
                        and(
                          eq(contextMemorySuccessor.supersedesId, memories.id),
                          lte(contextMemorySuccessor.effectiveAt, asOf),
                        ),
                      ),
                  ),
                ),
              )
              .orderBy(desc(memories.effectiveAt), desc(memories.id))
              .limit(input.limits.memories);
      const decisionRows =
        input.limits.decisions === 0
          ? []
          : await transaction
              .select()
              .from(decisions)
              .where(
                and(
                  lte(decisions.decidedAt, asOf),
                  or(isNull(decisions.revokedAt), gt(decisions.revokedAt, asOf)),
                  notExists(
                    transaction
                      .select({ id: contextDecisionSuccessor.id })
                      .from(contextDecisionSuccessor)
                      .where(
                        and(
                          eq(contextDecisionSuccessor.supersedesId, decisions.id),
                          lte(contextDecisionSuccessor.decidedAt, asOf),
                        ),
                      ),
                  ),
                ),
              )
              .orderBy(desc(decisions.decidedAt), desc(decisions.id))
              .limit(input.limits.decisions);
      const taskRows =
        input.limits.tasks === 0
          ? []
          : await transaction
              .select()
              .from(tasks)
              .where(
                and(
                  inArray(tasks.status, ["todo", "in_progress"]),
                  lte(tasks.createdAt, asOf),
                  lte(tasks.updatedAt, asOf),
                ),
              )
              .orderBy(asc(tasks.dueAt), desc(tasks.updatedAt), desc(tasks.id))
              .limit(input.limits.tasks);
      const reminderRows =
        input.limits.reminders === 0
          ? []
          : await transaction
              .select()
              .from(reminders)
              .where(
                and(
                  isNull(reminders.completedAt),
                  lte(reminders.createdAt, asOf),
                  lte(reminders.updatedAt, asOf),
                ),
              )
              .orderBy(asc(reminders.remindAt), desc(reminders.id))
              .limit(input.limits.reminders);
      const goalRows =
        input.limits.goals === 0
          ? []
          : await transaction
              .select()
              .from(goals)
              .where(
                and(
                  eq(goals.status, "active"),
                  lte(goals.createdAt, asOf),
                  lte(goals.updatedAt, asOf),
                ),
              )
              .orderBy(asc(goals.targetAt), desc(goals.updatedAt), desc(goals.id))
              .limit(input.limits.goals);
      const planRows = await transaction
        .select({ plan: priorityPlans, version: priorityPlanVersions })
        .from(priorityPlans)
        .innerJoin(
          priorityPlanVersions,
          and(
            eq(priorityPlanVersions.id, priorityPlans.currentVersionId),
          ),
        )
        .where(
          and(
            lte(priorityPlanVersions.periodStart, asOf),
            gt(priorityPlanVersions.periodEnd, asOf),
            lte(priorityPlanVersions.effectiveAt, asOf),
          ),
        )
        .orderBy(asc(priorityPlanVersions.periodEnd), asc(priorityPlans.id))
        .limit(20);
      const planVersionIds = planRows.map((row) => row.version.id);
      const planItemRows =
        planVersionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(priorityPlanVersionItems)
              .where(
                and(
                  inArray(priorityPlanVersionItems.priorityPlanVersionId, planVersionIds),
                ),
              )
              .orderBy(asc(priorityPlanVersionItems.rank));
      const taskIds = taskRows.map((row) => row.id);
      const taskLinks =
        taskIds.length === 0
          ? []
          : await transaction
              .select()
              .from(taskGoalLinks)
              .where(
                and(
                  inArray(taskGoalLinks.taskId, taskIds),
                ),
              );
      const people = await peopleByEntity(
        transaction,
        memoryRows.map((row) => row.id),
        decisionRows.map((row) => row.id),
      );
      const itemsByVersion = new Map<string, typeof planItemRows>();
      for (const item of planItemRows) {
        const current = itemsByVersion.get(item.priorityPlanVersionId) ?? [];
        current.push(item);
        itemsByVersion.set(item.priorityPlanVersionId, current);
      }
      const linksByTask = new Map<string, typeof taskLinks>();
      for (const link of taskLinks) {
        const current = linksByTask.get(link.taskId) ?? [];
        current.push(link);
        linksByTask.set(link.taskId, current);
      }
      const relevantMemories: Memory[] = memoryRows.map((row) => ({
        id: row.id,
        lineageId: row.lineageId,
        version: row.versionNumber,
        supersedesId: row.supersedesId,
        content: row.content,
        category: row.category,
        tags: row.tags,
        projectId: row.projectId,
        personIds: people.memories.get(row.id) ?? [],
        effectiveAt: row.effectiveAt.toISOString(),
        capturedAt: row.capturedAt?.toISOString() ?? null,
        supersededBy: null,
        supersededAt: null,
        provenance: attribution(row),
        sourceExcerpt: row.sourceExcerpt,
        contentHash: row.contentHash,
        createdAt: row.createdAt.toISOString(),
      }));
      const activeDecisions: Decision[] = decisionRows.map((row) => ({
        id: row.id,
        lineageId: row.lineageId,
        version: row.versionNumber,
        supersedesId: row.supersedesId,
        statement: row.statement,
        rationale: row.rationale,
        rejectedAlternatives: row.rejectedAlternatives,
        status: "active",
        projectId: row.projectId,
        personIds: people.decisions.get(row.id) ?? [],
        decidedAt: row.decidedAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
        provenance: attribution(row),
        sourceExcerpt: row.sourceExcerpt,
        contentHash: row.contentHash,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
      const openTasks: Task[] = taskRows.map((row) => ({
        id: row.id,
        listId: row.listId,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        dueAt: row.dueAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        projectId: row.projectId,
        goalLinks: (linksByTask.get(row.id) ?? []).map((link) => ({
          goalId: link.goalId,
          basis: link.basis,
          confidence: link.confidence,
        })),
        version: row.historyVersion,
        historyCompleteFrom: row.historyCompleteFrom.toISOString(),
        provenance: attribution(row),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
      const pendingReminders: Reminder[] = reminderRows.map((row) => ({
        id: row.id,
        message: row.message,
        remindAt: row.remindAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        version: row.historyVersion,
        historyCompleteFrom: row.historyCompleteFrom.toISOString(),
        provenance: attribution(row),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
      const activeGoals: Goal[] = goalRows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        successCriteria: row.successCriteria,
        status: row.status,
        targetAt: row.targetAt?.toISOString() ?? null,
        projectId: row.projectId,
        version: row.version,
        historyCompleteFrom: row.historyCompleteFrom.toISOString(),
        provenance: attribution(row),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
      const currentPriorities: PriorityPlan[] = planRows.map(({ plan, version }) => ({
        id: plan.id,
        projectId: version.projectId,
        periodStart: version.periodStart.toISOString(),
        periodEnd: version.periodEnd.toISOString(),
        version: version.versionNumber,
        currentVersionId: version.id,
        items: (itemsByVersion.get(version.id) ?? []).map((item) => ({
          goalId: item.goalId,
          rank: item.rank,
          intendedSharePercent: item.intendedSharePercent,
        })),
        note: version.note,
        provenance: attribution(plan),
        createdAt: plan.createdAt.toISOString(),
        updatedAt: plan.updatedAt.toISOString(),
      }));
      const [taskGap, reminderGap, goalGap, priorityGap] = await Promise.all([
        transaction
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              lte(tasks.createdAt, asOf),
              gt(tasks.updatedAt, asOf),
            ),
          )
          .limit(1),
        transaction
          .select({ id: reminders.id })
          .from(reminders)
          .where(
            and(
              lte(reminders.createdAt, asOf),
              gt(reminders.updatedAt, asOf),
            ),
          )
          .limit(1),
        transaction
          .select({ id: goals.id })
          .from(goals)
          .where(
            and(
              lte(goals.createdAt, asOf),
              gt(goals.updatedAt, asOf),
            ),
          )
          .limit(1),
        transaction
          .select({ id: priorityPlans.id })
          .from(priorityPlans)
          .where(
            and(
              lte(priorityPlans.createdAt, asOf),
              gt(priorityPlans.updatedAt, asOf),
            ),
          )
          .limit(1),
      ]);
      signal.throwIfAborted();
      const incompleteHistorical =
        taskGap.length > 0 ||
        reminderGap.length > 0 ||
        goalGap.length > 0 ||
        priorityGap.length > 0;
      const knowledgeBaseRows = await transaction
        .select({
          id: knowledgeBases.id,
          name: knowledgeBases.name,
          description: knowledgeBases.description,
        })
        .from(knowledgeBases)
        .orderBy(asc(knowledgeBases.createdAt), asc(knowledgeBases.id));
      const knowledgeBaseCatalog: KnowledgeBaseCatalogEntry[] = knowledgeBaseRows.map(
        (row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
        }),
      );
      const personRows = await transaction
        .select()
        .from(peopleTable)
        .orderBy(desc(peopleTable.updatedAt), desc(peopleTable.id))
        .limit(50);
      const personRelations = await loadPersonRelations(
        transaction,
        personRows.map((row) => row.id),
      );
      const relatedProjectIds = [
        ...new Set(
          [...personRelations.values()].flatMap((value) => [...value.projectIds]),
        ),
      ];
      const relatedProjectRows =
        relatedProjectIds.length === 0
          ? []
          : await transaction
              .select({ id: projects.id, name: projects.name })
              .from(projects)
              .where(inArray(projects.id, relatedProjectIds));
      const projectsById = new Map(relatedProjectRows.map((row) => [row.id, row]));
      const basesById = new Map(knowledgeBaseCatalog.map((row) => [row.id, row]));
      const peopleIndex: PersonIndexEntry[] = personRows.map((row) => {
        const related = personRelations.get(row.id);
        return {
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
        };
      });
      signal.throwIfAborted();
      return {
        generatedAt: new Date().toISOString(),
        asOf: asOf.toISOString(),
        purpose: input.purpose,
        currentPriorities,
        activeGoals,
        activeDecisions,
        relevantMemories,
        openTasks,
        pendingReminders,
        knowledgeBases: knowledgeBaseCatalog,
        peopleIndex,
        coverage: {
          completeFrom: null,
          requestedAsOf: asOf.toISOString(),
          complete: !incompleteHistorical,
          warnings: incompleteHistorical
            ? ["Some mutable entity history is incomplete for the requested time."]
            : [],
        },
      };
    });
  }

  async createHandoff(
    access: BrainAccessContext,
    input: {
      readonly title: string;
      readonly summary: string;
      readonly nextActions: readonly string[];
      readonly entityRefs: BrainHandoff["entityRefs"];
      readonly expiresAt: string | null;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<BrainHandoff> {
    const refs = entityRefsSchema.parse(input.entityRefs);
    const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
    if (expiresAt !== null && !Number.isFinite(expiresAt.valueOf())) {
      throw new Error("expiresAt must be a valid timestamp.");
    }
    if (input.idempotencyKey.trim() === "" || input.idempotencyKey.length > 500) {
      throw new Error("idempotencyKey must contain between 1 and 500 characters.");
    }
    const requestDigest = digest({ ...input, entityRefs: refs });
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "editor", signal);
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`handoff.create:${input.idempotencyKey}`}, 0))`,
      );
      const receiptRows = await transaction
        .select({ requestDigest: mutationReceipts.requestDigest, result: mutationReceipts.result })
        .from(mutationReceipts)
        .where(
          and(
            eq(mutationReceipts.operation, "handoff.create"),
            eq(mutationReceipts.idempotencyKey, input.idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);
      const receipt = receiptRows[0];
      if (receipt !== undefined) {
        if (receipt.requestDigest !== requestDigest) {
          throw new Error("The idempotency key was already used with another request.");
        }
        const decoded = receiptResultSchema.parse(receipt.result);
        const replay = await transaction
          .select()
          .from(brainHandoffs)
          .where(
            and(
              eq(brainHandoffs.id, decoded.handoffId),
            ),
          )
          .limit(1);
        if (replay[0] === undefined) throw new Error("Stored handoff receipt is invalid.");
        return mapHandoff(replay[0]);
      }
      const created = await transaction
        .insert(brainHandoffs)
        .values({
          title: input.title,
          summary: input.summary,
          nextActions: [...input.nextActions],
          entityRefs: refs,
          actorKind: access.actor.kind,
          actorAccountId: access.actor.accountId,
          actorClientId: access.actor.clientId,
          actorSource: access.actor.source,
          requestId: access.actor.requestId,
          correlationId: access.actor.correlationId,
          causationId: access.actor.causationId,
          dreamingRunId: null,
          expiresAt,
        })
        .returning();
      const row = created[0];
      if (row === undefined) throw new Error("The handoff was not created.");
      await transaction.insert(mutationReceipts).values({
        operation: "handoff.create",
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        resultEntityType: "handoff",
        resultEntityId: row.id,
        result: { handoffId: row.id },
      });
      signal.throwIfAborted();
      return mapHandoff(row);
    });
  }

  async listHandoffs(
    access: BrainAccessContext,
    input: {
      readonly cursor: { readonly ts: string; readonly id: string } | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("limit must be an integer between 1 and 100.");
    }
    const cursorDate = input.cursor === null ? null : new Date(input.cursor.ts);
    if (cursorDate !== null && !Number.isFinite(cursorDate.valueOf())) {
      throw new Error("cursor.ts must be a valid timestamp.");
    }
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "viewer", signal);
      const now = new Date();
      const rows = await transaction
        .select()
        .from(brainHandoffs)
        .where(
          and(
            or(isNull(brainHandoffs.expiresAt), gt(brainHandoffs.expiresAt, now)),
            input.cursor === null
              ? undefined
              : or(
                  lt(brainHandoffs.createdAt, cursorDate!),
                  and(
                    eq(brainHandoffs.createdAt, cursorDate!),
                    lt(brainHandoffs.id, input.cursor.id),
                  ),
                ),
          ),
        )
        .orderBy(desc(brainHandoffs.createdAt), desc(brainHandoffs.id))
        .limit(input.limit + 1);
      signal.throwIfAborted();
      const items = rows.slice(0, input.limit).map(mapHandoff);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? { ts: last.createdAt, id: last.id }
            : null,
      };
    });
  }
}
