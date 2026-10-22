import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { SecondBrainDatabase } from "@second-brain/engine/database/client";
import * as databaseSchema from "@second-brain/engine/database/schema/index";
import {
  DrizzleOidcAdapter,
  parseAdapterPayload,
} from "../src/services/auth/postgres-adapter.js";
import { parseOAuthSecrets } from "../src/services/auth/secrets.js";
import { accountAttributionTables } from "../src/services/auth/user-store.js";

function captureInserts(): {
  readonly database: SecondBrainDatabase;
  readonly rows: Record<string, unknown>[];
} {
  const rows: Record<string, unknown>[] = [];
  const database = {
    insert() {
      return {
        values(value: Record<string, unknown>) {
          rows.push(value);
          return { onConflictDoUpdate: async () => undefined };
        },
      };
    },
  } as unknown as SecondBrainDatabase;
  return { database, rows };
}

describe("OAuth persistence boundaries", () => {
  it("keeps erasure pseudonymization synchronized with every actor table", () => {
    const schemaActorTables = Object.values(databaseSchema)
      .flatMap((value) => {
        if (!is(value, PgTable)) return [];
        const table = value as PgTable;
        return "actorAccountId" in getTableColumns(table)
          ? [getTableName(table)]
          : [];
      })
      .sort();
    expect(accountAttributionTables.map(getTableName).sort()).toEqual(
      schemaActorTables,
    );
  });

  it("accepts a JSON OAuth artifact and rejects non-object or non-JSON values", () => {
    expect(
      parseAdapterPayload({ accountId: "account", scope: "openid" }),
    ).toEqual({
      accountId: "account",
      scope: "openid",
    });
    expect(() => parseAdapterPayload([])).toThrow(/payload is invalid/);
    expect(() => parseAdapterPayload({ callback: () => undefined })).toThrow(
      /payload is invalid/,
    );
    expect(() => parseAdapterPayload({ value: Number.NaN })).toThrow(
      /payload is invalid/,
    );
    expect(() => parseAdapterPayload({ value: "x".repeat(1_000_001) })).toThrow(
      /payload is invalid/,
    );
  });

  it("rejects invalid artifact lifetimes before persistence", async () => {
    const adapter = new DrizzleOidcAdapter(
      {} as SecondBrainDatabase,
      "AccessToken",
    );
    await expect(adapter.upsert("token", {}, -1)).rejects.toThrow(
      /lifetime is invalid/,
    );
    await expect(
      adapter.upsert("token", {}, Number.POSITIVE_INFINITY),
    ).rejects.toThrow(/lifetime is invalid/);
    await expect(
      adapter.upsert("token", { accountId: "legacy-account" }),
    ).rejects.toThrow(/identity metadata is invalid/);
    await expect(
      adapter.upsert("token", { clientId: "client-a", client_id: "client-b" }),
    ).rejects.toThrow(/lookup metadata is ambiguous/);
    await expect(
      adapter.upsert("token", { userCode: "x".repeat(10_001) }),
    ).rejects.toThrow(/lookup metadata is invalid/);
  });

  it("binds ownership only from trusted model-specific fields", async () => {
    const captured = captureInserts();
    const accountId = "00000000-0000-4000-8000-000000000001";
    const maliciousId = "00000000-0000-4000-8000-000000000002";
    await new DrizzleOidcAdapter(captured.database, "AccessToken").upsert(
      "trusted-token",
      {
        accountId,
        session: { accountId: maliciousId },
        extra: { brainId: maliciousId },
        brainId: maliciousId,
      },
    );
    await new DrizzleOidcAdapter(captured.database, "UnknownModel").upsert(
      "untrusted-token",
      { accountId: maliciousId, brainId: maliciousId },
    );

    expect(captured.rows).toEqual([
      expect.objectContaining({ accountId }),
      expect.objectContaining({ accountId: null }),
    ]);
    for (const row of captured.rows) {
      expect(row).not.toHaveProperty("brainId");
    }
    await expect(
      new DrizzleOidcAdapter(captured.database, "Interaction").upsert(
        "ambiguous-interaction",
        {
          session: { accountId },
          result: { login: { accountId: maliciousId } },
        },
      ),
    ).rejects.toThrow(/identity metadata is ambiguous/);
  });

  it("allows exactly one concurrent consumption winner", async () => {
    let consumed = false;
    const database = {
      update() {
        return {
          set() {
            return {
              where() {
                return {
                  async returning() {
                    await Promise.resolve();
                    if (consumed) return [];
                    consumed = true;
                    return [{ id: "one-time-code" }];
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as SecondBrainDatabase;
    const adapter = new DrizzleOidcAdapter(database, "AuthorizationCode");
    const results = await Promise.allSettled([
      adapter.consume("one-time-code"),
      adapter.consume("one-time-code"),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  it("requires complete private signing keys when decoding stored secrets", () => {
    const cookieKeys = ["a".repeat(32), "b".repeat(32)];
    expect(() =>
      parseOAuthSecrets([
        { key: "cookie_keys", value: cookieKeys },
        {
          key: "signing_jwks",
          value: {
            keys: [
              {
                kty: "EC",
                crv: "P-256",
                x: "x",
                y: "y",
                alg: "ES256",
                kid: "key",
                use: "sig",
              },
            ],
          },
        },
      ]),
    ).toThrow(/signing key store is invalid/);

    expect(
      parseOAuthSecrets([
        { key: "cookie_keys", value: cookieKeys },
        {
          key: "signing_jwks",
          value: {
            keys: [
              {
                kty: "EC",
                crv: "P-256",
                d: "private",
                x: "x",
                y: "y",
                alg: "ES256",
                kid: "key",
                use: "sig",
              },
            ],
          },
        },
      ]),
    ).toEqual({
      cookieKeys,
      jwks: {
        keys: [
          {
            kty: "EC",
            crv: "P-256",
            d: "private",
            x: "x",
            y: "y",
            alg: "ES256",
            kid: "key",
            use: "sig",
          },
        ],
      },
    });
  });
});
