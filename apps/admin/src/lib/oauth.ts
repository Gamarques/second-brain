import { useSyncExternalStore } from "react";

export const oauthConstants = {
  clientId: "second-brain-admin",
  scope: "openid offline_access admin:panel",
} as const;

const transactionKey = "second-brain-admin.oauth.transaction";
export const previousSignInStorageKey = "second-brain-admin.previously-signed-in";
const transactionLifetimeMs = 10 * 60 * 1_000;
const refreshSkewMs = 30_000;

interface OAuthDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  end_session_endpoint?: string;
}

interface OAuthTransaction {
  state: string;
  verifier: string;
  redirectUri: string;
  returnTo: string;
  createdAt: number;
  silent: boolean;
}

interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accessExpiresAt: number;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
}

export interface OAuthSnapshot {
  authenticated: boolean;
}

const anonymousSnapshot: OAuthSnapshot = Object.freeze({ authenticated: false });
const authenticatedSnapshot: OAuthSnapshot = Object.freeze({ authenticated: true });
let snapshot = anonymousSnapshot;
let tokens: OAuthTokens | null = null;
let discoveryPromise: Promise<OAuthDiscovery> | null = null;
let refreshPromise: Promise<string> | null = null;
const listeners = new Set<() => void>();

export class OAuthAuthenticationRequiredError extends Error {
  constructor(message = "OAuth authorization is required.") {
    super(message);
    this.name = "OAuthAuthenticationRequiredError";
  }
}

export class OAuthSilentRecoveryError extends Error {
  constructor() {
    super("The previous sign-in session is no longer available.");
    this.name = "OAuthSilentRecoveryError";
  }
}

export function hasPreviousOAuthSignIn(): boolean {
  try {
    return window.localStorage.getItem(previousSignInStorageKey) === "true";
  } catch {
    return false;
  }
}

function origin(): string {
  return window.location.origin;
}

function redirectUri(): string {
  return `${origin()}/admin/oauth/callback`;
}

function resource(): string {
  return `${origin()}/api/admin`;
}

function publish(nextTokens: OAuthTokens | null): void {
  tokens = nextTokens;
  const nextSnapshot = nextTokens === null ? anonymousSnapshot : authenticatedSnapshot;
  if (snapshot === nextSnapshot) return;
  snapshot = nextSnapshot;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOAuthSession(): OAuthSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => anonymousSnapshot);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function sameOriginEndpoint(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`OAuth discovery did not provide ${name}.`);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`OAuth discovery returned an invalid ${name}.`);
  }
  if (endpoint.origin !== origin()) {
    throw new Error(`OAuth discovery returned a cross-origin ${name}.`);
  }
  return endpoint.href;
}

async function discoverOAuth(): Promise<OAuthDiscovery> {
  discoveryPromise ??= (async () => {
    const response = await fetch(`${origin()}/.well-known/openid-configuration`, {
      credentials: "omit",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("OAuth discovery is unavailable.");
    const value = await response.json() as Record<string, unknown>;
    return {
      authorization_endpoint: sameOriginEndpoint(value.authorization_endpoint, "authorization_endpoint"),
      token_endpoint: sameOriginEndpoint(value.token_endpoint, "token_endpoint"),
      ...(value.revocation_endpoint === undefined ? {} : { revocation_endpoint: sameOriginEndpoint(value.revocation_endpoint, "revocation_endpoint") }),
      ...(value.end_session_endpoint === undefined ? {} : { end_session_endpoint: sameOriginEndpoint(value.end_session_endpoint, "end_session_endpoint") }),
    };
  })().catch((error) => {
    discoveryPromise = null;
    throw error;
  });
  return discoveryPromise;
}

function safeReturnTo(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export async function prepareOAuthAuthorization(
  returnTo = "/",
  options: { readonly prompt?: "none"; readonly locale?: "en" | "pt-BR" | "es" } = {},
): Promise<OAuthTransaction & { authorizationUrl: string }> {
  const discovery = await discoverOAuth();
  const transaction: OAuthTransaction = {
    state: randomToken(),
    verifier: randomToken(),
    redirectUri: redirectUri(),
    returnTo: safeReturnTo(returnTo),
    createdAt: Date.now(),
    silent: options.prompt === "none",
  };
  const authorization = new URL(discovery.authorization_endpoint);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: oauthConstants.clientId,
    redirect_uri: transaction.redirectUri,
    scope: oauthConstants.scope,
    resource: resource(),
    state: transaction.state,
    code_challenge: await createPkceChallenge(transaction.verifier),
    code_challenge_method: "S256",
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    ...(options.locale === undefined ? {} : { ui_locales: options.locale }),
  }).toString();
  sessionStorage.setItem(transactionKey, JSON.stringify(transaction));
  return { ...transaction, authorizationUrl: authorization.href };
}

export async function beginOAuthAuthorization(
  returnTo = "/",
  options: { readonly prompt?: "none"; readonly locale?: "en" | "pt-BR" | "es" } = {},
): Promise<void> {
  const transaction = await prepareOAuthAuthorization(returnTo, options);
  window.location.assign(transaction.authorizationUrl);
}

function readAndEraseTransaction(): OAuthTransaction {
  const serialized = sessionStorage.getItem(transactionKey);
  sessionStorage.removeItem(transactionKey);
  if (serialized === null) throw new Error("The OAuth authorization transaction is missing or expired.");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("The OAuth authorization transaction is invalid.");
  }
  if (typeof value !== "object" || value === null) throw new Error("The OAuth authorization transaction is invalid.");
  const candidate = value as Partial<OAuthTransaction>;
  if (
    typeof candidate.state !== "string" ||
    typeof candidate.verifier !== "string" ||
    typeof candidate.redirectUri !== "string" ||
    typeof candidate.returnTo !== "string" ||
    typeof candidate.createdAt !== "number" ||
    typeof candidate.silent !== "boolean" ||
    candidate.redirectUri !== redirectUri() ||
    Date.now() - candidate.createdAt > transactionLifetimeMs ||
    candidate.createdAt > Date.now() + 60_000
  ) {
    throw new Error("The OAuth authorization transaction is invalid or expired.");
  }
  return candidate as OAuthTransaction;
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const discovery = await discoverOAuth();
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    credentials: "omit",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body,
  });
  let value: Record<string, unknown> = {};
  try {
    value = await response.json() as Record<string, unknown>;
  } catch {
    // The public error remains generic when an OAuth endpoint returns non-JSON.
  }
  if (!response.ok) {
    const code = typeof value.error === "string" ? value.error : "token_request_failed";
    throw new Error(`OAuth token request failed (${code}).`);
  }
  return value;
}

function acceptTokenResponse(response: TokenResponse, previous: OAuthTokens | null): OAuthTokens {
  if (
    typeof response.access_token !== "string" ||
    response.access_token === "" ||
    typeof response.token_type !== "string" ||
    response.token_type.toLowerCase() !== "bearer" ||
    typeof response.expires_in !== "number" ||
    !Number.isFinite(response.expires_in) ||
    response.expires_in <= 0
  ) {
    throw new Error("OAuth token response is invalid.");
  }
  const next: OAuthTokens = {
    accessToken: response.access_token,
    refreshToken: typeof response.refresh_token === "string" && response.refresh_token !== "" ? response.refresh_token : previous?.refreshToken ?? null,
    idToken: typeof response.id_token === "string" && response.id_token !== "" ? response.id_token : previous?.idToken ?? null,
    accessExpiresAt: Date.now() + response.expires_in * 1_000,
  };
  publish(next);
  return next;
}

export async function completeOAuthAuthorization(search: string): Promise<string> {
  const transaction = readAndEraseTransaction();
  const parameters = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const returnedState = parameters.get("state");
  if (returnedState !== transaction.state) throw new Error("OAuth state validation failed.");
  const oauthError = parameters.get("error");
  if (oauthError !== null) {
    if (transaction.silent) {
      try {
        localStorage.removeItem(previousSignInStorageKey);
      } catch {
        // A blocked storage partition must never break sign-in recovery.
      }
      throw new OAuthSilentRecoveryError();
    }
    throw new Error(`OAuth authorization failed (${oauthError}).`);
  }
  const code = parameters.get("code");
  if (code === null || code === "") throw new Error("OAuth authorization code is missing.");
  const response = await tokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: oauthConstants.clientId,
    code,
    redirect_uri: transaction.redirectUri,
    code_verifier: transaction.verifier,
    resource: resource(),
  }));
  acceptTokenResponse(response, null);
  try {
    localStorage.setItem(previousSignInStorageKey, "true");
  } catch {
    // Tokens remain memory-only when browser storage is unavailable.
  }
  return transaction.returnTo;
}

export async function refreshOAuthAccessToken(rejectedAccessToken?: string): Promise<string> {
  if (tokens !== null && rejectedAccessToken !== undefined && tokens.accessToken !== rejectedAccessToken) {
    return getOAuthAccessToken();
  }
  if (refreshPromise !== null) return refreshPromise;
  const current = tokens;
  if (current?.refreshToken === null || current === null) {
    publish(null);
    throw new OAuthAuthenticationRequiredError();
  }
  const pending = (async () => {
    try {
      const response = await tokenRequest(new URLSearchParams({
        grant_type: "refresh_token",
        client_id: oauthConstants.clientId,
        refresh_token: current.refreshToken!,
        resource: resource(),
      }));
      if (tokens !== current) throw new OAuthAuthenticationRequiredError();
      return acceptTokenResponse(response, current).accessToken;
    } catch (error) {
      if (tokens === current) publish(null);
      throw error;
    }
  })().finally(() => {
    if (refreshPromise === pending) refreshPromise = null;
  });
  refreshPromise = pending;
  return pending;
}

export async function getOAuthAccessToken(): Promise<string> {
  if (tokens === null) throw new OAuthAuthenticationRequiredError();
  if (tokens.accessExpiresAt - refreshSkewMs > Date.now()) return tokens.accessToken;
  return refreshOAuthAccessToken();
}

async function revokeToken(endpoint: string, token: string, hint: "access_token" | "refresh_token"): Promise<void> {
  await fetch(endpoint, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ token, token_type_hint: hint, client_id: oauthConstants.clientId }),
  });
}

export function clearOAuthSession(): void {
  publish(null);
  refreshPromise = null;
  sessionStorage.removeItem(transactionKey);
}

export async function signOutOAuth(): Promise<void> {
  const current = tokens;
  clearOAuthSession();
  try {
    localStorage.removeItem(previousSignInStorageKey);
  } catch {
    // Local logout still clears the in-memory token state.
  }
  const login = `${origin()}/admin/login`;
  let discovery: OAuthDiscovery | null = null;
  try {
    discovery = await discoverOAuth();
    if (current !== null && discovery.revocation_endpoint !== undefined) {
      await Promise.allSettled([
        revokeToken(discovery.revocation_endpoint, current.accessToken, "access_token"),
        ...(current.refreshToken === null ? [] : [revokeToken(discovery.revocation_endpoint, current.refreshToken, "refresh_token")]),
      ]);
    }
  } catch {
    // Local logout still succeeds when discovery or revocation is unavailable.
  }
  if (discovery?.end_session_endpoint !== undefined && current?.idToken !== null && current !== null) {
    const endpoint = new URL(discovery.end_session_endpoint);
    endpoint.search = new URLSearchParams({
      id_token_hint: current.idToken,
      post_logout_redirect_uri: login,
      client_id: oauthConstants.clientId,
    }).toString();
    window.location.assign(endpoint.href);
    return;
  }
  window.location.assign(login);
}

/** Resets module state for isolated tests; production logout uses signOutOAuth. */
export function resetOAuthClient(): void {
  publish(null);
  discoveryPromise = null;
  refreshPromise = null;
  sessionStorage.removeItem(transactionKey);
  try {
    localStorage.removeItem(previousSignInStorageKey);
  } catch {
    // Test cleanup remains best-effort in restricted DOM environments.
  }
}
