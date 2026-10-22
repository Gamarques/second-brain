import { and, countDistinct, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";

import type { SecondBrainDatabase } from "@second-brain/engine/database/client";
import { accounts, oauthArtifacts } from "@second-brain/engine/database/schema/identity";
import { EngineStartupError, type EnvironmentRecord } from "@second-brain/engine/env";
import {
  createJwtAccessTokenVerifier,
  type OAuthAccessTokenVerifier,
} from "@second-brain/engine/http-auth";
import {
  adminOAuthClientId,
  adminOAuthResource,
  adminOAuthScope,
} from "../auth/admin-client.js";
import { readOAuthServerConfiguration } from "../auth/server-config.js";

const liveAccountSchema = z.object({
  accountId: z.uuid(),
  email: z.email(),
  role: z.enum(["admin", "owner"]),
  connectedClientCount: z.number().int().nonnegative(),
});

export interface AdminOAuthConfiguration {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly resource: string;
  readonly clientId: typeof adminOAuthClientId;
  readonly scopes: readonly [typeof adminOAuthScope];
}

export interface AdminAccountStore {
  findAuthorizedAccount(
    accountId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly accountId: string;
    readonly email: string;
    readonly role: "admin" | "owner";
    readonly connectedClientCount: number;
  } | null>;
}

export interface ResolvedAdminSession {
  readonly accountId: string;
  readonly email: string;
  readonly role: "admin" | "owner";
  readonly connectedClientCount: number;
  readonly principal: { readonly id: string };
  readonly oauthClientId: typeof adminOAuthClientId;
  readonly scopes: readonly string[];
}

export class AdminSessionError extends Error {
  readonly code = "ADMIN_SESSION_DENIED";

  constructor(cause?: unknown) {
    super("Admin session was denied.", { cause });
    this.name = "AdminSessionError";
  }
}

function deny(cause?: unknown): never {
  throw new AdminSessionError(cause);
}

function internalJwksUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EngineStartupError(
      "INVOKTA_OAUTH_JWKS_URL must be an absolute URL.",
    );
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  const internalHttp =
    url.protocol === "http:" && (loopback || !url.hostname.includes("."));
  if (url.protocol !== "https:" && !internalHttp) {
    throw new EngineStartupError(
      "INVOKTA_OAUTH_JWKS_URL must use HTTPS except for loopback or an internal host.",
    );
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new EngineStartupError(
      "INVOKTA_OAUTH_JWKS_URL must not contain credentials, a query, or a fragment.",
    );
  }
  return url.href;
}

export function readAdminOAuthConfiguration(
  environment: EnvironmentRecord = process.env,
): AdminOAuthConfiguration {
  const server = readOAuthServerConfiguration(environment);
  return {
    issuer: server.issuer,
    jwksUrl: internalJwksUrl(
      environment.INVOKTA_OAUTH_JWKS_URL ?? `${server.issuer}/jwks`,
    ),
    resource: adminOAuthResource(server.issuer),
    clientId: adminOAuthClientId,
    scopes: [adminOAuthScope],
  };
}

function bearerToken(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (authorization === null) return null;
  return /^Bearer ([^\s,]+)$/iu.exec(authorization)?.[1] ?? null;
}

export class DrizzleAdminAccountStore implements AdminAccountStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async findAuthorizedAccount(
    accountId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly accountId: string;
    readonly email: string;
    readonly role: "admin" | "owner";
    readonly connectedClientCount: number;
  } | null> {
    signal.throwIfAborted();
    if (!z.uuid().safeParse(accountId).success) return null;
    const connectedClients = this.database
      .select({
        accountId: oauthArtifacts.accountId,
        connectedClientCount: countDistinct(oauthArtifacts.clientId).as("connected_client_count"),
      })
      .from(oauthArtifacts)
      .where(and(
        eq(oauthArtifacts.accountId, accountId),
        eq(oauthArtifacts.model, "Grant"),
        ne(oauthArtifacts.clientId, adminOAuthClientId),
        or(isNull(oauthArtifacts.expiresAt), gt(oauthArtifacts.expiresAt, new Date())),
      ))
      .groupBy(oauthArtifacts.accountId)
      .as("connected_clients");
    const rows = await this.database
      .select({
        accountId: accounts.id,
        email: accounts.email,
        role: accounts.role,
        connectedClientCount: connectedClients.connectedClientCount,
      })
      .from(accounts)
      .leftJoin(connectedClients, eq(connectedClients.accountId, accounts.id))
      .where(
        and(
          eq(accounts.id, accountId),
          eq(accounts.status, "active"),
          inArray(accounts.role, ["admin", "owner"]),
        ),
      )
      .limit(2);
    signal.throwIfAborted();
    if (rows.length !== 1) return null;
    const decoded = liveAccountSchema.safeParse({
      ...rows[0],
      connectedClientCount: rows[0]?.connectedClientCount ?? 0,
    });
    return decoded.success ? decoded.data : null;
  }
}

/** Validates one admin bearer token and rechecks live domain authorization. */
export async function resolveAdminSession(
  verifier: OAuthAccessTokenVerifier,
  accountsStore: AdminAccountStore,
  headers: Headers,
  signal: AbortSignal,
): Promise<ResolvedAdminSession> {
  signal.throwIfAborted();
  const token = bearerToken(headers);
  if (token === null) deny();

  let verified: Awaited<ReturnType<OAuthAccessTokenVerifier["verify"]>>;
  try {
    verified = await verifier.verify(token, signal);
  } catch (cause) {
    if (signal.aborted) signal.throwIfAborted();
    deny(cause);
  }
  signal.throwIfAborted();
  if (
    verified === null ||
    verified.subject === "" ||
    verified.clientId !== adminOAuthClientId ||
    !verified.scopes.includes(adminOAuthScope)
  ) {
    deny();
  }

  let account: Awaited<
    ReturnType<AdminAccountStore["findAuthorizedAccount"]>
  >;
  try {
    account = await accountsStore.findAuthorizedAccount(verified.subject, signal);
  } catch (cause) {
    if (signal.aborted) signal.throwIfAborted();
    deny(cause);
  }
  if (account === null || account.accountId !== verified.subject) deny();
  signal.throwIfAborted();
  return {
    accountId: account.accountId,
    email: account.email,
    role: account.role,
    connectedClientCount: account.connectedClientCount,
    principal: { id: account.accountId },
    oauthClientId: adminOAuthClientId,
    scopes: [...verified.scopes],
  };
}

export function createAdminOAuthSessionResolver(
  database: SecondBrainDatabase,
  configuration: AdminOAuthConfiguration,
) {
  const verifier = createJwtAccessTokenVerifier(configuration);
  const accountsStore = new DrizzleAdminAccountStore(database);
  return {
    resolve(headers: Headers, signal: AbortSignal) {
      return resolveAdminSession(verifier, accountsStore, headers, signal);
    },
  };
}
