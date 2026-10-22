import { randomUUID } from "node:crypto";
import { createEngine, type ExecutionSource } from "@invokta/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase } from "@second-brain/engine/database/client";
import { runMigrations } from "@second-brain/engine/database/migrate";
import { accounts } from "@second-brain/engine/database/schema/identity";
import {
  projects,
  people,
  personProjects,
  taskLists,
  tasks,
  memories,
  memoryPeople,
  knowledgeBases,
  knowledgeDocuments,
  knowledgeDocumentRevisions,
  knowledgeChunks,
  decisions,
} from "@second-brain/engine/database/schema/content";
import { goals } from "@second-brain/engine/database/schema/temporal";
import { DrizzleBrainAccessStore } from "@second-brain/engine/database/stores/access-store";
import { DrizzleProjectOverviewStore } from "@second-brain/engine/database/stores/project-overview-store";
import { createDrizzleBrainQuestionService } from "@second-brain/engine/database/stores/brain-question-service";
import { memoryEmbeddingRecipe } from "@second-brain/engine/domain";
import type { BrainQuestionProvider } from "@second-brain/engine/domain/brain-question";
import { createAdminProjectCapabilities } from "../../src/services/admin/capabilities/admin-projects.js";
import { createAdminQuestionCapabilities } from "../../src/services/admin/capabilities/admin-question.js";
import {
  provisionTestDatabase,
  type DisposableTestDatabase,
} from "./support/database.js";
let resource: DisposableTestDatabase;
let database: ReturnType<typeof createDatabase>;
let engine: ReturnType<
  typeof createEngine<
    ReturnType<typeof createAdminProjectCapabilities> &
      ReturnType<typeof createAdminQuestionCapabilities>
  >
>;
const accountId = randomUUID();
const projectId = randomUUID();
const unrelatedId = randomUUID();
const baseId = randomUUID();
const documentId = randomUUID();
const revisionId = randomUUID();
const memoryId = randomUUID();
const personId = randomUUID();
const actor = {
  actorKind: "account" as const,
  actorAccountId: accountId,
  actorSource: "direct" as const,
};
const options = {
  source: "admin" as ExecutionSource,
  principal: { id: accountId },
};
const answerAcrossBrain = vi.fn<BrainQuestionProvider["answerAcrossBrain"]>(
  async (input) => {
    const memory =
      input.evidence.findIndex((item) => item.sourceType === "memory") + 1;
    const document =
      input.evidence.findIndex(
        (item) => item.sourceType === "knowledge_chunk",
      ) + 1;
    return {
      answer: `The product review is on Friday [${memory}] [${document}].`,
      answerable: true,
      citationIndexes: [memory, document],
    };
  },
);
beforeAll(async () => {
  resource = await provisionTestDatabase("project_workspace");
  await runMigrations(resource.pool);
  database = createDatabase(resource.pool);
  await database
    .insert(accounts)
    .values({
      id: accountId,
      email: "workspace@example.test",
      passwordHash: "test",
      role: "admin",
    });
  await database.insert(projects).values([
    { id: projectId, name: "Product review", ...actor },
    { id: unrelatedId, name: "Unrelated", ...actor },
  ]);
  const listId = randomUUID();
  await database
    .insert(taskLists)
    .values({ id: listId, name: "Review work", ...actor });
  await database.insert(tasks).values([
    { listId, projectId, title: "Product review checklist", ...actor },
    { listId, projectId, title: "Product review notes", ...actor },
    {
      listId,
      projectId: unrelatedId,
      title: "Private unrelated task",
      ...actor,
    },
  ]);
  await database
    .insert(goals)
    .values({ projectId, title: "Product review readiness", ...actor });
  const decisionId = randomUUID();
  await database
    .insert(decisions)
    .values({
      id: decisionId,
      lineageId: decisionId,
      projectId,
      statement: "Product review on Friday",
      rationale: "The team is available",
      contentHash: "a".repeat(64),
      ...actor,
    });
  await database
    .insert(memories)
    .values({
      id: memoryId,
      lineageId: memoryId,
      projectId,
      content: "Product review was on Thursday",
      contentHash: memoryEmbeddingRecipe("Product review was on Thursday")
        .contentHash,
      ...actor,
    });
  const currentId = randomUUID();
  await database
    .insert(memories)
    .values({
      id: currentId,
      lineageId: memoryId,
      supersedesId: memoryId,
      versionNumber: 2,
      projectId,
      content: "Product review is on Friday",
      contentHash: memoryEmbeddingRecipe("Product review is on Friday")
        .contentHash,
      effectiveAt: new Date(Date.now() + 1),
      ...actor,
    });
  await database
    .insert(people)
    .values({ id: personId, name: "Product review owner", ...actor });
  await database.insert(personProjects).values({ projectId, personId });
  await database.insert(memoryPeople).values({ memoryId: currentId, personId });
  await database.transaction(async (tx) => {
    await tx
      .insert(knowledgeBases)
      .values({ id: baseId, name: "Product reviews", ...actor });
    await tx
      .insert(knowledgeDocuments)
      .values({
        id: documentId,
        knowledgeBaseId: baseId,
        projectId,
        title: "Product review schedule",
        ...actor,
      });
    await tx
      .insert(knowledgeDocumentRevisions)
      .values({
        id: revisionId,
        documentId,
        revisionNumber: 1,
        contentHash: "b".repeat(64),
        chunkCount: 1,
        ...actor,
      });
    await tx
      .insert(knowledgeChunks)
      .values({
        revisionId,
        position: 0,
        content: "Product review is on Friday",
        contentHash: "c".repeat(64),
      });
  });
  const access = new DrizzleBrainAccessStore(database);
  const models = {
    provider: "test",
    model: "test",
    modelRevision: "1",
    dimensions: 1536,
    embed: vi.fn(async () => []),
    answerAcrossBrain,
  };
  engine = createEngine({
    name: "workspace",
    version: "1",
    capabilities: {
      ...createAdminProjectCapabilities(
        access,
        new DrizzleProjectOverviewStore(database),
      ),
      ...createAdminQuestionCapabilities(
        access,
        createDrizzleBrainQuestionService(database, models),
      ),
    },
  });
}, 180_000);
afterAll(async () => {
  await resource?.destroy();
});
it("counts every project section, deduplicates related people, and excludes obsolete memories", async () => {
  expect(
    (await engine.invoke("admin_project_get", { projectId }, options)).result
      ?.counts,
  ).toEqual({
    tasks: 2,
    goals: 1,
    decisions: 1,
    people: 1,
    documents: 1,
    memories: 1,
  });
  const current = await engine.invoke(
    "admin_project_section",
    { projectId, section: "memories" },
    options,
  );
  expect(current.items[0]).toMatchObject({
    title: "Product review is on Friday",
    version: 2,
  });
  expect(
    (
      await engine.invoke(
        "admin_project_section",
        { projectId, section: "documents" },
        options,
      )
    ).items[0],
  ).toMatchObject({ id: documentId, knowledgeBaseId: baseId });
  const first = await engine.invoke(
    "admin_project_section",
    { projectId, section: "tasks", limit: 1 },
    options,
  );
  const second = await engine.invoke(
    "admin_project_section",
    { projectId, section: "tasks", limit: 1, cursor: first.nextCursor },
    options,
  );
  expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
  expect(second.nextCursor).toBeNull();
});
it("retrieves both document and memory evidence and returns exact document references", async () => {
  const answer = await engine.invoke(
    "admin_brain_question",
    { question: "Product review", locale: "en", projectId },
    options,
  );
  expect(answer.answerable).toBe(true);
  expect(answer.citations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sourceType: "memory" }),
      expect.objectContaining({
        sourceType: "knowledge_chunk",
        documentId,
        revisionId,
        knowledgeBaseId: baseId,
      }),
    ]),
  );
  expect(
    answerAcrossBrain.mock.calls[0]![0].evidence.some(
      (item) => item.projectId === unrelatedId,
    ),
  ).toBe(false);
});
it("denies revoked administration access and missing project reads", async () => {
  expect(
    (
      await engine.invoke(
        "admin_project_get",
        { projectId: randomUUID() },
        options,
      )
    ).result,
  ).toBeNull();
  await database
    .update(accounts)
    .set({ role: "viewer" })
    .where(eq(accounts.id, accountId));
  await expect(
    engine.invoke("admin_project_get", { projectId }, options),
  ).rejects.toBeDefined();
  await expect(
    engine.invoke(
      "admin_brain_question",
      { question: "Product review" },
      options,
    ),
  ).rejects.toBeDefined();
});
