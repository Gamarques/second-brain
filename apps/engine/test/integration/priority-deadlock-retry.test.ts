import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../../src/database/client.js";
import { runMigrations } from "../../src/database/migrate.js";
import { accounts } from "../../src/database/schema/identity.js";
import { DrizzleBrainAccessStore } from "../../src/database/stores/access-store.js";
import { DrizzleGoalStore } from "../../src/database/stores/goal-store.js";
import { DrizzlePriorityPlanStore } from "../../src/database/stores/priority-store.js";
import { createSecondBrainEngine } from "../../src/engine.js";
import { boundaryDependencies } from "../support/engine-dependencies.js";
import { provisionTestDatabase, type DisposableTestDatabase } from "./support/database.js";

describe("priority mutation deadlock recovery", () => {
  let resource: DisposableTestDatabase;
  let database: ReturnType<typeof createDatabase>;
  let engine: ReturnType<typeof createSecondBrainEngine>;
  let accountId: string;
  let goalId: string;

  beforeEach(async () => {
    resource = await provisionTestDatabase("priority_deadlock");
    await runMigrations(resource.pool);
    database = createDatabase(resource.pool);
    accountId = randomUUID();
    await database.insert(accounts).values({ id: accountId, email: `${accountId}@example.test`, passwordHash: "unused", role: "owner" });
    engine = createSecondBrainEngine({
      ...boundaryDependencies(),
      access: new DrizzleBrainAccessStore(database),
      goals: new DrizzleGoalStore(database),
      priorities: new DrizzlePriorityPlanStore(database),
    });
    const goal = await engine.invoke("goals_create", { title: "Recover a priority mutation", idempotencyKey: "retry-goal" }, { principal: { id: accountId } });
    goalId = goal.id;
  });

  afterEach(async () => { vi.restoreAllMocks(); await resource?.destroy(); });

  function createInput() {
    return { periodStart: "2099-01-01T00:00:00.000Z", periodEnd: "2099-02-01T00:00:00.000Z", items: [{ goalId, rank: 1, intendedSharePercent: 100 }], idempotencyKey: "retry-plan" };
  }

  async function installFailure(code: "40P01" | "22023", failures: number) {
    // Sequence values survive rollback, so retries are observable without
    // depending on which participant PostgreSQL selects as a deadlock victim.
    await resource.pool.query(`
      CREATE SEQUENCE priority_retry_attempts;
      CREATE FUNCTION fail_priority_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('priority_retry_attempts') <= ${failures} THEN
          RAISE EXCEPTION 'Injected priority transaction failure' USING ERRCODE = '${code}';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_priority_mutation BEFORE INSERT OR UPDATE ON priority_plans
        FOR EACH ROW EXECUTE FUNCTION fail_priority_mutation();
    `);
  }

  async function attempts() {
    const result = await resource.pool.query<{ last_value: string }>("SELECT last_value FROM priority_retry_attempts");
    return Number(result.rows[0]!.last_value);
  }

  async function mutationCounts() {
    const result = await resource.pool.query(`
      SELECT
        (SELECT count(*)::int FROM priority_plans) AS plans,
        (SELECT count(*)::int FROM priority_plan_versions) AS versions,
        (SELECT count(*)::int FROM mutation_receipts WHERE operation LIKE 'priorities.%') AS receipts,
        (SELECT count(*)::int FROM activity_events WHERE entity_type = 'priority_plan') AS events
    `);
    return result.rows[0];
  }

  it("retries the complete create transaction and preserves idempotent history", async () => {
    await installFailure("40P01", 1);
    const input = createInput();
    const plan = await engine.invoke("priorities_create", input, { principal: { id: accountId } });
    expect(plan.version).toBe(1);
    expect(await attempts()).toBe(2);
    expect(await mutationCounts()).toEqual({ plans: 1, versions: 1, receipts: 1, events: 1 });
    expect(await engine.invoke("priorities_create", input, { principal: { id: accountId } })).toEqual(plan);
    expect(await attempts()).toBe(2);
  });

  it("retries an update with its original precondition and records one version", async () => {
    const plan = await engine.invoke("priorities_create", createInput(), { principal: { id: accountId } });
    await installFailure("40P01", 1);
    const input = { id: plan.id, expectedVersion: 1, note: "Recovered update", idempotencyKey: "retry-update" };
    const updated = await engine.invoke("priorities_update", input, { principal: { id: accountId } });
    expect(updated).toMatchObject({ id: plan.id, version: 2, note: input.note });
    expect(await attempts()).toBe(2);
    expect(await mutationCounts()).toEqual({ plans: 1, versions: 2, receipts: 2, events: 2 });
    expect(await engine.invoke("priorities_update", input, { principal: { id: accountId } })).toEqual(updated);
  });

  it("stops after three deadlocked attempts without persisting partial writes", async () => {
    await installFailure("40P01", 10);
    await expect(engine.invoke("priorities_create", createInput(), { principal: { id: accountId } })).rejects.toThrow();
    expect(await attempts()).toBe(3);
    expect(await mutationCounts()).toEqual({ plans: 0, versions: 0, receipts: 0, events: 0 });
  });

  it("propagates unrelated database failures without retrying", async () => {
    await installFailure("22023", 10);
    await expect(engine.invoke("priorities_create", createInput(), { principal: { id: accountId } })).rejects.toThrow();
    expect(await attempts()).toBe(1);
    expect(await mutationCounts()).toEqual({ plans: 0, versions: 0, receipts: 0, events: 0 });
  });

  it("honors cancellation before starting a retry", async () => {
    const controller = new AbortController();
    const transaction = vi.spyOn(database, "transaction").mockImplementationOnce(async () => {
      controller.abort(new Error("Stop the priority retry."));
      throw Object.assign(new Error("Deadlock victim."), { code: "40P01" });
    });
    await expect(engine.invoke("priorities_create", createInput(), {
      principal: { id: accountId }, signal: controller.signal,
    })).rejects.toThrow();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(await mutationCounts()).toEqual({ plans: 0, versions: 0, receipts: 0, events: 0 });
  });
});
