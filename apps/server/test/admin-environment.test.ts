import type { ExecutionSource } from "@invokta/core";
import { createEngine } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import { createAdminEnvironmentCapabilities } from "../src/services/admin/capabilities/admin-environment.js";
import type {
  EnvironmentConfigurationManager,
  ListedEnvironmentConfiguration,
} from "@second-brain/engine/environment-configuration";
import type {
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
} from "@second-brain/engine/domain";

const accountId = "00000000-0000-4000-8000-000000000001";
const adminSource = "admin" as ExecutionSource;

function accessFor(request: BrainAccessRequest): BrainAccessContext {
  return {
    accountId,
    role: request.requiredRole,
    actor: {
      kind: "account",
      accountId,
      clientId: null,
      source: "direct",
      requestId: request.requestId,
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
}

function createSubject() {
  const resolveAccess = vi.fn<BrainAccessStore["resolveAccess"]>(
    async (request) => accessFor(request),
  );
  const access: BrainAccessStore = {
    resolveAccess,
    async revalidateAccess(current) {
      return current;
    },
    async getTimeZone() {
      return "UTC";
    },
  };
  const listed: ListedEnvironmentConfiguration = {
    revision: 3,
    restartRequired: true,
    updatedAt: "2026-08-23T12:00:00.000Z",
    variables: [
      {
        name: "OPENROUTER_API_KEY",
        secret: true,
        configured: true,
        restartRequired: true,
      },
      {
        name: "OPENROUTER_DREAMING_MODEL",
        secret: false,
        configured: true,
        value: "provider/model",
        restartRequired: true,
      },
    ],
  };
  const configuration: EnvironmentConfigurationManager = {
    list: vi.fn(async () => listed),
    stage: vi.fn(async () => ({
      revision: 4,
      changedNames: ["OPENROUTER_API_KEY"] as const,
      restartRequired: true,
      updatedAt: "2026-08-23T12:01:00.000Z",
      replayed: false,
    })),
    restart: vi.fn(async () => ({
      revision: 3,
      targets: ["engine", "admin", "automation-worker"] as const,
      requestedAt: "2026-08-23T12:02:00.000Z",
      replayed: false,
    })),
  };
  const capabilities = createAdminEnvironmentCapabilities(access, configuration);
  const engine = createEngine({
    name: "admin-environment-test",
    version: "1",
    capabilities,
  });
  return { capabilities, configuration, engine, listed, resolveAccess };
}

describe("admin environment capabilities", () => {
  it("publishes a bounded list and update surface", () => {
    const { capabilities, engine } = createSubject();

    expect(Object.keys(capabilities)).toEqual([
      "admin_environment_variables_list",
      "admin_environment_variables_update",
      "admin_environment_services_restart",
    ]);
    expect(engine.list()).toEqual([
      expect.objectContaining({
        id: "admin_environment_variables_list",
        annotations: expect.objectContaining({ readOnly: true }),
      }),
      expect.objectContaining({
        id: "admin_environment_variables_update",
        annotations: expect.objectContaining({ readOnly: false, idempotent: true }),
      }),
      expect.objectContaining({
        id: "admin_environment_services_restart",
        annotations: expect.objectContaining({ readOnly: false, idempotent: true }),
      }),
    ]);
  });

  it("requires owner access to request a bounded service restart", async () => {
    const { configuration, engine, resolveAccess } = createSubject();

    await expect(
      engine.invoke(
        "admin_environment_services_restart",
        { expectedRevision: 3, idempotencyKey: "restart-services-v3" },
        { source: adminSource, principal: { id: accountId }, requestId: "restart-env" },
      ),
    ).resolves.toEqual({
      revision: 3,
      targets: ["engine", "admin", "automation-worker"],
      requestedAt: "2026-08-23T12:02:00.000Z",
      replayed: false,
    });
    expect(resolveAccess).toHaveBeenCalledWith(
      expect.objectContaining({ requiredRole: "owner", source: "direct" }),
      expect.any(AbortSignal),
    );
    expect(configuration.restart).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, role: "owner" }),
      { expectedRevision: 3, idempotencyKey: "restart-services-v3" },
      expect.any(AbortSignal),
    );
  });

  it("lists through admin access without ever returning a secret value", async () => {
    const { configuration, engine, listed, resolveAccess } = createSubject();

    await expect(
      engine.invoke(
        "admin_environment_variables_list",
        {},
        { source: adminSource, principal: { id: accountId }, requestId: "list-env" },
      ),
    ).resolves.toEqual(listed);
    expect(resolveAccess).toHaveBeenCalledWith(
      expect.objectContaining({ requiredRole: "admin", source: "direct" }),
      expect.any(AbortSignal),
    );
    expect(configuration.list).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, role: "admin" }),
      expect.any(AbortSignal),
    );
    const serialized = JSON.stringify(listed.variables[0]);
    expect(serialized).not.toContain("value");
    expect(serialized).not.toContain("ciphertext");
  });

  it("requires owner access and explicit set or clear operations for updates", async () => {
    const { configuration, engine, resolveAccess } = createSubject();

    await expect(
      engine.invoke(
        "admin_environment_variables_update",
        {
          expectedRevision: 3,
          idempotencyKey: "rotate-openrouter-key",
          changes: [
            {
              name: "OPENROUTER_API_KEY",
              operation: "set",
              value: "new-secret-value",
            },
          ],
        },
        { source: adminSource, principal: { id: accountId }, requestId: "update-env" },
      ),
    ).resolves.toEqual({
      revision: 4,
      changedNames: ["OPENROUTER_API_KEY"],
      restartRequired: true,
      updatedAt: "2026-08-23T12:01:00.000Z",
      replayed: false,
    });
    expect(resolveAccess).toHaveBeenCalledWith(
      expect.objectContaining({ requiredRole: "owner", source: "direct" }),
      expect.any(AbortSignal),
    );
    expect(configuration.stage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, role: "owner" }),
      {
        expectedRevision: 3,
        idempotencyKey: "rotate-openrouter-key",
        changes: [
          {
            name: "OPENROUTER_API_KEY",
            operation: "set",
            value: "new-secret-value",
          },
        ],
      },
      expect.any(AbortSignal),
    );

    await expect(
      engine.invoke(
        "admin_environment_variables_update",
        {
          expectedRevision: 4,
          idempotencyKey: "clear-app-url",
          changes: [{ name: "OPENROUTER_APP_URL", operation: "clear" }],
        },
        { source: adminSource, principal: { id: accountId } },
      ),
    ).resolves.toMatchObject({ revision: 4 });
  });

  it("denies non-admin channels before resolving access", async () => {
    const { engine, resolveAccess } = createSubject();

    await expect(
      engine.invoke(
        "admin_environment_variables_list",
        {},
        { source: "direct", principal: { id: accountId } },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it("returns a sanitized revision conflict and rejects unknown fields", async () => {
    const { configuration, engine } = createSubject();
    vi.mocked(configuration.stage).mockResolvedValueOnce(null);
    const options = { source: adminSource, principal: { id: accountId } };

    await expect(
      engine.invoke(
        "admin_environment_variables_update",
        {
          expectedRevision: 3,
          idempotencyKey: "stale",
          changes: [{ name: "OPENROUTER_APP_URL", operation: "clear" }],
        },
        options,
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      cause: expect.objectContaining({ code: "REVISION_CONFLICT" }),
    });

    await expect(
      engine.invoke(
        "admin_environment_variables_update",
        {
          expectedRevision: 3,
          idempotencyKey: "unknown",
          changes: [{ name: "DATABASE_URL", operation: "clear" }],
        } as never,
        options,
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
});
