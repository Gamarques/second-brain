import type { ExecutionContext, Principal } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import type {
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
  BrainRole,
} from "../src/domain.js";
import {
  CapabilityAccessDeniedError,
  requireBrainAccess,
} from "../src/capabilities/access.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000003";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function executionContext(options: {
  readonly principal?: Principal | null;
  readonly requestId?: string;
  readonly source?: ExecutionContext["source"];
  readonly signal?: AbortSignal;
} = {}): ExecutionContext {
  return {
    principal: options.principal === undefined ? { id: accountId } : options.principal,
    requestId: options.requestId ?? "request-1",
    source: options.source ?? "direct",
    signal: options.signal ?? new AbortController().signal,
    logger,
  };
}

function allowedAccess(
  request: BrainAccessRequest,
  role: BrainRole = request.requiredRole,
): BrainAccessContext {
  const clientId = request.principal.attributes?.clientId;
  const isOAuth = request.source === "mcp_http" && typeof clientId === "string";
  const actorCommon = {
    accountId: request.principal.id,
    source: request.source,
    requestId: request.requestId,
    correlationId: request.correlationId,
    causationId: null,
    dreamingRunId: null,
  } as const;
  return {
    accountId: request.principal.id,
    role,
    actor: isOAuth
      ? { ...actorCommon, kind: "oauth_client", clientId }
      : { ...actorCommon, kind: "account", clientId: null },
  };
}

function accessStore(
  resolveAccess: BrainAccessStore["resolveAccess"],
): BrainAccessStore {
  return {
    resolveAccess,
    async revalidateAccess() {
      throw new Error("Not used by this test.");
    },
    async getTimeZone() {
      throw new Error("Not used by this test.");
    },
  };
}

describe("capability brain access", () => {
  it.each([
    ["direct", "direct"],
    ["mcp-http", "mcp_http"],
  ] as const)("maps the %s execution source to %s", async (source, expectedSource) => {
    const resolveAccess = vi.fn<BrainAccessStore["resolveAccess"]>(
      async (request) => allowedAccess(request),
    );
    const store = accessStore(resolveAccess);

    await expect(
      requireBrainAccess(store, executionContext({ source }), {
        requiredRole: "viewer",
      }),
    ).resolves.toMatchObject({ accountId, role: "viewer" });

    expect(resolveAccess).toHaveBeenCalledWith(
      {
        principal: { id: accountId },
        requiredRole: "viewer",
        source: expectedSource,
        requestId: "request-1",
        correlationId: null,
      },
      expect.any(AbortSignal),
    );
  });

  it("preserves the private admin channel while using direct database provenance", async () => {
    const resolveAccess = vi.fn<BrainAccessStore["resolveAccess"]>(
      async (request) => allowedAccess(request, "admin"),
    );

    const result = await requireBrainAccess(
      accessStore(resolveAccess),
      {
        ...executionContext(),
        source: "admin" as ExecutionContext["source"],
      },
      { requiredRole: "editor" },
    );

    expect(resolveAccess).toHaveBeenCalledWith(
      expect.objectContaining({ source: "direct" }),
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      administrativeChannel: true,
      actor: { source: "direct" },
    });
  });

  it("does not trust an administrative channel marker returned for direct access", async () => {
    const result = await requireBrainAccess(
      accessStore(async (request) => ({
        ...allowedAccess(request, "admin"),
        administrativeChannel: true,
      })),
      executionContext({ source: "direct" }),
      { requiredRole: "editor" },
    );

    expect(result.administrativeChannel).toBeUndefined();
  });

  it.each(["cli", "mcp-stdio"] as const)(
    "rejects the removed %s execution source before consulting the store",
    async (source) => {
      const resolveAccess = vi.fn<BrainAccessStore["resolveAccess"]>();

      await expect(
        requireBrainAccess(accessStore(resolveAccess), executionContext({ source }), {
          requiredRole: "viewer",
        }),
      ).rejects.toMatchObject({
        code: "BRAIN_ACCESS_DENIED",
        message: "Brain access was denied.",
      });
      expect(resolveAccess).not.toHaveBeenCalled();
    },
  );

  it("never reads authorization from principal attributes", async () => {
    const resolveAccess = vi.fn<BrainAccessStore["resolveAccess"]>(
      async (request) => allowedAccess(request),
    );
    const store = accessStore(resolveAccess);
    const principal = {
      id: accountId,
      attributes: {
        brainId: otherId,
        clientId: "cursor",
        role: "owner",
        scopes: ["mcp:tools"],
      },
    };

    const access = await requireBrainAccess(
      store,
      executionContext({ principal, source: "mcp-http", requestId: "request-42" }),
      { requiredRole: "editor" },
    );

    expect(access).toMatchObject({
      accountId,
      role: "editor",
      actor: {
        kind: "oauth_client",
        clientId: "cursor",
        source: "mcp_http",
        requestId: "request-42",
      },
    });
    // Only the client id survives sanitization; other attributes are dropped
    // rather than forwarded to the store.
    expect(resolveAccess).toHaveBeenCalledWith(
      {
        principal: { id: accountId, attributes: { clientId: "cursor" } },
        requiredRole: "editor",
        source: "mcp_http",
        requestId: "request-42",
        correlationId: null,
      },
      expect.any(AbortSignal),
    );
  });

  it("offers no way for a caller to select a brain", async () => {
    const resolveAccess = vi.fn<BrainAccessStore["resolveAccess"]>(async (request) =>
      allowedAccess(request),
    );

    await requireBrainAccess(accessStore(resolveAccess), executionContext(), {
      requiredRole: "viewer",
    });

    const [request] = resolveAccess.mock.calls[0]!;
    expect(Object.keys(request).sort()).toEqual([
      "correlationId",
      "principal",
      "requestId",
      "requiredRole",
      "source",
    ]);
  });

  it("requires an authenticated principal before consulting the store", async () => {
    const resolveAccess = vi.fn<BrainAccessStore["resolveAccess"]>();

    await expect(
      requireBrainAccess(accessStore(resolveAccess), executionContext({ principal: null }), {
        requiredRole: "viewer",
      }),
    ).rejects.toMatchObject({
      code: "BRAIN_ACCESS_DENIED",
      message: "Brain access was denied.",
    });
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it.each([
    ["empty account id", { id: "" }],
    ["invalid client id", { id: accountId, attributes: { clientId: "   " } }],
    ["oversized client id", { id: accountId, attributes: { clientId: "x".repeat(501) } }],
  ])("fails closed for an %s", async (_label, principal) => {
    const resolveAccess = vi.fn<BrainAccessStore["resolveAccess"]>();

    await expect(
      requireBrainAccess(accessStore(resolveAccess), executionContext({ principal }), {
        requiredRole: "viewer",
      }),
    ).rejects.toBeInstanceOf(CapabilityAccessDeniedError);
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it.each([
    ["empty request id", executionContext({ requestId: "" })],
    [
      "unknown execution source",
      { ...executionContext(), source: "automation" as ExecutionContext["source"] },
    ],
  ])("fails closed for an %s", async (_label, context) => {
    const resolveAccess = vi.fn<BrainAccessStore["resolveAccess"]>();

    await expect(
      requireBrainAccess(accessStore(resolveAccess), context, { requiredRole: "viewer" }),
    ).rejects.toBeInstanceOf(CapabilityAccessDeniedError);
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it("replaces dependency failures with a stable sanitized boundary error", async () => {
    const cause = new Error("account role row for a private account did not exist");
    const store = accessStore(async () => {
      throw cause;
    });

    let failure: unknown;
    try {
      await requireBrainAccess(store, executionContext(), { requiredRole: "viewer" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CapabilityAccessDeniedError);
    expect(failure).toMatchObject({
      code: "BRAIN_ACCESS_DENIED",
      message: "Brain access was denied.",
      cause,
    });
    expect(String(failure)).not.toContain("private account");
  });

  it.each([
    ["account", (access: BrainAccessContext) => ({ ...access, accountId: otherId })],
    ["role", (access: BrainAccessContext) => ({ ...access, role: "viewer" as const })],
    [
      "actor account",
      (access: BrainAccessContext) => ({
        ...access,
        actor: { ...access.actor, accountId: otherId },
      }),
    ],
    [
      "actor request",
      (access: BrainAccessContext) => ({
        ...access,
        actor: { ...access.actor, requestId: "wrong-request" },
      }),
    ],
    [
      "actor source",
      (access: BrainAccessContext) => ({
        ...access,
        actor: { ...access.actor, source: "mcp_http" as const },
      }),
    ],
  ])("fails closed when the store returns mismatched %s attribution", async (_label, mutate) => {
    const store = accessStore(async (request) => mutate(allowedAccess(request, "editor")));

    await expect(
      requireBrainAccess(store, executionContext(), { requiredRole: "editor" }),
    ).rejects.toBeInstanceOf(CapabilityAccessDeniedError);
  });

  it("does not turn cancellation into an access denial", async () => {
    const controller = new AbortController();
    const cancellation = new Error("stop");
    controller.abort(cancellation);
    const resolveAccess = vi.fn<BrainAccessStore["resolveAccess"]>();

    await expect(
      requireBrainAccess(
        accessStore(resolveAccess),
        executionContext({ signal: controller.signal }),
        { requiredRole: "viewer" },
      ),
    ).rejects.toBe(cancellation);
    expect(resolveAccess).not.toHaveBeenCalled();
  });
});
