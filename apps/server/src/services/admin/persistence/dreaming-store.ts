import { alias } from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import { and, desc, eq, exists, gte, lt, sql } from "drizzle-orm";
import { automationJobs, automationSettings } from "@second-brain/engine/database/schema/automation";
import { dreamingReports, dreamingRuns } from "@second-brain/engine/database/schema/dreaming";
import { mutationReceipts } from "@second-brain/engine/database/schema/temporal";
import { authorizeBrainTransaction } from "@second-brain/engine/database/stores/authorization";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import type { BrainAccessContext } from "@second-brain/engine/domain";
import type { AdminDreamingStore } from "../dreaming-domain.js";
import { AdminRevisionConflictError } from "../domain.js";
import { appendAdminAuditEvent } from "../../shared/audit-store.js";
import { AdminAutomationIdempotencyConflictError, AdminDreamingDateError, AdminDreamingDisabledError } from "./automation-store.js";

const retryOperation = "admin_dreaming_retry";
function localDateAt(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export class DrizzleAdminDreamingStore implements AdminDreamingStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async calendar(access: BrainAccessContext, input: { month: string }, signal: AbortSignal) {
    if (!/^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(input.month)) throw new AdminDreamingDateError();
    const [year, month] = input.month.split("-").map(Number);
    const nextMonth = new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 10);
    return this.database.transaction(async (tx) => {
      await authorizeBrainTransaction(tx, access, "admin", signal);
      const [settings] = await tx.select().from(automationSettings).where(eq(automationSettings.id, 1));
      if (!settings) throw new AdminRevisionConflictError();
      const localDate = sql<string>`${automationJobs.payload}->>'localDate'`;
      const replayJobs = alias(automationJobs, "replay_jobs");
      const rows = await tx.select({
        jobId: automationJobs.id, localDate, status: automationJobs.status, attemptCount: automationJobs.attemptCount,
        runId: dreamingRuns.id, reportRunId: dreamingReports.runId, replayOfRunId: dreamingRuns.replayOfRunId,
        sourceJobId: sql<string | null>`${automationJobs.payload}->>'replayOfJobId'`,
        mode: dreamingRuns.mode, timeZone: dreamingRuns.timeZone, model: dreamingRuns.model, sanitizedError: automationJobs.sanitizedError,
        createdAt: automationJobs.createdAt, updatedAt: automationJobs.updatedAt,
        hasReplay: sql<boolean>`${exists(tx.select({ id: replayJobs.id }).from(replayJobs).where(and(eq(replayJobs.kind, "daily_dreaming"), eq(replayJobs.canonicalKey, sql`'daily_dreaming:retry:' || ${automationJobs.id}::text`))))}`,
      }).from(automationJobs).leftJoin(dreamingRuns, eq(dreamingRuns.automationJobId, automationJobs.id)).leftJoin(dreamingReports, eq(dreamingReports.runId, dreamingRuns.id))
        .where(and(eq(automationJobs.kind, "daily_dreaming"), gte(localDate, `${input.month}-01`), lt(localDate, nextMonth)))
        .orderBy(desc(localDate), desc(automationJobs.createdAt), desc(automationJobs.id)).limit(501);
      signal.throwIfAborted();
      return { month: input.month, timeZone: settings.timeZone, today: localDateAt(new Date(), settings.timeZone), truncated: rows.length > 500, items: rows.slice(0, 500).map(({ hasReplay, ...row }) => ({ ...row, timeZone: row.timeZone ?? settings.timeZone, mode: row.mode ?? (row.sourceJobId ? "preview" as const : null), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), canRetry: row.status === "failed" && !hasReplay })) };
    });
  }

  async retry(access: BrainAccessContext, input: { jobId: string; idempotencyKey: string }, signal: AbortSignal) {
    const requestDigest = createHash("sha256").update(JSON.stringify({ jobId: input.jobId })).digest("hex");
    return this.database.transaction(async (tx) => {
      const authorized = await authorizeBrainTransaction(tx, access, "admin", signal);
      // All enqueue paths lock settings first; this also serializes retry receipts.
      const [settings] = await tx.select().from(automationSettings).where(eq(automationSettings.id, 1)).for("update");
      if (!settings) throw new AdminRevisionConflictError();
      const [receipt] = await tx.select().from(mutationReceipts).where(and(eq(mutationReceipts.operation, retryOperation), eq(mutationReceipts.idempotencyKey, input.idempotencyKey))).limit(1);
      if (receipt) {
        if (receipt.requestDigest !== requestDigest) throw new AdminAutomationIdempotencyConflictError();
        if (!receipt.resultEntityId) throw new AdminRevisionConflictError();
        return { jobId: receipt.resultEntityId, sourceJobId: input.jobId, created: false, mode: "preview" as const };
      }
      if (!settings.dreamingEnabled) throw new AdminDreamingDisabledError();
      const [source] = await tx.select().from(automationJobs).where(and(eq(automationJobs.id, input.jobId), eq(automationJobs.kind, "daily_dreaming"))).for("update").limit(1);
      if (!source || source.status !== "failed") throw new AdminRevisionConflictError();
      let [parentRun] = await tx.select().from(dreamingRuns).where(eq(dreamingRuns.automationJobId, source.id)).limit(1);
      const payload = source.payload as { localDate?: unknown; replayOfRunId?: unknown };
      if (!parentRun && typeof payload?.replayOfRunId === "string" && /^[0-9a-f-]{36}$/i.test(payload.replayOfRunId)) {
        [parentRun] = await tx.select().from(dreamingRuns).where(eq(dreamingRuns.id, payload.replayOfRunId)).limit(1);
      }
      const date = payload?.localDate;
      if (parentRun && parentRun.localDate !== date) throw new AdminRevisionConflictError();
      const timeZone = parentRun?.timeZone ?? settings.timeZone;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || date >= localDateAt(new Date(), timeZone)) throw new AdminDreamingDateError();
      const canonicalKey = `daily_dreaming:retry:${source.id}`;
      const inserted = await tx.insert(automationJobs).values({ kind: "daily_dreaming", canonicalKey, scheduledFor: new Date(), payload: { localDate: date, replayOfJobId: source.id, replayOfRunId: parentRun?.id ?? null } }).onConflictDoNothing({ target: [automationJobs.kind, automationJobs.canonicalKey] }).returning();
      const replay = inserted[0] ?? (await tx.select().from(automationJobs).where(and(eq(automationJobs.kind, "daily_dreaming"), eq(automationJobs.canonicalKey, canonicalKey))).limit(1))[0];
      if (!replay) throw new AdminRevisionConflictError();
      await tx.insert(mutationReceipts).values({ operation: retryOperation, idempotencyKey: input.idempotencyKey, requestDigest, resultEntityType: "automation_job", resultEntityId: replay.id, result: { sourceJobId: source.id, localDate: date, mode: "preview" } });
      await appendAdminAuditEvent(tx, authorized, { category: "automation", action: "automation.dreaming.retried", outcome: "succeeded", targetType: "automation_job", targetId: replay.id, errorCode: null, metadata: { sourceJobId: source.id, localDate: date, mode: "preview", created: inserted.length > 0 } }, signal);
      signal.throwIfAborted();
      return { jobId: replay.id, sourceJobId: source.id, created: inserted.length > 0, mode: "preview" as const };
    });
  }
}
