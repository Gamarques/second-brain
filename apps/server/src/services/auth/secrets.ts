import { randomBytes, randomUUID } from "node:crypto";

import { inArray, sql } from "drizzle-orm";
import { exportJWK, generateKeyPair, type JWK } from "jose";

import type { SecondBrainDatabase } from "@second-brain/engine/database/client";
import { oauthSettings } from "@second-brain/engine/database/schema/identity";

const cookieKeysSetting = "cookie_keys";
const signingKeysSetting = "signing_jwks";
const advisoryLockId = 7_412_026;

export interface OAuthSecrets {
  readonly cookieKeys: readonly string[];
  readonly jwks: { readonly keys: readonly JWK[] };
}

interface SettingRow {
  readonly key: string;
  readonly value: unknown;
}

async function createSigningJwks(): Promise<{ readonly keys: readonly JWK[] }> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const key = await exportJWK(privateKey);
  return {
    keys: [{ ...key, alg: "ES256", kid: randomUUID(), use: "sig" }],
  };
}

function validSigningKey(value: unknown): value is JWK {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.kty === "EC" &&
    record.crv === "P-256" &&
    typeof record.d === "string" &&
    record.d.length > 0 &&
    record.d.length <= 1_000 &&
    typeof record.x === "string" &&
    record.x.length > 0 &&
    record.x.length <= 1_000 &&
    typeof record.y === "string" &&
    record.y.length > 0 &&
    record.y.length <= 1_000 &&
    record.alg === "ES256" &&
    typeof record.kid === "string" &&
    record.kid.length > 0 &&
    record.kid.length <= 500 &&
    record.use === "sig"
  );
}

export function parseOAuthSecrets(rows: readonly SettingRow[]): OAuthSecrets {
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const cookieKeys = values.get(cookieKeysSetting);
  const jwks = values.get(signingKeysSetting);
  if (
    !Array.isArray(cookieKeys) ||
    cookieKeys.length !== 2 ||
    cookieKeys.some(
      (value) =>
        typeof value !== "string" || value.length < 32 || value.length > 512,
    )
  ) {
    throw new Error("The OAuth cookie key store is invalid.");
  }
  if (
    typeof jwks !== "object" ||
    jwks === null ||
    Array.isArray(jwks) ||
    !("keys" in jwks) ||
    !Array.isArray(jwks.keys) ||
    jwks.keys.length === 0 ||
    jwks.keys.length > 10 ||
    !jwks.keys.every(validSigningKey)
  ) {
    throw new Error("The OAuth signing key store is invalid.");
  }
  return {
    cookieKeys,
    jwks: { keys: jwks.keys },
  };
}

export async function loadOrCreateOAuthSecrets(
  database: SecondBrainDatabase,
): Promise<OAuthSecrets> {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${advisoryLockId})`,
    );
    const candidateCookieKeys = [
      randomBytes(32).toString("base64url"),
      randomBytes(32).toString("base64url"),
    ];
    const candidateJwks = await createSigningJwks();
    await transaction
      .insert(oauthSettings)
      .values([
        { key: cookieKeysSetting, value: candidateCookieKeys },
        { key: signingKeysSetting, value: candidateJwks },
      ])
      .onConflictDoNothing({ target: oauthSettings.key });
    const rows = await transaction
      .select({ key: oauthSettings.key, value: oauthSettings.value })
      .from(oauthSettings)
      .where(
        inArray(oauthSettings.key, [cookieKeysSetting, signingKeysSetting]),
      );
    return parseOAuthSecrets(rows);
  });
}
