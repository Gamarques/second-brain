import { createEngine, type ExecutionSource } from "@invokta/core";
import { expect, it, vi } from "vitest";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import { createAdminProjectCapabilities } from "../src/services/admin/capabilities/admin-projects.js";

const id = "00000000-0000-4000-8000-000000000001";
it("reads project context through the private engine with bounded sections", async () => {
  const access: BrainAccessStore = {
    resolveAccess: vi.fn(async (request) => ({
      accountId: id,
      role: request.requiredRole,
      actor: {
        kind: "account" as const,
        accountId: id,
        clientId: null,
        source: "direct" as const,
        requestId: request.requestId,
        correlationId: null,
        causationId: null,
        dreamingRunId: null,
      },
    })),
    revalidateAccess: vi.fn(async (value) => value),
    getTimeZone: vi.fn(async () => "UTC"),
  };
  const store = {
    overview: vi.fn(async () => null),
    section: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  const engine = createEngine({
    name: "projects",
    version: "1",
    capabilities: createAdminProjectCapabilities(access, store),
  });
  const options = { source: "admin" as ExecutionSource, principal: { id } };
  await expect(
    engine.invoke("admin_project_get", { projectId: id }, options),
  ).resolves.toEqual({ result: null });
  await expect(
    engine.invoke(
      "admin_project_section",
      { projectId: id, section: "tasks", limit: 101 },
      options,
    ),
  ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  await expect(
    engine.invoke(
      "admin_project_section",
      { projectId: id, section: "memories" },
      options,
    ),
  ).resolves.toEqual({ items: [], nextCursor: null });
  await expect(
    engine.invoke(
      "admin_project_get",
      { projectId: id },
      { ...options, source: "mcp-http" },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
