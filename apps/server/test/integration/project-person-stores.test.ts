import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "@second-brain/engine/database/migrate";
import { DrizzlePersonStore } from "@second-brain/engine/database/stores/person-store";
import { DrizzleProjectStore } from "@second-brain/engine/database/stores/project-store";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import {
  accounts,
  activityEvents,
  mutationReceipts,
  people,
  projects,
  schema,
} from "@second-brain/engine/database/schema/index";
import type { BrainAccessContext } from "@second-brain/engine/domain";
import { OAuthUserStore } from "../../src/services/auth/user-store.js";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

describe("Drizzle project and person stores", () => {
  let database: DisposableTestDatabase;
  let orm: SecondBrainDatabase;
  let projectStore: DrizzleProjectStore;
  let personStore: DrizzlePersonStore;
  const accountId = randomUUID();

  function access(requestId = randomUUID()): BrainAccessContext {
    return {
      accountId,
      role: "editor",
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

  function oauthAccess(clientId = "integration-client"): BrainAccessContext {
    return {
      accountId,
      role: "editor",
      actor: {
        kind: "oauth_client",
        accountId,
        clientId,
        source: "mcp_http",
        requestId: randomUUID(),
        correlationId: null,
        causationId: null,
        dreamingRunId: null,
      },
    };
  }

  beforeAll(async () => {
    database = await provisionTestDatabase("entity_stores");
    await runMigrations(database.pool);
    orm = drizzle(database.pool, { schema });
    await orm.insert(accounts).values({
      id: accountId,
      email: `entity-stores-${accountId}@example.test`,
      passwordHash: "not-used-by-store-tests",
      status: "active",
      role: "editor",
    });
    projectStore = new DrizzleProjectStore(orm);
    personStore = new DrizzlePersonStore(orm);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it("keeps creation, replay receipts, provenance, and reads", async () => {
    const primaryProject = await projectStore.createProject(
      access(),
      {
        name: "Launch",
        description: "Primary",
        idempotencyKey: "project-launch",
      },
      new AbortController().signal,
    );
    const replay = await projectStore.createProject(
      oauthAccess("project-create-replay-client"),
      {
        name: "Launch",
        description: "Primary",
        idempotencyKey: "project-launch",
      },
      new AbortController().signal,
    );

    expect(replay).toEqual(primaryProject);
    expect(primaryProject).toMatchObject({
      version: 1,
      provenance: { kind: "account", accountId, source: "direct" },
    });
    await expect(
      projectStore.createProject(
        access(),
        {
          name: "Different",
          description: null,
          idempotencyKey: "project-launch",
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const primaryPage = await projectStore.listProjects(
      access(),
      { status: null, cursor: null, limit: 100 },
      new AbortController().signal,
    );
    expect(primaryPage.items.map((project) => project.id)).toContain(
      primaryProject.id,
    );
    await expect(
      projectStore.findProjectByName(
        access(),
        "launch",
        new AbortController().signal,
      ),
    ).resolves.toEqual(primaryProject);
  });

  it("updates with optimistic concurrency and replays the exact original result", async () => {
    const project = await projectStore.createProject(
      access(),
      {
        name: "Versioned project",
        description: null,
        idempotencyKey: "project-versioned",
      },
      new AbortController().signal,
    );
    const versionTwo = await projectStore.updateProject(
      oauthAccess("project-version-two-client"),
      project.id,
      {
        description: "Version two",
        precondition: {
          expectedVersion: 1,
          idempotencyKey: "project-update-v2",
        },
      },
      new AbortController().signal,
    );
    const versionThree = await projectStore.updateProject(
      access(),
      project.id,
      {
        status: "paused",
        precondition: {
          expectedVersion: 2,
          idempotencyKey: "project-update-v3",
        },
      },
      new AbortController().signal,
    );
    const replay = await projectStore.updateProject(
      oauthAccess("project-version-two-replay-client"),
      project.id,
      {
        description: "Version two",
        precondition: {
          expectedVersion: 1,
          idempotencyKey: "project-update-v2",
        },
      },
      new AbortController().signal,
    );

    expect(versionTwo).toMatchObject({
      version: 2,
      description: "Version two",
    });
    expect(versionTwo).toMatchObject({
      provenance: {
        kind: "oauth_client",
        clientId: "project-version-two-client",
      },
    });
    expect(versionThree).toMatchObject({ version: 3, status: "paused" });
    expect(replay).toEqual(versionTwo);
    const projectEventsBeforeNoop = await orm
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(eq(activityEvents.entityId, project.id));
    const noOp = await projectStore.updateProject(
      oauthAccess("project-noop-client"),
      project.id,
      {
        status: "paused",
        precondition: { expectedVersion: 3, idempotencyKey: "project-noop-v3" },
      },
      new AbortController().signal,
    );
    const noOpReplay = await projectStore.updateProject(
      oauthAccess("project-noop-replay-client"),
      project.id,
      {
        status: "paused",
        precondition: { expectedVersion: 3, idempotencyKey: "project-noop-v3" },
      },
      new AbortController().signal,
    );
    const projectEventsAfterNoop = await orm
      .select({
        id: activityEvents.id,
        changedFields: activityEvents.changedFields,
        clientId: activityEvents.actorClientId,
      })
      .from(activityEvents)
      .where(eq(activityEvents.entityId, project.id));
    expect(noOp).toMatchObject({
      id: project.id,
      version: 3,
      status: "paused",
      provenance: { kind: "oauth_client", clientId: "project-noop-client" },
    });
    expect(noOpReplay).toEqual(noOp);
    expect(projectEventsAfterNoop).toHaveLength(
      projectEventsBeforeNoop.length + 1,
    );
    expect(
      projectEventsAfterNoop.find(
        (event) =>
          !projectEventsBeforeNoop.some((prior) => prior.id === event.id),
      ),
    ).toMatchObject({ changedFields: [], clientId: "project-noop-client" });

    const outcomes = await Promise.allSettled([
      projectStore.updateProject(
        access(),
        project.id,
        {
          status: "completed",
          precondition: {
            expectedVersion: 3,
            idempotencyKey: "project-race-a",
          },
        },
        new AbortController().signal,
      ),
      projectStore.updateProject(
        access(),
        project.id,
        {
          status: "archived",
          precondition: {
            expectedVersion: 3,
            idempotencyKey: "project-race-b",
          },
        },
        new AbortController().signal,
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    const fulfilled = outcomes.find(
      (outcome) => outcome.status === "fulfilled",
    );
    expect(fulfilled?.value).toMatchObject({ version: 4 });
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.reason).toMatchObject({
      code: "PROJECT_VERSION_CONFLICT",
    });
  });

  it("supports people alias search, stable pagination, replay, and ambiguity detection", async () => {
    const ada = await personStore.createPerson(
      access(),
      {
        name: "Ada Lovelace",
        aliases: ["Enchantress of Numbers"],
        notes: null,
        summary: null,
        tags: [],
        projectIds: [],
        knowledgeBaseIds: [],
        idempotencyKey: "person-ada",
      },
      new AbortController().signal,
    );
    const replay = await personStore.createPerson(
      oauthAccess("person-create-replay-client"),
      {
        name: "Ada Lovelace",
        aliases: ["Enchantress of Numbers"],
        notes: null,
        summary: null,
        tags: [],
        projectIds: [],
        knowledgeBaseIds: [],
        idempotencyKey: "person-ada",
      },
      new AbortController().signal,
    );
    await personStore.createPerson(
      access(),
      {
        name: "Grace Hopper",
        aliases: ["Amazing Grace"],
        notes: null,
        summary: null,
        tags: [],
        projectIds: [],
        knowledgeBaseIds: [],
        idempotencyKey: "person-grace",
      },
      new AbortController().signal,
    );
    expect(replay).toEqual(ada);
    const adaVersionTwo = await personStore.updatePerson(
      oauthAccess("person-version-two-client"),
      ada.id,
      {
        notes: "Version two notes",
        precondition: { expectedVersion: 1, idempotencyKey: "person-ada-v2" },
      },
      new AbortController().signal,
    );
    const adaVersionThree = await personStore.updatePerson(
      access(),
      ada.id,
      {
        notes: "Version three notes",
        precondition: { expectedVersion: 2, idempotencyKey: "person-ada-v3" },
      },
      new AbortController().signal,
    );
    const adaVersionTwoReplay = await personStore.updatePerson(
      oauthAccess("person-version-two-replay-client"),
      ada.id,
      {
        notes: "Version two notes",
        precondition: { expectedVersion: 1, idempotencyKey: "person-ada-v2" },
      },
      new AbortController().signal,
    );
    expect(adaVersionTwo).toMatchObject({
      version: 2,
      provenance: {
        kind: "oauth_client",
        clientId: "person-version-two-client",
      },
    });
    expect(adaVersionTwoReplay).toEqual(adaVersionTwo);
    const personEventsBeforeNoop = await orm
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(eq(activityEvents.entityId, ada.id));
    const adaNoOp = await personStore.updatePerson(
      oauthAccess("person-noop-client"),
      ada.id,
      {
        notes: "Version three notes",
        precondition: {
          expectedVersion: 3,
          idempotencyKey: "person-ada-noop-v3",
        },
      },
      new AbortController().signal,
    );
    const adaNoOpReplay = await personStore.updatePerson(
      oauthAccess("person-noop-replay-client"),
      ada.id,
      {
        notes: "Version three notes",
        precondition: {
          expectedVersion: 3,
          idempotencyKey: "person-ada-noop-v3",
        },
      },
      new AbortController().signal,
    );
    const personEventsAfterNoop = await orm
      .select({
        id: activityEvents.id,
        changedFields: activityEvents.changedFields,
        clientId: activityEvents.actorClientId,
      })
      .from(activityEvents)
      .where(eq(activityEvents.entityId, ada.id));
    expect(adaNoOp).toMatchObject({
      id: ada.id,
      version: 3,
      notes: "Version three notes",
      provenance: { kind: "oauth_client", clientId: "person-noop-client" },
    });
    expect(adaNoOpReplay).toEqual(adaNoOp);
    expect(personEventsAfterNoop).toHaveLength(
      personEventsBeforeNoop.length + 1,
    );
    expect(
      personEventsAfterNoop.find(
        (event) =>
          !personEventsBeforeNoop.some((prior) => prior.id === event.id),
      ),
    ).toMatchObject({ changedFields: [], clientId: "person-noop-client" });

    const aliasPage = await personStore.listPeople(
      access(),
      { query: "numbers", cursor: null, limit: 10 },
      new AbortController().signal,
    );
    expect(aliasPage.items.map((person) => person.id)).toEqual([ada.id]);
    await expect(
      personStore.findPersonByName(
        access(),
        "ENCHANTRESS OF NUMBERS",
        new AbortController().signal,
      ),
    ).resolves.toEqual(adaNoOp);

    const firstPage = await personStore.listPeople(
      access(),
      { query: null, cursor: null, limit: 1 },
      new AbortController().signal,
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await personStore.listPeople(
      access(),
      { query: null, cursor: firstPage.nextCursor, limit: 100 },
      new AbortController().signal,
    );
    expect(
      secondPage.items.some((person) => person.id === firstPage.items[0]!.id),
    ).toBe(false);

    await personStore.createPerson(
      access(),
      {
        name: "Alias collision one",
        aliases: ["Shared alias"],
        notes: null,
        summary: null,
        tags: [],
        projectIds: [],
        knowledgeBaseIds: [],
        idempotencyKey: "person-alias-one",
      },
      new AbortController().signal,
    );
    await personStore.createPerson(
      access(),
      {
        name: "Alias collision two",
        aliases: ["shared alias", "Ada Lovelace"],
        notes: null,
        summary: null,
        tags: [],
        projectIds: [],
        knowledgeBaseIds: [],
        idempotencyKey: "person-alias-two",
      },
      new AbortController().signal,
    );
    await expect(
      personStore.findPersonByName(
        access(),
        "Shared Alias",
        new AbortController().signal,
      ),
    ).rejects.toThrow("ambiguous");
    await expect(
      personStore.findPersonByName(
        access(),
        "ADA LOVELACE",
        new AbortController().signal,
      ),
    ).rejects.toThrow("ambiguous");
  });

  it("persists one activity event and one receipt for one successful mutation", async () => {
    const project = await projectStore.createProject(
      access(),
      {
        name: "Audited project",
        description: null,
        idempotencyKey: "project-audited",
      },
      new AbortController().signal,
    );
    const events = await orm
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.entityId, project.id));
    const receipts = await orm
      .select()
      .from(mutationReceipts)
      .where(
        and(
          eq(mutationReceipts.operation, "project.create"),
          eq(mutationReceipts.idempotencyKey, "project-audited"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.activityEventId).toBe(events[0]!.id);
  });

  it("fails closed when a creation receipt points to a mismatched activity event", async () => {
    const person = await personStore.createPerson(
      access(),
      {
        name: "Corrupt receipt person",
        aliases: [],
        notes: null,
        summary: null,
        tags: [],
        projectIds: [],
        knowledgeBaseIds: [],
        idempotencyKey: "person-corrupt-receipt",
      },
      new AbortController().signal,
    );
    await orm
      .update(activityEvents)
      .set({ action: "updated" })
      .where(eq(activityEvents.entityId, person.id));

    await expect(
      personStore.createPerson(
        access(),
        {
          name: "Corrupt receipt person",
          aliases: [],
          notes: null,
          summary: null,
          tags: [],
          projectIds: [],
          knowledgeBaseIds: [],
          idempotencyKey: "person-corrupt-receipt",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("receipt activity event points to another mutation");
  });

  it("keeps mutation receipt JSON free of erased account and OAuth client identifiers", async () => {
    const erasedAccountId = randomUUID();
    const clientId = `privacy-client-${randomUUID()}`;
    await orm.insert(accounts).values({
      id: erasedAccountId,
      email: `erased-${erasedAccountId}@example.test`,
      passwordHash: "not-used-by-store-tests",
      status: "active",
      role: "editor",
    });
    const erasedAccess: BrainAccessContext = {
      accountId: erasedAccountId,
      role: "editor",
      actor: {
        kind: "oauth_client",
        accountId: erasedAccountId,
        clientId,
        source: "mcp_http",
        requestId: randomUUID(),
        correlationId: null,
        causationId: null,
        dreamingRunId: null,
      },
    };
    const project = await projectStore.createProject(
      erasedAccess,
      {
        name: "Privacy project",
        description: null,
        idempotencyKey: "privacy-project",
      },
      new AbortController().signal,
    );
    const person = await personStore.createPerson(
      {
        ...erasedAccess,
        actor: { ...erasedAccess.actor, requestId: randomUUID() },
      },
      {
        name: "Privacy person",
        aliases: [],
        notes: null,
        summary: null,
        tags: [],
        projectIds: [],
        knowledgeBaseIds: [],
        idempotencyKey: "privacy-person",
      },
      new AbortController().signal,
    );

    const receiptsBefore = await orm
      .select({ result: mutationReceipts.result })
      .from(mutationReceipts)
      .where(inArray(mutationReceipts.resultEntityId, [project.id, person.id]));
    expect(JSON.stringify(receiptsBefore)).not.toContain(erasedAccountId);
    expect(JSON.stringify(receiptsBefore)).not.toContain(clientId);

    await expect(
      new OAuthUserStore(orm).eraseAccount(erasedAccountId),
    ).resolves.toBe(true);

    const receiptsAfter = await orm
      .select({ result: mutationReceipts.result })
      .from(mutationReceipts)
      .where(inArray(mutationReceipts.resultEntityId, [project.id, person.id]));
    expect(JSON.stringify(receiptsAfter)).not.toContain(erasedAccountId);
    expect(JSON.stringify(receiptsAfter)).not.toContain(clientId);
    const [projectRow] = await orm
      .select({
        accountId: projects.actorAccountId,
        clientId: projects.actorClientId,
      })
      .from(projects)
      .where(eq(projects.id, project.id));
    const [personRow] = await orm
      .select({
        accountId: people.actorAccountId,
        clientId: people.actorClientId,
      })
      .from(people)
      .where(eq(people.id, person.id));
    expect(projectRow).toEqual({ accountId: null, clientId: null });
    expect(personRow).toEqual({ accountId: null, clientId: null });
  });
});
