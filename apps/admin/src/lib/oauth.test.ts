// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  completeOAuthAuthorization,
  clearOAuthSession,
  createPkceChallenge,
  getOAuthAccessToken,
  oauthConstants,
  prepareOAuthAuthorization,
  previousSignInStorageKey,
  refreshOAuthAccessToken,
  resetOAuthClient,
} from "./oauth";

const discovery = {
  authorization_endpoint: "http://localhost:3000/authorize",
  token_endpoint: "http://localhost:3000/token",
  revocation_endpoint: "http://localhost:3000/revoke",
};

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function tokenResponse(accessToken: string): Response {
  return Response.json({
    access_token: accessToken,
    refresh_token: `refresh-${accessToken}`,
    token_type: "Bearer",
    expires_in: 600,
  });
}

async function signIn() {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(discovery))
    .mockResolvedValueOnce(tokenResponse("original-token"));
  const transaction = await prepareOAuthAuthorization();
  await completeOAuthAuthorization(`?code=code&state=${transaction.state}`);
  return fetchMock;
}

describe("admin OAuth client", () => {
  afterEach(() => {
    sessionStorage.clear();
    resetOAuthClient();
    vi.restoreAllMocks();
  });

  it("creates an S256 authorization request for the built-in admin client", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(discovery), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const request = await prepareOAuthAuthorization("/audit");
    const url = new URL(request.authorizationUrl);

    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
    expect(url.searchParams.get("client_id")).toBe("second-brain-admin");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/admin/oauth/callback");
    expect(url.searchParams.get("resource")).toBe("http://localhost:3000/api/admin");
    expect(url.searchParams.get("scope")).toBe("openid offline_access admin:panel");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(await createPkceChallenge(request.verifier));
    expect(request.returnTo).toBe("/audit");
  });

  it("creates a localized silent recovery request without persisting tokens", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(discovery), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const request = await prepareOAuthAuthorization("/memories", {
      locale: "pt-BR",
      prompt: "none",
    });
    const url = new URL(request.authorizationUrl);

    expect(url.searchParams.get("prompt")).toBe("none");
    expect(url.searchParams.get("ui_locales")).toBe("pt-BR");
    expect(localStorage.getItem(previousSignInStorageKey)).toBeNull();
  });

  it("exchanges the callback code and erases the one-time PKCE transaction", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(discovery), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "id-token",
        token_type: "Bearer",
        expires_in: 600,
        scope: oauthConstants.scope,
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const request = await prepareOAuthAuthorization("/memories");

    const returnTo = await completeOAuthAuthorization(`?code=authorization-code&state=${encodeURIComponent(request.state)}`);

    expect(returnTo).toBe("/memories");
    expect(sessionStorage.length).toBe(0);
    const tokenCall = fetchMock.mock.calls.at(-1);
    expect(tokenCall?.[0]).toBe(discovery.token_endpoint);
    const body = tokenCall?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get("code_verifier")).toBe(request.verifier);
    expect((body as URLSearchParams).get("resource")).toBe("http://localhost:3000/api/admin");
    expect(localStorage.getItem(previousSignInStorageKey)).toBe("true");
  });

  it("does not restore a cleared session when an in-flight refresh succeeds", async () => {
    const fetchMock = await signIn();
    const response = deferredResponse();
    fetchMock.mockReturnValueOnce(response.promise);
    const refresh = refreshOAuthAccessToken();
    const rejected = expect(refresh).rejects.toMatchObject({ name: "OAuthAuthenticationRequiredError" });

    clearOAuthSession();
    response.resolve(tokenResponse("stale-token"));

    await rejected;
    await expect(getOAuthAccessToken()).rejects.toMatchObject({ name: "OAuthAuthenticationRequiredError" });
  });

  it.each(["success", "failure"])("isolates a new session from an old refresh %s", async (outcome) => {
    const fetchMock = await signIn();
    const oldResponse = deferredResponse();
    fetchMock.mockReturnValueOnce(oldResponse.promise);
    const oldRefresh = refreshOAuthAccessToken();
    const oldRejected = expect(oldRefresh).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    clearOAuthSession();

    fetchMock.mockResolvedValueOnce(tokenResponse("new-session-token"));
    const transaction = await prepareOAuthAuthorization();
    await completeOAuthAuthorization(`?code=new-code&state=${transaction.state}`);
    const newResponse = deferredResponse();
    fetchMock.mockReturnValueOnce(newResponse.promise);
    const newRefresh = refreshOAuthAccessToken();
    const newRefreshed = expect(newRefresh).resolves.toBe("new-refreshed-token");

    oldResponse.resolve(outcome === "success"
      ? tokenResponse("stale-token")
      : Response.json({ error: "invalid_grant" }, { status: 400 }));
    await oldRejected;
    await expect(getOAuthAccessToken()).resolves.toBe("new-session-token");
    const joinedRefresh = refreshOAuthAccessToken();
    newResponse.resolve(tokenResponse("new-refreshed-token"));
    await newRefreshed;
    await expect(joinedRefresh).resolves.toBe("new-refreshed-token");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("shares concurrent refreshes and reuses the replacement token for a delayed 401", async () => {
    const fetchMock = await signIn();
    fetchMock.mockResolvedValueOnce(tokenResponse("replacement-token"));

    await expect(Promise.all([
      refreshOAuthAccessToken("original-token"),
      refreshOAuthAccessToken("original-token"),
    ])).resolves.toEqual(["replacement-token", "replacement-token"]);
    await expect(refreshOAuthAccessToken("original-token")).resolves.toBe("replacement-token");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
