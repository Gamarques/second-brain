import type { ExecutionSource } from "@invokta/core";
import { createEngine } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import { createSecondBrainAdminEngine } from "../src/services/admin/engine.js";
import { createAdminAuditCapabilities } from "../src/services/admin/capabilities/admin-audit.js";
import { createAdminAutomationCapabilities } from "../src/services/admin/capabilities/admin-automation.js";
import type { EnvironmentConfigurationManager } from "@second-brain/engine/environment-configuration";
import type {
  AdminAuditStore,
  AdminAutomationSettings,
  AdminAutomationStore,
  AdminBrainMapStore,
} from "../src/services/admin/domain.js";
import type {
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
} from "@second-brain/engine/domain";

const accountId = "00000000-0000-4000-8000-000000000001";
const jobId = "00000000-0000-4000-8000-000000000002";
const auditId = "00000000-0000-4000-8000-000000000003";
const adminSource = "admin" as ExecutionSource;

const settings: AdminAutomationSettings = {
  timeZone: "America/Sao_Paulo",
  dreamingEnabled: true,
  dreamLocalTime: "03:00",
  nextDreamAt: "2026-08-24T06:00:00.000Z",
  dreamingMode: "preview",
  dailyInputTokenLimit: 20_000,
  dailyOutputTokenLimit: 2_000,
  reminderDeliveryEnabled: false,
  revision: 4,
  updatedAt: "2026-08-23T12:00:00.000Z",
};

const job = {
  id: jobId,
  kind: "daily_dreaming" as const,
  canonicalKey: "daily_dreaming:2026-08-22",
  scheduledFor: "2026-08-23T12:00:00.000Z",
  status: "pending" as const,
  attemptCount: 0,
  nextAttemptAt: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  fencingToken: null,
  cancelRequestedAt: null,
  sanitizedError: null,
  createdAt: "2026-08-23T12:00:00.000Z",
  updatedAt: "2026-08-23T12:00:00.000Z",
};

function allowedAccess(request: BrainAccessRequest): BrainAccessContext {
  return {
    accountId: request.principal.id,
    role: "admin",
    actor: {
      kind: "account",
      accountId: request.principal.id,
      clientId: null,
      source: "direct",
      requestId: request.requestId,
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
}

function accessStore() {
  const resolveAccess = vi.fn<BrainAccessStore["resolveAccess"]>(
    async (request) => allowedAccess(request),
  );
  const store: BrainAccessStore = {
    resolveAccess,
    async revalidateAccess(access) {
      return access;
    },
    async getTimeZone() {
      return "America/Sao_Paulo";
    },
  };
  return { resolveAccess, store };
}

function automationStore(): AdminAutomationStore {
  return {
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async () => ({ ...settings, revision: 5 })),
    getStatus: vi.fn(async () => ({
      observedAt: "2026-08-23T12:01:00.000Z",
      workers: [
        {
          workerId: "worker-1",
          version: "1.2.0",
          startedAt: "2026-08-23T10:00:00.000Z",
          lastSeenAt: "2026-08-23T12:00:30.000Z",
          health: "healthy" as const,
        },
      ],
      jobs: {
        pending: 1,
        running: 0,
        retryWait: 0,
        failed: 0,
        lastCompletedAt: null,
      },
    })),
    listJobs: vi.fn(async () => ({ items: [job], nextCursor: null })),
    enqueueDreamingRun: vi.fn(async () => ({ job, created: true })),
  };
}

function auditStore(): AdminAuditStore {
  return {
    listAuditEvents: vi.fn(async () => ({
      items: [
        {
          id: auditId,
          category: "administration" as const,
          action: "automation.settings.updated",
          outcome: "succeeded" as const,
          targetType: "automation_settings",
          targetId: null,
          actorAccountId: accountId,
          actorRole: "admin" as const,
          requestId: "request-audit",
          errorCode: null,
          metadata: { changedFields: ["dreamingEnabled"] },
          occurredAt: "2026-08-23T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    })),
  };
}

function brainMapStore(): AdminBrainMapStore {
  return {
    getBrainMap: vi.fn(async () => ({
      generatedAt: "2026-08-25T12:00:00.000Z",
      periodDays: 30,
      counts: { memories: 0, knowledgeBases: 0, documents: 0, people: 0, projects: 0 },
      totalItems: 0,
      growth: 0,
      explicitConnections: 0,
      connectedItems: 0,
      connectedCoverage: 0,
      truncated: false,
      nodes: [],
      edges: [],
      series: [],
    })),
  };
}

function environmentConfiguration(): EnvironmentConfigurationManager {
  return {
    list: vi.fn(async () => ({
      revision: 0,
      restartRequired: false,
      updatedAt: null,
      variables: [],
    })),
    stage: vi.fn(async () => null),
    restart: vi.fn(async () => null),
  };
}

describe("second-brain admin engine", () => {
  it("publishes only the bounded administrative catalog", () => {
    const engine = createSecondBrainAdminEngine({
      access: accessStore().store,
      automation: automationStore(),
      dreaming: { calendar: vi.fn(), retry: vi.fn() },
      learning: { list: vi.fn(), getDreaming: vi.fn(), reviewDreaming: vi.fn() },
      projectOverview: { overview: vi.fn(), section: vi.fn() }, questions: { ask: vi.fn() }, briefing: { get: vi.fn(), act: vi.fn() }, notifications: { channels: vi.fn(), saveChannel: vi.fn(), deliveries: vi.fn() },
      audit: auditStore(),
      brainMap: brainMapStore(),
      configuration: environmentConfiguration(),
      models: { status: vi.fn(), models: vi.fn(), probe: vi.fn() },
      modelUsage: { summary: vi.fn(), runtimes: vi.fn() },
    });

    expect(engine.name).toBe("second-brain-admin");
    expect(engine.list().map(({ id }) => id)).toEqual([
      "admin_notification_channels_list", "admin_notification_channel_save", "admin_notification_deliveries_list",
      "admin_briefing_get", "admin_briefing_act",
      "admin_project_get", "admin_project_section", "admin_brain_question",
      "admin_learning_list", "admin_learning_dreaming_get", "admin_learning_dreaming_review",
      "admin_dreaming_calendar_get", "admin_dreaming_retry",
      "admin_model_configuration_get", "admin_model_catalog_list", "admin_model_probe", "admin_model_usage_get",
      "admin_automation_settings_get",
      "admin_automation_settings_update",
      "admin_automation_status_get",
      "admin_automation_jobs_list",
      "admin_dreaming_runs_create",
      "admin_audit_events_list",
      "admin_brain_map_get",
      "admin_environment_variables_list",
      "admin_environment_variables_update",
      "admin_environment_services_restart",
    ]);
  });

  it("forces the internal admin execution source", async () => {
    const access = accessStore();
    const engine = createSecondBrainAdminEngine({
      access: access.store,
      automation: automationStore(),
      dreaming: { calendar: vi.fn(), retry: vi.fn() },
      learning: { list: vi.fn(), getDreaming: vi.fn(), reviewDreaming: vi.fn() },
      projectOverview: { overview: vi.fn(), section: vi.fn() }, questions: { ask: vi.fn() }, briefing: { get: vi.fn(), act: vi.fn() }, notifications: { channels: vi.fn(), saveChannel: vi.fn(), deliveries: vi.fn() },
      audit: auditStore(),
      brainMap: brainMapStore(),
      configuration: environmentConfiguration(),
      models: { status: vi.fn(), models: vi.fn(), probe: vi.fn() },
      modelUsage: { summary: vi.fn(), runtimes: vi.fn() },
    });

    await expect(
      engine.invoke(
        "admin_automation_settings_get",
        {},
        { principal: { id: accountId }, requestId: "admin-request" },
      ),
    ).resolves.toEqual({ settings });
    expect(access.resolveAccess).toHaveBeenCalledWith(
      {
        principal: { id: accountId },
        requiredRole: "admin",
        source: "direct",
        requestId: "admin-request",
        correlationId: null,
      },
      expect.any(AbortSignal),
    );
  });
});

describe("admin capability channel and contracts", () => {
  it("rejects non-admin execution channels before domain access", async () => {
    const access = accessStore();
    const capabilities = createAdminAutomationCapabilities(
      access.store,
      automationStore(),
    );
    const engine = createEngine({ name: "test", version: "1", capabilities });

    await expect(
      engine.invoke(
        "admin_automation_settings_get",
        {},
        { source: "direct", principal: { id: accountId } },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(access.resolveAccess).not.toHaveBeenCalled();
  });

  it("reads and revision-updates the complete settings contract", async () => {
    const access = accessStore();
    const automation = automationStore();
    const capabilities = createAdminAutomationCapabilities(
      access.store,
      automation,
    );
    const engine = createEngine({ name: "test", version: "1", capabilities });
    const options = {
      source: adminSource,
      principal: { id: accountId },
      requestId: "settings-request",
    };

    await expect(
      engine.invoke("admin_automation_settings_get", {}, options),
    ).resolves.toEqual({ settings });
    await expect(
      engine.invoke(
        "admin_automation_settings_update",
        {
          expectedRevision: 4,
          idempotencyKey: "settings-update-1",
          dreamingEnabled: true,
          dreamingMode: "preview",
          timeZone: "America/Sao_Paulo",
          dailyInputTokenLimit: 30_000,
          dailyOutputTokenLimit: 3_000,
        },
        options,
      ),
    ).resolves.toEqual({ settings: { ...settings, revision: 5 } });
    expect(automation.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, role: "admin" }),
      {
        expectedRevision: 4,
        idempotencyKey: "settings-update-1",
        dreamingEnabled: true,
        dreamingMode: "preview",
        timeZone: "America/Sao_Paulo",
        dailyInputTokenLimit: 30_000,
        dailyOutputTokenLimit: 3_000,
      },
      expect.any(AbortSignal),
    );
  });

  it("rejects empty settings changes and reports revision conflicts safely", async () => {
    const access = accessStore();
    const automation = automationStore();
    vi.mocked(automation.updateSettings).mockResolvedValueOnce(null);
    const capabilities = createAdminAutomationCapabilities(
      access.store,
      automation,
    );
    const engine = createEngine({ name: "test", version: "1", capabilities });
    const options = { source: adminSource, principal: { id: accountId } };

    await expect(
      engine.invoke(
        "admin_automation_settings_update",
        { expectedRevision: 4, idempotencyKey: "empty" } as never,
        options,
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "admin_automation_settings_update",
        {
          expectedRevision: 4,
          idempotencyKey: "conflict",
          dreamingEnabled: false,
        },
        options,
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      cause: expect.objectContaining({ code: "REVISION_CONFLICT" }),
    });
  });

  it("returns status, lists jobs, and durably enqueues a bounded dreaming day", async () => {
    const access = accessStore();
    const automation = automationStore();
    const capabilities = createAdminAutomationCapabilities(
      access.store,
      automation,
    );
    const engine = createEngine({ name: "test", version: "1", capabilities });
    const options = { source: adminSource, principal: { id: accountId } };

    await expect(
      engine.invoke("admin_automation_status_get", {}, options),
    ).resolves.toMatchObject({ workers: [{ health: "healthy" }], jobs: { pending: 1 } });
    await expect(
      engine.invoke(
        "admin_automation_jobs_list",
        { kind: "daily_dreaming", status: "pending" },
        options,
      ),
    ).resolves.toEqual({ jobs: [job], nextCursor: null });
    await expect(
      engine.invoke(
        "admin_dreaming_runs_create",
        { localDate: "2026-08-22", idempotencyKey: "dream-2026-08-22" },
        options,
      ),
    ).resolves.toEqual({ job, created: true });
    expect(automation.enqueueDreamingRun).toHaveBeenCalledWith(
      expect.objectContaining({ accountId }),
      { localDate: "2026-08-22", idempotencyKey: "dream-2026-08-22" },
      expect.any(AbortSignal),
    );
  });

  it("lists normalized audit entries with admin access", async () => {
    const access = accessStore();
    const audit = auditStore();
    const capabilities = createAdminAuditCapabilities(access.store, audit);
    const engine = createEngine({ name: "test", version: "1", capabilities });

    const result = await engine.invoke(
      "admin_audit_events_list",
      {
        category: "administration",
        outcome: "succeeded",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-09-01T00:00:00.000Z",
      },
      { source: adminSource, principal: { id: accountId } },
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      action: "automation.settings.updated",
      metadata: { changedFields: ["dreamingEnabled"] },
    });
    expect(audit.listAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ accountId }),
      expect.objectContaining({
        category: "administration",
        outcome: "succeeded",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-09-01T00:00:00.000Z",
        limit: 50,
      }),
      expect.any(AbortSignal),
    );
  });
});
