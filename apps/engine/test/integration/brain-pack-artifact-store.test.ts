import { createHash, randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/database/migrate.js";
import { schema } from "../../src/database/schema/index.js";
import { accounts } from "../../src/database/schema/identity.js";
import { DrizzleBrainPackArtifactStore } from "../../src/database/stores/brain-pack-artifact-store.js";
import { BrainPackError, brainPackLimits } from "../../src/domain/brain-pack.js";
import { type DisposableTestDatabase, provisionTestDatabase } from "./support/database.js";

describe("Brain Pack artifact store", () => {
  let database: DisposableTestDatabase;
  let store: DrizzleBrainPackArtifactStore;
  const owner = randomUUID();

  beforeAll(async () => {
    database = await provisionTestDatabase("brain_pack_artifacts");
    await runMigrations(database.pool);
    const db = drizzle(database.pool, { schema });
    await db
      .insert(accounts)
      .values({
        id: owner,
        email: `${owner}@example.test`,
        passwordHash: "not-used-by-store-tests",
        role: "admin",
        status: "active",
      });
    store = new DrizzleBrainPackArtifactStore(db);
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  });

  it("stores bytes with a server-side hash and reads them back byte for byte", async () => {
    const bytes = new TextEncoder().encode("PK pretend archive with ção 🧠");
    const record = await store.put({
      kind: "upload",
      ownerAccountId: owner,
      bytes,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    expect(record.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(record.kind).toBe("upload");
    expect(record.ownerAccountId).toBe(owner);
    expect(record.byteSize).toBe(bytes.byteLength);
    expect(record.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(record.contentType).toBe("application/zip");
    expect(record.expiresAt).toBe("2099-01-01T00:00:00.000Z");

    expect(await store.head(record.id)).toEqual(record);
    const read = await store.read(record.id);
    expect(read?.record).toEqual(record);
    expect(Buffer.from(read!.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("rejects a claimed hash that does not match the bytes", async () => {
    await expect(
      store.put({
        kind: "upload",
        ownerAccountId: owner,
        bytes: new Uint8Array([1, 2, 3]),
        expiresAt: "2099-01-01T00:00:00.000Z",
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "PACK_INTEGRITY_FAILED" });
  });

  it("refuses empty and oversized artifacts", async () => {
    await expect(
      store.put({
        kind: "export",
        ownerAccountId: owner,
        bytes: new Uint8Array(0),
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(BrainPackError);
    await expect(
      store.put({
        kind: "export",
        ownerAccountId: owner,
        bytes: new Uint8Array(brainPackLimits.compressedBytes + 1),
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PACK_LIMIT_EXCEEDED" });
  });

  it("removes and expires artifacts independently", async () => {
    const stale = await store.put({
      kind: "export",
      ownerAccountId: owner,
      bytes: new Uint8Array([9]),
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    const fresh = await store.put({
      kind: "export",
      ownerAccountId: owner,
      bytes: new Uint8Array([8]),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    expect(await store.expire("2026-06-01T00:00:00.000Z")).toBe(1);
    expect(await store.head(stale.id)).toBeNull();
    expect(await store.head(fresh.id)).not.toBeNull();
    expect(await store.remove(fresh.id)).toBe(true);
    expect(await store.remove(fresh.id)).toBe(false);
    expect(await store.read(fresh.id)).toBeNull();
  });
});
