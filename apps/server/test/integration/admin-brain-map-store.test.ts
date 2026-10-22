import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "@second-brain/engine/database/migrate";
import {
  accounts,
  knowledgeBases,
  knowledgeDocumentPeople,
  knowledgeDocumentRevisions,
  knowledgeDocuments,
  memories,
  memoryPeople,
  people,
  personKnowledgeBases,
  personProjects,
  projects,
  schema,
} from "@second-brain/engine/database/schema/index";
import type { BrainAccessContext } from "@second-brain/engine/domain";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import { DrizzleAdminBrainMapStore } from "../../src/services/admin/persistence/brain-map-store.js";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

describe("Drizzle admin brain map store", () => {
  let resource: DisposableTestDatabase;
  let database: SecondBrainDatabase;
  const accountId = randomUUID();
  const actor = {
    actorKind: "account" as const,
    actorAccountId: accountId,
    actorClientId: null,
    actorSource: "direct" as const,
  };

  function access(): BrainAccessContext {
    return {
      accountId,
      role: "admin",
      actor: {
        kind: "account",
        accountId,
        clientId: null,
        source: "direct",
        requestId: randomUUID(),
        correlationId: null,
        causationId: null,
        dreamingRunId: null,
      },
    };
  }

  beforeAll(async () => {
    resource = await provisionTestDatabase("admin_brain_map_store");
    await runMigrations(resource.pool);
    database = drizzle(resource.pool, { schema });
    await database.insert(accounts).values({
      id: accountId,
      email: `${accountId}@example.test`,
      passwordHash: "admin-brain-map-test-password-hash",
      role: "admin",
    });
  }, 180_000);

  afterAll(async () => {
    await resource?.destroy();
  });

  it("counts current entities, excludes superseded memory versions, and returns explicit links", async () => {
    const projectId = randomUUID();
    const personId = randomUUID();
    const baseId = randomUUID();
    const documentId = randomUUID();
    const firstMemoryId = randomUUID();
    const currentMemoryId = randomUUID();
    await database.insert(projects).values({
      id: projectId,
      name: "Brain map project",
      description: "A connected project",
      ...actor,
    });
    await database.insert(people).values({
      id: personId,
      name: "Alex Map",
      summary: "A person referenced by the graph",
      ...actor,
    });
    await database.insert(knowledgeBases).values({
      id: baseId,
      name: "Product knowledge",
      description: "Product documents",
      ...actor,
    });
    await database.transaction(async (transaction) => {
      await transaction.insert(knowledgeDocuments).values({
        id: documentId,
        knowledgeBaseId: baseId,
        title: "Product strategy",
        projectId,
        currentRevisionNumber: 1,
        ...actor,
      });
      await transaction.insert(knowledgeDocumentRevisions).values({
        id: randomUUID(),
        documentId,
        revisionNumber: 1,
        contentHash: "c".repeat(64),
        chunkCount: 0,
        ...actor,
      });
    });
    await database.insert(memories).values({
      id: firstMemoryId,
      lineageId: firstMemoryId,
      versionNumber: 1,
      content: "Alex prefers weekly updates.",
      contentHash: "a".repeat(64),
      projectId,
      createdAt: new Date("2020-01-01T12:00:00.000Z"),
      ...actor,
    });
    await database.insert(memories).values({
      id: currentMemoryId,
      lineageId: firstMemoryId,
      versionNumber: 2,
      supersedesId: firstMemoryId,
      content: "Alex prefers concise weekly updates.",
      contentHash: "b".repeat(64),
      projectId,
      ...actor,
    });
    await database.insert(memoryPeople).values({ memoryId: currentMemoryId, personId });
    await database.insert(knowledgeDocumentPeople).values({ documentId, personId });
    await database.insert(personKnowledgeBases).values({ personId, knowledgeBaseId: baseId });
    await database.insert(personProjects).values({ personId, projectId });

    const snapshot = await new DrizzleAdminBrainMapStore(database).getBrainMap(
      access(),
      { days: 30, nodeLimit: 25 },
      new AbortController().signal,
    );

    expect(snapshot.counts).toEqual({
      memories: 1,
      knowledgeBases: 1,
      documents: 1,
      people: 1,
      projects: 1,
    });
    expect(snapshot.totalItems).toBe(5);
    expect(snapshot.growth).toBe(4);
    expect(snapshot.nodes.map((node) => node.id)).toContain(currentMemoryId);
    expect(snapshot.nodes.map((node) => node.id)).not.toContain(firstMemoryId);
    expect(snapshot.nodes.find((node) => node.id === currentMemoryId)).toMatchObject({
      version: 2,
      createdAt: "2020-01-01T12:00:00.000Z",
      updatedAt: expect.any(String),
    });
    expect(snapshot.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "contains", source: baseId, target: documentId }),
      expect.objectContaining({ type: "mentions", source: currentMemoryId, target: personId }),
      expect.objectContaining({ type: "belongs_to", source: documentId, target: projectId }),
      expect.objectContaining({ type: "participates_in", source: personId, target: projectId }),
    ]));
    expect(snapshot.explicitConnections).toBe(7);
    expect(snapshot.connectedCoverage).toBe(1);
    expect(snapshot.series).toHaveLength(30);
    expect(snapshot.series.at(-1)?.total).toBe(5);
  });
});
