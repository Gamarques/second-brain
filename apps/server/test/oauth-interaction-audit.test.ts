import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createInteractionHandler } from "../src/services/auth/interaction-server.js";

const uid = "private-interaction-id";
const csrfKey = "private-csrf-key";

function request(body: URLSearchParams): IncomingMessage {
  const stream = Readable.from([Buffer.from(body.toString(), "utf8")]);
  return Object.assign(stream, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }) as unknown as IncomingMessage;
}

function response(): ServerResponse & { body: string } {
  const headers = new Map<string, unknown>();
  const result = {
    body: "",
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: unknown) { headers.set(name, value); return result; },
    getHeader(name: string) { return headers.get(name); },
    end(value?: unknown) {
      result.body += value === undefined ? "" : String(value);
      result.writableEnded = true;
      return result;
    },
  };
  return result as unknown as ServerResponse & { body: string };
}

function provider(clientId = "second-brain-admin") {
  return {
    Client: { async find() { return { clientName: "Second Brain Admin" }; } },
    async interactionDetails() {
      return {
        uid,
        prompt: { name: "login", details: {} },
        params: { client_id: clientId },
      };
    },
    interactionFinished: vi.fn(async () => undefined),
  };
}

function form(password: string) {
  return new URLSearchParams({
    csrf: createHmac("sha256", csrfKey).update(uid, "utf8").digest("base64url"),
    email: "private-owner@example.com",
    password,
  });
}

describe("OAuth admin login audit", () => {
  it("records success and credential denial for only the built-in admin client", async () => {
    const record = vi.fn(async () => undefined);
    const adminProvider = provider();
    const authenticate = vi
      .fn()
      .mockResolvedValueOnce({
        id: "00000000-0000-4000-8000-000000000001",
        email: "private-owner@example.com",
      })
      .mockResolvedValueOnce(null);
    const handler = createInteractionHandler({
      provider: adminProvider as never,
      users: { authenticate } as never,
      csrfKey,
      loginAudit: { clientId: "second-brain-admin", record },
    });

    await handler(request(form("private correct password")), response(), `/interaction/${uid}/login`);
    await handler(request(form("private wrong password")), response(), `/interaction/${uid}/login`);

    expect(record).toHaveBeenNthCalledWith(
      1,
      {
        outcome: "succeeded",
        accountId: "00000000-0000-4000-8000-000000000001",
        requestId: expect.any(String),
        errorCode: null,
      },
      expect.any(AbortSignal),
    );
    expect(record).toHaveBeenNthCalledWith(
      2,
      {
        outcome: "denied",
        accountId: null,
        requestId: expect.any(String),
        errorCode: "OAUTH_CREDENTIALS_DENIED",
      },
      expect.any(AbortSignal),
    );
    const auditJson = JSON.stringify(record.mock.calls);
    expect(auditJson).not.toContain(uid);
    expect(auditJson).not.toContain("private-owner@example.com");
    expect(auditJson).not.toContain("private correct password");

    record.mockClear();
    const mcpHandler = createInteractionHandler({
      provider: provider("mcp-client") as never,
      users: { authenticate: vi.fn(async () => null) } as never,
      csrfKey,
      loginAudit: { clientId: "second-brain-admin", record },
    });
    await mcpHandler(request(form("private password")), response(), `/interaction/${uid}/login`);
    expect(record).not.toHaveBeenCalled();
  });

  it("records an admin-client CSRF denial without reading credentials into the event", async () => {
    const record = vi.fn(async () => undefined);
    const handler = createInteractionHandler({
      provider: provider() as never,
      users: { authenticate: vi.fn() } as never,
      csrfKey,
      loginAudit: { clientId: "second-brain-admin", record },
    });

    const denied = form("private password");
    denied.set("csrf", "invalid-private-token");
    await handler(request(denied), response(), `/interaction/${uid}/login`);

    expect(record).toHaveBeenCalledWith(
      {
        outcome: "denied",
        accountId: null,
        requestId: expect.any(String),
        errorCode: "OAUTH_INTERACTION_CSRF_DENIED",
      },
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain("invalid-private-token");
    expect(JSON.stringify(record.mock.calls)).not.toContain("private password");
  });
});
