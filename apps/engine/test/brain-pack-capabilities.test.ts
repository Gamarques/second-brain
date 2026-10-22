import { createEngine } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { createBrainPackCapabilities } from "../src/capabilities/brain-pack.js";
import { encodeCursor } from "../src/capabilities/schemas.js";
import { BrainPackError } from "../src/domain/brain-pack.js";
import type { BrainPackArtifactRecord, BrainPackArtifactStore } from "../src/domain/brain-pack-artifacts.js";
import { brainPackCodec, decodeBrainPack, encodeBrainPack } from "../src/domain/brain-pack-codec.js";
import type { BrainPackRunRecord, BrainPackStore } from "../src/domain/brain-pack-store.js";
import { BrainPackStoreConflictError } from "../src/domain/brain-pack-store.js";
import type { AutomationStore, BrainAccessContext, BrainAccessStore } from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const otherAccountId = "00000000-0000-4000-8000-000000000002";
const baseId = "00000000-0000-4000-8000-000000000004";
const documentId = "00000000-0000-4000-8000-000000000005";
const revisionId = "00000000-0000-4000-8000-000000000006";
const runId = "00000000-0000-4000-8000-000000000010";
const jobId = "00000000-0000-4000-8000-000000000011";
const artifactId = "00000000-0000-4000-8000-000000000012";
const externalPackId = "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60";
const now = "2026-09-07T12:00:00.000Z";
const hashA = "a".repeat(64);
const principal = { id: accountId };

function run(overrides: Partial<BrainPackRunRecord> = {}): BrainPackRunRecord {
  return {
    id: runId,
    kind: "export",
    status: "completed",
    ownerAccountId: accountId,
    pack: { id: "00000000-0000-4000-8000-000000000020", externalPackId, publisher: { namespace: "local.brain", displayName: "Local" }, owned: true },
    packRevision: { id: "00000000-0000-4000-8000-000000000021", number: 1, title: "Local pack", manifestSha256: hashA },
    artifactId,
    jobId: null,
    idempotencyKey: "export-1",
    requestDigest: hashA,
    reviewVersion: 0,
    reviewDigest: null,
    review: null,
    exportSelection: null,
    progress: null,
    receipt: {
      runId,
      packId: externalPackId,
      packRevision: 1,
      artifactId,
      sha256: hashA,
      byteSize: 10,
      collectionCount: 1,
      documentCount: 1,
      frozenAt: now,
    },
    sanitizedError: null,
    cancelRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function setup(overrides: Partial<BrainPackStore> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const record = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const accessStore: BrainAccessStore = {
    async resolveAccess(request) {
      record("resolveAccess", request.requiredRole);
      const context: BrainAccessContext = {
        accountId: request.principal.id,
        role: "admin",
        actor: {
          kind: "account",
          accountId: request.principal.id,
          clientId: null,
          source: "direct",
          requestId: request.requestId,
          correlationId: null,
          causationId: null,
          dreamingRunId: null,
        },
      };
      return context;
    },
    async revalidateAccess(context, role) {
      record("revalidateAccess", role);
      return context;
    },
    async getTimeZone() {
      return "UTC";
    },
  };
  const stored = new Map<string, { record: BrainPackArtifactRecord; bytes: Uint8Array }>();
  const artifacts: BrainPackArtifactStore = {
    async put(input) {
      record("put", { kind: input.kind, ownerAccountId: input.ownerAccountId, expiresAt: input.expiresAt });
      const artifact: BrainPackArtifactRecord = {
        id: artifactId,
        kind: input.kind,
        ownerAccountId: input.ownerAccountId,
        sha256: input.expectedSha256 ?? hashA,
        byteSize: input.bytes.byteLength,
        contentType: "application/zip",
        createdAt: now,
        expiresAt: input.expiresAt,
      };
      stored.set(artifact.id, { record: artifact, bytes: input.bytes });
      return artifact;
    },
    async head(id) {
      return stored.get(id)?.record ?? null;
    },
    async read(id) {
      return stored.get(id) ?? null;
    },
    async remove(id) {
      record("remove", id);
      return stored.delete(id);
    },
    async expire() {
      return 0;
    },
  };
  const automation: Pick<AutomationStore, "requestCancel"> = {
    async requestCancel(id, input) {
      record("requestCancel", id, input.requestedBy);
      return null;
    },
  };
  const base: Partial<BrainPackStore> = {
    async findRunByIdempotencyKey() {
      return null;
    },
    async prepareExport(_access, input) {
      record("prepareExport", input);
      return { externalPackId, packRevision: 1 };
    },
    async snapshotExportSelection(_access, input) {
      record("snapshotExportSelection", input);
      return {
        frozenAt: now,
        knowledgeBases: [
          {
            id: baseId,
            name: "Notes",
            description: null,
            documents: [
              {
                id: documentId,
                title: "Alpha",
                tags: ["a"],
                sourceUri: null,
                revision: { id: revisionId, number: 2, contentHash: hashA },
                content: "Alpha text.",
                representation: "canonical" as const,
                origin: null,
              },
            ],
          },
        ],
      };
    },
    async recordExport(_access, input) {
      record("recordExport", input);
      return { run: run({ receipt: { ...input.receipt, runId } }), replayed: false };
    },
    async getRun(_access, id) {
      record("getRun", id);
      return run();
    },
    async listRuns(_access, input) {
      record("listRuns", input);
      return { runs: [run()], nextCursor: { ts: now, id: runId } };
    },
    async cancelRun(_access, input) {
      record("cancelRun", input);
      return { run: run({ kind: "import", status: "indexing", jobId, receipt: null }), canceled: false, jobToCancel: jobId };
    },
    async createImportRun(_access, input) {
      record("createImportRun", { failure: input.failure, hasPack: input.pack !== null, artifactId: input.artifactId });
      return {
        run: run({ kind: "import", status: input.failure === null ? "awaiting_review" : "failed", pack: null, packRevision: null, receipt: null }),
        replayed: false,
      };
    },
  };
  const packs = { ...base, ...overrides } as BrainPackStore;
  const engine = createEngine({
    name: "test",
    version: "1.0.0",
    capabilities: createBrainPackCapabilities({ access: accessStore, packs, artifacts, codec: brainPackCodec, automation, now: () => now }),
  });
  return { engine, calls, artifacts, stored };
}

const exportInput = {
  selection: { knowledgeBaseIds: [baseId], documentIds: [] },
  metadata: { title: "Local pack", description: null, publisherNamespace: "local.brain", publisherDisplayName: "Local", language: "en" },
  packId: null,
  expectedPackRevision: null,
  idempotencyKey: "export-1",
};

describe("Brain Pack capabilities", () => {
  it("exports synchronously: freezes, encodes, stores the artifact for seven days and records the run", async () => {
    const { engine, calls, stored } = setup();

    const result = await engine.invoke("knowledge_packs_export", exportInput, { principal });

    expect(calls[0]).toEqual({ name: "resolveAccess", args: ["admin"] });
    expect(calls.map((call) => call.name)).toEqual([
      "resolveAccess",
      "prepareExport",
      "snapshotExportSelection",
      "revalidateAccess",
      "put",
      "recordExport",
    ]);
    expect(calls.find((call) => call.name === "put")?.args[0]).toEqual({
      kind: "export",
      ownerAccountId: accountId,
      expiresAt: "2026-09-14T12:00:00.000Z",
    });
    const recorded = calls.find((call) => call.name === "recordExport")?.args[0] as { revision: { items: { itemKey: string; kind: string }[] } };
    expect(recorded.revision.items.map((item) => [item.kind, item.itemKey])).toEqual([
      ["collection", `kb-${baseId}`],
      ["document", `doc-${documentId}`],
    ]);
    const decoded = decodeBrainPack(stored.get(artifactId)!.bytes);
    expect(decoded.documents[0]).toMatchObject({ key: `doc-${documentId}`, representation: "canonical", content: "Alpha text." });
    expect(result).toMatchObject({ runId, status: "completed", packId: externalPackId, packRevision: 1, artifactId });
  });

  it("replays an identical export request and rejects a different one under the same key", async () => {
    const { engine, calls } = setup({
      async findRunByIdempotencyKey() {
        return run({ requestDigest: "not-the-digest".padEnd(64, "0") });
      },
    });
    await expect(engine.invoke("knowledge_packs_export", exportInput, { principal })).rejects.toMatchObject({
      cause: expect.any(BrainPackStoreConflictError),
    });
    expect(calls.map((call) => call.name)).not.toContain("put");
  });

  it("refuses an export beyond the synchronous limit before storing anything", async () => {
    const { engine, calls } = setup({
      async snapshotExportSelection() {
        throw new BrainPackError("PACK_LIMIT_EXCEEDED", "Too many documents.");
      },
    });
    await expect(engine.invoke("knowledge_packs_export", exportInput, { principal })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "PACK_LIMIT_EXCEEDED" }),
    });
    expect(calls.map((call) => call.name)).not.toContain("put");
  });

  it("decodes an upload synchronously and records a typed failure instead of throwing", async () => {
    const { engine, calls, artifacts } = setup();
    await artifacts.put({ kind: "upload", ownerAccountId: accountId, bytes: new TextEncoder().encode("nope"), expiresAt: now });

    const started = await engine.invoke("knowledge_packs_import", { artifactId, idempotencyKey: "import-1" }, { principal });

    expect(started).toEqual({ runId, status: "failed" });
    expect(calls.find((call) => call.name === "createImportRun")?.args[0]).toMatchObject({
      hasPack: false,
      failure: { code: expect.stringMatching(/^PACK_/u) },
    });
  });

  it("only imports uploads the caller owns", async () => {
    const { engine, artifacts } = setup();
    const encoded = encodeBrainPack({
      manifest: {
        formatVersion: 1,
        packId: externalPackId,
        packRevision: 1,
        publisher: { namespace: "acme", displayName: "Acme" },
        title: "Pack",
        description: null,
        createdAt: now,
        language: null,
      },
      collections: [],
      documents: [],
    });
    await artifacts.put({ kind: "upload", ownerAccountId: otherAccountId, bytes: encoded.bytes, expiresAt: now });

    await expect(
      engine.invoke("knowledge_packs_import", { artifactId, idempotencyKey: "import-2" }, { principal }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/not found/u) }) });
  });

  it("asks the automation store to stop the job when a run is already indexing", async () => {
    const { engine, calls } = setup();

    const result = await engine.invoke("knowledge_packs_runs_cancel", { runId, idempotencyKey: "cancel-1" }, { principal });

    expect(result).toEqual({ runId, status: "indexing", canceled: false });
    expect(calls.find((call) => call.name === "requestCancel")?.args).toEqual([jobId, accountId]);
  });

  it("lists runs with opaque cursors", async () => {
    const { engine, calls } = setup();

    const page = await engine.invoke("knowledge_packs_runs_list", { kind: "export", status: null, cursor: encodeCursor({ ts: now, id: runId }), limit: 5 }, { principal });

    expect(calls.find((call) => call.name === "listRuns")?.args[0]).toEqual({ kind: "export", status: null, cursor: { ts: now, id: runId }, limit: 5 });
    expect(page.items[0]).toMatchObject({ id: runId, kind: "export", packId: externalPackId, title: "Local pack" });
    expect(page.nextCursor).toBe(encodeCursor({ ts: now, id: runId }));
  });

  it("returns the export artifact reference with the run", async () => {
    const { engine, artifacts } = setup();
    await artifacts.put({ kind: "export", ownerAccountId: accountId, bytes: new Uint8Array([1, 2, 3]), expiresAt: now, expectedSha256: hashA });

    const fetched = await engine.invoke("knowledge_packs_export_get", { runId }, { principal });

    expect(fetched.artifact).toEqual({ id: artifactId, sha256: hashA, byteSize: 3, expiresAt: now });
    expect(fetched.receipt?.documentCount).toBe(1);
  });
});
