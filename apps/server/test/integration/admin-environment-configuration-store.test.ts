import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEnvironmentConfigurationManager } from "@second-brain/engine/environment-configuration";
import type { BrainAccessContext, BrainRole } from "@second-brain/engine/domain";
import { schema } from "@second-brain/engine/database/schema/index";
import { accounts } from "@second-brain/engine/database/schema/identity";
import { DrizzleEnvironmentConfigurationStore } from "../../src/services/admin/persistence/environment-configuration-store.js";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

async function runMigrations(resource: DisposableTestDatabase): Promise<void> {
  const migrationModule = (await import("@second-brain/engine/database/migrate")) as {
    runMigrations?: (pool: DisposableTestDatabase["pool"]) => Promise<void>;
  };
  if (migrationModule.runMigrations === undefined) {
    throw new Error("runMigrations is not exported.");
  }
  await migrationModule.runMigrations(resource.pool);
}

function access(
  accountId: string,
  role: BrainRole,
  requestId: string = randomUUID(),
): BrainAccessContext {
  return {
    accountId,
    role,
    actor: {
      kind: "account",
      source: "direct",
      accountId,
      clientId: null,
      requestId,
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
}

describe("Drizzle environment configuration persistence", () => {
  let resource: DisposableTestDatabase;
  let database: SecondBrainDatabase;

  beforeAll(async () => {
    resource = await provisionTestDatabase("environment_config");
    await runMigrations(resource);
    database = drizzle(resource.pool, { schema });
  });

  afterAll(async () => {
    await resource?.destroy();
  });

  it("authorizes, encrypts, revisions, replays, and audits staged values", async () => {
    const ownerId = randomUUID();
    const adminId = randomUUID();
    await database.insert(accounts).values([
      {
        id: ownerId,
        email: `${ownerId}@example.com`,
        passwordHash: "integration-test-password-hash",
        role: "owner",
      },
      {
        id: adminId,
        email: `${adminId}@example.com`,
        passwordHash: "integration-test-password-hash",
        role: "admin",
      },
    ]);
    const owner = access(ownerId, "owner", "configuration-owner-request");
    const admin = access(adminId, "admin", "configuration-admin-request");
    const store = new DrizzleEnvironmentConfigurationStore(database);
    const manager = createEnvironmentConfigurationManager({
      store,
      encryptionKey: Buffer.alloc(32, 13),
    });
    const signal = AbortSignal.timeout(10_000);

    await expect(manager.list(admin, signal)).resolves.toMatchObject({
      revision: 0,
      restartRequired: false,
      updatedAt: null,
    });
    await expect(
      manager.stage(
        admin,
        {
          expectedRevision: 0,
          idempotencyKey: "admin-must-not-stage",
          changes: [
            {
              name: "OPENROUTER_ANSWER_MODEL",
              operation: "set",
              value: "provider/model",
            },
          ],
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "BRAIN_ACCESS_DENIED" });

    const stageInput = {
      expectedRevision: 0,
      idempotencyKey: "owner-provider-configuration-v1",
      changes: [
        { name: "OPENROUTER_API_KEY", operation: "set", value: "raw-secret-value" },
        {
          name: "OPENROUTER_ANSWER_MODEL",
          operation: "set",
          value: "provider/model",
        },
      ],
    } as const;
    const created = await manager.stage(owner, stageInput, signal);
    expect(created).toMatchObject({
      revision: 1,
      restartRequired: true,
      replayed: false,
      changedNames: ["OPENROUTER_ANSWER_MODEL", "OPENROUTER_API_KEY"],
    });

    const rawConfiguration = await resource.pool.query<{
      entries: Record<string, unknown>;
    }>("select entries from environment_configuration where id = 1");
    expect(JSON.stringify(rawConfiguration.rows)).not.toContain("raw-secret-value");
    expect(rawConfiguration.rows[0]?.entries.OPENROUTER_API_KEY).toMatchObject({
      kind: "secret",
      version: 1,
    });

    const listed = await manager.list(admin, signal);
    const secret = listed.variables.find(({ name }) => name === "OPENROUTER_API_KEY");
    expect(secret).toEqual({
      name: "OPENROUTER_API_KEY",
      secret: true,
      configured: true,
      restartRequired: true,
    });
    expect(secret).not.toHaveProperty("value");

    await expect(manager.stage(owner, stageInput, signal)).resolves.toMatchObject({
      revision: 1,
      replayed: true,
    });
    await expect(
      manager.stage(
        owner,
        {
          ...stageInput,
          changes: [
            {
              name: "OPENROUTER_ANSWER_MODEL",
              operation: "set",
              value: "provider/changed-model",
            },
          ],
        },
        signal,
      ),
    ).rejects.toThrow("idempotency key was already used with another request");
    await expect(
      manager.stage(
        owner,
        {
          expectedRevision: 0,
          idempotencyKey: "owner-stale-revision",
          changes: [
            {
              name: "OPENROUTER_ANSWER_MODEL",
              operation: "set",
              value: "provider/changed-model",
            },
          ],
        },
        signal,
      ),
    ).resolves.toBeNull();

    const receipts = await resource.pool.query<{
      changed_names: string[];
      result_revision: number;
      actor_alias_id: string;
    }>(
      "select changed_names, result_revision, actor_alias_id from environment_configuration_changes order by created_at, id",
    );
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]).toMatchObject({
      changed_names: ["OPENROUTER_ANSWER_MODEL", "OPENROUTER_API_KEY"],
      result_revision: 1,
    });
    expect(receipts.rows[0]?.actor_alias_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const audits = await resource.pool.query<{
      action: string;
      metadata: Record<string, unknown>;
      changed_names: string[];
    }>(
      "select action, metadata, changed_names from admin_audit_events where target_type = 'environment_configuration' order by created_at, id",
    );
    expect(audits.rows).toEqual([
      {
        action: "environment.configuration.updated",
        metadata: {
          changedNames: ["OPENROUTER_ANSWER_MODEL", "OPENROUTER_API_KEY"],
        },
        changed_names: ["OPENROUTER_ANSWER_MODEL", "OPENROUTER_API_KEY"],
      },
    ]);
    expect(JSON.stringify(audits.rows)).not.toContain("raw-secret-value");
    const auditAlias = await resource.pool.query<{ actor_alias_id: string }>(
      "select actor_alias_id from admin_audit_events where target_type = 'environment_configuration'",
    );
    expect(auditAlias.rows[0]?.actor_alias_id).toBe(receipts.rows[0]?.actor_alias_id);

    const restartInput = {
      expectedRevision: 1,
      idempotencyKey: "owner-restart-configuration-v1",
    } as const;
    await expect(manager.restart(admin, restartInput, signal)).rejects.toMatchObject({
      code: "BRAIN_ACCESS_DENIED",
    });
    const requested = await manager.restart(owner, restartInput, signal);
    expect(requested).toMatchObject({
      revision: 1,
      targets: ["engine", "admin", "automation-worker"],
      replayed: false,
    });
    expect(requested?.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    await expect(store.readRestartRequestForRuntime(signal)).resolves.toBe(1);
    await expect(manager.list(admin, signal)).resolves.toMatchObject({
      revision: 1,
      restartRequired: false,
    });
    await expect(manager.restart(owner, restartInput, signal)).resolves.toMatchObject({
      revision: 1,
      replayed: true,
    });
    await expect(
      manager.restart(
        owner,
        { expectedRevision: 1, idempotencyKey: "owner-restart-stale" },
        signal,
      ),
    ).resolves.toBeNull();

    const restartReceipts = await resource.pool.query<{
      configuration_revision: number;
      actor_alias_id: string;
    }>(
      "select configuration_revision, actor_alias_id from environment_configuration_restart_requests order by created_at, id",
    );
    expect(restartReceipts.rows).toEqual([
      {
        configuration_revision: 1,
        actor_alias_id: receipts.rows[0]?.actor_alias_id,
      },
    ]);
    const restartAudits = await resource.pool.query<{
      action: string;
      target_id: string;
      metadata: Record<string, unknown>;
      changed_names: string[];
    }>(
      "select action, target_id, metadata, changed_names from admin_audit_events where target_type = 'environment_services' order by created_at, id",
    );
    expect(restartAudits.rows).toEqual([
      {
        action: "environment.services.restart_requested",
        target_id: "1",
        metadata: {},
        changed_names: [],
      },
    ]);
  });
});
