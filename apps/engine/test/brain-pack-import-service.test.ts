import { describe, expect, it } from "vitest";

import { BrainPackError } from "../src/domain/brain-pack.js";
import { createBrainPackImportService, type BrainPackImportStore } from "../src/domain/brain-pack-import.js";
import type {
  BrainPackImportWork,
  BrainPackImportWorkItem,
  BrainPackRunRecord,
} from "../src/domain/brain-pack-store.js";
import { KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION } from "../src/domain/embedding-recipes.js";
import type {
  BrainAccessContext,
  BrainAccessStore,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
} from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000010";
const spaceId = "00000000-0000-4000-8000-000000000008";
const now = "2026-09-07T12:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

class CanceledError extends Error {
  constructor() {
    super("canceled");
    this.name = "AutomationJobCanceledError";
  }
}

function run(overrides: Partial<BrainPackRunRecord> = {}): BrainPackRunRecord {
  return {
    id: runId,
    kind: "import",
    status: "indexing",
    ownerAccountId: accountId,
    pack: null,
    packRevision: null,
    artifactId: null,
    jobId: null,
    idempotencyKey: "import-1",
    requestDigest: hashA,
    reviewVersion: 1,
    reviewDigest: hashB,
    review: null,
    exportSelection: null,
    progress: null,
    receipt: null,
    sanitizedError: null,
    cancelRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function item(key: string, overrides: Partial<BrainPackImportWorkItem> = {}): BrainPackImportWorkItem {
  return {
    id: `00000000-0000-4000-8000-0000000000${key.length === 1 ? `2${key}` : key}`,
    itemKey: key,
    decision: "create",
    content: `Text of ${key}.`,
    contentSha256: hashA,
    checkpoint: { indexed: null },
    ...overrides,
  };
}

function setup(work: BrainPackImportWork | null) {
  const calls: { name: string; args: unknown[] }[] = [];
  let commitFailure: unknown = null;
  const record = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const store: BrainPackImportStore = {
    async loadImportWork() {
      record("loadImportWork");
      return work;
    },
    async stageItemChunks(runItemId, input) {
      record("stageItemChunks", runItemId, input);
    },
    async updateRunProgress(_runId, progress) {
      record("updateRunProgress", progress);
    },
    async markRunFailed(_runId, input) {
      record("markRunFailed", input);
    },
    async markRunCanceled() {
      record("markRunCanceled");
    },
    async commitImport(_runId, input) {
      record("commitImport", input);
      if (commitFailure !== null) throw commitFailure;
      return {
        runId,
        packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60",
        packRevision: 1,
        publishedAt: now,
        created: [],
        updated: [],
        skipped: [],
        excluded: [],
      };
    },
  };

  const accessRequests: Parameters<BrainAccessStore["resolveAccess"]>[0][] = [];
  let denyAccess = false;
  const access: BrainAccessStore = {
    async resolveAccess(request) {
      accessRequests.push(request);
      if (denyAccess) throw new Error("Brain access was denied.");
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
    async revalidateAccess(context) {
      return context;
    },
    async getTimeZone() {
      return "UTC";
    },
  };
  const space: EmbeddingSpace = {
    id: spaceId,
    entityType: "knowledge_chunk",
    provider: "fake",
    model: "embed-v1",
    modelRevision: "2026-08-01",
    recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
    dimensions: 3,
    metric: "cosine",
    status: "active",
    createdAt: now,
    promotedAt: now,
    retiredAt: null,
  };
  const embeddingSpaces: EmbeddingSpaceStore = {
    async getActiveSpace() {
      return space;
    },
    async createSpace() {
      throw new Error("not used");
    },
    async promoteSpace() {
      throw new Error("not used");
    },
  };
  const embedCalls: (readonly string[])[] = [];
  const embeddings: EmbeddingProvider = {
    provider: "fake",
    model: "embed-v1",
    modelRevision: "2026-08-01",
    dimensions: 3,
    async embed(texts) {
      embedCalls.push(texts);
      return texts.map(() => [1, 0, 0]);
    },
  };
  const service = createBrainPackImportService({ store, access, embeddingSpaces, embeddings, now: () => now });
  return {
    service,
    calls,
    accessRequests,
    embedCalls,
    setDenyAccess(value: boolean) {
      denyAccess = value;
    },
    setCommitFailure(value: unknown) {
      commitFailure = value;
    },
  };
}

const noCancel = async () => {};

describe("Brain Pack import service", () => {
  it("indexes every written item with a per-item checkpoint and re-resolves the owner's role", async () => {
    const { service, calls, accessRequests, embedCalls } = setup({
      run: run(),
      items: [item("b"), item("a")],
    });

    await service.index(runId, { signal: new AbortController().signal, checkCancelled: noCancel });

    expect(accessRequests).toEqual([
      {
        principal: { id: accountId },
        requiredRole: "admin",
        source: "direct",
        requestId: `brain-pack-import:${runId}`,
        correlationId: null,
      },
    ]);
    expect(embedCalls).toEqual([["Text of a."], ["Text of b."]]);
    const staged = calls.filter((call) => call.name === "stageItemChunks");
    expect(staged.map((call) => call.args[0])).toEqual([item("a").id, item("b").id]);
    expect(staged[0]!.args[1]).toEqual({
      contentSha256: hashA,
      recipeVersion: KNOWLEDGE_CHUNK_EMBEDDING_RECIPE_VERSION,
      chunks: [
        {
          position: 0,
          content: "Text of a.",
          embedding: { spaceId, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u), vector: [1, 0, 0] },
        },
      ],
    });
    expect(calls.filter((call) => call.name === "updateRunProgress").map((call) => call.args[0])).toEqual([
      { stage: "indexing", processedItems: 1, totalItems: 2 },
      { stage: "indexing", processedItems: 2, totalItems: 2 },
      { stage: "indexed", processedItems: 2, totalItems: 2 },
    ]);
  });

  it("resumes after an interruption: items already staged for the active space are not embedded again", async () => {
    const { service, calls, embedCalls } = setup({
      run: run(),
      items: [
        item("a", { checkpoint: { indexed: { spaceId, contentSha256: hashA, chunkCount: 1 } } }),
        item("b", { checkpoint: { indexed: { spaceId: "00000000-0000-4000-8000-000000000099", contentSha256: hashA, chunkCount: 1 } } }),
      ],
    });

    await service.index(runId, { signal: new AbortController().signal, checkCancelled: noCancel });

    expect(embedCalls).toEqual([["Text of b."]]);
    expect(calls.filter((call) => call.name === "stageItemChunks").map((call) => call.args[0])).toEqual([item("b").id]);
  });

  it("stops at an item boundary when the job is canceled and marks the run canceled", async () => {
    const { service, calls, embedCalls } = setup({ run: run(), items: [item("a"), item("b")] });
    let checks = 0;
    const checkCancelled = async () => {
      checks += 1;
      if (checks === 2) throw new CanceledError();
    };

    await expect(
      service.index(runId, { signal: new AbortController().signal, checkCancelled }),
    ).rejects.toBeInstanceOf(CanceledError);

    expect(embedCalls).toHaveLength(1);
    expect(calls.map((call) => call.name)).toContain("markRunCanceled");
    expect(calls.map((call) => call.name)).not.toContain("markRunFailed");
  });

  it("marks the run failed with a sanitized message when the owner lost the role", async () => {
    const { service, calls, setDenyAccess } = setup({ run: run(), items: [item("a")] });
    setDenyAccess(true);

    await expect(
      service.index(runId, { signal: new AbortController().signal, checkCancelled: noCancel }),
    ).rejects.toThrow(/denied/u);

    expect(calls.find((call) => call.name === "markRunFailed")?.args[0]).toEqual({
      sanitizedError: "Brain access was denied.",
    });
  });

  it("does not touch the run when the signal aborted (lease lost or shutdown)", async () => {
    const { service, calls } = setup({ run: run(), items: [item("a")] });
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.index(runId, { signal: controller.signal, checkCancelled: noCancel }),
    ).rejects.toThrow();

    expect(calls.map((call) => call.name)).not.toContain("markRunFailed");
    expect(calls.map((call) => call.name)).not.toContain("markRunCanceled");
  });

  it("publishes with the worker's fence and returns the receipt", async () => {
    const { service, calls } = setup({
      run: run(),
      items: [item("a", { checkpoint: { indexed: { spaceId, contentSha256: hashA, chunkCount: 1 } } })],
    });
    const fence = { jobId: "00000000-0000-4000-8000-000000000042", fencingToken: "00000000-0000-4000-8000-000000000043" };

    const receipt = await service.publish(runId, { signal: new AbortController().signal, fence });

    expect(receipt?.runId).toBe(runId);
    expect(calls.find((call) => call.name === "commitImport")?.args[0]).toEqual({ now, fence });
  });

  it("publishes nothing when cancellation was requested before the commit", async () => {
    const { service, calls } = setup({
      run: run({ cancelRequestedAt: now }),
      items: [item("a", { checkpoint: { indexed: { spaceId, contentSha256: hashA, chunkCount: 1 } } })],
    });

    const receipt = await service.publish(runId, { signal: new AbortController().signal });

    expect(receipt).toBeNull();
    expect(calls.map((call) => call.name)).toEqual(["loadImportWork", "markRunCanceled"]);
  });

  it("refuses to publish an item that was never indexed", async () => {
    const { service, calls } = setup({ run: run(), items: [item("a")] });

    await expect(service.publish(runId, { signal: new AbortController().signal })).rejects.toThrow(/unindexed/u);
    expect(calls.map((call) => call.name)).not.toContain("commitImport");
  });

  it("records typed pack errors from the publish transaction on the run", async () => {
    const conflict = new BrainPackError("PACK_REVISION_CONFLICT", "A document moved.", ["a"]);
    const { service, calls, setCommitFailure } = setup({
      run: run(),
      items: [item("a", { checkpoint: { indexed: { spaceId, contentSha256: hashA, chunkCount: 1 } } })],
    });
    setCommitFailure(conflict);

    await expect(service.publish(runId, { signal: new AbortController().signal })).rejects.toBe(conflict);
    expect(calls.find((call) => call.name === "markRunFailed")?.args[0]).toEqual({
      sanitizedError: "PACK_REVISION_CONFLICT: A document moved.",
    });
  });
});
