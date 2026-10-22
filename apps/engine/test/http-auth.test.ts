import { describe, expect, it } from "vitest";
import type { McpHttpAuthenticationRequest } from "@invokta/mcp";

import {
  combineHttpAuth,
  createBearerHttpAuth,
  createHttpAuth,
  createOAuthHttpAuth,
  readHttpAuthenticationConfiguration,
} from "../src/http-auth.js";

function authenticationRequest(
  authorization?: string,
): McpHttpAuthenticationRequest {
  const headers = new Headers(
    authorization === undefined ? {} : { authorization },
  );
  return {
    path: "/mcp",
    method: "POST",
    headers,
    signal: new AbortController().signal,
  };
}

describe("HTTP bearer authentication", () => {
  it("returns the configured principal for the exact bearer token", () => {
    const auth = createBearerHttpAuth({
      token: "a-secure-token-with-enough-entropy",
      principalId: "person:ada",
    });
    const request = authenticationRequest(
      "Bearer a-secure-token-with-enough-entropy",
    );

    expect(auth.authenticate(request)).toEqual({ id: "person:ada" });
  });

  it("rejects missing, malformed, and incorrect credentials", () => {
    const auth = createBearerHttpAuth({
      token: "a-secure-token-with-enough-entropy",
      principalId: "person:ada",
    });

    expect(auth.authenticate(authenticationRequest())).toBeNull();
    expect(
      auth.authenticate(
        authenticationRequest("Basic a-secure-token-with-enough-entropy"),
      ),
    ).toBeNull();
    expect(
      auth.authenticate(
        authenticationRequest("Bearer incorrect-token"),
      ),
    ).toBeNull();
  });

  it("fails closed when server authentication is not configured", () => {
    const auth = createBearerHttpAuth({ token: "", principalId: "" });
    const request = authenticationRequest("Bearer anything");

    expect(auth.authenticate(request)).toBeNull();
  });
});

describe("HTTP OAuth authentication", () => {
  it("uses OAuth by default and derives MCP resource metadata", () => {
    expect(
      readHttpAuthenticationConfiguration({
        SECOND_BRAIN_PUBLIC_URL: "https://brain.example.com",
      }),
    ).toEqual({
      mode: "oauth",
      issuer: "https://brain.example.com",
      jwksUrl: "https://brain.example.com/jwks",
      resource: "https://brain.example.com/mcp",
      scopes: ["mcp:tools"],
    });
  });

  it("allows an explicit internal JWKS URL without changing the public issuer", () => {
    expect(
      readHttpAuthenticationConfiguration({
        SECOND_BRAIN_PUBLIC_URL: "https://brain.example.com",
        INVOKTA_OAUTH_JWKS_URL: "http://auth:3001/jwks",
      }),
    ).toMatchObject({
      issuer: "https://brain.example.com",
      jwksUrl: "http://auth:3001/jwks",
      resource: "https://brain.example.com/mcp",
    });
  });

  it("maps a valid OAuth subject and scopes to an engine principal", async () => {
    const auth = createOAuthHttpAuth({
      issuer: "https://brain.example.com",
      resource: "https://brain.example.com/mcp",
      scopes: ["mcp:tools"],
      verifier: {
        async verify(token) {
          if (token !== "valid-access-token") return null;
          return {
            subject: "person:ada",
            clientId: "https://client.example.com/metadata.json",
            scopes: ["mcp:tools", "offline_access"],
          };
        },
      },
    });

    await expect(
      auth.authenticate(authenticationRequest("Bearer valid-access-token")),
    ).resolves.toEqual({
      id: "person:ada",
      attributes: {
        clientId: "https://client.example.com/metadata.json",
        scopes: ["mcp:tools", "offline_access"],
      },
    });
    expect(auth.resourceMetadata).toEqual({
      resource: "https://brain.example.com/mcp",
      authorizationServers: ["https://brain.example.com"],
      scopesSupported: ["mcp:tools"],
    });
  });

  it("rejects invalid tokens and tokens missing the required scope", async () => {
    const auth = createOAuthHttpAuth({
      issuer: "https://brain.example.com",
      resource: "https://brain.example.com/mcp",
      scopes: ["mcp:tools"],
      verifier: {
        async verify(token) {
          if (token === "wrong-scope") {
            return { subject: "person:ada", scopes: ["profile"] };
          }
          return null;
        },
      },
    });

    await expect(auth.authenticate(authenticationRequest())).resolves.toBeNull();
    await expect(
      auth.authenticate(authenticationRequest("Bearer invalid")),
    ).resolves.toBeNull();
    await expect(
      auth.authenticate(authenticationRequest("Bearer wrong-scope")),
    ).resolves.toBeNull();
  });

  it("requires an explicit opt-in for exclusive static Bearer mode", () => {
    expect(() =>
      readHttpAuthenticationConfiguration({
        INVOKTA_HTTP_AUTH_MODE: "bearer",
        INVOKTA_HTTP_BEARER_TOKEN: "a-secure-token-with-enough-entropy",
        INVOKTA_HTTP_PRINCIPAL_ID: "person:ada",
      }),
    ).not.toThrow();
    expect(() => readHttpAuthenticationConfiguration({})).toThrow(
      /SECOND_BRAIN_PUBLIC_URL/,
    );
  });

  it("accepts an optional static bearer token alongside OAuth", () => {
    expect(
      readHttpAuthenticationConfiguration({
        SECOND_BRAIN_PUBLIC_URL: "https://brain.example.com",
        INVOKTA_HTTP_BEARER_TOKEN: "a-secure-token-with-enough-entropy",
        INVOKTA_HTTP_PRINCIPAL_ID: "person:ada",
      }),
    ).toEqual({
      mode: "oauth",
      issuer: "https://brain.example.com",
      jwksUrl: "https://brain.example.com/jwks",
      resource: "https://brain.example.com/mcp",
      scopes: ["mcp:tools"],
      bearer: {
        token: "a-secure-token-with-enough-entropy",
        principalId: "person:ada",
      },
    });
  });

  it("treats blank Compose bearer placeholders as OAuth-only", () => {
    expect(
      readHttpAuthenticationConfiguration({
        SECOND_BRAIN_PUBLIC_URL: "https://brain.example.com",
        INVOKTA_HTTP_BEARER_TOKEN: "",
        INVOKTA_HTTP_PRINCIPAL_ID: "",
      }),
    ).toEqual({
      mode: "oauth",
      issuer: "https://brain.example.com",
      jwksUrl: "https://brain.example.com/jwks",
      resource: "https://brain.example.com/mcp",
      scopes: ["mcp:tools"],
    });
  });

  it("rejects a partial static bearer configuration in OAuth mode", () => {
    expect(() =>
      readHttpAuthenticationConfiguration({
        SECOND_BRAIN_PUBLIC_URL: "https://brain.example.com",
        INVOKTA_HTTP_BEARER_TOKEN: "a-secure-token-with-enough-entropy",
      }),
    ).toThrow(/INVOKTA_HTTP_PRINCIPAL_ID/);
    expect(() =>
      readHttpAuthenticationConfiguration({
        SECOND_BRAIN_PUBLIC_URL: "https://brain.example.com",
        INVOKTA_HTTP_PRINCIPAL_ID: "person:ada",
      }),
    ).toThrow(/INVOKTA_HTTP_BEARER_TOKEN/);
  });

  it("rejects insecure public OAuth URLs outside loopback development", () => {
    expect(() =>
      readHttpAuthenticationConfiguration({
        SECOND_BRAIN_PUBLIC_URL: "http://brain.example.com",
      }),
    ).toThrow(/HTTPS/);
  });
});

describe("HTTP OAuth and bearer authentication", () => {
  const oauthAuth = createOAuthHttpAuth({
    issuer: "https://brain.example.com",
    resource: "https://brain.example.com/mcp",
    scopes: ["mcp:tools"],
    verifier: {
      async verify(token) {
        if (token !== "valid-access-token") return null;
        return {
          subject: "person:ada",
          clientId: "https://client.example.com/metadata.json",
          scopes: ["mcp:tools"],
        };
      },
    },
  });

  it("accepts the static bearer token without disabling OAuth metadata", async () => {
    const auth = createHttpAuth({
      mode: "oauth",
      issuer: "https://brain.example.com",
      jwksUrl: "https://brain.example.com/jwks",
      resource: "https://brain.example.com/mcp",
      scopes: ["mcp:tools"],
      bearer: {
        token: "a-secure-token-with-enough-entropy",
        principalId: "person:ada",
      },
    });

    await expect(
      auth.authenticate(
        authenticationRequest("Bearer a-secure-token-with-enough-entropy"),
      ),
    ).resolves.toEqual({ id: "person:ada" });
    expect(auth.resourceMetadata).toEqual({
      resource: "https://brain.example.com/mcp",
      authorizationServers: ["https://brain.example.com"],
      scopesSupported: ["mcp:tools"],
    });
  });

  it("accepts a valid OAuth token when the static bearer does not match", async () => {
    const auth = combineHttpAuth(
      createBearerHttpAuth({
        token: "a-secure-token-with-enough-entropy",
        principalId: "person:ada",
      }),
      oauthAuth,
    );

    await expect(
      auth.authenticate(authenticationRequest("Bearer valid-access-token")),
    ).resolves.toEqual({
      id: "person:ada",
      attributes: {
        clientId: "https://client.example.com/metadata.json",
        scopes: ["mcp:tools"],
      },
    });
  });

  it("rejects missing and unknown credentials in combined mode", async () => {
    const auth = combineHttpAuth(
      createBearerHttpAuth({
        token: "a-secure-token-with-enough-entropy",
        principalId: "person:ada",
      }),
      oauthAuth,
    );

    await expect(auth.authenticate(authenticationRequest())).resolves.toBeNull();
    await expect(
      auth.authenticate(authenticationRequest("Bearer unknown-token")),
    ).resolves.toBeNull();
  });
});
