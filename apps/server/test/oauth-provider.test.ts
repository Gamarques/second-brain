import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import {
  createOAuthProviderConfiguration,
  formatOAuthRegistrationError,
} from "../src/services/auth/provider.js";
import {
  adminOAuthClientId,
  adminOAuthScope,
} from "../src/services/auth/admin-client.js";

async function testConfiguration() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const key = await exportJWK(privateKey);
  Object.assign(key, { alg: "ES256", kid: "test-signing-key", use: "sig" });
  return createOAuthProviderConfiguration({
    secrets: {
      cookieKeys: ["test-cookie-key-with-at-least-32-characters"],
      jwks: { keys: [key] },
    },
    server: {
      issuer: "https://brain.example.com",
      resource: "https://brain.example.com/mcp",
      adminResource: "https://brain.example.com/api/admin",
      host: "127.0.0.1",
      port: 3001,
      allowedHosts: ["brain.example.com"],
    },
    users: {
      async findAccount() {
        return null;
      },
    },
  });
}

describe("OAuth client registration", () => {
  it("registers one same-origin public admin client with authorization code PKCE metadata", async () => {
    const configuration = await testConfiguration();

    expect(configuration.clients).toEqual([
      expect.objectContaining({
        client_id: adminOAuthClientId,
        redirect_uris: ["https://brain.example.com/admin/oauth/callback"],
        post_logout_redirect_uris: ["https://brain.example.com/admin/login"],
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
    ]);
    expect(configuration.clients?.[0]).not.toHaveProperty("client_secret");
    const pkceRequired = configuration.pkce?.required;
    expect(pkceRequired).toEqual(expect.any(Function));
    expect(pkceRequired!({} as never, {} as never)).toBe(true);
    expect(configuration.scopes).toContain(adminOAuthScope);
  });

  it("reserves the admin audience for the static client without changing MCP resources", async () => {
    const configuration = await testConfiguration();
    const resourceIndicators = configuration.features?.resourceIndicators;
    expect(resourceIndicators).toEqual(
      expect.objectContaining({ getResourceServerInfo: expect.any(Function) }),
    );
    const getResourceServerInfo = resourceIndicators!.getResourceServerInfo!;

    expect(() =>
      getResourceServerInfo(
        {} as never,
        "https://brain.example.com/api/admin",
        { clientId: "dynamic-client" } as never,
      ),
    ).toThrow("invalid_target");
    expect(
      getResourceServerInfo(
        {} as never,
        "https://brain.example.com/mcp",
        { clientId: "dynamic-client" } as never,
      ),
    ).toMatchObject({
      scope: "mcp:tools",
      audience: "https://brain.example.com/mcp",
    });
    expect(
      getResourceServerInfo(
        {} as never,
        "https://brain.example.com/api/admin",
        { clientId: adminOAuthClientId } as never,
      ),
    ).toMatchObject({
      scope: adminOAuthScope,
      audience: "https://brain.example.com/api/admin",
    });
  });

  it("defaults DCR clients to confidential ES256 metadata", async () => {
    const configuration = await testConfiguration();

    expect(configuration.clientDefaults).toMatchObject({
      id_token_signed_response_alg: "ES256",
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  it("formats registration failures without leaking submitted secrets", () => {
    const diagnostic = formatOAuthRegistrationError(
      { method: "POST", path: "/reg" },
      {
        error: "invalid_client_metadata",
        error_description: "client_secret super-secret-value is invalid",
        statusCode: 400,
      },
    );

    expect(diagnostic).toBe(
      "OAuth client registration failed: method=POST path=/reg status=400 code=invalid_client_metadata.\n",
    );
    expect(diagnostic).not.toContain("super-secret-value");
  });
});
