import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/database/client.js";
import { runMigrations } from "../../src/database/migrate.js";
import { DrizzleModelUsageStore } from "../../src/database/stores/model-usage-store.js";
import { provisionTestDatabase, type DisposableTestDatabase } from "./support/database.js";

describe("durable model request accounting", () => {
  let database: DisposableTestDatabase;
  let store: DrizzleModelUsageStore;
  const signal = new AbortController().signal;
  beforeAll(async () => { database = await provisionTestDatabase("model_usage"); await runMigrations(database.pool); store = new DrizzleModelUsageStore(createDatabase(database.pool)); }, 180_000);
  afterAll(async () => { await database?.destroy(); });

  it("aggregates bounded usage and preserves missing measurements separately from zero", async () => {
    const base = { operation: "dreaming" as const, model: "test/model", occurredAt: new Date().toISOString(), durationMs: 100, outcome: "succeeded" as const, inputTokens: 40, outputTokens: 10, cost: 0, errorReason: null };
    await store.record(base);
    await store.record({ ...base, durationMs: 300, inputTokens: null, outputTokens: null, cost: null, outcome: "failed", errorReason: "privacy" });
    await store.record({ ...base, operation: "brain_ask", cost: 1 });
    await store.record({ ...base, occurredAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), cost: 100 });
    const summary = await store.summary({ days: 7, operation: "dreaming" }, signal);
    expect(summary.groups).toEqual([{ operation: "dreaming", model: "test/model", requests: 2, failures: 1, inputTokens: 40, outputTokens: 10, reportedCost: 0, costCoverage: 1, tokenCoverage: 1, averageDurationMs: 200 }]);
    expect(summary.failures).toEqual([{ reason: "privacy", count: 1 }]);
    expect((await store.summary({ days: 7, model: "missing" }, signal)).groups).toEqual([]);
    await expect(store.summary({ days: 7 }, AbortSignal.abort())).rejects.toBeDefined();
  });

  it("reports simultaneous service revisions until their processes close", async () => {
    const first = await store.monitorRuntime("automation-worker", 3, { dreaming: "old/model" });
    const second = await store.monitorRuntime("automation-worker", 4, { dreaming: "new/model" });
    try {
      const runtimes = await store.runtimes(signal);
      expect(runtimes).toHaveLength(2);
      expect(runtimes).toEqual(expect.arrayContaining([expect.objectContaining({ configurationRevision: 3, healthy: true }), expect.objectContaining({ configurationRevision: 4, healthy: true })]));
    } finally { await first.close(); await second.close(); }
    expect(await store.runtimes(signal)).toEqual([]);
  });
});
