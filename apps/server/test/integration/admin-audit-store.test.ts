import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "@second-brain/engine/database/migrate";
import {
  adminAuditActorAliases,
  adminAuditEvents,
} from "@second-brain/engine/database/schema/admin";
import { accounts } from "@second-brain/engine/database/schema/identity";
import { schema } from "@second-brain/engine/database/schema/index";
import { DrizzleAdminAuditStore } from "../../src/services/shared/audit-store.js";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import type { BrainAccessContext } from "@second-brain/engine/domain/core";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

describe("Drizzle admin audit store", () => {
  let database: DisposableTestDatabase;
  let orm: SecondBrainDatabase;
  let store: DrizzleAdminAuditStore;
  const adminAccountId = randomUUID();
  const viewerAccountId = randomUUID();

  function access(
    accountId: string,
    requestId: string,
    claimedRole: "viewer" | "admin" = "admin",
  ): BrainAccessContext {
    return {
      accountId,
      role: claimedRole,
      actor: {
        kind: "account",
        accountId,
        clientId: null,
        source: "direct",
        requestId,
        correlationId: null,
        causationId: null,
        dreamingRunId: null,
      },
    };
  }

  beforeAll(async () => {
    database = await provisionTestDatabase("admin_audit_store");
    await runMigrations(database.pool);
    orm = drizzle(database.pool, { schema });
    await orm.insert(accounts).values([
      {
        id: adminAccountId,
        email: `admin-audit-${adminAccountId}@example.test`,
        passwordHash: "not-used-by-store-tests",
        status: "active",
        role: "admin",
      },
      {
        id: viewerAccountId,
        email: `audit-viewer-${viewerAccountId}@example.test`,
        passwordHash: "not-used-by-store-tests",
        status: "active",
        role: "viewer",
      },
    ]);
    store = new DrizzleAdminAuditStore(orm);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it("persists changed names without values and returns bounded cursor pages", async () => {
    const first = await store.appendAuditEvent(
      access(adminAccountId, "audit-request-1"),
      {
        category: "administration",
        action: "environment_configuration.update",
        outcome: "succeeded",
        targetType: "environment_configuration",
        targetId: null,
        errorCode: null,
        changedNames: ["OPENROUTER_API_KEY", "DREAMING_ENABLED"],
      },
      new AbortController().signal,
    );
    await store.appendAuditEvent(
      access(adminAccountId, "audit-request-2"),
      {
        category: "authentication",
        action: "admin.session.created",
        outcome: "succeeded",
        targetType: "admin_session",
        targetId: null,
        errorCode: null,
        metadata: { method: "password" },
      },
      new AbortController().signal,
    );
    await store.appendAuditEvent(
      access(adminAccountId, "audit-request-3"),
      {
        category: "administration",
        action: "environment_configuration.update",
        outcome: "succeeded",
        targetType: "environment_configuration",
        targetId: null,
        errorCode: null,
        changedNames: ["DREAMING_MODE"],
      },
      new AbortController().signal,
    );

    const raw = await orm
      .select({
        metadata: adminAuditEvents.metadata,
        changedNames: adminAuditEvents.changedNames,
      })
      .from(adminAuditEvents)
      .where(eq(adminAuditEvents.id, first.id));
    expect(raw).toEqual([
      {
        metadata: {
          changedNames: ["DREAMING_ENABLED", "OPENROUTER_API_KEY"],
        },
        changedNames: ["DREAMING_ENABLED", "OPENROUTER_API_KEY"],
      },
    ]);
    expect(JSON.stringify(raw)).not.toContain("secret");

    const firstPage = await store.listAuditEvents(
      access(adminAccountId, "audit-list-1"),
      {
        category: "administration",
        action: null,
        outcome: "succeeded",
        actorAccountId: adminAccountId,
        targetType: "environment_configuration",
        from: null,
        to: null,
        cursor: null,
        limit: 1,
      },
      new AbortController().signal,
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await store.listAuditEvents(
      access(adminAccountId, "audit-list-2"),
      {
        category: "administration",
        action: null,
        outcome: "succeeded",
        actorAccountId: adminAccountId,
        targetType: "environment_configuration",
        from: null,
        to: null,
        cursor: firstPage.nextCursor,
        limit: 1,
      },
      new AbortController().signal,
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);
  });

  it("revalidates the live administrative role for reads and appends", async () => {
    const forged = access(viewerAccountId, "forged-admin", "admin");
    await expect(
      store.listAuditEvents(
        forged,
        {
          category: null,
          action: null,
          outcome: null,
          actorAccountId: null,
          targetType: null,
          from: null,
          to: null,
          cursor: null,
          limit: 10,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "BRAIN_ACCESS_DENIED" });
    await expect(
      store.appendAuditEvent(
        forged,
        {
          category: "administration",
          action: "environment_configuration.update",
          outcome: "succeeded",
          targetType: "environment_configuration",
          targetId: null,
          errorCode: null,
          changedNames: ["DREAMING_MODE"],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "BRAIN_ACCESS_DENIED" });
  });

  it("persists anonymous authentication denials without an actor alias", async () => {
    await store.recordOAuthSignInOutcome(
      {
        accountId: null,
        outcome: "denied",
        requestId: "anonymous-sign-in-request",
        errorCode: "OAUTH_CREDENTIALS_DENIED",
      },
      new AbortController().signal,
    );

    const rows = await orm
      .select({
        actorAliasId: adminAuditEvents.actorAliasId,
        actorRole: adminAuditEvents.actorRole,
        metadata: adminAuditEvents.metadata,
      })
      .from(adminAuditEvents)
      .where(eq(adminAuditEvents.requestId, "anonymous-sign-in-request"));
    expect(rows).toEqual([{ actorAliasId: null, actorRole: null, metadata: {} }]);

    const page = await store.listAuditEvents(
      access(adminAccountId, "anonymous-sign-in-list"),
      {
        category: "authentication",
        action: "authentication.oauth_sign_in",
        outcome: "denied",
        actorAccountId: null,
        targetType: "admin_session",
        from: null,
        to: null,
        cursor: null,
        limit: 10,
      },
      new AbortController().signal,
    );
    expect(page.items).toContainEqual(
      expect.objectContaining({
        actorAccountId: null,
        actorRole: null,
        requestId: "anonymous-sign-in-request",
      }),
    );
  });

  it("attributes successful admin OAuth sign-in through the erasable alias", async () => {
    await store.recordOAuthSignInOutcome(
      {
        accountId: adminAccountId,
        outcome: "succeeded",
        requestId: "admin-oauth-sign-in-success",
        errorCode: null,
      },
      new AbortController().signal,
    );

    const page = await store.listAuditEvents(
      access(adminAccountId, "admin-oauth-sign-in-list"),
      {
        category: "authentication",
        action: "authentication.oauth_sign_in",
        outcome: "succeeded",
        actorAccountId: adminAccountId,
        targetType: "admin_session",
        from: null,
        to: null,
        cursor: null,
        limit: 10,
      },
      new AbortController().signal,
    );
    expect(page.items).toContainEqual(
      expect.objectContaining({
        actorAccountId: adminAccountId,
        actorRole: "admin",
        requestId: "admin-oauth-sign-in-success",
      }),
    );
  });

  it("unlinks erased account identity without rewriting immutable events", async () => {
    const event = await store.appendAuditEvent(
      access(adminAccountId, "privacy-erasure-request"),
      {
        category: "administration",
        action: "environment_configuration.update",
        outcome: "succeeded",
        targetType: "environment_configuration",
        targetId: null,
        errorCode: null,
        changedNames: ["DREAMING_MODE"],
      },
      new AbortController().signal,
    );
    const aliasRows = await orm
      .select({ aliasId: adminAuditActorAliases.id })
      .from(adminAuditActorAliases)
      .where(eq(adminAuditActorAliases.accountId, adminAccountId));
    expect(aliasRows).toHaveLength(1);

    await orm
      .update(adminAuditActorAliases)
      .set({ accountId: null })
      .where(eq(adminAuditActorAliases.id, aliasRows[0]!.aliasId));

    const page = await store.listAuditEvents(
      access(adminAccountId, "privacy-erasure-list"),
      {
        category: "administration",
        action: "environment_configuration.update",
        outcome: "succeeded",
        actorAccountId: null,
        targetType: "environment_configuration",
        from: null,
        to: null,
        cursor: null,
        limit: 100,
      },
      new AbortController().signal,
    );
    expect(page.items).toContainEqual(
      expect.objectContaining({ id: event.id, actorAccountId: null }),
    );
    await expect(
      orm
        .update(adminAuditEvents)
        .set({ action: "privacy-rewrite" })
        .where(eq(adminAuditEvents.id, event.id)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/append.only|immutable/iu),
      }),
    });
  });

  it("rejects update and delete attempts at the persistence boundary", async () => {
    const event = await store.appendAuditEvent(
      access(adminAccountId, "append-only-request"),
      {
        category: "administration",
        action: "environment_configuration.update",
        outcome: "succeeded",
        targetType: "environment_configuration",
        targetId: null,
        errorCode: null,
        changedNames: ["DREAMING_ENABLED"],
      },
      new AbortController().signal,
    );

    await expect(
      orm
        .update(adminAuditEvents)
        .set({ action: "tampered" })
        .where(eq(adminAuditEvents.id, event.id)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/append.only|immutable/iu),
      }),
    });
    await expect(
      orm.delete(adminAuditEvents).where(eq(adminAuditEvents.id, event.id)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/append.only|immutable/iu),
      }),
    });
  });
});
