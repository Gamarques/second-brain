import { createEngine, type ExecutionSource } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import { createAdminModelCapabilities } from "../src/services/admin/capabilities/admin-models.js";

function subject() {
  const access: BrainAccessStore = {
    resolveAccess: vi.fn<BrainAccessStore["resolveAccess"]>(async (request) => ({ accountId: request.principal.id, role: request.requiredRole, actor: { kind: "account", accountId: request.principal.id, clientId: null, source: "direct", requestId: request.requestId, correlationId: null, causationId: null, dreamingRunId: null } })),
    revalidateAccess: vi.fn(async (value) => value), getTimeZone: vi.fn(async () => "UTC"),
  };
  const models = {
    status: vi.fn(async () => ({ revision: 3, hasApiKey: true, models: { dreaming: "test/model" } })),
    models: vi.fn(async () => ({ models: [{ id: "test/model", name: "Test" }], checkedAt: "2026-09-04T00:00:00.000Z" })),
    probe: vi.fn(async () => ({ ok: true, reason: null, model: "test/model", checkedAt: "2026-09-04T00:00:00.000Z", durationMs: 42 })),
  };
  const usage = {
    summary: vi.fn(async () => ({ since: "2026-09-03T00:00:00.000Z", observedAt: "2026-09-04T00:00:00.000Z", groups: [], failures: [], truncated: false })),
    runtimes: vi.fn(async () => []),
  };
  const engine = createEngine({ name: "test", version: "1", capabilities: createAdminModelCapabilities(access, models, usage) });
  return { engine, models, usage, access };
}

const options = { source: "admin" as ExecutionSource, principal: { id: "00000000-0000-4000-8000-000000000001" } };
describe("private model configuration and usage", () => {
  it("requires owner access for a paid probe and never returns its key", async () => {
    const { engine, models, access } = subject();
    const result = await engine.invoke("admin_model_probe", { model: "test/model", apiKey: "private-key" }, options);
    expect(models.probe).toHaveBeenCalledWith({ model: "test/model", apiKey: "private-key" }, expect.any(AbortSignal));
    expect(access.resolveAccess).toHaveBeenCalledWith(expect.objectContaining({ requiredRole: "owner" }), expect.any(AbortSignal));
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain("private-key");
  });
  it("denies public transports and invalid bounds before contacting a provider", async () => {
    const { engine, models } = subject();
    await expect(engine.invoke("admin_model_probe", { model: "test/model" }, { ...options, source: "direct" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(engine.invoke("admin_model_probe", { model: " " }, options)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(engine.invoke("admin_model_usage_get", { days: 366 }, options)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(models.probe).not.toHaveBeenCalled();
  });
  it("separates saved configuration from runtime observations and validates outputs", async () => {
    const { engine, models, usage } = subject();
    await expect(engine.invoke("admin_model_configuration_get", {}, options)).resolves.toMatchObject({ saved: { revision: 3 }, runtimes: [] });
    await engine.invoke("admin_model_usage_get", { days: 7, operation: "dreaming" }, options);
    expect(usage.summary).toHaveBeenCalledWith({ days: 7, operation: "dreaming" }, expect.any(AbortSignal));
    models.probe.mockResolvedValueOnce({ ok: true, reason: null, model: "test/model", checkedAt: "invalid", durationMs: -1 });
    await expect(engine.invoke("admin_model_probe", { model: "test/model" }, options)).rejects.toBeDefined();
  });
});
