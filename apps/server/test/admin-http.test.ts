import { describe, expect, it, vi } from "vitest";
import { BrainPackError } from "@second-brain/engine/domain/brain-pack";

import { adminEngineOperations, createAdminHttpHandler } from "../src/services/admin/http.js";

const origin = "https://brain.example.com";
const accountId = "00000000-0000-4000-8000-000000000001";

function session() {
  return {
    accountId,
    email: "owner@example.test",
    role: "owner" as const,
    connectedClientCount: 2,
    principal: { id: accountId },
    oauthClientId: "second-brain-admin" as const,
    scopes: ["admin:panel"],
  };
}

function mutation(path: string, body: unknown = {}) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

it("forwards browser cancellation to both private and public capability invocations", async () => {
  for (const operation of ["brain-question", "memories-create"]) {
    const controller = new AbortController();
    let forwarded: AbortSignal | undefined;
    const invoke = vi.fn(async (_id: string, _input: unknown, options: { signal?: AbortSignal }) => { forwarded = options.signal; return {}; });
    const handler = createAdminHttpHandler({ trustedOrigin: origin, sessions: { async resolve() { return session(); } }, adminEngine: { invoke }, publicEngine: { invoke } });
    const request = new Request(mutation(`/api/admin/engine/${operation}`, { question: "When is the review?", content: "Review notes", idempotencyKey: "request" }), { signal: controller.signal });
    expect((await handler(request)).status).toBe(200);
    expect(forwarded).toBe(request.signal);
    controller.abort();
    expect(forwarded?.aborted).toBe(true);
  }
});

describe("admin HTTP integration", () => {
  it("returns a human account identity and persisted connection progress", async () => {
    const handler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { return session(); } },
    });

    const response = await handler(new Request(`${origin}/api/admin/me`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId,
      email: "owner@example.test",
      role: "owner",
      connectedClientCount: 2,
    });
  });

  it("marks successful browser content mutations for transactional store auditing", async () => {
    const memoryId = "00000000-0000-4000-8000-000000000010";
    const record = vi.fn(async () => undefined);
    const invoke = vi.fn(async (..._args: unknown[]) => ({ id: memoryId, created: true }));
    const handler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { return session(); } },
      publicEngine: { invoke },
      audit: { record },
    });

    const response = await handler(
      mutation("/api/admin/memories", {
        content: "private memory content",
        idempotencyKey: "memory-create-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(
      "memories_create",
      expect.any(Object),
      expect.objectContaining({ source: "admin" }),
    );
    expect(record).not.toHaveBeenCalled();
  });

  it("audits denied content mutations and origin failures with fixed error metadata", async () => {
    const record = vi.fn(async () => undefined);
    const forbidden = Object.assign(new Error("sensitive authorization detail"), {
      code: "FORBIDDEN",
    });
    const handler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { return session(); } },
      publicEngine: { invoke: vi.fn(async () => { throw forbidden; }) },
      audit: { record },
    });

    const denied = await handler(
      mutation("/api/admin/memories", {
        content: "must not be logged",
        idempotencyKey: "memory-create-2",
      }),
    );
    expect(denied.status).toBe(403);
    expect(record).toHaveBeenCalledWith(
      {
        kind: "content_mutation_outcome",
        actor: { accountId, role: "owner" },
        capabilityId: "memories_create",
        outcome: "denied",
        targetId: null,
        requestId: expect.any(String),
        errorCode: "ADMIN_ACCESS_DENIED",
      },
      expect.any(AbortSignal),
    );

    record.mockClear();
    const originDenied = await handler(
      new Request(`${origin}/api/admin/memories`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ content: "also private" }),
      }),
    );
    expect(originDenied.status).toBe(403);
    expect(record).toHaveBeenCalledWith(
      {
        kind: "request_outcome",
        actor: { accountId, role: "owner" },
        category: "administration",
        action: "administration.request",
        outcome: "denied",
        requestId: expect.any(String),
        errorCode: "ADMIN_ORIGIN_DENIED",
        method: "POST",
      },
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain("also private");
  });

  it("returns actionable provider authentication failures without leaking their cause", async () => {
    const providerFailure = Object.assign(
      new Error("The OpenRouter request failed with status 401. secret detail"),
      { code: "OPENROUTER_AUTHENTICATION_FAILED" },
    );
    const engineFailure = Object.assign(new Error("Capability execution failed."), {
      code: "EXECUTION_FAILED",
      cause: providerFailure,
    });
    const record = vi.fn(async () => undefined);
    const handler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { return session(); } },
      publicEngine: { invoke: vi.fn(async () => { throw engineFailure; }) },
      audit: { record },
    });

    const response = await handler(
      mutation("/api/admin/memories", {
        content: "private memory content",
        idempotencyKey: "memory-create-provider-failure",
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "ADMIN_PROVIDER_AUTHENTICATION_FAILED",
      message:
        "AI provider authentication failed. Update OPENROUTER_API_KEY in Configuration, restart services, and try again.",
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityId: "memories_create",
        errorCode: "ADMIN_PROVIDER_AUTHENTICATION_FAILED",
        outcome: "failed",
      }),
      expect.any(AbortSignal),
    );
  });

  it("audits anonymous OAuth session denials", async () => {
    const record = vi.fn(async () => undefined);
    const sessionError = Object.assign(new Error("token detail"), {
      code: "ADMIN_SESSION_DENIED",
    });
    const deniedHandler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { throw sessionError; } },
      audit: { record },
    });
    const denied = await deniedHandler(new Request(`${origin}/api/admin/session`));
    expect(denied.status).toBe(401);
    expect(record).toHaveBeenCalledWith(
      {
        kind: "request_outcome",
        actor: null,
        category: "authentication",
        action: "authentication.session",
        outcome: "denied",
        requestId: expect.any(String),
        errorCode: "ADMIN_SESSION_DENIED",
        method: "GET",
      },
      expect.any(AbortSignal),
    );

  });

  it("audits target-origin denials before session resolution", async () => {
    const record = vi.fn(async () => undefined);
    const resolve = vi.fn();
    const handler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { resolve },
      audit: { record },
    });

    const response = await handler(
      new Request("https://attacker.example/api/admin/session"),
    );
    expect(response.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      {
        kind: "request_outcome",
        actor: null,
        category: "administration",
        action: "administration.request",
        outcome: "denied",
        method: "GET",
        requestId: expect.any(String),
        errorCode: "ADMIN_ORIGIN_DENIED",
      },
      expect.any(AbortSignal),
    );
  });

  it("routes fixed REST operations to the public and private engines", async () => {
    const publicInvoke = vi.fn(async () => ({ memories: [], nextCursor: null }));
    const adminInvoke = vi.fn(async () => ({
      settings: {
        timeZone: "America/Sao_Paulo",
        dreamingEnabled: false,
      },
    }));
    const handler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { return session(); } },
      publicEngine: { invoke: publicInvoke },
      adminEngine: { invoke: adminInvoke },
    });

    const memories = await handler(
      new Request(`${origin}/api/admin/memories?limit=50&includeSuperseded=true`),
    );
    expect(memories.status).toBe(200);
    expect(publicInvoke).toHaveBeenCalledWith(
      "memories_list",
      { limit: 50, includeSuperseded: true },
      expect.objectContaining({ principal: { id: accountId }, source: "admin" }),
    );

    const settings = await handler(
      new Request(`${origin}/api/admin/automation/settings`),
    );
    expect(settings.status).toBe(200);
    await expect(settings.json()).resolves.toEqual({
      timeZone: "America/Sao_Paulo",
      dreamingEnabled: false,
    });
    expect(adminInvoke).toHaveBeenCalledWith(
      "admin_automation_settings_get",
      {},
      expect.objectContaining({ principal: { id: accountId }, source: "direct" }),
    );

    await handler(
      new Request(`${origin}/api/admin/brain-map?days=90&nodeLimit=250`),
    );
    expect(adminInvoke).toHaveBeenLastCalledWith(
      "admin_brain_map_get",
      { days: 90, nodeLimit: 250 },
      expect.objectContaining({ principal: { id: accountId }, source: "direct" }),
    );

    await handler(
      new Request(
        `${origin}/api/admin/knowledge/bases/base-id/documents/document-id/revisions?limit=20`,
      ),
    );
    expect(publicInvoke).toHaveBeenLastCalledWith(
      "knowledge_document_revisions_list",
      { documentId: "document-id", limit: 20 },
      expect.objectContaining({ principal: { id: accountId }, source: "admin" }),
    );

    await handler(
      mutation("/api/admin/config/restart", {
        expectedRevision: 3,
        idempotencyKey: "restart-services-v3",
      }),
    );
    expect(adminInvoke).toHaveBeenLastCalledWith(
      "admin_environment_services_restart",
      { expectedRevision: 3, idempotencyKey: "restart-services-v3" },
      expect.objectContaining({ principal: { id: accountId }, source: "direct" }),
    );
  });

  it("rejects an arbitrary capability ID and accepts bearer mutations without CSRF", async () => {
    const invoke = vi.fn();
    const handler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { return session(); } },
      publicEngine: { invoke },
      adminEngine: { invoke },
    });

    const arbitrary = await handler(
      mutation("/api/admin/engine/tasks-delete"),
    );
    expect(arbitrary.status).toBe(404);

    const bearerMutation = await handler(
      new Request(`${origin}/api/admin/memories`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ content: "A memory" }),
      }),
    );
    expect(bearerMutation.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(
      "memories_create",
      { content: "A memory" },
      expect.objectContaining({ source: "admin" }),
    );
  });

  it("accepts a document at the documented 1,000,000-character limit even when every character is three bytes", async () => {
    const invoke = vi.fn(async () => ({ document: {}, revision: {} }));
    const handler = createAdminHttpHandler({ trustedOrigin: origin, sessions: { async resolve() { return session(); } }, publicEngine: { invoke } });
    const content = "文".repeat(1_000_000);
    const body = JSON.stringify({ knowledgeBaseId: accountId, title: "Wide", content, idempotencyKey: "wide-1" });
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(1024 * 1024);

    const response = await handler(new Request(`${origin}/api/admin/engine/knowledge-document-revisions-create`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", "content-length": String(Buffer.byteLength(body, "utf8")) },
      body,
    }));

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("knowledge_document_revisions_create", expect.objectContaining({ content }), expect.anything());
  });

  it("still rejects a body above the JSON limit, by declared length and by actual bytes", async () => {
    const invoke = vi.fn(async () => ({}));
    const handler = createAdminHttpHandler({ trustedOrigin: origin, sessions: { async resolve() { return session(); } }, publicEngine: { invoke } });

    const declared = await handler(new Request(`${origin}/api/admin/engine/knowledge-document-revisions-create`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", "content-length": String(4 * 1024 * 1024 + 1) },
      body: "{}",
    }));
    const actual = await handler(mutation("/api/admin/engine/knowledge-document-revisions-create", { content: "x".repeat(4 * 1024 * 1024) }));

    expect(declared.status).toBe(413);
    expect(actual.status).toBe(413);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a bearer mutation without an exact JSON content type", async () => {
    const invoke = vi.fn();
    const handler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { return session(); } },
      publicEngine: { invoke },
    });

    const response = await handler(
      new Request(`${origin}/api/admin/memories`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ content: "A memory" }),
      }),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({
      error: "ADMIN_CONTENT_TYPE_DENIED",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the OAuth-backed admin session without caching", async () => {
    const handler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { return session(); } },
    });
    const response = await handler(new Request(`${origin}/api/admin/session`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId,
      email: "owner@example.test",
      role: "owner",
      connectedClientCount: 2,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("Brain Pack operations on the admin allowlist", () => {
  it.each([false, true])("returns an actionable pack limit without private details (wrapped: %s)", async (wrapped) => {
    const failure = new BrainPackError("PACK_LIMIT_EXCEEDED", "Private diagnostic message", ["Private pack details"]);
    const record = vi.fn(async () => undefined);
    const handler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { return session(); } },
      publicEngine: { invoke: vi.fn(async () => { throw wrapped ? new Error("Capability execution failed.", { cause: failure }) : failure; }) },
      audit: { record },
    });

    const response = await handler(mutation("/api/admin/engine/knowledge-packs-import", {
      artifactId: "00000000-0000-4000-8000-000000000010",
      idempotencyKey: "import-limit",
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "PACK_LIMIT_EXCEEDED",
      message: "A Brain Pack size or active import limit was exceeded.",
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", errorCode: "PACK_LIMIT_EXCEEDED" }),
      expect.any(AbortSignal),
    );
  });

  const expected = {
    "knowledge-packs-export": "knowledge_packs_export",
    "knowledge-packs-export-get": "knowledge_packs_export_get",
    "knowledge-packs-import": "knowledge_packs_import",
    "knowledge-packs-import-get": "knowledge_packs_import_get",
    "knowledge-packs-import-review": "knowledge_packs_import_review",
    "knowledge-packs-import-publish": "knowledge_packs_import_publish",
    "knowledge-packs-runs-list": "knowledge_packs_runs_list",
    "knowledge-packs-runs-cancel": "knowledge_packs_runs_cancel",
    "knowledge-packs-runs-retry": "knowledge_packs_runs_retry",
  } as const;

  it("maps every pack route onto its public capability", () => {
    for (const [operation, capabilityId] of Object.entries(expected)) {
      expect(adminEngineOperations[operation as keyof typeof adminEngineOperations]).toEqual({ target: "public", capabilityId });
    }
  });

  it("forwards a pack call to the public engine under the session principal", async () => {
    const invoke = vi.fn(async () => ({ runs: [], nextCursor: null }));
    const handler = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { return session(); } },
      publicEngine: { invoke },
      adminEngine: { invoke: vi.fn() },
    });

    const response = await handler(mutation("/api/admin/engine/knowledge-packs-runs-list", { cursor: null, limit: 20 }));

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(
      "knowledge_packs_runs_list",
      { cursor: null, limit: 20 },
      expect.objectContaining({ principal: { id: accountId } }),
    );
  });
});
