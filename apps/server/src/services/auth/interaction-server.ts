/** Login and consent interaction adapter owned by the OAuth service. */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Provider, UnknownObject } from "oidc-provider";

import type { OAuthUserStore } from "./user-store.js";

const maximumFormBytes = 16 * 1_024;

export interface OAuthInteractionLoginAuditEvent {
  readonly outcome: "succeeded" | "denied" | "failed";
  readonly accountId: string | null;
  readonly requestId: string;
  readonly errorCode: string | null;
}

export interface OAuthInteractionLoginAudit {
  readonly clientId: string;
  record(
    event: OAuthInteractionLoginAuditEvent,
    signal: AbortSignal,
  ): Promise<void>;
}

async function recordLoginAudit(
  audit: OAuthInteractionLoginAudit | undefined,
  event: OAuthInteractionLoginAuditEvent,
): Promise<void> {
  if (audit === undefined) return;
  try {
    await audit.record(event, AbortSignal.timeout(5_000));
  } catch {
    // The authentication result must not disclose or be replaced by audit failures.
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function oauthScopeLabel(scope: string): string {
  switch (scope) {
    case "openid":
      return "Verify who you are";
    case "offline_access":
      return "Stay connected after you close the app";
    case "admin:panel":
      return "Manage settings and content in this brain";
    case "mcp:tools":
      return "Use this brain’s tools and data";
    default:
      return scope;
  }
}

function csrfToken(key: string, uid: string): string {
  return createHmac("sha256", key).update(uid, "utf8").digest("base64url");
}

function validCsrf(key: string, uid: string, received: string | null): boolean {
  if (received === null) return false;
  const expected = Buffer.from(csrfToken(key, uid), "utf8");
  const candidate = Buffer.from(received, "utf8");
  return (
    expected.length === candidate.length && timingSafeEqual(expected, candidate)
  );
}

function safeFormActionSource(redirectUri: string | null | undefined): string | null {
  if (redirectUri === null || redirectUri === undefined) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol === "https:") return "https:";
  if (url.protocol === "http:" && loopback) return url.origin;
  return null;
}

export function interactionContentSecurityPolicy(
  redirectUri?: string | null,
): string {
  const redirectSource = safeFormActionSource(redirectUri);
  const formAction =
    redirectSource === null ? "'self'" : `'self' ${redirectSource}`;
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;
}

function securityHeaders(
  response: ServerResponse,
  redirectUri?: string | null,
): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    interactionContentSecurityPolicy(redirectUri),
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendHtml(
  response: ServerResponse,
  status: number,
  title: string,
  body: string,
  redirectUri?: string | null,
): void {
  securityHeaders(response, redirectUri);
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f7f6; --panel: #ffffff; --line: #e3e3df;
      --text: #1d1d1b; --muted: #6e6e68; --accent: #242421; --accent-text: #ffffff; --bad: #b42318;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #101110; --panel: #171817; --line: #2d2f2c;
        --text: #f1f2ef; --muted: #a0a39d; --accent: #f1f2ef; --accent-text: #171817; --bad: #ff8a80;
      }
    }
    * { box-sizing: border-box; }
    body {
      max-width: 30rem; margin: 8vh auto; padding: 1.25rem;
      background: var(--bg); color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; line-height: 1.55;
    }
    .brand { display: flex; align-items: center; justify-content: center; gap: .65rem; margin-bottom: 1.25rem; font-size: .9rem; font-weight: 650; }
    .brand-mark { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: .65rem; background: var(--accent); color: var(--accent-text); }
    .panel { border: 1px solid var(--line); border-radius: 14px; background: var(--panel); padding: 1.35rem 1.4rem 1.5rem; box-shadow: 0 10px 30px rgb(0 0 0 / .06); }
    h1 { font-size: 1.28rem; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 .5rem; }
    p { margin: .55rem 0; }
    label {
      display: grid; gap: .35rem; margin: 1rem 0;
      font-size: .82rem; font-weight: 600; color: var(--muted);
    }
    input {
      font: inherit; font-size: .95rem; padding: .7rem .75rem; width: 100%;
      background: var(--panel); color: var(--text);
      border: 1px solid var(--line); border-radius: 8px;
    }
    input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 22%, transparent); border-color: var(--accent); }
    button {
      font: inherit; font-size: .9rem; font-weight: 650;
      padding: .7rem 1.05rem; width: 100%; margin-top: 1rem;
      background: var(--accent); color: var(--accent-text);
      border: 1px solid transparent; border-radius: 8px; cursor: pointer;
    }
    button:hover { opacity: .9; }
    button.secondary { background: transparent; color: var(--text); border-color: var(--line); }
    button.secondary:hover { border-color: var(--muted); opacity: 1; }
    .actions { display: flex; gap: .75rem; margin-top: 1.25rem; }
    .actions button { margin-top: 0; }
    .error { color: var(--bad); font-size: .88rem; }
    ul { padding-left: 1.2rem; }
    code { overflow-wrap: anywhere; font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
<div class="brand"><span class="brand-mark" aria-hidden="true">S</span><span>Second Brain</span></div>
<main class="panel">${body}</main>
</body>
</html>`);
}

function loginPage(
  response: ServerResponse,
  options: {
    readonly uid: string;
    readonly csrf: string;
    readonly clientName: string;
    readonly error?: string;
  },
): void {
  sendHtml(
    response,
    200,
    "Sign in",
    `<h1>Sign in</h1>
<p>Continue to <strong>${escapeHtml(options.clientName)}</strong>.</p>
${options.error === undefined ? "" : `<p class="error">${escapeHtml(options.error)}</p>`}
<form method="post" action="/interaction/${encodeURIComponent(options.uid)}/login">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <label>Email<input name="email" type="email" autocomplete="username" required></label>
  <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
</form>`,
  );
}

function consentPage(
  response: ServerResponse,
  options: {
    readonly uid: string;
    readonly csrf: string;
    readonly clientName: string;
    readonly scopes: readonly string[];
    readonly redirectUri: string | null;
  },
): void {
  const scopes = options.scopes
    .map((scope) => `<li>${escapeHtml(oauthScopeLabel(scope))}</li>`)
    .join("");
  sendHtml(
    response,
    200,
    "Authorize",
    `<h1>Authorize ${escapeHtml(options.clientName)}</h1>
<p>This client is requesting access to your second brain:</p>
<ul>${scopes}</ul>
<form method="post" action="/interaction/${encodeURIComponent(options.uid)}/consent">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <div class="actions">
    <button class="secondary" name="decision" value="deny" type="submit">Deny</button>
    <button name="decision" value="approve" type="submit">Authorize</button>
  </div>
</form>`,
    options.redirectUri,
  );
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0];
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new Error("Unsupported interaction form content type.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumFormBytes) {
      throw new Error("The interaction form is too large.");
    }
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requestedScopes(details: UnknownObject): readonly string[] {
  const values = new Set<string>();
  for (const name of ["missingOIDCScope", "missingOIDCClaims"]) {
    const items = details[name];
    if (Array.isArray(items)) {
      for (const item of items) if (typeof item === "string") values.add(item);
    }
  }
  const resources = details.missingResourceScopes;
  if (typeof resources === "object" && resources !== null) {
    for (const scopes of Object.values(resources)) {
      if (Array.isArray(scopes)) {
        for (const scope of scopes) {
          if (typeof scope === "string") values.add(scope);
        }
      }
    }
  }
  return [...values];
}

async function clientName(
  provider: Provider,
  parameters: UnknownObject,
): Promise<string> {
  const clientId = stringValue(parameters.client_id);
  if (clientId === null) return "MCP client";
  const client = await provider.Client.find(clientId);
  return client?.clientName ?? clientId;
}

export function createInteractionHandler(options: {
  readonly provider: Provider;
  readonly users: OAuthUserStore;
  readonly csrfKey: string;
  readonly loginAudit?: OAuthInteractionLoginAudit;
}) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<boolean> => {
    const match = /^\/interaction\/([^/]+)(?:\/(login|consent))?$/.exec(path);
    if (match === null) return false;
    const uid = decodeURIComponent(match[1]!);
    const action = match[2];
    const details = await options.provider.interactionDetails(request, response);
    if (details.uid !== uid) {
      response.statusCode = 400;
      response.end("Invalid interaction.");
      return true;
    }
    const csrf = csrfToken(options.csrfKey, uid);
    const name = await clientName(options.provider, details.params);
    const loginAudit =
      action === "login" &&
      details.prompt.name === "login" &&
      stringValue(details.params.client_id) === options.loginAudit?.clientId
        ? options.loginAudit
        : undefined;
    const loginAuditRequestId = loginAudit === undefined ? null : randomUUID();

    if (request.method === "GET" && action === undefined) {
      if (details.prompt.name === "login") {
        loginPage(response, { uid, csrf, clientName: name });
      } else if (details.prompt.name === "consent") {
        consentPage(response, {
          uid,
          csrf,
          clientName: name,
          scopes: requestedScopes(details.prompt.details),
          redirectUri: stringValue(details.params.redirect_uri),
        });
      } else {
        response.statusCode = 400;
        response.end("Unsupported interaction prompt.");
      }
      return true;
    }

    if (request.method !== "POST") {
      response.statusCode = 405;
      response.setHeader("allow", "GET, POST");
      response.end();
      return true;
    }
    let form: URLSearchParams;
    try {
      form = await readForm(request);
    } catch (error) {
      if (loginAuditRequestId !== null) {
        await recordLoginAudit(loginAudit, {
          outcome: "failed",
          accountId: null,
          requestId: loginAuditRequestId,
          errorCode: "OAUTH_INTERACTION_REQUEST_INVALID",
        });
      }
      throw error;
    }
    if (!validCsrf(options.csrfKey, uid, form.get("csrf"))) {
      if (loginAuditRequestId !== null) {
        await recordLoginAudit(loginAudit, {
          outcome: "denied",
          accountId: null,
          requestId: loginAuditRequestId,
          errorCode: "OAUTH_INTERACTION_CSRF_DENIED",
        });
      }
      response.statusCode = 403;
      response.end("Invalid interaction token.");
      return true;
    }

    if (action === "login" && details.prompt.name === "login") {
      let account: Awaited<ReturnType<OAuthUserStore["authenticate"]>>;
      try {
        account = await options.users.authenticate(
          form.get("email") ?? "",
          form.get("password") ?? "",
        );
      } catch (error) {
        if (loginAuditRequestId !== null) {
          await recordLoginAudit(loginAudit, {
            outcome: "failed",
            accountId: null,
            requestId: loginAuditRequestId,
            errorCode: "OAUTH_AUTHENTICATION_FAILED",
          });
        }
        throw error;
      }
      if (account === null) {
        if (loginAuditRequestId !== null) {
          await recordLoginAudit(loginAudit, {
            outcome: "denied",
            accountId: null,
            requestId: loginAuditRequestId,
            errorCode: "OAUTH_CREDENTIALS_DENIED",
          });
        }
        loginPage(response, {
          uid,
          csrf,
          clientName: name,
          error: "The email or password is invalid.",
        });
        return true;
      }
      try {
        await options.provider.interactionFinished(
          request,
          response,
          {
            login: {
              accountId: account.id,
              amr: ["pwd"],
              remember: true,
            },
          },
          { mergeWithLastSubmission: false },
        );
      } catch (error) {
        if (loginAuditRequestId !== null) {
          await recordLoginAudit(loginAudit, {
            outcome: "failed",
            accountId: account.id,
            requestId: loginAuditRequestId,
            errorCode: "OAUTH_INTERACTION_FAILED",
          });
        }
        throw error;
      }
      if (loginAuditRequestId !== null) {
        await recordLoginAudit(loginAudit, {
          outcome: "succeeded",
          accountId: account.id,
          requestId: loginAuditRequestId,
          errorCode: null,
        });
      }
      return true;
    }

    if (action === "consent" && details.prompt.name === "consent") {
      if (form.get("decision") !== "approve") {
        await options.provider.interactionFinished(
          request,
          response,
          { error: "access_denied", error_description: "Authorization denied." },
          { mergeWithLastSubmission: false },
        );
        return true;
      }
      const accountId = details.session?.accountId;
      const clientId = stringValue(details.params.client_id);
      if (accountId === undefined || clientId === null) {
        throw new Error("The consent interaction is incomplete.");
      }
      let grant =
        details.grantId === undefined
          ? undefined
          : await options.provider.Grant.find(details.grantId);
      grant ??= new options.provider.Grant({ accountId, clientId });
      const missingOidcScope = details.prompt.details.missingOIDCScope;
      if (Array.isArray(missingOidcScope)) {
        grant.addOIDCScope(
          missingOidcScope.filter((value): value is string => typeof value === "string"),
        );
      }
      const missingOidcClaims = details.prompt.details.missingOIDCClaims;
      if (Array.isArray(missingOidcClaims)) {
        grant.addOIDCClaims(
          missingOidcClaims.filter((value): value is string => typeof value === "string"),
        );
      }
      const missingResources = details.prompt.details.missingResourceScopes;
      if (typeof missingResources === "object" && missingResources !== null) {
        for (const [resource, scopes] of Object.entries(missingResources)) {
          if (Array.isArray(scopes)) {
            grant.addResourceScope(
              resource,
              scopes.filter((value): value is string => typeof value === "string"),
            );
          }
        }
      }
      const grantId = await grant.save();
      await options.provider.interactionFinished(
        request,
        response,
        { consent: details.grantId === undefined ? { grantId } : {} },
        { mergeWithLastSubmission: true },
      );
      return true;
    }

    response.statusCode = 400;
    response.end("Invalid interaction action.");
    return true;
  };
}
