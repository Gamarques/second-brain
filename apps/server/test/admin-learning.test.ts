import { createEngine, type ExecutionSource } from "@invokta/core";
import { expect, it, vi } from "vitest";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import { createAdminLearningCapabilities } from "../src/services/admin/capabilities/admin-learning.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const changeId = "00000000-0000-4000-8000-000000000002";
it("reviews stored proposals through the private engine and denies public channels", async () => {
  const access: BrainAccessStore = {
    resolveAccess: vi.fn(async (request) => ({
      accountId,
      role: request.requiredRole,
      actor: {
        kind: "account" as const,
        accountId,
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
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    getDreaming: vi.fn(async () => null),
    reviewDreaming: vi.fn(async () => ({
      changeId,
      decision: "reject" as const,
      resultMemoryId: null,
      reviewedAt: "2026-09-05T00:00:00.000Z",
    })),
  };
  const engine = createEngine({
    name: "review",
    version: "1",
    capabilities: createAdminLearningCapabilities(access, store),
  });
  const options = {
    source: "admin" as ExecutionSource,
    principal: { id: accountId },
  };
  await expect(
    engine.invoke(
      "admin_learning_list",
      { kind: "dreaming", status: "pending" },
      options,
    ),
  ).resolves.toEqual({ items: [], nextCursor: null });
  await expect(
    engine.invoke(
      "admin_learning_dreaming_review",
      {
        changeId,
        fingerprint: "a".repeat(64),
        decision: "reject",
        idempotencyKey: "review",
      },
      options,
    ),
  ).resolves.toMatchObject({ decision: "reject" });
  expect(store.reviewDreaming).toHaveBeenCalledWith(
    expect.objectContaining({ administrativeChannel: true }),
    expect.objectContaining({ changeId }),
    expect.any(AbortSignal),
  );
  await expect(
    engine.invoke(
      "admin_learning_dreaming_get",
      { changeId },
      { ...options, source: "mcp-http" },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(store.getDreaming).not.toHaveBeenCalled();
});
