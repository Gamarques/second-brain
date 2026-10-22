import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  type SecondBrainDatabase,
} from "@second-brain/engine/database/client";
import { automationSettings } from "@second-brain/engine/database/schema/automation";
import { embeddingSpaces } from "@second-brain/engine/database/schema/embeddings";
import {
  BrainAccessDeniedError,
  DrizzleBrainAccessStore,
} from "@second-brain/engine/database/stores/access-store";
import {
  accounts,
  oauthArtifacts,
  oauthSettings,
} from "@second-brain/engine/database/schema/identity";
import { people, projects } from "@second-brain/engine/database/schema/content";
import {
  activityEvents,
  mutationReceipts,
} from "@second-brain/engine/database/schema/temporal";
import { DrizzlePersonStore } from "@second-brain/engine/database/stores/person-store";
import { DrizzleProjectStore } from "@second-brain/engine/database/stores/project-store";
import { DrizzleOidcAdapter } from "../../src/services/auth/postgres-adapter.js";
import { hashPassword } from "../../src/services/auth/password.js";
import { loadOrCreateOAuthSecrets } from "../../src/services/auth/secrets.js";
import {
  accountAttributionTables,
  OAuthUserStore,
} from "../../src/services/auth/user-store.js";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

async function runMigrations(database: DisposableTestDatabase): Promise<void> {
  const migrationModule = (await import("@second-brain/engine/database/migrate")) as {
    runMigrations?: (pool: DisposableTestDatabase["pool"]) => Promise<void>;
  };
  if (!migrationModule.runMigrations) {
    throw new Error("The database migrator must export runMigrations(pool).");
  }
  await migrationModule.runMigrations(database.pool);
}

async function createOwnerAccount(database: SecondBrainDatabase) {
  const email = `${randomUUID()}@example.com`;
  const passwordHash = await hashPassword("correct horse battery staple");
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .insert(accounts)
      .values({ email, passwordHash, role: "owner" })
      .returning({ id: accounts.id, email: accounts.email });
    if (account === undefined) throw new Error("Test account was not created.");
    // The singleton settings row may already exist from an earlier test.
    await transaction
      .insert(automationSettings)
      .values({ timeZone: "UTC" })
      .onConflictDoNothing({ target: automationSettings.id });
    return account;
  });
}

describe("Drizzle OAuth and brain access persistence", () => {
  let databaseResource: DisposableTestDatabase;
  let database: SecondBrainDatabase;

  beforeAll(async () => {
    databaseResource = await provisionTestDatabase("oauth_access");
    await runMigrations(databaseResource);
    database = createDatabase(databaseResource.pool);
  });

  afterAll(async () => {
    await databaseResource?.destroy();
  });

  it("bootstraps the owner account atomically", async () => {
    const store = new OAuthUserStore(database);
    const password = "correct horse battery staple";
    const embeddingIdentity = {
      provider: "test-provider",
      model: "test-model",
      modelRevision: "test-revision",
      dimensions: 1_536,
    } as const;
    const signal = new AbortController().signal;
    const created = await store.createBootstrapAccount(
      "First@Example.com",
      password,
      embeddingIdentity,
      signal,
    );
    expect(created).not.toHaveProperty("personalBrainId");

    await expect(
      store.authenticate("first@example.com", password),
    ).resolves.toEqual({
      id: created.id,
      email: "first@example.com",
    });
    const roles = await database
      .select({ role: accounts.role })
      .from(accounts)
      .where(eq(accounts.id, created.id));
    expect(roles).toEqual([{ role: "owner" }]);
    const settings = await database
      .select({ timeZone: automationSettings.timeZone })
      .from(automationSettings);
    expect(settings).toEqual([{ timeZone: "UTC" }]);
    const spaces = await database
      .select({
        entityType: embeddingSpaces.entityType,
        recipeVersion: embeddingSpaces.recipeVersion,
        status: embeddingSpaces.status,
      })
      .from(embeddingSpaces);
    expect(spaces).toHaveLength(3);
    expect(spaces).toEqual(
      expect.arrayContaining([
        { entityType: "memory", recipeVersion: "memory-v1", status: "active" },
        {
          entityType: "decision",
          recipeVersion: "decision-v1",
          status: "active",
        },
        {
          entityType: "knowledge_chunk",
          recipeVersion: "knowledge-chunk-v1",
          status: "active",
        },
      ]),
    );
    await expect(
      store.createBootstrapAccount(
        "first@example.com",
        password,
        embeddingIdentity,
        signal,
      ),
    ).resolves.toEqual(created);
    await database
      .update(automationSettings)
      .set({ timeZone: "America/Sao_Paulo" });
    await expect(
      store.createBootstrapAccount(
        "first@example.com",
        password,
        embeddingIdentity,
        signal,
      ),
    ).resolves.toEqual(created);
    await database.update(automationSettings).set({ timeZone: "UTC" });
    await expect(
      store.createBootstrapAccount(
        "second@example.com",
        password,
        embeddingIdentity,
        signal,
      ),
    ).rejects.toThrow("The bootstrap state does not match this request.");

    await expect(store.eraseAccount(created.id)).resolves.toBe(true);
    const bootstrapMarker = await database
      .select({ value: oauthSettings.value })
      .from(oauthSettings)
      .where(eq(oauthSettings.key, "account_bootstrap"));
    expect(bootstrapMarker).toEqual([]);
    await expect(
      store.authenticate("first@example.com", password),
    ).resolves.toBeNull();

    const replacement = await store.createBootstrapAccount(
      "replacement@example.com",
      password,
      embeddingIdentity,
      signal,
    );
    await expect(
      store.createBootstrapAccount(
        "replacement@example.com",
        password,
        embeddingIdentity,
        signal,
      ),
    ).resolves.toEqual(replacement);
    const replacementMarker = await database
      .select({ value: oauthSettings.value })
      .from(oauthSettings)
      .where(eq(oauthSettings.key, "account_bootstrap"));
    expect(replacementMarker).toEqual([
      {
        value: {
          version: 1,
          status: "complete",
          accountId: replacement.id,
        },
      },
    ]);
    expect(JSON.stringify(replacementMarker)).not.toContain(created.id);
  });

  it("keeps the account-erasure inventory synchronized with every actor table", async () => {
    const result = await databaseResource.pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'actor_account_id'
      ORDER BY table_name
    `);
    const inventory = accountAttributionTables
      .map((table) => getTableName(table))
      .sort();
    expect(inventory).toEqual(result.rows.map((row) => row.table_name));

    const incompletePairs = await databaseResource.pool.query<{
      table_name: string;
    }>(`
      SELECT account_columns.table_name
      FROM information_schema.columns AS account_columns
      LEFT JOIN information_schema.columns AS client_columns
        ON client_columns.table_schema = account_columns.table_schema
       AND client_columns.table_name = account_columns.table_name
       AND client_columns.column_name = 'actor_client_id'
      WHERE account_columns.table_schema = 'public'
        AND account_columns.column_name = 'actor_account_id'
        AND client_columns.column_name IS NULL
    `);
    expect(incompletePairs.rows).toEqual([]);
  });

  it("initializes one durable OAuth secret set under concurrent startup", async () => {
    const [first, second] = await Promise.all([
      loadOrCreateOAuthSecrets(database),
      loadOrCreateOAuthSecrets(database),
    ]);
    expect(first).toEqual(second);
    expect(first.cookieKeys).toHaveLength(2);
    expect(first.jwks.keys).toHaveLength(1);
  });

  it("preserves the oidc-provider adapter lifecycle and unique lookups", async () => {
    const adapter = new DrizzleOidcAdapter(database, "DeviceCode");
    await adapter.upsert(
      "device-1",
      { uid: "uid-1", userCode: "code-1", grantId: "grant-1", scope: "openid" },
      60,
    );
    await expect(adapter.find("device-1")).resolves.toMatchObject({
      scope: "openid",
    });
    await expect(adapter.findByUid("uid-1")).resolves.toMatchObject({
      userCode: "code-1",
    });
    await expect(adapter.findByUserCode("code-1")).resolves.toMatchObject({
      uid: "uid-1",
    });

    const concurrentConsumption = await Promise.allSettled([
      adapter.consume("device-1"),
      adapter.consume("device-1"),
    ]);
    expect(concurrentConsumption.map((result) => result.status).sort()).toEqual(
      ["fulfilled", "rejected"],
    );
    const consumedPayload = await adapter.find("device-1");
    expect(consumedPayload).toMatchObject({ consumed: expect.any(Number) });
    expect(consumedPayload!.consumed).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1_000),
    );
    await adapter.upsert("device-1", { uid: "uid-1", userCode: "code-1" }, 60);
    await expect(adapter.find("device-1")).resolves.not.toHaveProperty(
      "consumed",
    );
    await expect(
      adapter.upsert("device-2", { userCode: "code-1" }, 60),
    ).rejects.toThrow();

    await adapter.upsert("expired", {}, 0);
    await expect(adapter.find("expired")).resolves.toBeUndefined();
    await adapter.upsert("grant-linked", { grantId: "grant-to-revoke" }, 60);
    await adapter.revokeByGrantId("grant-to-revoke");
    await expect(adapter.find("grant-linked")).resolves.toBeUndefined();
    await adapter.destroy("device-1");
    await expect(adapter.find("device-1")).resolves.toBeUndefined();
  });

  it("resolves the account's stored role and revalidates it", async () => {
    const identity = await createOwnerAccount(database);
    const store = new DrizzleBrainAccessStore(database);
    const signal = new AbortController().signal;
    const access = await store.resolveAccess(
      {
        principal: {
          id: identity.id,
          attributes: { clientId: "oauth-client" },
        },
        requiredRole: "editor",
        source: "mcp_http",
        requestId: randomUUID(),
        correlationId: null,
      },
      signal,
    );
    expect(access).not.toHaveProperty("brainId");
    expect(access).toMatchObject({
      accountId: identity.id,
      role: "owner",
      actor: {
        kind: "oauth_client",
        accountId: identity.id,
        clientId: "oauth-client",
        source: "mcp_http",
      },
    });
    await expect(store.getTimeZone(access, signal)).resolves.toBe("UTC");

    await database
      .update(accounts)
      .set({ role: "viewer", updatedAt: new Date() })
      .where(eq(accounts.id, identity.id));
    await expect(
      store.revalidateAccess(access, "editor", signal),
    ).rejects.toBeInstanceOf(BrainAccessDeniedError);
    await expect(
      store.resolveAccess(
        {
          principal: { id: identity.id },
          requiredRole: "editor",
          source: "direct",
          requestId: randomUUID(),
          correlationId: null,
        },
        signal,
      ),
    ).rejects.toBeInstanceOf(BrainAccessDeniedError);
    await expect(
      store.resolveAccess(
        {
          principal: { id: identity.id },
          requiredRole: "viewer",
          source: "direct",
          requestId: randomUUID(),
          correlationId: null,
        },
        signal,
      ),
    ).resolves.toMatchObject({ role: "viewer" });

    // A disabled account has no reachable role left to resolve.
    await database
      .update(accounts)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(eq(accounts.id, identity.id));
    await expect(
      store.resolveAccess(
        {
          principal: { id: identity.id },
          requiredRole: "viewer",
          source: "direct",
          requestId: randomUUID(),
          correlationId: null,
        },
        signal,
      ),
    ).rejects.toBeInstanceOf(BrainAccessDeniedError);
  });

  it("erases the account and grant-linked artifacts while brain content survives", async () => {
    const identity = await createOwnerAccount(database);
    const creator = await createOwnerAccount(database);
    const creatorAccess = {
      accountId: creator.id,
      role: "owner",
      actor: {
        kind: "account",
        accountId: creator.id,
        clientId: null,
        source: "direct",
        requestId: randomUUID(),
        correlationId: null,
        causationId: null,
        dreamingRunId: null,
      },
    } as const;
    const erasedAccess = {
      accountId: identity.id,
      role: "owner",
      actor: {
        kind: "oauth_client",
        accountId: identity.id,
        clientId: "test-client",
        source: "mcp_http",
        requestId: identity.id,
        correlationId: "test-client",
        causationId: null,
        dreamingRunId: null,
      },
    } as const;
    const signal = new AbortController().signal;
    const projectStore = new DrizzleProjectStore(database);
    const personStore = new DrizzlePersonStore(database);
    const sharedProject = await projectStore.createProject(
      creatorAccess,
      {
        name: "Surviving attribution",
        description: null,
        idempotencyKey: "erase-project",
      },
      signal,
    );
    const sharedPerson = await personStore.createPerson(
      creatorAccess,
      {
        name: "Surviving person",
        aliases: [],
        notes: null,
        summary: null,
        tags: [],
        projectIds: [],
        knowledgeBaseIds: [],
        idempotencyKey: "erase-person",
      },
      signal,
    );
    await projectStore.updateProject(
      erasedAccess,
      sharedProject.id,
      {
        name: sharedProject.name,
        precondition: {
          expectedVersion: sharedProject.version,
          idempotencyKey: "erase-project-noop",
        },
      },
      signal,
    );
    await personStore.updatePerson(
      erasedAccess,
      sharedPerson.id,
      {
        name: sharedPerson.name,
        precondition: {
          expectedVersion: sharedPerson.version,
          idempotencyKey: "erase-person-noop",
        },
      },
      signal,
    );
    const preErasureEvents = await database
      .select({
        id: activityEvents.id,
        requestDigest: activityEvents.requestDigest,
        contentHash: activityEvents.contentHash,
        requestId: activityEvents.requestId,
        idempotencyKey: activityEvents.idempotencyKey,
      })
      .from(activityEvents)
      .where(eq(activityEvents.actorAccountId, identity.id));
    const preErasureReceipts = await database
      .select({
        id: mutationReceipts.id,
        requestDigest: mutationReceipts.requestDigest,
        idempotencyKey: mutationReceipts.idempotencyKey,
      })
      .from(mutationReceipts)
      .where(
        inArray(
          mutationReceipts.activityEventId,
          preErasureEvents.map((event) => event.id),
        ),
      );
    expect(preErasureEvents).toHaveLength(2);
    expect(preErasureReceipts).toHaveLength(2);

    const grantId = randomUUID();
    await new DrizzleOidcAdapter(database, "Grant").upsert(grantId, {
      accountId: identity.id,
      grantId,
      clientId: "test-client",
    });
    await new DrizzleOidcAdapter(database, "AccessToken").upsert(randomUUID(), {
      grantId,
      clientId: "test-client",
    });
    await new DrizzleOidcAdapter(database, "AccessToken").upsert("unrelated", {
      clientId: "other-client",
    });

    await expect(
      new OAuthUserStore(database).eraseAccount(identity.id),
    ).resolves.toBe(true);
    await expect(
      new OAuthUserStore(database).findAccount(identity.id),
    ).resolves.toBeNull();
    await expect(
      new OAuthUserStore(database).findAccount(creator.id),
    ).resolves.toEqual({ id: creator.id, email: creator.email });
    const remainingProject = await database
      .select({
        id: projects.id,
        accountId: projects.actorAccountId,
        clientId: projects.actorClientId,
      })
      .from(projects)
      .where(eq(projects.id, sharedProject.id));
    expect(remainingProject).toEqual([
      { id: sharedProject.id, accountId: null, clientId: null },
    ]);
    const remainingPerson = await database
      .select({
        id: people.id,
        accountId: people.actorAccountId,
        clientId: people.actorClientId,
      })
      .from(people)
      .where(eq(people.id, sharedPerson.id));
    expect(remainingPerson).toEqual([
      { id: sharedPerson.id, accountId: null, clientId: null },
    ]);
    const erasedEventIds = preErasureEvents.map((event) => event.id);
    const redactedEvents = await database
      .select({
        requestDigest: activityEvents.requestDigest,
        contentHash: activityEvents.contentHash,
        requestId: activityEvents.requestId,
        correlationId: activityEvents.correlationId,
        idempotencyKey: activityEvents.idempotencyKey,
        accountId: activityEvents.actorAccountId,
        clientId: activityEvents.actorClientId,
        redactedAt: activityEvents.redactedAt,
      })
      .from(activityEvents)
      .where(inArray(activityEvents.id, erasedEventIds));
    expect(redactedEvents).toHaveLength(2);
    for (const event of redactedEvents) {
      expect(event).toMatchObject({
        accountId: null,
        clientId: null,
        correlationId: null,
        redactedAt: expect.any(Date),
      });
      expect(event.requestId).toMatch(/^erased:/u);
      expect(preErasureEvents.map((row) => row.requestDigest)).not.toContain(
        event.requestDigest,
      );
      expect(preErasureEvents.map((row) => row.contentHash)).not.toContain(
        event.contentHash,
      );
      expect(preErasureEvents.map((row) => row.idempotencyKey)).not.toContain(
        event.idempotencyKey,
      );
    }
    const redactedReceipts = await database
      .select({
        requestDigest: mutationReceipts.requestDigest,
        idempotencyKey: mutationReceipts.idempotencyKey,
        result: mutationReceipts.result,
      })
      .from(mutationReceipts)
      .where(inArray(mutationReceipts.activityEventId, erasedEventIds));
    expect(redactedReceipts).toHaveLength(2);
    for (const receipt of redactedReceipts) {
      expect(preErasureReceipts.map((row) => row.requestDigest)).not.toContain(
        receipt.requestDigest,
      );
      expect(preErasureReceipts.map((row) => row.idempotencyKey)).not.toContain(
        receipt.idempotencyKey,
      );
    }
    const remainingArtifacts = await database
      .select({
        id: oauthArtifacts.id,
        accountId: oauthArtifacts.accountId,
        clientId: oauthArtifacts.clientId,
        payload: oauthArtifacts.payload,
      })
      .from(oauthArtifacts);
    expect(remainingArtifacts).toEqual([
      {
        id: "unrelated",
        accountId: null,
        clientId: "other-client",
        payload: { clientId: "other-client" },
      },
    ]);
    const survivingPersistence = JSON.stringify({
      remainingProject,
      remainingPerson,
      redactedEvents,
      redactedReceipts,
      remainingArtifacts,
    });
    expect(survivingPersistence).not.toContain(identity.id);
    expect(survivingPersistence).not.toContain("test-client");
    for (const table of accountAttributionTables) {
      const tableName = getTableName(table).replaceAll('"', '""');
      const residue = await databaseResource.pool.query(
        `SELECT 1 FROM "${tableName}" WHERE actor_account_id = $1 OR actor_client_id = $2 LIMIT 1`,
        [identity.id, "test-client"],
      );
      expect(residue.rows, tableName).toEqual([]);
    }
  });
});
