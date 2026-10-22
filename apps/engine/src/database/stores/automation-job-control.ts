import { eq } from "drizzle-orm";

import type { AutomationJob, AutomationStore } from "../../domain.js";
import { automationJobs } from "../schema/automation.js";
import type { SecondBrainDatabase } from "./database.js";
import { requireUuid } from "./mutation-support.js";

/*
 * The engine's own handle on job cancellation. The automation worker and its
 * full store live in the server; the engine only needs to ask a job to stop
 * when an administrator cancels a Brain Pack run, and it must do so without
 * depending on the server workspace.
 */

const canceledSanitizedError = "JOB_CANCELED";

function mapJob(row: typeof automationJobs.$inferSelect): AutomationJob {
  return {
    id: row.id,
    kind: row.kind,
    canonicalKey: row.canonicalKey,
    scheduledFor: row.scheduledFor.toISOString(),
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    fencingToken: row.fencingToken,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    sanitizedError: row.sanitizedError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type AutomationJobControl = Pick<AutomationStore, "requestCancel">;

/** Same contract as the server's automation store: a waiting job ends now, a running one is flagged for its worker. */
export class DrizzleAutomationJobControl implements AutomationJobControl {
  constructor(private readonly database: SecondBrainDatabase) {}

  async requestCancel(
    jobId: string,
    input: { readonly requestedBy: string; readonly now: string },
    signal: AbortSignal,
  ): Promise<AutomationJob | null> {
    requireUuid(jobId, "jobId");
    if (input.requestedBy.trim() === "" || input.requestedBy.length > 500) {
      throw new Error("requestedBy must contain between 1 and 500 characters.");
    }
    const now = new Date(input.now);
    if (!Number.isFinite(now.valueOf())) throw new Error("now must be a valid ISO timestamp.");
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.select().from(automationJobs).where(eq(automationJobs.id, jobId)).for("update");
      const row = rows[0];
      if (row === undefined) return null;
      const terminal = row.status === "completed" || row.status === "failed" || row.status === "canceled";
      if (terminal || row.cancelRequestedAt !== null) return mapJob(row);
      const waiting = row.status === "pending" || row.status === "retry_wait";
      const payload =
        typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {};
      const updated = await transaction
        .update(automationJobs)
        .set({
          ...(waiting
            ? {
                status: "canceled" as const,
                nextAttemptAt: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                fencingToken: null,
                sanitizedError: canceledSanitizedError,
              }
            : {}),
          cancelRequestedAt: now,
          payload: { ...payload, cancelRequestedBy: input.requestedBy },
          updatedAt: now,
        })
        .where(eq(automationJobs.id, row.id))
        .returning();
      signal.throwIfAborted();
      return updated[0] === undefined ? null : mapJob(updated[0]);
    });
  }
}
