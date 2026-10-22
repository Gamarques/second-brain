import type { ExecutionSource } from "@invokta/core";
import { createEngine } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import { createAdminBrainMapCapabilities } from "../src/services/admin/capabilities/admin-brain-map.js";
import type { AdminBrainMapStore } from "../src/services/admin/domain.js";
import type {
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
} from "@second-brain/engine/domain";

const accountId = "00000000-0000-4000-8000-000000000001";
const adminSource = "admin" as ExecutionSource;

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

function brainMapStore(): AdminBrainMapStore {
  return {
    getBrainMap: vi.fn(async () => ({
      generatedAt: "2026-08-25T12:00:00.000Z",
      periodDays: 30,
      counts: {
        memories: 1,
        knowledgeBases: 1,
        documents: 1,
        people: 1,
        projects: 1,
      },
      totalItems: 5,
      growth: 2,
      explicitConnections: 4,
      connectedItems: 5,
      connectedCoverage: 1,
      truncated: false,
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          type: "memory" as const,
          label: "Prefers concise status updates",
          description: null,
          tags: ["communication"],
          version: 2,
          createdAt: "2026-08-24T12:00:00.000Z",
          updatedAt: null,
        },
      ],
      edges: [],
      series: [
        {
          date: "2026-08-25",
          memories: 1,
          knowledgeBases: 1,
          documents: 1,
          people: 1,
          projects: 1,
          total: 5,
        },
      ],
    })),
  };
}

describe("admin brain map capability", () => {
  it("returns a bounded read-only graph through the private admin channel", async () => {
    const access = accessStore();
    const brainMap = brainMapStore();
    const capabilities = createAdminBrainMapCapabilities(access.store, brainMap);
    const engine = createEngine({ name: "test", version: "1", capabilities });

    const result = await engine.invoke(
      "admin_brain_map_get",
      { days: 30, nodeLimit: 200 },
      { source: adminSource, principal: { id: accountId }, requestId: "brain-map" },
    );

    expect(result).toMatchObject({ totalItems: 5, connectedCoverage: 1 });
    expect(brainMap.getBrainMap).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, role: "admin" }),
      { days: 30, nodeLimit: 200 },
      expect.any(AbortSignal),
    );
  });

  it("rejects non-admin execution channels and unbounded inputs", async () => {
    const access = accessStore();
    const brainMap = brainMapStore();
    const capabilities = createAdminBrainMapCapabilities(access.store, brainMap);
    const engine = createEngine({ name: "test", version: "1", capabilities });

    await expect(
      engine.invoke(
        "admin_brain_map_get",
        {},
        { source: "direct", principal: { id: accountId } },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      engine.invoke(
        "admin_brain_map_get",
        { days: 365, nodeLimit: 10_000 },
        { source: adminSource, principal: { id: accountId } },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(access.resolveAccess).not.toHaveBeenCalled();
    expect(brainMap.getBrainMap).not.toHaveBeenCalled();
  });
});
