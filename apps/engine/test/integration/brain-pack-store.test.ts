import { createHash, randomUUID } from "node:crypto";

import { createEngine } from "@invokta/core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBrainPackCapabilities } from "../../src/capabilities/brain-pack.js";
import { runMigrations } from "../../src/database/migrate.js";
import { automationJobs } from "../../src/database/schema/automation.js";
import {
  knowledgePackMappings,
  knowledgePackRunChunks,
  knowledgePackRunItems,
  knowledgePackRuns,
  knowledgeRevisionContents,
  knowledgeRevisionOrigins,
} from "../../src/database/schema/brain-pack.js";
import { knowledgeDocumentRevisions, knowledgeDocuments } from "../../src/database/schema/content.js";
import { accounts } from "../../src/database/schema/identity.js";
import { schema } from "../../src/database/schema/index.js";
import { DrizzleBrainAccessStore } from "../../src/database/stores/access-store.js";
import { DrizzleAutomationJobControl } from "../../src/database/stores/automation-job-control.js";
import { DrizzleBrainPackArtifactStore } from "../../src/database/stores/brain-pack-artifact-store.js";
import { DrizzleBrainPackStore } from "../../src/database/stores/brain-pack-store.js";
import { provisionInitialEmbeddingSpacesInTransaction } from "../../src/database/stores/embedding-space-store.js";
import { DrizzleKnowledgeStore } from "../../src/database/stores/knowledge-store.js";
import { BrainPackError, type BrainPackSource } from "../../src/domain/brain-pack.js";
import { brainPackCodec, decodeBrainPack, encodeBrainPack } from "../../src/domain/brain-pack-codec.js";
import { createBrainPackImportService } from "../../src/domain/brain-pack-import.js";
import { BrainPackStoreConflictError } from "../../src/domain/brain-pack-store.js";
import { knowledgeChunkEmbeddingRecipe } from "../../src/domain/embedding-recipes.js";
import type { BrainAccessContext, EmbeddingProvider } from "../../src/domain.js";
import { type DisposableTestDatabase, provisionTestDatabase } from "./support/database.js";

const fingerprint = {
  provider: "integration-provider",
  model: "integration-embedding-model",
  modelRevision: "2026-08-16",
  dimensions: 1_536,
} as const;

const packId = "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60";
const noCancel = async () => {};
const signal = () => new AbortController().signal;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function vectorFor(text: string): number[] {
  const seed = Number.parseInt(sha256(text).slice(0, 4), 16) / 0xffff;
  return [seed, Math.sqrt(Math.max(0, 1 - seed ** 2)), ...Array<number>(1_534).fill(0)];
}

function access(accountId: string, role: "owner" | "admin" = "owner"): BrainAccessContext {
  return {
    accountId,
    role,
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

function packSource(revision: number, overrides: Partial<BrainPackSource> = {}): BrainPackSource {
  return {
    manifest: {
      formatVersion: 1,
      packId,
      packRevision: revision,
      publisher: { namespace: "acme.engineering", displayName: "Acme Engineering" },
      title: "Engineering Brain Pack",
      description: "Architecture notes.",
      createdAt: `2026-09-0${revision}T12:00:00.000Z`,
      language: "en",
    },
    collections: [
      { key: "architecture", name: "Architecture", description: "How it is built.", documentKeys: ["notes", "runbook"] },
      { key: "onboarding", name: "Onboarding", description: null, documentKeys: ["welcome"] },
    ],
    documents: [
      {
        key: "notes",
        collectionKey: "architecture",
        title: "Architecture notes",
        tags: ["architecture"],
        sourceUri: "https://docs.example.com/architecture",
        attribution: { authors: [{ name: "Alex Rivera", uri: null }], origin: null, sourceRevision: null },
        references: [],
        representation: "canonical",
        content: "# Architecture notes\n\nOne brain per deployment.\n",
      },
      {
        key: "runbook",
        collectionKey: "architecture",
        title: "Deploy runbook",
        tags: [],
        sourceUri: null,
        attribution: { authors: [], origin: null, sourceRevision: null },
        references: [],
        representation: "canonical",
        content: "Deploy with the pipeline. Roll back with the previous image.\n",
      },
      {
        key: "welcome",
        collectionKey: "onboarding",
        title: "Bem-vindo",
        tags: ["onboarding"],
        sourceUri: null,
        attribution: { authors: [], origin: null, sourceRevision: null },
        references: [],
        representation: "canonical",
        content: "Bem-vindo à equipe. Leia as notas de arquitetura primeiro.\n",
      },
    ],
    ...overrides,
  };
}

function buildEngine(dependencies: Parameters<typeof createBrainPackCapabilities>[0]) {
  return createEngine({ name: "test", version: "1.0.0", capabilities: createBrainPackCapabilities(dependencies) });
}

describe("Brain Pack store, capabilities and import service", () => {
  let database: DisposableTestDatabase;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let accountId: string;
  let owner: BrainAccessContext;
  let store: DrizzleBrainPackStore;
  let artifacts: DrizzleBrainPackArtifactStore;
  let knowledge: DrizzleKnowledgeStore;
  let engine: ReturnType<typeof buildEngine>;
  let spaceId: string;
  const embedCalls: string[][] = [];
  const embeddings: EmbeddingProvider = {
    ...fingerprint,
    async embed(texts) {
      embedCalls.push([...texts]);
      return texts.map((text) => vectorFor(text));
    },
  };
  let service: ReturnType<typeof createBrainPackImportService>;
  let principal: { id: string };

  beforeAll(async () => {
    database = await provisionTestDatabase("brain_pack_store");
    await runMigrations(database.pool);
    db = drizzle(database.pool, { schema });
    accountId = randomUUID();
    principal = { id: accountId };
    await db.insert(accounts).values({
      id: accountId,
      email: `packs-${accountId}@example.com`,
      passwordHash: "not-used-in-store-integration-tests",
      role: "owner",
    });
    const spaces = await db.transaction((transaction) =>
      provisionInitialEmbeddingSpacesInTransaction(transaction, fingerprint, AbortSignal.timeout(10_000)),
    );
    spaceId = spaces.find((space) => space.entityType === "knowledge_chunk")!.id;
    owner = access(accountId);
    store = new DrizzleBrainPackStore(db);
    artifacts = new DrizzleBrainPackArtifactStore(db);
    knowledge = new DrizzleKnowledgeStore(db);
    const accessStore = new DrizzleBrainAccessStore(db);
    const embeddingSpaces = { getActiveSpace: async () => spaces.find((space) => space.entityType === "knowledge_chunk")!, createSpace: async () => { throw new Error("unused"); }, promoteSpace: async () => { throw new Error("unused"); } };
    engine = buildEngine({
      access: accessStore,
      packs: store,
      artifacts,
      codec: brainPackCodec,
      automation: new DrizzleAutomationJobControl(db),
    });
    service = createBrainPackImportService({ store, access: accessStore, embeddingSpaces, embeddings });
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  });

  async function createDocument(knowledgeBaseId: string, title: string, content: string, options: { canonical: boolean; idempotencyKey: string }) {
    const recipe = knowledgeChunkEmbeddingRecipe(content);
    const created = await knowledge.createDocumentRevision(
      owner,
      {
        knowledgeBaseId,
        documentId: null,
        expectedRevision: null,
        title,
        sourceUri: null,
        contentHash: sha256(content),
        chunks: [{ content, position: 0, embedding: { spaceId, contentHash: recipe.contentHash, vector: vectorFor(content) } }],
        tags: ["local"],
        projectId: null,
        personIds: [],
        idempotencyKey: options.idempotencyKey,
        ...(options.canonical ? { content } : {}),
      },
      signal(),
    );
    return created!;
  }

  async function reviseDocument(documentId: string, expectedRevision: number, content: string, idempotencyKey: string) {
    const recipe = knowledgeChunkEmbeddingRecipe(content);
    const document = await knowledge.getDocument(owner, { documentId, revision: null }, signal());
    return knowledge.createDocumentRevision(
      owner,
      {
        knowledgeBaseId: document!.document.knowledgeBaseId,
        documentId,
        expectedRevision,
        title: document!.document.title,
        sourceUri: null,
        contentHash: sha256(content),
        chunks: [{ content, position: 0, embedding: { spaceId, contentHash: recipe.contentHash, vector: vectorFor(content) } }],
        tags: [],
        projectId: null,
        personIds: [],
        idempotencyKey,
        content,
      },
      signal(),
    );
  }

  async function upload(source: BrainPackSource) {
    const encoded = encodeBrainPack(source);
    return artifacts.put({ kind: "upload", ownerAccountId: accountId, bytes: encoded.bytes, expiresAt: "2099-01-01T00:00:00.000Z" });
  }

  async function runRow(runId: string) {
    const rows = await db.select().from(knowledgePackRuns).where(eq(knowledgePackRuns.id, runId));
    return rows[0]!;
  }

  let exportedPackId = "";
  let localBaseId = "";
  let canonicalDocumentId = "";

  it("exports a selection synchronously, labels representations honestly, and replays on the same key", async () => {
    const base = await knowledge.createKnowledgeBase(owner, { name: "Local notes", description: "Mine", idempotencyKey: "base-local" }, signal());
    localBaseId = base.id;
    const canonical = await createDocument(base.id, "Canonical", "Exact text kept beside the chunks.", { canonical: true, idempotencyKey: "doc-canonical" });
    const reconstructed = await createDocument(base.id, "Reconstructed", "Only chunks were stored for this one.", { canonical: false, idempotencyKey: "doc-reconstructed" });
    canonicalDocumentId = canonical.document.id;

    const input = {
      selection: { knowledgeBaseIds: [base.id], documentIds: [] },
      metadata: { title: "Local pack", description: null, publisherNamespace: "local.brain", publisherDisplayName: "Local Brain", language: "en" },
      packId: null,
      expectedPackRevision: null,
      idempotencyKey: "export-1",
    };
    const exported = await engine.invoke("knowledge_packs_export", input, { principal });
    expect(exported).toMatchObject({ status: "completed", packRevision: 1, receipt: { collectionCount: 1, documentCount: 2 } });
    exportedPackId = exported.packId;

    const artifact = await artifacts.read(exported.artifactId!);
    const decoded = decodeBrainPack(artifact!.bytes);
    expect(decoded.manifest.packId).toBe(exportedPackId);
    expect(decoded.collections).toEqual([
      expect.objectContaining({ key: `kb-${base.id}`, name: "Local notes", documentKeys: [`doc-${canonical.document.id}`, `doc-${reconstructed.document.id}`] }),
    ]);
    expect(decoded.documents.map((document) => [document.key, document.representation, document.content])).toEqual([
      [`doc-${canonical.document.id}`, "canonical", "Exact text kept beside the chunks."],
      [`doc-${reconstructed.document.id}`, "reconstructed", "Only chunks were stored for this one."],
    ]);

    const replayed = await engine.invoke("knowledge_packs_export", input, { principal });
    expect(replayed).toEqual(exported);
    await expect(
      engine.invoke("knowledge_packs_export", { ...input, metadata: { ...input.metadata, title: "Other" } }, { principal }),
    ).rejects.toMatchObject({ cause: expect.any(BrainPackStoreConflictError) });

    const fetched = await engine.invoke("knowledge_packs_export_get", { runId: exported.runId }, { principal });
    expect(fetched.artifact).toMatchObject({ id: exported.artifactId, sha256: artifact!.record.sha256 });
    expect(fetched.run).toMatchObject({ kind: "export", status: "completed", packId: exportedPackId, title: "Local pack" });
  });

  it("re-exports an owned pack with stable keys and refuses a stale expected revision", async () => {
    const again = await engine.invoke(
      "knowledge_packs_export",
      {
        selection: { knowledgeBaseIds: [localBaseId], documentIds: [] },
        metadata: { title: "Local pack", description: "Second cut", publisherNamespace: "local.brain", publisherDisplayName: "Local Brain", language: "en" },
        packId: exportedPackId,
        expectedPackRevision: 1,
        idempotencyKey: "export-2",
      },
      { principal },
    );
    expect(again).toMatchObject({ packId: exportedPackId, packRevision: 2 });
    const decoded = decodeBrainPack((await artifacts.read(again.artifactId!))!.bytes);
    expect(decoded.documents.map((document) => document.key)).toContain(`doc-${canonicalDocumentId}`);

    await expect(
      engine.invoke(
        "knowledge_packs_export",
        {
          selection: { knowledgeBaseIds: [localBaseId], documentIds: [] },
          metadata: { title: "Local pack", description: null, publisherNamespace: "local.brain", publisherDisplayName: "Local Brain", language: "en" },
          packId: exportedPackId,
          expectedPackRevision: 1,
          idempotencyKey: "export-3",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "PACK_REVISION_CONFLICT" }) });
  });

  let importRunId = "";
  let importedNotesId = "";
  let importedRunbookId = "";
  let architectureBaseId = "";

  it("validates an upload, previews it, freezes a review, indexes with checkpoints and publishes in one transaction", async () => {
    const uploaded = await upload(packSource(1));
    const started = await engine.invoke("knowledge_packs_import", { artifactId: uploaded.id, idempotencyKey: "import-1" }, { principal });
    expect(started.status).toBe("awaiting_review");
    importRunId = started.runId;

    const fetched = await engine.invoke("knowledge_packs_import_get", { runId: importRunId, cursor: null, limit: 10 }, { principal });
    expect(fetched.preview).toMatchObject({
      packId,
      packRevision: 1,
      publisher: { namespace: "acme.engineering", displayName: "Acme Engineering" },
      counts: { collections: 2, documents: 3, new: 3, updated: 0, unchanged: 0, conflicting: 0, invalid: 0 },
      collections: [
        { key: "architecture", name: "Architecture", documentCount: 2 },
        { key: "onboarding", name: "Onboarding", documentCount: 1 },
      ],
    });
    expect(fetched.preview!.samples.map((sample) => sample.itemKey)).toEqual(["notes", "runbook", "welcome"]);
    expect(fetched.items.items.map((item) => [item.itemKey, item.classification])).toEqual([
      ["notes", "new"],
      ["runbook", "new"],
      ["welcome", "new"],
    ]);

    await expect(
      engine.invoke(
        "knowledge_packs_import_review",
        { runId: importRunId, expectedReviewVersion: 1, collections: [], items: [], projectId: null, tags: [], idempotencyKey: "review-stale" },
        { principal },
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "PACK_REVIEW_STALE" }) });

    const reviewed = await engine.invoke(
      "knowledge_packs_import_review",
      {
        runId: importRunId,
        expectedReviewVersion: 0,
        collections: [
          { collectionKey: "architecture", destination: { createKnowledgeBase: { name: "Architecture (imported)", description: null } } },
          { collectionKey: "onboarding", destination: { knowledgeBaseId: localBaseId } },
        ],
        items: [
          { itemKey: "notes", decision: "create", expectedLocalRevision: null },
          { itemKey: "runbook", decision: "create", expectedLocalRevision: null },
        ],
        projectId: null,
        tags: ["imported"],
        idempotencyKey: "review-1",
      },
      { principal },
    );
    expect(reviewed).toMatchObject({ runId: importRunId, reviewVersion: 1, status: "reviewed" });

    await expect(
      engine.invoke("knowledge_packs_import_publish", { runId: importRunId, reviewDigest: "0".repeat(64), idempotencyKey: "publish-stale" }, { principal }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "PACK_REVIEW_STALE" }) });

    const published = await engine.invoke(
      "knowledge_packs_import_publish",
      { runId: importRunId, reviewDigest: reviewed.reviewDigest, idempotencyKey: "publish-1" },
      { principal },
    );
    expect(published.status).toBe("indexing");
    const jobs = await db.select().from(automationJobs).where(eq(automationJobs.id, published.jobId!));
    expect(jobs[0]).toMatchObject({ kind: "brain_pack_import", canonicalKey: `brain-pack-import:${importRunId}`, status: "pending", payload: { runId: importRunId } });
    const replayedPublish = await engine.invoke(
      "knowledge_packs_import_publish",
      { runId: importRunId, reviewDigest: reviewed.reviewDigest, idempotencyKey: "publish-1" },
      { principal },
    );
    expect(replayedPublish.jobId).toBe(published.jobId);

    embedCalls.length = 0;
    await service.index(importRunId, { signal: signal(), checkCancelled: noCancel });
    expect(embedCalls.flat()).toHaveLength(2);
    const staged = await db.select().from(knowledgePackRunChunks);
    expect(staged).toHaveLength(2);
    await service.index(importRunId, { signal: signal(), checkCancelled: noCancel });
    expect(embedCalls.flat()).toHaveLength(2);
    expect((await runRow(importRunId)).progress).toEqual({ stage: "indexed", processedItems: 2, totalItems: 2 });

    const receipt = await service.publish(importRunId, { signal: signal() });
    expect(receipt).toMatchObject({
      runId: importRunId,
      packId,
      packRevision: 1,
      created: [expect.objectContaining({ itemKey: "notes" }), expect.objectContaining({ itemKey: "runbook" })],
      updated: [],
      skipped: [],
      excluded: [{ itemKey: "welcome", reason: expect.any(String) }],
    });
    importedNotesId = receipt!.created[0]!.documentId;
    importedRunbookId = receipt!.created[1]!.documentId;

    const done = await engine.invoke("knowledge_packs_import_get", { runId: importRunId, cursor: null, limit: 10 }, { principal });
    expect(done.run.status).toBe("completed");
    expect(done.receipt?.created).toHaveLength(2);
    expect(done.items.items.map((item) => [item.itemKey, item.result])).toEqual([
      ["notes", "created"],
      ["runbook", "created"],
      ["welcome", "excluded"],
    ]);
    expect(await db.select().from(knowledgePackRunChunks)).toHaveLength(0);

    const notes = await knowledge.getDocument(owner, { documentId: importedNotesId, revision: null }, signal());
    expect(notes).toMatchObject({
      document: { title: "Architecture notes", tags: ["architecture", "imported"], provenance: { kind: "import" } },
      revision: { version: 1 },
      content: "# Architecture notes\n\nOne brain per deployment.\n",
      representation: "canonical",
      origin: {
        publisher: { namespace: "acme.engineering", displayName: "Acme Engineering" },
        packId,
        packRevision: 1,
        packTitle: "Engineering Brain Pack",
        itemKey: "notes",
        authors: [{ name: "Alex Rivera", uri: null }],
      },
    });
    architectureBaseId = notes!.document.knowledgeBaseId;
    expect(architectureBaseId).not.toBe(localBaseId);
    const origins = await db.select().from(knowledgeRevisionOrigins);
    expect(origins).toHaveLength(2);
    const mappings = await db.select().from(knowledgePackMappings);
    expect(mappings.map((mapping) => [mapping.itemKey, mapping.importedPackRevision])).toEqual(
      expect.arrayContaining([["notes", 1], ["runbook", 1]]),
    );

    const matches = await knowledge.searchKnowledge(
      owner,
      {
        knowledgeBaseId: architectureBaseId,
        embedding: { spaceId, contentHash: sha256("query"), vector: vectorFor("# Architecture notes\n\nOne brain per deployment.") },
        limit: 5,
      },
      signal(),
    );
    expect(matches![0]).toMatchObject({ documentId: importedNotesId, origin: { itemKey: "notes", packRevision: 1 } });
  });

  it("classifies a re-import against mappings and local edits, updates only what the review allows, and never rolls back", async () => {
    const localEdit = await reviseDocument(importedRunbookId, 1, "Runbook edited locally.", "runbook-local-edit");
    expect(localEdit?.revision.version).toBe(2);

    const revised = packSource(2, {
      documents: packSource(2).documents.map((document) =>
        document.key === "welcome"
          ? document
          : { ...document, content: `${document.content}Revised in pack revision 2.\n` },
      ),
    });
    const uploaded = await upload(revised);
    const started = await engine.invoke("knowledge_packs_import", { artifactId: uploaded.id, idempotencyKey: "import-2" }, { principal });
    const fetched = await engine.invoke("knowledge_packs_import_get", { runId: started.runId, cursor: null, limit: 10 }, { principal });
    expect(fetched.items.items.map((item) => [item.itemKey, item.classification, item.localRevision])).toEqual([
      ["notes", "updated", 1],
      ["runbook", "conflicting", 2],
      ["welcome", "new", null],
    ]);
    expect(fetched.preview!.counts).toMatchObject({ new: 1, updated: 1, conflicting: 1, unchanged: 0 });

    const reviewed = await engine.invoke(
      "knowledge_packs_import_review",
      {
        runId: started.runId,
        expectedReviewVersion: 0,
        collections: [
          { collectionKey: "architecture", destination: { knowledgeBaseId: architectureBaseId } },
          { collectionKey: "onboarding", destination: { knowledgeBaseId: localBaseId } },
        ],
        items: [
          { itemKey: "notes", decision: "update", expectedLocalRevision: 1 },
          { itemKey: "runbook", decision: "keep_local", expectedLocalRevision: 2 },
          { itemKey: "welcome", decision: "create", expectedLocalRevision: null },
        ],
        projectId: null,
        tags: [],
        idempotencyKey: "review-2",
      },
      { principal },
    );
    const published = await engine.invoke(
      "knowledge_packs_import_publish",
      { runId: started.runId, reviewDigest: reviewed.reviewDigest, idempotencyKey: "publish-2" },
      { principal },
    );
    expect(published.status).toBe("indexing");
    await service.index(started.runId, { signal: signal(), checkCancelled: noCancel });
    const receipt = await service.publish(started.runId, { signal: signal() });
    expect(receipt).toMatchObject({
      created: [expect.objectContaining({ itemKey: "welcome" })],
      updated: [expect.objectContaining({ itemKey: "notes", documentId: importedNotesId })],
      skipped: [{ itemKey: "runbook", reason: expect.stringMatching(/local/u) }],
      excluded: [],
    });
    const notes = await knowledge.getDocument(owner, { documentId: importedNotesId, revision: null }, signal());
    expect(notes).toMatchObject({ revision: { version: 2 }, origin: { packRevision: 2 }, representation: "canonical" });
    expect(notes!.content).toContain("Revised in pack revision 2.");
    const runbook = await knowledge.getDocument(owner, { documentId: importedRunbookId, revision: null }, signal());
    expect(runbook).toMatchObject({ revision: { version: 2 }, content: "Runbook edited locally.", origin: null });
    const welcome = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.knowledgeBaseId, localBaseId));
    expect(welcome.map((row) => row.title)).toContain("Bem-vindo");

    const older = await upload(packSource(1));
    const stale = await engine.invoke("knowledge_packs_import", { artifactId: older.id, idempotencyKey: "import-older" }, { principal });
    const staleItems = await engine.invoke("knowledge_packs_import_get", { runId: stale.runId, cursor: null, limit: 10 }, { principal });
    // notes and welcome were last imported from revision 2, so revision 1 cannot roll them back;
    // runbook's mapping still points at revision 1 (the local edit was kept), so its text is simply unchanged.
    expect(staleItems.items.items.map((item) => [item.itemKey, item.classification])).toEqual([
      ["notes", "invalid"],
      ["runbook", "unchanged"],
      ["welcome", "invalid"],
    ]);
    await engine.invoke("knowledge_packs_runs_cancel", { runId: stale.runId, idempotencyKey: "cancel-older" }, { principal });
  });

  it("fails publication when a local document moved after the review, and publishes nothing", async () => {
    const revision3 = packSource(3, {
      documents: packSource(3).documents.map((document) => ({ ...document, content: `${document.content}Third revision.\n` })),
    });
    const uploaded = await upload(revision3);
    const started = await engine.invoke("knowledge_packs_import", { artifactId: uploaded.id, idempotencyKey: "import-3" }, { principal });
    const reviewed = await engine.invoke(
      "knowledge_packs_import_review",
      {
        runId: started.runId,
        expectedReviewVersion: 0,
        collections: [
          { collectionKey: "architecture", destination: { knowledgeBaseId: architectureBaseId } },
          { collectionKey: "onboarding", destination: { knowledgeBaseId: localBaseId } },
        ],
        items: [{ itemKey: "notes", decision: "update", expectedLocalRevision: 2 }],
        projectId: null,
        tags: [],
        idempotencyKey: "review-3",
      },
      { principal },
    );
    await engine.invoke("knowledge_packs_import_publish", { runId: started.runId, reviewDigest: reviewed.reviewDigest, idempotencyKey: "publish-3" }, { principal });
    await service.index(started.runId, { signal: signal(), checkCancelled: noCancel });

    const concurrent = await reviseDocument(importedNotesId, 2, "Notes edited locally while the import was indexing.", "notes-concurrent-edit");
    expect(concurrent?.revision.version).toBe(3);

    await expect(service.publish(started.runId, { signal: signal() })).rejects.toMatchObject({ code: "PACK_REVISION_CONFLICT" });
    const failed = await runRow(started.runId);
    expect(failed.status).toBe("failed");
    expect(failed.sanitizedError).toMatch(/^PACK_REVISION_CONFLICT/u);
    const revisions = await db.select().from(knowledgeDocumentRevisions).where(eq(knowledgeDocumentRevisions.documentId, importedNotesId));
    expect(revisions.map((row) => row.revisionNumber).sort()).toEqual([1, 2, 3]);

    const retried = await engine.invoke("knowledge_packs_runs_retry", { runId: started.runId, idempotencyKey: "retry-3" }, { principal });
    expect(retried.status).toBe("indexing");
    const rerun = await runRow(started.runId);
    const job = await db.select().from(automationJobs).where(eq(automationJobs.id, rerun.jobId!));
    expect(job[0]?.status).toBe("pending");
    await engine.invoke("knowledge_packs_runs_cancel", { runId: started.runId, idempotencyKey: "cancel-3" }, { principal });
    const canceledJob = await db.select().from(automationJobs).where(eq(automationJobs.id, rerun.jobId!));
    expect(canceledJob[0]?.status).toBe("canceled");
    const canceled = await runRow(started.runId);
    expect(canceled.cancelRequestedAt).not.toBeNull();
    expect(await service.publish(started.runId, { signal: signal() })).toBeNull();
    expect((await runRow(started.runId)).status).toBe("canceled");
  });

  it("publishes nothing when cancellation is requested before the commit, and lists runs newest first", async () => {
    const base = await knowledge.createKnowledgeBase(owner, { name: "Cancel target", description: null, idempotencyKey: "base-cancel" }, signal());
    const uploaded = await upload(
      packSource(1, {
        manifest: { ...packSource(1).manifest, packId: "1f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f61", publisher: { namespace: "acme.other", displayName: "Other" } },
      }),
    );
    const started = await engine.invoke("knowledge_packs_import", { artifactId: uploaded.id, idempotencyKey: "import-cancel" }, { principal });
    const reviewed = await engine.invoke(
      "knowledge_packs_import_review",
      {
        runId: started.runId,
        expectedReviewVersion: 0,
        collections: [
          { collectionKey: "architecture", destination: { knowledgeBaseId: base.id } },
          { collectionKey: "onboarding", destination: { knowledgeBaseId: base.id } },
        ],
        items: [{ itemKey: "welcome", decision: "create", expectedLocalRevision: null }],
        projectId: null,
        tags: [],
        idempotencyKey: "review-cancel",
      },
      { principal },
    );
    const published = await engine.invoke("knowledge_packs_import_publish", { runId: started.runId, reviewDigest: reviewed.reviewDigest, idempotencyKey: "publish-cancel" }, { principal });
    await service.index(started.runId, { signal: signal(), checkCancelled: noCancel });

    const canceled = await engine.invoke("knowledge_packs_runs_cancel", { runId: started.runId, idempotencyKey: "cancel-run" }, { principal });
    expect(canceled).toMatchObject({ runId: started.runId, status: "indexing", canceled: false });
    const job = await db.select().from(automationJobs).where(eq(automationJobs.id, published.jobId!));
    expect(job[0]?.cancelRequestedAt).not.toBeNull();

    expect(await service.publish(started.runId, { signal: signal() })).toBeNull();
    expect((await runRow(started.runId)).status).toBe("canceled");
    expect(await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.knowledgeBaseId, base.id))).toHaveLength(0);
    const again = await engine.invoke("knowledge_packs_runs_cancel", { runId: started.runId, idempotencyKey: "cancel-run" }, { principal });
    expect(again).toMatchObject({ status: "canceled", canceled: true });

    const runs = await engine.invoke("knowledge_packs_runs_list", { kind: null, status: null, cursor: null, limit: 3 }, { principal });
    expect(runs.items).toHaveLength(3);
    expect(runs.items[0]!.id).toBe(started.runId);
    expect(runs.nextCursor).not.toBeNull();
    const rest = await engine.invoke("knowledge_packs_runs_list", { kind: "export", status: "completed", cursor: null, limit: 10 }, { principal });
    expect(rest.items.map((run) => run.kind)).toEqual(["export", "export"]);
  });

  it("refuses to publish with a stale fence and records failed decodes as failed runs", async () => {
    const broken = await artifacts.put({ kind: "upload", ownerAccountId: accountId, bytes: new TextEncoder().encode("not a zip"), expiresAt: "2099-01-01T00:00:00.000Z" });
    const failed = await engine.invoke("knowledge_packs_import", { artifactId: broken.id, idempotencyKey: "import-broken" }, { principal });
    expect(failed.status).toBe("failed");
    expect((await runRow(failed.runId)).sanitizedError).toMatch(/^PACK_/u);

    const uploaded = await upload(
      packSource(1, {
        manifest: { ...packSource(1).manifest, packId: "2f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f62", publisher: { namespace: "acme.fenced", displayName: "Fenced" } },
      }),
    );
    const started = await engine.invoke("knowledge_packs_import", { artifactId: uploaded.id, idempotencyKey: "import-fence" }, { principal });
    const reviewed = await engine.invoke(
      "knowledge_packs_import_review",
      {
        runId: started.runId,
        expectedReviewVersion: 0,
        collections: [{ collectionKey: "onboarding", destination: { knowledgeBaseId: localBaseId } }],
        items: [{ itemKey: "welcome", decision: "create", expectedLocalRevision: null }],
        projectId: null,
        tags: [],
        idempotencyKey: "review-fence",
      },
      { principal },
    );
    const published = await engine.invoke("knowledge_packs_import_publish", { runId: started.runId, reviewDigest: reviewed.reviewDigest, idempotencyKey: "publish-fence" }, { principal });
    await service.index(started.runId, { signal: signal(), checkCancelled: noCancel });
    await expect(
      service.publish(started.runId, { signal: signal(), fence: { jobId: published.jobId!, fencingToken: randomUUID() } }),
    ).rejects.toThrow(/lease/u);
    expect((await runRow(started.runId)).status).toBe("failed");
    const contents = await db
      .select()
      .from(knowledgeRevisionContents)
      .innerJoin(knowledgeDocumentRevisions, eq(knowledgeDocumentRevisions.id, knowledgeRevisionContents.revisionId))
      .innerJoin(knowledgeDocuments, and(eq(knowledgeDocuments.id, knowledgeDocumentRevisions.documentId), eq(knowledgeDocuments.title, "Bem-vindo")));
    expect(contents).toHaveLength(1);
    const items = await db.select().from(knowledgePackRunItems).where(eq(knowledgePackRunItems.runId, started.runId));
    expect(items.find((item) => item.itemKey === "welcome")?.checkpoint).toMatchObject({ indexed: { spaceId, chunkCount: 1 } });
  });
});
