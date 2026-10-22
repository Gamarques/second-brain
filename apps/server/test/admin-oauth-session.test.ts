import { createServer } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  AdminSessionError,
  createAdminOAuthSessionResolver,
  readAdminOAuthConfiguration,
  resolveAdminSession,
  type AdminAccountStore,
} from "../src/services/admin/session.js";
import {
  adminOAuthClientId,
  adminOAuthScope,
} from "../src/services/auth/admin-client.js";

const accountId = "00000000-0000-4000-8000-000000000001";

function authorizedAccount(): AdminAccountStore {
  return {
    async findAuthorizedAccount(subject) {
      return subject === accountId
        ? {
            accountId,
            email: "owner@example.test",
            role: "owner",
            connectedClientCount: 2,
          }
        : null;
    },
  };
}

describe("admin OAuth configuration", () => {
  it("derives the same-origin issuer, admin audience, and internal JWKS URL", () => {
    expect(
      readAdminOAuthConfiguration({
        SECOND_BRAIN_PUBLIC_URL: "https://brain.example.com",
        INVOKTA_OAUTH_JWKS_URL: "http://auth:3001/jwks",
      }),
    ).toEqual({
      issuer: "https://brain.example.com",
      jwksUrl: "http://auth:3001/jwks",
      resource: "https://brain.example.com/api/admin",
      clientId: adminOAuthClientId,
      scopes: [adminOAuthScope],
    });
  });

  it("rejects an insecure external JWKS endpoint", () => {
    expect(() =>
      readAdminOAuthConfiguration({
        SECOND_BRAIN_PUBLIC_URL: "https://brain.example.com",
        INVOKTA_OAUTH_JWKS_URL: "http://keys.example.com/jwks",
      }),
    ).toThrow(/JWKS_URL must use HTTPS/);
  });
});

describe("admin OAuth bearer session", () => {
  it("maps an audience-verified admin token to a live domain administrator", async () => {
    const verifier = {
      async verify() {
        return {
          subject: accountId,
          clientId: adminOAuthClientId,
          scopes: ["openid", "offline_access", adminOAuthScope],
        };
      },
    };

    await expect(
      resolveAdminSession(
        verifier,
        authorizedAccount(),
        new Headers({ authorization: "Bearer signed.jwt.token" }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      accountId,
      email: "owner@example.test",
      role: "owner",
      connectedClientCount: 2,
      principal: { id: accountId },
      oauthClientId: adminOAuthClientId,
      scopes: ["openid", "offline_access", adminOAuthScope],
    });
  });

  it.each([
    ["missing bearer", new Headers(), { subject: accountId, clientId: adminOAuthClientId, scopes: [adminOAuthScope] }],
    ["malformed bearer", new Headers({ authorization: "Basic token" }), { subject: accountId, clientId: adminOAuthClientId, scopes: [adminOAuthScope] }],
    ["wrong client", new Headers({ authorization: "Bearer token" }), { subject: accountId, clientId: "other-client", scopes: [adminOAuthScope] }],
    ["missing scope", new Headers({ authorization: "Bearer token" }), { subject: accountId, clientId: adminOAuthClientId, scopes: ["openid"] }],
    ["invalid token", new Headers({ authorization: "Bearer token" }), null],
  ])("fails closed for %s", async (_name, headers, token) => {
    const verifier = { async verify() { return token; } };

    await expect(
      resolveAdminSession(
        verifier,
        authorizedAccount(),
        headers,
        new AbortController().signal,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AdminSessionError>>({
        code: "ADMIN_SESSION_DENIED",
      }),
    );
  });

  it("rejects a valid token when the live account is no longer administrative", async () => {
    const findAuthorizedAccount = vi.fn(async () => null);
    await expect(
      resolveAdminSession(
        {
          async verify() {
            return {
              subject: accountId,
              clientId: adminOAuthClientId,
              scopes: [adminOAuthScope],
            };
          },
        },
        { findAuthorizedAccount },
        new Headers({ authorization: "Bearer token" }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "ADMIN_SESSION_DENIED" });
    expect(findAuthorizedAccount).toHaveBeenCalledWith(
      accountId,
      expect.any(AbortSignal),
    );
  });

  it("rejects a correctly signed token issued for the MCP audience", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const jwk = await exportJWK(publicKey);
    Object.assign(jwk, { alg: "ES256", kid: "admin-test-key", use: "sig" });
    const jwksServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => {
      jwksServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = jwksServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("The test JWKS server did not bind a TCP port.");
      }
      const issuer = "https://brain.example.com";
      const token = await new SignJWT({
        client_id: adminOAuthClientId,
        scope: adminOAuthScope,
      })
        .setProtectedHeader({ alg: "ES256", kid: "admin-test-key" })
        .setIssuer(issuer)
        .setAudience(`${issuer}/mcp`)
        .setSubject(accountId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      const resolver = createAdminOAuthSessionResolver(
        {} as never,
        {
          issuer,
          jwksUrl: `http://127.0.0.1:${address.port}/jwks`,
          resource: `${issuer}/api/admin`,
          clientId: adminOAuthClientId,
          scopes: [adminOAuthScope],
        },
      );

      await expect(
        resolver.resolve(
          new Headers({ authorization: `Bearer ${token}` }),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "ADMIN_SESSION_DENIED" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        jwksServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
