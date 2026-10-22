import { createHash, randomUUID } from "node:crypto";

import { createEngine } from "@invokta/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBrainPackCapabilities } from "@second-brain/engine/capabilities/brain-pack";
import { runMigrations } from "@second-brain/engine/database/migrate";
import { automationJobs } from "@second-brain/engine/database/schema/automation";
import { accounts } from "@second-brain/engine/database/schema/identity";
import { schema } from "@second-brain/engine/database/schema/index";
import { DrizzleBrainAccessStore } from "@second-brain/engine/database/stores/access-store";
import { DrizzleBrainPackArtifactStore } from "@second-brain/engine/database/stores/brain-pack-artifact-store";
import { DrizzleBrainPackStore } from "@second-brain/engine/database/stores/brain-pack-store";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import { DrizzleDreamingStore } from "@second-brain/engine/database/stores/dreaming-store";
import {
  DrizzleEmbeddingSpaceStore,
  provisionInitialEmbeddingSpacesInTransaction,
} from "@second-brain/engine/database/stores/embedding-space-store";
import type { EmbeddingProvider } from "@second-brain/engine/domain";
import type { BrainPackSource } from "@second-brain/engine/domain/brain-pack";
import { brainPackCodec, decodeBrainPack, encodeBrainPack } from "@second-brain/engine/domain/brain-pack-codec";
import { createBrainPackImportService } from "@second-brain/engine/domain/brain-pack-import";

import { createAdminHttpHandler } from "../../src/services/admin/http.js";
import { createBrainPackTransferDependencies } from "../../src/services/admin/packs/resolve.js";
import type { ResolvedAdminSession } from "../../src/services/admin/session.js";
import { createBrainPackImportRunner } from "../../src/services/automation/brain-pack-runner.js";
import { DrizzleAutomationStore } from "../../src/services/automation/persistence/store.js";
import { createAutomationWorker } from "../../src/services/automation/worker.js";
import { type DisposableTestDatabase, provisionTestDatabase } from "./support/database.js";

const origin = "https://brain.example.com";
const packId = "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60";
const fingerprint = {
  provider: "integration-provider",
  model: "integration-embedding-model",
  modelRevision: "2026-08-16",
  dimensions: 1_536,
} as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function vectorFor(text: string): number[] {
  const seed = Number.parseInt(sha256(text).slice(0, 4), 16) / 0xffff;
  return [seed, Math.sqrt(Math.max(0, 1 - seed ** 2)), ...Array<number>(1_534).fill(0)];
}

function session(accountId: string, role: "admin" | "owner" = "owner"): ResolvedAdminSession {
  return {
    accountId,
    email: `${accountId}@example.test`,
    role,
    connectedClientCount: 1,
    principal: { id: accountId },
    oauthClientId: "second-brain-admin",
    scopes: ["admin:panel"],
  };
}

function packSource(): BrainPackSource {
  return {
    manifest: {
      formatVersion: 1,
      packId,
      packRevision: 1,
      publisher: { namespace: "acme.engineering", displayName: "Acme Engineering" },
      title: "Engineering Brain Pack",
      description: "Architecture notes.",
      createdAt: "2026-09-01T12:00:00.000Z",
      language: "en",
    },
    collections: [{ key: "architecture", name: "Architecture", description: "How it is built.", documentKeys: ["notes", "runbook"] }],
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
    ],
  };
}

describe("Brain Pack end to end through the admin routes and the worker", () => {
  let resource: DisposableTestDatabase;
  let db: SecondBrainDatabase;
  let accountId: string;
  let current: ResolvedAdminSession;
  let artifacts: DrizzleBrainPackArtifactStore;
  let http: ReturnType<typeof createAdminHttpHandler>;
  let worker: ReturnType<typeof createAutomationWorker>;
  const signal = () => new AbortController().signal;

  beforeAll(async () => {
    resource = await provisionTestDatabase("brain_pack_end_to_end");
    await runMigrations(resource.pool);
    db = drizzle(resource.pool, { schema }) as unknown as SecondBrainDatabase;
    accountId = randomUUID();
    current = session(accountId);
    await db.insert(accounts).values({
      id: accountId,
      email: `packs-${accountId}@example.com`,
      passwordHash: "not-used-in-integration-tests",
      role: "owner",
    });
    await db.transaction((transaction) =>
      provisionInitialEmbeddingSpacesInTransaction(transaction, fingerprint, AbortSignal.timeout(10_000)),
    );

    const access = new DrizzleBrainAccessStore(db);
    const packs = new DrizzleBrainPackStore(db);
    artifacts = new DrizzleBrainPackArtifactStore(db);
    const automation = new DrizzleAutomationStore(db);
    const embeddings: EmbeddingProvider = {
      ...fingerprint,
      async embed(texts) {
        return texts.map((text) => vectorFor(text));
      },
    };
    const engine = createEngine({
      name: "test",
      version: "1.0.0",
      capabilities: createBrainPackCapabilities({ access, packs, artifacts, codec: brainPackCodec, automation }),
    });
    http = createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: { async resolve() { return current; } },
      publicEngine: engine,
      packs: createBrainPackTransferDependencies(db),
    });
    worker = createAutomationWorker({
      workerId: "worker-end-to-end",
      automationStore: automation,
      dreamingStore: new DrizzleDreamingStore(db),
      dreamingRunner: {
        async runDaily() {
          throw new Error("The end-to-end test never dreams.");
        },
      },
      runners: {
        brain_pack_import: createBrainPackImportRunner({
          service: createBrainPackImportService({
            store: packs,
            access,
            embeddingSpaces: new DrizzleEmbeddingSpaceStore(db),
            embeddings,
          }),
          runs: packs,
          artifacts,
          housekeepingIntervalMs: 0,
        }),
      },
    });
  }, 180_000);

  afterAll(async () => {
    await resource?.destroy();
  });

  async function call<T>(operation: string, body: unknown): Promise<T> {
    const response = await http(
      new Request(`${origin}/api/admin/engine/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
        body: JSON.stringify(body),
      }),
    );
    const payload = (await response.json()) as T;
    expect(response.status, JSON.stringify(payload)).toBe(200);
    return payload;
  }

  let createdDocumentIds: string[] = [];

  it("moves a pack from upload to receipt: routes, engine, queue, worker", async () => {
    const bytes = encodeBrainPack(packSource()).bytes;
    const uploaded = await http(
      new Request(`${origin}/api/admin/packs/uploads`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          origin,
          "sec-fetch-site": "same-origin",
          "x-content-sha256": sha256(bytes),
        },
        body: bytes,
      }),
    );
    expect(uploaded.status).toBe(200);
    const upload = (await uploaded.json()) as { artifactId: string; sha256: string; byteSize: number };
    expect(upload).toMatchObject({ sha256: sha256(bytes), byteSize: bytes.byteLength });

    const started = await call<{ runId: string; status: string }>("knowledge-packs-import", {
      artifactId: upload.artifactId,
      idempotencyKey: "import-1",
    });
    expect(started.status).toBe("awaiting_review");
    const runId = started.runId;

    const blocked = await http(new Request(`${origin}/api/admin/engine/knowledge-packs-import`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ artifactId: upload.artifactId, idempotencyKey: "import-while-awaiting-review" }),
    }));
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toEqual({
      error: "PACK_LIMIT_EXCEEDED",
      message: "A Brain Pack size or active import limit was exceeded.",
    });
    await expect(call("knowledge-packs-import", {
      artifactId: upload.artifactId,
      idempotencyKey: "import-1",
    })).resolves.toEqual(started);

    const fetched = await call<{ preview: { counts: Record<string, number> }; items: { items: Array<{ itemKey: string }> } }>(
      "knowledge-packs-import-get",
      { runId, cursor: null, limit: 10 },
    );
    expect(fetched.preview.counts).toMatchObject({ collections: 1, documents: 2, new: 2 });
    expect(fetched.items.items.map((item) => item.itemKey)).toEqual(["notes", "runbook"]);

    const reviewed = await call<{ reviewDigest: string; status: string }>("knowledge-packs-import-review", {
      runId,
      expectedReviewVersion: 0,
      collections: [{ collectionKey: "architecture", destination: { createKnowledgeBase: { name: "Architecture (imported)", description: null } } }],
      items: [
        { itemKey: "notes", decision: "create", expectedLocalRevision: null },
        { itemKey: "runbook", decision: "create", expectedLocalRevision: null },
      ],
      projectId: null,
      tags: ["imported"],
      idempotencyKey: "review-1",
    });
    expect(reviewed.status).toBe("reviewed");

    const published = await call<{ status: string; jobId: string | null }>("knowledge-packs-import-publish", {
      runId,
      reviewDigest: reviewed.reviewDigest,
      idempotencyKey: "publish-1",
    });
    expect(published.status).toBe("indexing");
    expect(published.jobId).not.toBeNull();

    await expect(worker.runOnce(signal())).resolves.toBe(true);

    const [job] = await db.select().from(automationJobs).where(eq(automationJobs.id, published.jobId!));
    expect(job).toMatchObject({ kind: "brain_pack_import", status: "completed", leaseOwner: null });

    const done = await call<{
      run: { status: string; packId: string | null };
      receipt: { created: Array<{ itemKey: string; documentId: string }>; excluded: unknown[] } | null;
      items: { items: Array<{ itemKey: string; result: string | null }> };
    }>("knowledge-packs-import-get", { runId, cursor: null, limit: 10 });
    expect(done.run).toMatchObject({ status: "completed", packId });
    expect(done.receipt?.created.map((item) => item.itemKey)).toEqual(["notes", "runbook"]);
    expect(done.items.items.map((item) => [item.itemKey, item.result])).toEqual([
      ["notes", "created"],
      ["runbook", "created"],
    ]);
    createdDocumentIds = done.receipt!.created.map((item) => item.documentId);

    const listed = await call<{ items: Array<{ id: string; kind: string; status: string }> }>("knowledge-packs-runs-list", {
      kind: null,
      status: null,
      cursor: null,
      limit: 20,
    });
    expect(listed.items).toEqual([expect.objectContaining({ id: runId, kind: "import", status: "completed" })]);
    await expect(worker.runOnce(signal())).resolves.toBe(false);
  });

  it("serves an export archive on the download route to its owner and hides it from strangers", async () => {
    const exported = await call<{ runId: string; status: string; packId: string; artifactId: string | null }>("knowledge-packs-export", {
      selection: { knowledgeBaseIds: [], documentIds: createdDocumentIds },
      metadata: { title: "Local pack", description: null, publisherNamespace: "local.brain", publisherDisplayName: "Local Brain", language: "en" },
      packId: null,
      expectedPackRevision: null,
      idempotencyKey: "export-1",
    });
    expect(exported.status).toBe("completed");

    const download = await http(new Request(`${origin}/api/admin/packs/exports/${exported.runId}/download`));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/zip");
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="${exported.packId}-r1.brainpack"`);
    const decoded = decodeBrainPack(new Uint8Array(await download.arrayBuffer()));
    expect(decoded.manifest).toMatchObject({ packId: exported.packId, packRevision: 1, title: "Local pack" });
    expect(decoded.documents.map((document) => document.title)).toEqual(["Architecture notes", "Deploy runbook"]);

    const unknown = await http(new Request(`${origin}/api/admin/packs/exports/${randomUUID()}/download`));
    expect(unknown.status).toBe(404);

    current = session(randomUUID(), "admin");
    try {
      const stranger = await http(new Request(`${origin}/api/admin/packs/exports/${exported.runId}/download`));
      expect(stranger.status).toBe(404);
    } finally {
      current = session(accountId);
    }
  });

  it("sweeps expired archives when the worker polls", async () => {
    const expired = await artifacts.put({
      kind: "upload",
      ownerAccountId: accountId,
      bytes: new Uint8Array([1, 2, 3]),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const kept = await artifacts.put({
      kind: "upload",
      ownerAccountId: accountId,
      bytes: new Uint8Array([4, 5, 6]),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await expect(worker.runOnce(signal())).resolves.toBe(false);

    await expect(artifacts.head(expired.id)).resolves.toBeNull();
    await expect(artifacts.head(kept.id)).resolves.toMatchObject({ id: kept.id });
  });
});
