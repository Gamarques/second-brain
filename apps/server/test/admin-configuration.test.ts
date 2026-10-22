import { describe, expect, it, vi } from "vitest";

import {
  createEnvironmentConfigurationManager,
  environmentConfigurationOverlay,
  environmentConfigurationCatalog,
  parseEnvironmentConfigurationEncryptionKey,
  type EnvironmentConfigurationState,
  environmentServiceRestartTargets,
  type EnvironmentConfigurationRestartStoreInput,
  type EnvironmentConfigurationStore,
  type StageEnvironmentConfigurationStoreInput,
} from "@second-brain/engine/environment-configuration";
import type { BrainAccessContext } from "@second-brain/engine/domain";

const key = Buffer.alloc(32, 7);
const access: BrainAccessContext = {
  accountId: "00000000-0000-4000-8000-000000000001",
  role: "owner",
  actor: {
    kind: "account",
    source: "direct",
    accountId: "00000000-0000-4000-8000-000000000001",
    clientId: null,
    requestId: "admin-request",
    correlationId: null,
    causationId: null,
    dreamingRunId: null,
  },
};

class MemoryConfigurationStore implements EnvironmentConfigurationStore {
  state: EnvironmentConfigurationState = {
    revision: 0,
    entries: {},
    restartRequired: false,
    updatedAt: null,
  };

  lastStage: StageEnvironmentConfigurationStoreInput | undefined;
  lastRestart: EnvironmentConfigurationRestartStoreInput | undefined;

  async read(_access: BrainAccessContext): Promise<EnvironmentConfigurationState> {
    return this.state;
  }

  async stage(_access: BrainAccessContext, input: StageEnvironmentConfigurationStoreInput) {
    this.lastStage = input;
    if (input.expectedRevision !== this.state.revision) return null;
    const entries = { ...this.state.entries };
    const changedNames = input.changes.map((change) => {
      if (change.entry === null) {
        delete entries[change.name];
        return change.name;
      }
      entries[change.name] = change.entry;
      return change.name;
    });
    this.state = {
      revision: this.state.revision + 1,
      entries,
      restartRequired: true,
      updatedAt: "2026-08-23T12:00:00.000Z",
    };
    return {
      revision: this.state.revision,
      changedNames,
      restartRequired: true,
      updatedAt: this.state.updatedAt,
      replayed: false,
    };
  }

  async requestRestart(
    _access: BrainAccessContext,
    input: EnvironmentConfigurationRestartStoreInput,
  ) {
    this.lastRestart = input;
    if (input.expectedRevision !== this.state.revision || !this.state.restartRequired) {
      return null;
    }
    this.state = { ...this.state, restartRequired: false };
    return {
      revision: this.state.revision,
      targets: [...environmentServiceRestartTargets],
      requestedAt: "2026-08-23T12:05:00.000Z",
      replayed: false,
    };
  }
}

describe("environment configuration", () => {
  it("requests a bounded restart with an HMAC digest and clears the pending state", async () => {
    const store = new MemoryConfigurationStore();
    const manager = createEnvironmentConfigurationManager({ store, encryptionKey: key });
    await manager.stage(access, {
      expectedRevision: 0,
      idempotencyKey: "stage-for-restart",
      changes: [{ name: "OPENROUTER_ANSWER_MODEL", operation: "set", value: "provider/model" }],
    });

    await expect(manager.restart(access, {
      expectedRevision: 1,
      idempotencyKey: "restart-services-v1",
    })).resolves.toEqual({
      revision: 1,
      targets: ["engine", "admin", "automation-worker"],
      requestedAt: "2026-08-23T12:05:00.000Z",
      replayed: false,
    });
    expect(store.lastRestart).toMatchObject({
      expectedRevision: 1,
      idempotencyKey: "restart-services-v1",
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(store.state.restartRequired).toBe(false);
  });

  it("publishes a fixed, restart-required allowlist without infrastructure or embedding variables", () => {
    expect(environmentConfigurationCatalog.map(({ name }) => name)).toEqual([
      "OPENROUTER_API_KEY",
      "OPENROUTER_ANSWER_MODEL",
      "OPENROUTER_INGESTION_MODEL",
      "OPENROUTER_DREAMING_MODEL",
      "OPENROUTER_VERIFICATION_MODEL",
      "OPENROUTER_REQUEST_TIMEOUT_MS",
      "OPENROUTER_APP_URL",
    ]);
    expect(environmentConfigurationCatalog.every((item) => item.restartRequired)).toBe(true);
    expect(environmentConfigurationCatalog).not.toContainEqual(
      expect.objectContaining({ name: "OPENROUTER_BASE_URL" }),
    );
    expect(environmentConfigurationCatalog).not.toContainEqual(
      expect.objectContaining({ name: "DATABASE_URL" }),
    );
  });

  it("encrypts secrets with a fresh AES-GCM envelope and never lists their value", async () => {
    const store = new MemoryConfigurationStore();
    const manager = createEnvironmentConfigurationManager({ store, encryptionKey: key });

    const first = await manager.stage(access, {
      expectedRevision: 0,
      idempotencyKey: "configure-provider",
      changes: [
        { name: "OPENROUTER_API_KEY", operation: "set", value: "super-secret" },
      ],
    });

    expect(first?.changedNames).toEqual(["OPENROUTER_API_KEY"]);
    const persisted = store.state.entries.OPENROUTER_API_KEY;
    expect(persisted).toMatchObject({ kind: "secret", version: 1 });
    expect(JSON.stringify(persisted)).not.toContain("super-secret");
    if (persisted?.kind !== "secret") throw new Error("Expected an encrypted secret.");
    expect(Buffer.from(persisted.iv, "base64url")).toHaveLength(12);
    expect(Buffer.from(persisted.tag, "base64url")).toHaveLength(16);

    const listed = await manager.list(access);
    const secret = listed.variables.find(({ name }) => name === "OPENROUTER_API_KEY");
    expect(secret).toEqual({
      name: "OPENROUTER_API_KEY",
      secret: true,
      configured: true,
      restartRequired: true,
    });
    expect(secret).not.toHaveProperty("value");
  });

  it("stages clear non-secret values, reports restartRequired, and forwards no clear secret", async () => {
    const store = new MemoryConfigurationStore();
    const stage = vi.spyOn(store, "stage");
    const manager = createEnvironmentConfigurationManager({ store, encryptionKey: key });

    const result = await manager.stage(access, {
      expectedRevision: 0,
      idempotencyKey: "models-v1",
      changes: [
        { name: "OPENROUTER_API_KEY", operation: "set", value: "secret-value" },
        {
          name: "OPENROUTER_ANSWER_MODEL",
          operation: "set",
          value: "provider/model",
        },
      ],
    });

    expect(result).toMatchObject({ revision: 1, restartRequired: true, replayed: false });
    expect(stage).toHaveBeenCalledOnce();
    expect(JSON.stringify(stage.mock.calls[0]?.[1])).not.toContain("secret-value");
    expect(store.state.entries.OPENROUTER_ANSWER_MODEL).toEqual({
      kind: "plain",
      value: "provider/model",
    });
    expect((await manager.list(access)).variables).toContainEqual({
      name: "OPENROUTER_ANSWER_MODEL",
      secret: false,
      configured: true,
      value: "provider/model",
      restartRequired: true,
    });
  });

  it("rejects unknown, duplicate, empty, and invalid variables before the store", async () => {
    const store = new MemoryConfigurationStore();
    const manager = createEnvironmentConfigurationManager({ store, encryptionKey: key });
    const base = { expectedRevision: 0, idempotencyKey: "invalid" };

    await expect(
      manager.stage(access, {
        ...base,
        changes: [{ name: "DATABASE_URL", operation: "set", value: "hidden" }],
      }),
    ).rejects.toThrow("DATABASE_URL is not an editable environment variable");
    await expect(
      manager.stage(access, {
        ...base,
        changes: [
          {
            name: "OPENROUTER_APP_URL",
            operation: "set",
            value: "https://example.com",
          },
          {
            name: "OPENROUTER_APP_URL",
            operation: "set",
            value: "https://other.example.com",
          },
        ],
      }),
    ).rejects.toThrow("must not contain duplicate names");
    await expect(manager.stage(access, { ...base, changes: [] })).rejects.toThrow(
      "changes must contain at least one variable",
    );
    await expect(
      manager.stage(access, {
        ...base,
        changes: [
          { name: "OPENROUTER_REQUEST_TIMEOUT_MS", operation: "set", value: "zero" },
        ],
      }),
    ).rejects.toThrow("must be a positive integer");
    await expect(
      manager.stage(access, {
        ...base,
        changes: [
          {
            name: "OPENROUTER_ANSWER_MODEL",
            operation: "set",
            value: "provider/model\nINJECTED=value",
          },
        ],
      }),
    ).rejects.toThrow("must not contain NUL, carriage return, or line feed");
    await expect(
      manager.stage(access, {
        ...base,
        changes: [
          {
            name: "OPENROUTER_APP_URL",
            operation: "set",
            value: "https://user:secret@example.com/?token=secret",
          },
        ],
      }),
    ).rejects.toThrow("must be a valid HTTP or HTTPS URL");
    expect(store.lastStage).toBeUndefined();
  });

  it("uses optimistic revision checks and an HMAC request digest", async () => {
    const store = new MemoryConfigurationStore();
    const manager = createEnvironmentConfigurationManager({ store, encryptionKey: key });
    const input = {
      expectedRevision: 4,
      idempotencyKey: "stale",
      changes: [
        {
          name: "OPENROUTER_ANSWER_MODEL",
          operation: "set",
          value: "provider/model",
        },
      ],
    } as const;

    await expect(manager.stage(access, input)).resolves.toBeNull();
    expect(store.lastStage?.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(store.lastStage?.requestDigest).not.toBe(
      "5c7d7c247aaea95bfb2ed57f30234776e3995845529468977379b30c4c2b88c3",
    );
  });

  it("requires an injected 32-byte encryption key", () => {
    const store = new MemoryConfigurationStore();
    expect(() =>
      createEnvironmentConfigurationManager({ store, encryptionKey: Buffer.alloc(31) }),
    ).toThrow("encryptionKey must contain exactly 32 bytes");
  });

  it("clears a secret explicitly without introducing a secret-value sentinel", async () => {
    const store = new MemoryConfigurationStore();
    const manager = createEnvironmentConfigurationManager({ store, encryptionKey: key });
    await manager.stage(access, {
      expectedRevision: 0,
      idempotencyKey: "secret-set",
      changes: [
        { name: "OPENROUTER_API_KEY", operation: "set", value: "super-secret" },
      ],
    });

    await manager.stage(access, {
      expectedRevision: 1,
      idempotencyKey: "secret-clear",
      changes: [{ name: "OPENROUTER_API_KEY", operation: "clear" }],
    });

    const secret = (await manager.list(access)).variables.find(
      ({ name }) => name === "OPENROUTER_API_KEY",
    );
    expect(secret).toEqual({
      name: "OPENROUTER_API_KEY",
      secret: true,
      configured: false,
      restartRequired: true,
    });
    expect(secret).not.toHaveProperty("value");
  });

  it("parses a canonical 32-byte key and decrypts a validated runtime overlay", async () => {
    const store = new MemoryConfigurationStore();
    const manager = createEnvironmentConfigurationManager({ store, encryptionKey: key });
    await manager.stage(access, {
      expectedRevision: 0,
      idempotencyKey: "runtime-overlay",
      changes: [
        { name: "OPENROUTER_API_KEY", operation: "set", value: "runtime-secret" },
        {
          name: "OPENROUTER_ANSWER_MODEL",
          operation: "set",
          value: "provider/model",
        },
      ],
    });
    const parsed = parseEnvironmentConfigurationEncryptionKey({
      SECOND_BRAIN_CONFIG_ENCRYPTION_KEY: key.toString("base64url"),
    });

    expect(parsed).toEqual(key);
    expect(environmentConfigurationOverlay(store.state, parsed)).toEqual({
      OPENROUTER_API_KEY: "runtime-secret",
      OPENROUTER_ANSWER_MODEL: "provider/model",
    });
  });

  it("fails closed with sanitized errors for a corrupt tag or wrong runtime key", async () => {
    const store = new MemoryConfigurationStore();
    const manager = createEnvironmentConfigurationManager({ store, encryptionKey: key });
    await manager.stage(access, {
      expectedRevision: 0,
      idempotencyKey: "corrupt-overlay",
      changes: [
        { name: "OPENROUTER_API_KEY", operation: "set", value: "must-not-leak" },
      ],
    });
    const entry = store.state.entries.OPENROUTER_API_KEY;
    if (entry?.kind !== "secret") throw new Error("Expected an encrypted secret.");
    const corruptState: EnvironmentConfigurationState = {
      ...store.state,
      entries: {
        ...store.state.entries,
        OPENROUTER_API_KEY: { ...entry, tag: Buffer.alloc(16, 1).toString("base64url") },
      },
    };

    for (const operation of [
      () => environmentConfigurationOverlay(corruptState, key),
      () => environmentConfigurationOverlay(store.state, Buffer.alloc(32, 8)),
    ]) {
      let failure: unknown;
      try {
        operation();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "ENVIRONMENT_CONFIGURATION_CORRUPT",
        message: "Stored environment configuration is invalid.",
      });
      expect(String(failure)).not.toContain("must-not-leak");
    }
  });

  it("rejects missing, noncanonical, and wrong-length runtime keys", () => {
    for (const environment of [
      {},
      { SECOND_BRAIN_CONFIG_ENCRYPTION_KEY: `${key.toString("base64url")}=` },
      { SECOND_BRAIN_CONFIG_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64url") },
    ]) {
      expect(() => parseEnvironmentConfigurationEncryptionKey(environment)).toThrow(
        "must be canonical base64url encoding of exactly 32 bytes",
      );
    }
  });
});
