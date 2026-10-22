import { createEngine, type ExecutionSource } from "@invokta/core";
import { expect, it, vi } from "vitest";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import { createAdminBriefingCapabilities } from "../src/services/admin/capabilities/admin-briefing.js";
const id = "00000000-0000-4000-8000-000000000001";
it("requires an explicit valid task or reminder action through the private engine", async () => {
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
    get: vi.fn(),
    act: vi.fn(async () => ({ id, kind: "task" as const, entityId: id })),
  };
  const engine = createEngine({
    name: "briefing",
    version: "1",
    capabilities: createAdminBriefingCapabilities(access, store),
  });
  const options = { source: "admin" as ExecutionSource, principal: { id } };
  const input = {
    reportId: id,
    insightIndex: 0,
    expectedDigest: "a".repeat(64),
    kind: "task" as const,
    text: "Prepare the review",
    listId: id,
    idempotencyKey: "briefing-action",
  };
  await expect(
    engine.invoke("admin_briefing_act", { ...input, listId: null }, options),
  ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  expect(store.act).not.toHaveBeenCalled();
  await expect(
    engine.invoke("admin_briefing_act", input, options),
  ).resolves.toMatchObject({ kind: "task" as const, entityId: id });
  await expect(
    engine.invoke("admin_briefing_get", {}, { ...options, source: "mcp-http" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
