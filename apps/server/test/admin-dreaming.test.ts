import { createEngine, type ExecutionSource } from "@invokta/core";
import { expect, it, vi } from "vitest";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import { createAdminDreamingCapabilities } from "../src/services/admin/capabilities/admin-dreaming.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const jobId = "00000000-0000-4000-8000-000000000002";
function subject() {
  const access: BrainAccessStore = {
    resolveAccess: vi.fn<BrainAccessStore["resolveAccess"]>(async (request) => ({ accountId, role: request.requiredRole, actor: { kind: "account", accountId, clientId: null, source: "direct", requestId: request.requestId, correlationId: null, causationId: null, dreamingRunId: null } })),
    revalidateAccess: vi.fn(async (value) => value), getTimeZone: vi.fn(async () => "UTC"),
  };
  const store = {
    calendar: vi.fn(async () => ({ month: "2026-08", timeZone: "UTC", today: "2026-09-04", items: [], truncated: false })),
    retry: vi.fn(async () => ({ jobId, sourceJobId: jobId, created: true, mode: "preview" as const })),
  };
  const engine = createEngine({ name: "test", version: "1", capabilities: createAdminDreamingCapabilities(access, store) });
  return { engine, store, access };
}
const options = { source: "admin" as ExecutionSource, principal: { id: accountId } };

it("reads a bounded calendar and creates an explicitly preview-only replay through the private engine", async () => {
  const { engine, store, access } = subject();
  await expect(engine.invoke("admin_dreaming_calendar_get", { month: "2026-08" }, options)).resolves.toMatchObject({ month: "2026-08", items: [] });
  await expect(engine.invoke("admin_dreaming_retry", { jobId, idempotencyKey: "retry-failed-day" }, options)).resolves.toMatchObject({ mode: "preview", created: true });
  expect(store.retry).toHaveBeenCalledWith(expect.objectContaining({ accountId }), { jobId, idempotencyKey: "retry-failed-day" }, expect.any(AbortSignal));
  expect(access.resolveAccess).toHaveBeenCalledWith(expect.objectContaining({ requiredRole: "admin" }), expect.any(AbortSignal));
});

it("rejects public channels and invalid calendar months before accessing stored jobs", async () => {
  const { engine, store } = subject();
  await expect(engine.invoke("admin_dreaming_retry", { jobId, idempotencyKey: "key" }, { ...options, source: "mcp-http" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(engine.invoke("admin_dreaming_calendar_get", { month: "2026-13" }, options)).rejects.toMatchObject({ code: "INPUT_INVALID" });
  expect(store.calendar).not.toHaveBeenCalled();
  expect(store.retry).not.toHaveBeenCalled();
});
