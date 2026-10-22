import { createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { BrainAccessContext } from "../../domain.js";
import {
  BriefingConflictError,
  type BriefingAction,
  type BriefingInsight,
  type BriefingSnapshot,
  type BriefingStore,
} from "../../domain/briefing.js";
import { briefingActions } from "../schema/briefing.js";
import { automationSettings } from "../schema/automation.js";
import { dreamingEvidence, dreamingReports } from "../schema/dreaming.js";
import {
  decisions,
  knowledgeDocuments,
  memories,
  reminders,
  tasks,
} from "../schema/content.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type { SecondBrainDatabase } from "./database.js";
import { mapReport } from "./dreaming-store.js";
import { createTaskInTransaction } from "./task-store.js";
import { createReminderInTransaction } from "./reminder-store.js";
const digest = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
const conflict = (): never => {
  throw new BriefingConflictError();
};
const nextMemory = alias(memories, "briefing_memory_successor");
const nextDecision = alias(decisions, "briefing_decision_successor");
const actionValue = (
  row: typeof briefingActions.$inferSelect,
): BriefingAction => ({ id: row.id, kind: row.kind, entityId: row.entityId });
export class DrizzleBriefingStore implements BriefingStore {
  constructor(private readonly database: SecondBrainDatabase) {}
  async get(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<BriefingSnapshot> {
    const now = new Date();
    const recentSince = new Date(now.valueOf() - 86400000);
    const insightsSince = new Date(now.valueOf() - 30 * 86400000);
    const dueEnd = new Date(now.valueOf() + 86400000);
    return this.database.transaction(
      async (tx) => {
        await authorizeBrainTransaction(tx, access, "admin", signal);
        const [settings] = await tx
          .select({ timeZone: automationSettings.timeZone })
          .from(automationSettings)
          .where(eq(automationSettings.id, 1));
        const memoryRows = await tx
          .select({
            id: memories.id,
            title: sql<string>`left(${memories.content}, 200)`,
            occurredAt: memories.createdAt,
            projectId: memories.projectId,
          })
          .from(memories)
          .where(
            and(
              gte(memories.createdAt, recentSince),
              notExists(
                tx
                  .select({ id: nextMemory.id })
                  .from(nextMemory)
                  .where(eq(nextMemory.supersedesId, memories.id)),
              ),
            ),
          )
          .orderBy(desc(memories.createdAt), desc(memories.id))
          .limit(21);
        const decisionRows = await tx
          .select({
            id: decisions.id,
            title: decisions.statement,
            occurredAt: decisions.createdAt,
            projectId: decisions.projectId,
          })
          .from(decisions)
          .where(
            and(
              gte(decisions.createdAt, recentSince),
              isNull(decisions.revokedAt),
              notExists(
                tx
                  .select({ id: nextDecision.id })
                  .from(nextDecision)
                  .where(eq(nextDecision.supersedesId, decisions.id)),
              ),
            ),
          )
          .orderBy(desc(decisions.createdAt), desc(decisions.id))
          .limit(21);
        const documentRows = await tx
          .select({
            id: knowledgeDocuments.id,
            title: knowledgeDocuments.title,
            occurredAt: knowledgeDocuments.updatedAt,
            projectId: knowledgeDocuments.projectId,
            knowledgeBaseId: knowledgeDocuments.knowledgeBaseId,
          })
          .from(knowledgeDocuments)
          .where(gte(knowledgeDocuments.updatedAt, recentSince))
          .orderBy(
            desc(knowledgeDocuments.updatedAt),
            desc(knowledgeDocuments.id),
          )
          .limit(21);
        const recent = [
          ...memoryRows.map((row) => ({
            ...row,
            type: "memory" as const,
            knowledgeBaseId: null,
          })),
          ...decisionRows.map((row) => ({
            ...row,
            type: "decision" as const,
            knowledgeBaseId: null,
          })),
          ...documentRows.map((row) => ({ ...row, type: "document" as const })),
        ].sort(
          (a, b) =>
            b.occurredAt.valueOf() - a.occurredAt.valueOf() ||
            a.id.localeCompare(b.id),
        );
        const dueTasks = await tx
          .select({
            id: tasks.id,
            title: tasks.title,
            dueAt: tasks.dueAt,
            projectId: tasks.projectId,
            version: tasks.historyVersion,
          })
          .from(tasks)
          .where(
            and(
              inArray(tasks.status, ["todo", "in_progress"]),
              lte(tasks.dueAt, dueEnd),
            ),
          )
          .orderBy(tasks.dueAt, tasks.id)
          .limit(11);
        const dueReminders = await tx
          .select({
            id: reminders.id,
            message: reminders.message,
            remindAt: reminders.remindAt,
            version: reminders.historyVersion,
          })
          .from(reminders)
          .where(
            and(isNull(reminders.completedAt), lte(reminders.remindAt, dueEnd)),
          )
          .orderBy(reminders.remindAt, reminders.id)
          .limit(11);
        const reports = await tx
          .select()
          .from(dreamingReports)
          .where(
            and(
              gte(dreamingReports.generatedAt, insightsSince),
              notExists(
                tx
                  .select({ id: dreamingEvidence.id })
                  .from(dreamingEvidence)
                  .where(
                    and(
                      eq(dreamingEvidence.runId, dreamingReports.runId),
                      isNotNull(dreamingEvidence.redactedAt),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(desc(dreamingReports.generatedAt), desc(dreamingReports.id))
          .limit(31);
        const reportIds = reports.slice(0, 30).map((row) => row.id);
        const actions = reportIds.length
          ? await tx
              .select({
                action: briefingActions,
                done: sql<boolean>`case when ${briefingActions.kind} = 'resolve' then true when ${briefingActions.kind} = 'task' then (${tasks.id} is null or ${tasks.status} in ('done', 'canceled')) else (${reminders.id} is null or ${reminders.completedAt} is not null) end`,
              })
              .from(briefingActions)
              .leftJoin(
                tasks,
                and(
                  eq(briefingActions.kind, "task"),
                  eq(tasks.id, briefingActions.entityId),
                ),
              )
              .leftJoin(
                reminders,
                and(
                  eq(briefingActions.kind, "reminder"),
                  eq(reminders.id, briefingActions.entityId),
                ),
              )
              .where(inArray(briefingActions.reportId, reportIds))
          : [];
        const insights: BriefingInsight[] = [];
        for (const row of reports.slice(0, 30)) {
          const report = mapReport(row);
          for (const [index, insight] of report.insights.entries()) {
            if (
              insight.kind !== "open_loop" &&
              insight.kind !== "contradiction"
            )
              continue;
            const related = actions.filter(
              ({ action }) =>
                action.reportId === row.id && action.insightIndex === index,
            );
            if (related.some((action) => action.done)) continue;
            insights.push({
              reportId: row.id,
              runId: row.runId,
              localDate: row.localDate,
              index,
              digest: digest(insight),
              kind: insight.kind,
              statement: insight.statement,
              confidence: insight.confidence,
              evidence: insight.evidence.map((item) => ({
                type: item.type,
                id: item.id,
                excerpt: item.excerpt,
              })),
              actions: related.map(({ action }) => actionValue(action)),
            });
          }
        }
        signal.throwIfAborted();
        return {
          timeZone: settings?.timeZone ?? "UTC",
          generatedAt: now.toISOString(),
          recentSince: recentSince.toISOString(),
          insightsSince: insightsSince.toISOString(),
          truncated:
            recent.length > 20 ||
            dueTasks.length > 10 ||
            dueReminders.length > 10 ||
            reports.length > 30 ||
            insights.length > 30,
          recent: recent
            .slice(0, 20)
            .map((row) => ({
              ...row,
              occurredAt: row.occurredAt.toISOString(),
            })),
          dueTasks: dueTasks
            .slice(0, 10)
            .map((row) => ({ ...row, dueAt: row.dueAt!.toISOString() })),
          dueReminders: dueReminders
            .slice(0, 10)
            .map((row) => ({ ...row, remindAt: row.remindAt.toISOString() })),
          insights: insights.slice(0, 30),
        };
      },
      { isolationLevel: "repeatable read" },
    );
  }
  async act(
    access: BrainAccessContext,
    input: Parameters<BriefingStore["act"]>[1],
    signal: AbortSignal,
  ): Promise<BriefingAction> {
    const inputDigest = digest({
      reportId: input.reportId,
      insightIndex: input.insightIndex,
      expectedDigest: input.expectedDigest,
      kind: input.kind,
      text: input.text,
      listId: input.listId,
      projectId: input.projectId,
      dueAt: input.dueAt,
    });
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "admin", signal);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`briefing-key:${input.idempotencyKey}`}, 0))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`briefing-insight:${input.reportId}:${input.insightIndex}`}, 0))`,
      );
      const receipts = await tx
        .select()
        .from(briefingActions)
        .where(
          or(
            eq(briefingActions.idempotencyKey, input.idempotencyKey),
            and(
              eq(briefingActions.reportId, input.reportId),
              eq(briefingActions.insightIndex, input.insightIndex),
              eq(briefingActions.kind, input.kind),
            ),
          ),
        );
      if (receipts.length) {
        if (receipts.some((row) => row.inputDigest !== inputDigest))
          return conflict();
        return actionValue(receipts[0]!);
      }
      const [resolved] = await tx
        .select({ id: briefingActions.id })
        .from(briefingActions)
        .where(
          and(
            eq(briefingActions.reportId, input.reportId),
            eq(briefingActions.insightIndex, input.insightIndex),
            eq(briefingActions.kind, "resolve"),
          ),
        );
      if (resolved) return conflict();
      const [row] = await tx
        .select()
        .from(dreamingReports)
        .where(eq(dreamingReports.id, input.reportId))
        .for("share");
      if (!row) return conflict();
      const evidence = await tx
        .select({ redactedAt: dreamingEvidence.redactedAt })
        .from(dreamingEvidence)
        .where(eq(dreamingEvidence.runId, row.runId))
        .for("share");
      if (evidence.some((item) => item.redactedAt !== null)) return conflict();
      const insight = mapReport(row).insights[input.insightIndex];
      if (
        !insight ||
        (insight.kind !== "open_loop" && insight.kind !== "contradiction") ||
        digest(insight) !== input.expectedDigest
      )
        return conflict();
      let entityId: string | null = null;
      if (input.kind === "task") {
        if (!input.listId || !input.text || input.text.length > 500)
          return conflict();
        const effect = await createTaskInTransaction(
          tx,
          { ...access, administrativeChannel: true },
          {
            listId: input.listId,
            title: input.text,
            description: insight.statement,
            priority: "normal",
            dueAt: input.dueAt,
            projectId: input.projectId,
            goalLinks: [],
            idempotencyKey: `briefing:${row.id}:${input.insightIndex}:task`,
          },
          signal,
        );
        if (!effect) return conflict();
        entityId = effect.task.id;
      } else if (input.kind === "reminder") {
        if (
          !input.text ||
          !input.dueAt ||
          !Number.isFinite(Date.parse(input.dueAt)) ||
          Date.parse(input.dueAt) <= Date.now()
        )
          return conflict();
        entityId = (
          await createReminderInTransaction(
            tx,
            { ...access, administrativeChannel: true },
            {
              message: input.text,
              remindAt: input.dueAt,
              idempotencyKey: `briefing:${row.id}:${input.insightIndex}:reminder`,
            },
            signal,
          )
        ).reminder.id;
      }
      const [saved] = await tx
        .insert(briefingActions)
        .values({
          reportId: row.id,
          insightIndex: input.insightIndex,
          kind: input.kind,
          inputDigest,
          idempotencyKey: input.idempotencyKey,
          entityId,
          accountId: access.accountId,
          requestId: access.actor.requestId,
        })
        .returning();
      signal.throwIfAborted();
      return actionValue(saved!);
    });
  }
}
