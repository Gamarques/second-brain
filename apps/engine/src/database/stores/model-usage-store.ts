import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { ModelOperation, ModelRequestObservation } from "../../domain/model-usage.js";
import type { SecondBrainDatabase } from "./database.js";
import { modelRequests, modelRuntimeInstances } from "../schema/model-usage.js";

export class DrizzleModelUsageStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async record(observation: ModelRequestObservation): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '1500ms'`);
      await tx.insert(modelRequests).values({ ...observation, occurredAt: new Date(observation.occurredAt) });
    });
  }

  async summary(input: { days: number; operation?: ModelOperation | undefined; model?: string | undefined }, signal: AbortSignal) {
    signal.throwIfAborted();
    const since = new Date(Date.now() - input.days * 86_400_000);
    const rows = await this.database.select({
      operation: modelRequests.operation,
      model: modelRequests.model,
      requests: sql<number>`count(*)::int`,
      failures: sql<number>`count(*) filter (where ${modelRequests.outcome} = 'failed')::int`,
      inputTokens: sql<number>`coalesce(sum(${modelRequests.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${modelRequests.outputTokens}), 0)::float8`,
      reportedCost: sql<number>`coalesce(sum(${modelRequests.cost}), 0)::float8`,
      costCoverage: sql<number>`count(${modelRequests.cost})::int`,
      tokenCoverage: sql<number>`count(*) filter (where ${modelRequests.inputTokens} is not null and ${modelRequests.outputTokens} is not null)::int`,
      averageDurationMs: sql<number>`avg(${modelRequests.durationMs})::float8`,
    }).from(modelRequests).where(and(gte(modelRequests.occurredAt, since), input.operation ? eq(modelRequests.operation, input.operation) : undefined, input.model ? eq(modelRequests.model, input.model) : undefined))
      .groupBy(modelRequests.operation, modelRequests.model).orderBy(sql`count(*) desc`, modelRequests.operation, modelRequests.model).limit(501);
    const failures = await this.database.select({ reason: modelRequests.errorReason, count: sql<number>`count(*)::int` }).from(modelRequests)
      .where(and(gte(modelRequests.occurredAt, since), eq(modelRequests.outcome, "failed"), input.operation ? eq(modelRequests.operation, input.operation) : undefined, input.model ? eq(modelRequests.model, input.model) : undefined)).groupBy(modelRequests.errorReason);
    signal.throwIfAborted();
    return { since: since.toISOString(), observedAt: new Date().toISOString(), groups: rows.slice(0, 500), failures, truncated: rows.length > 500 };
  }

  async runtimes(signal: AbortSignal) {
    signal.throwIfAborted();
    const rows = await this.database.select().from(modelRuntimeInstances)
      .where(gte(modelRuntimeInstances.lastSeenAt, new Date(Date.now() - 86_400_000)))
      .orderBy(desc(modelRuntimeInstances.lastSeenAt)).limit(100);
    return rows.map((row) => ({ ...row, startedAt: row.startedAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(), healthy: Date.now() - row.lastSeenAt.getTime() < 90_000 }));
  }

  async monitorRuntime(service: "engine" | "admin" | "automation-worker", configurationRevision: number, models: Readonly<Record<string, string>>) {
    const id = randomUUID();
    await this.database.insert(modelRuntimeInstances).values({ id, service, configurationRevision, models });
    let pending: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (pending !== undefined) return;
      pending = this.database.update(modelRuntimeInstances).set({ lastSeenAt: new Date() }).where(eq(modelRuntimeInstances.id, id)).then(() => undefined).catch(() => undefined).finally(() => { pending = undefined; });
    }, 30_000);
    timer.unref();
    return { close: async () => { clearInterval(timer); await pending; await this.database.delete(modelRuntimeInstances).where(eq(modelRuntimeInstances.id, id)); } };
  }
}
