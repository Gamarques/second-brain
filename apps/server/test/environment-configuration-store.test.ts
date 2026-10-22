import { describe, expect, it } from "vitest";

import { createEnvironmentConfigurationManager } from "@second-brain/engine/environment-configuration";
import type { BrainAccessContext, BrainRole } from "@second-brain/engine/domain";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import { DrizzleEnvironmentConfigurationStore } from "../src/services/admin/persistence/environment-configuration-store.js";
import {
  adminAuditActorAliases,
  adminAuditEvents,
  environmentConfiguration,
  environmentConfigurationChanges,
} from "@second-brain/engine/database/schema/admin";
import { accounts } from "@second-brain/engine/database/schema/identity";

const accountId = "00000000-0000-4000-8000-000000000001";
const access: BrainAccessContext = {
  accountId,
  role: "owner",
  actor: {
    kind: "account",
    source: "direct",
    accountId,
    clientId: null,
    requestId: "admin-configuration-request",
    correlationId: null,
    causationId: null,
    dreamingRunId: null,
  },
};

interface FakeState {
  role: BrainRole;
  configuration: Record<string, unknown> | undefined;
  receipts: Record<string, unknown>[];
  audits: Record<string, unknown>[];
  actorAlias: Record<string, unknown> | undefined;
  advisoryLocks: number;
}

function fakeDatabase(state: FakeState): SecondBrainDatabase {
  const transaction = {
    execute: async () => {
      state.advisoryLocks += 1;
      return [];
    },
    select: () => {
      let table: unknown;
      const chain = {
        from(value: unknown) {
          table = value;
          return chain;
        },
        where() {
          return chain;
        },
        limit() {
          return chain;
        },
        for() {
          return chain;
        },
        then<TResult1 = unknown, TResult2 = never>(
          onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          const rows =
            table === accounts
              ? [{ role: state.role }]
              : table === environmentConfiguration
                ? state.configuration === undefined
                  ? []
                  : [state.configuration]
              : table === environmentConfigurationChanges
                  ? state.receipts
                  : table === adminAuditActorAliases
                    ? state.actorAlias === undefined
                      ? []
                      : [{ actorAliasId: state.actorAlias.id }]
                  : [];
          return Promise.resolve(rows).then(onfulfilled, onrejected);
        },
      };
      return chain;
    },
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        const returning = async () => {
          const now = new Date("2026-08-23T12:00:00.000Z");
          if (table === environmentConfiguration) {
            state.configuration = { ...value, id: 1, updatedAt: now };
            return [state.configuration];
          }
          if (table === environmentConfigurationChanges) {
            const row = {
              ...value,
              id: "00000000-0000-4000-8000-000000000002",
              createdAt: now,
            };
            state.receipts = [row];
            return [row];
          }
          if (table === adminAuditActorAliases) {
            const row = {
              ...value,
              id: "00000000-0000-4000-8000-000000000004",
              createdAt: now,
            };
            state.actorAlias = row;
            return [row];
          }
          if (table === adminAuditEvents) {
            const row = {
              ...value,
              id: "00000000-0000-4000-8000-000000000003",
              occurredAt: now,
            };
            state.audits.push(row);
            return [row];
          }
          return [];
        };
        return {
          returning,
          onConflictDoNothing: async () => {
            if (table === adminAuditActorAliases && state.actorAlias === undefined) {
              state.actorAlias = {
                ...value,
                id: "00000000-0000-4000-8000-000000000004",
                createdAt: new Date("2026-08-23T12:00:00.000Z"),
              };
            }
            return [];
          },
        };
      },
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (state.configuration === undefined) return [];
            state.configuration = {
              ...state.configuration,
              ...value,
              updatedAt: new Date("2026-08-23T12:00:00.000Z"),
            };
            return [state.configuration];
          },
        }),
      }),
    }),
  };
  return {
    transaction: async (operation: (value: unknown) => unknown) => operation(transaction),
  } as unknown as SecondBrainDatabase;
}

function initialState(role: BrainRole = "owner"): FakeState {
  return {
    role,
    configuration: undefined,
    receipts: [],
    audits: [],
    actorAlias: undefined,
    advisoryLocks: 0,
  };
}

describe("DrizzleEnvironmentConfigurationStore", () => {
  it("represents an absent singleton as revision zero after database authorization", async () => {
    const state = initialState("admin");
    const store = new DrizzleEnvironmentConfigurationStore(fakeDatabase(state));

    await expect(store.read(access, AbortSignal.timeout(1_000))).resolves.toEqual({
      revision: 0,
      entries: {},
      restartRequired: false,
      updatedAt: null,
    });
    expect(state.advisoryLocks).toBe(1);
  });

  it("offers a trusted runtime read without requiring an interactive account", async () => {
    const state = initialState("viewer");
    const store = new DrizzleEnvironmentConfigurationStore(fakeDatabase(state));

    await expect(store.readForRuntime(AbortSignal.timeout(1_000))).resolves.toEqual({
      revision: 0,
      entries: {},
      restartRequired: false,
      updatedAt: null,
    });
    expect(state.advisoryLocks).toBe(0);
  });

  it("atomically stages encrypted configuration, receipt, and changed-name-only audit", async () => {
    const state = initialState();
    const store = new DrizzleEnvironmentConfigurationStore(fakeDatabase(state));
    const manager = createEnvironmentConfigurationManager({
      store,
      encryptionKey: Buffer.alloc(32, 9),
    });

    const result = await manager.stage(
      access,
      {
        expectedRevision: 0,
        idempotencyKey: "provider-configuration-v1",
        changes: [
          { name: "OPENROUTER_API_KEY", operation: "set", value: "never-store-clear" },
          {
            name: "OPENROUTER_ANSWER_MODEL",
            operation: "set",
            value: "provider/model",
          },
        ],
      },
      AbortSignal.timeout(1_000),
    );

    expect(result).toEqual({
      revision: 1,
      changedNames: ["OPENROUTER_ANSWER_MODEL", "OPENROUTER_API_KEY"],
      restartRequired: true,
      updatedAt: "2026-08-23T12:00:00.000Z",
      replayed: false,
    });
    expect(JSON.stringify(state.configuration)).not.toContain("never-store-clear");
    expect(JSON.stringify(state.receipts)).not.toContain("never-store-clear");
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      category: "administration",
      action: "environment.configuration.updated",
      outcome: "succeeded",
      targetType: "environment_configuration",
      targetId: null,
      actorAliasId: "00000000-0000-4000-8000-000000000004",
      actorRole: "owner",
      requestId: "admin-configuration-request",
      metadata: {
        changedNames: ["OPENROUTER_ANSWER_MODEL", "OPENROUTER_API_KEY"],
      },
      changedNames: ["OPENROUTER_ANSWER_MODEL", "OPENROUTER_API_KEY"],
    });
    expect(Object.keys(state.audits[0]?.metadata as object)).toEqual(["changedNames"]);
    expect(state.receipts[0]?.actorAliasId).toBe(state.audits[0]?.actorAliasId);
  });

  it("replays an exact receipt before checking the now-stale revision", async () => {
    const state = initialState();
    const database = fakeDatabase(state);
    const manager = createEnvironmentConfigurationManager({
      store: new DrizzleEnvironmentConfigurationStore(database),
      encryptionKey: Buffer.alloc(32, 9),
    });
    const input = {
      expectedRevision: 0,
      idempotencyKey: "model-configuration-v1",
      changes: [
        {
          name: "OPENROUTER_ANSWER_MODEL",
          operation: "set",
          value: "provider/model",
        },
      ],
    } as const;

    const first = await manager.stage(access, input, AbortSignal.timeout(1_000));
    const replay = await manager.stage(access, input, AbortSignal.timeout(1_000));

    expect(first?.revision).toBe(1);
    expect(replay).toMatchObject({ revision: 1, replayed: true });
    expect(state.audits).toHaveLength(1);
  });

  it("rejects idempotency payload drift and returns null for a stale new request", async () => {
    const state = initialState();
    const manager = createEnvironmentConfigurationManager({
      store: new DrizzleEnvironmentConfigurationStore(fakeDatabase(state)),
      encryptionKey: Buffer.alloc(32, 9),
    });
    await manager.stage(
      access,
      {
        expectedRevision: 0,
        idempotencyKey: "model-configuration-v1",
        changes: [
          {
            name: "OPENROUTER_ANSWER_MODEL",
            operation: "set",
            value: "provider/model-a",
          },
        ],
      },
      AbortSignal.timeout(1_000),
    );

    await expect(
      manager.stage(
        access,
        {
          expectedRevision: 0,
          idempotencyKey: "model-configuration-v1",
          changes: [
            {
              name: "OPENROUTER_ANSWER_MODEL",
              operation: "set",
              value: "provider/model-b",
            },
          ],
        },
        AbortSignal.timeout(1_000),
      ),
    ).rejects.toThrow("idempotency key was already used with another request");
    // The fake query layer does not interpret Drizzle predicates. Remove the
    // unrelated receipt so this call exercises the optimistic revision path.
    state.receipts = [];
    await expect(
      manager.stage(
        access,
        {
          expectedRevision: 0,
          idempotencyKey: "stale-new-key",
          changes: [
            {
              name: "OPENROUTER_ANSWER_MODEL",
              operation: "set",
              value: "provider/model-b",
            },
          ],
        },
        AbortSignal.timeout(1_000),
      ),
    ).resolves.toBeNull();
    expect(state.audits).toHaveLength(1);
  });
});
