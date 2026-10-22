import type { z } from "zod";

import {
  BrainPackError,
  brainPackLimits,
  brainPackRequestDigest,
  type BrainPackExportReceipt,
  type BrainPackImportReceipt,
} from "../domain/brain-pack.js";
import type { BrainPackArtifactStore } from "../domain/brain-pack-artifacts.js";
import type { BrainPackCodec } from "../domain/brain-pack-codec.js";
import { buildBrainPackExportSource } from "../domain/brain-pack-export.js";
import type {
  BrainPackImportCreateInput,
  BrainPackItemRecordInput,
  BrainPackRunItemRecord,
  BrainPackRunRecord,
  BrainPackStore,
} from "../domain/brain-pack-store.js";
import { BrainPackStoreConflictError } from "../domain/brain-pack-store.js";
import { canonicalDigest, sha256Hex } from "../domain/digests.js";
import type { AutomationStore, BrainAccessStore } from "../domain/stores.js";
import { requireBrainAccess } from "./access.js";
import {
  brainPackCapabilityContracts,
  type BrainPackCapabilityContract,
  type BrainPackCapabilityId,
  type BrainPackRunItem,
  type BrainPackRunSummary,
} from "./brain-pack-schemas.js";
import { defineCapability } from "./define.js";
import { decodeCursor, encodeCursor, requireFound } from "./schemas.js";

export interface BrainPackCapabilityDependencies {
  readonly access: BrainAccessStore;
  readonly packs: BrainPackStore;
  readonly artifacts: BrainPackArtifactStore;
  readonly codec: BrainPackCodec;
  readonly automation: Pick<AutomationStore, "requestCancel">;
  readonly now?: () => string;
}

const EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const titles: Readonly<Record<BrainPackCapabilityId, string>> = {
  knowledge_packs_export: "Export a Brain Pack",
  knowledge_packs_export_get: "Get an export run",
  knowledge_packs_import: "Start a Brain Pack import",
  knowledge_packs_import_get: "Get an import run",
  knowledge_packs_import_review: "Review a Brain Pack import",
  knowledge_packs_import_publish: "Publish a reviewed import",
  knowledge_packs_runs_list: "List Brain Pack runs",
  knowledge_packs_runs_cancel: "Cancel a Brain Pack run",
  knowledge_packs_runs_retry: "Retry a failed Brain Pack run",
};

function summarize(run: BrainPackRunRecord): BrainPackRunSummary {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    packId: run.pack?.externalPackId ?? null,
    packRevision: run.packRevision?.number ?? null,
    publisher: run.pack === null ? null : { ...run.pack.publisher },
    title: run.packRevision?.title ?? null,
    artifactId: run.artifactId,
    reviewVersion: run.reviewVersion,
    reviewDigest: run.reviewDigest,
    progress: run.progress === null ? null : { ...run.progress },
    sanitizedError: run.sanitizedError,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

function importReceipt(run: BrainPackRunRecord) {
  if (run.kind !== "import" || run.receipt === null) return null;
  const receipt = run.receipt as BrainPackImportReceipt;
  return {
    runId: receipt.runId,
    packId: receipt.packId,
    packRevision: receipt.packRevision,
    publishedAt: receipt.publishedAt,
    created: receipt.created.map((item) => ({ ...item })),
    updated: receipt.updated.map((item) => ({ ...item })),
    skipped: receipt.skipped.map((item) => ({ ...item })),
    excluded: receipt.excluded.map((item) => ({ ...item })),
  };
}

function exportReceipt(run: BrainPackRunRecord) {
  if (run.kind !== "export" || run.receipt === null) return null;
  return { ...(run.receipt as BrainPackExportReceipt) };
}

function writableItem(item: BrainPackRunItemRecord): BrainPackRunItem {
  return {
    itemKey: item.itemKey,
    collectionKey: item.collectionKey,
    title: item.title,
    classification: item.classification,
    decision: item.decision,
    expectedLocalRevision: item.expectedLocalRevision,
    localDocumentId: item.localDocumentId,
    localRevision: item.localRevision,
    result: item.result,
    resultDocumentId: item.resultDocumentId,
    resultRevisionId: item.resultRevisionId,
    sanitizedError: item.sanitizedError,
  };
}

function requireRun(run: BrainPackRunRecord | null, kind: "import" | "export"): BrainPackRunRecord {
  const found = requireFound(run, kind === "import" ? "Import run" : "Export run");
  if (found.kind !== kind) throw new Error(`${kind === "import" ? "Import" : "Export"} run was not found.`);
  return found;
}

/** Records the same replay-or-conflict rule the stores apply to mutation receipts. */
function replayOrConflict(existing: BrainPackRunRecord | null, requestDigest: string): BrainPackRunRecord | null {
  if (existing === null) return null;
  if (existing.requestDigest !== requestDigest) throw new BrainPackStoreConflictError();
  return existing;
}

const EXCERPT_CHARACTERS = 500;

function excerptOf(content: string): string {
  const flattened = content.replace(/\s+/gu, " ").trim();
  return flattened.length <= EXCERPT_CHARACTERS ? flattened : flattened.slice(0, EXCERPT_CHARACTERS);
}

/**
 * The nine Brain Pack capabilities, all administrative. Exports run
 * synchronously within the format's limits; imports validate synchronously
 * and publish through the automation worker after a review.
 */
export function createBrainPackCapabilities(dependencies: BrainPackCapabilityDependencies) {
  const { access: accessStore, packs, artifacts, codec, automation } = dependencies;
  const now = dependencies.now ?? (() => new Date().toISOString());

  function base<Input extends z.ZodType, Output extends z.ZodType>(
    contract: BrainPackCapabilityContract<Input, Output>,
    title: string,
  ) {
    return {
      title,
      description: contract.description,
      input: contract.input,
      output: contract.output,
      access: "authenticated",
      timeoutMs: contract.timeoutMs,
      annotations: { ...contract.annotations },
    } as const;
  }

  const exportPack = defineCapability({
    ...base(brainPackCapabilityContracts.knowledge_packs_export, titles.knowledge_packs_export),
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, { requiredRole: "admin" });
      const { signal } = context;
      const requestDigest = brainPackRequestDigest({
        selection: input.selection,
        metadata: input.metadata,
        packId: input.packId,
        expectedPackRevision: input.expectedPackRevision,
      });
      const replayed = replayOrConflict(
        await packs.findRunByIdempotencyKey(access, { kind: "export", idempotencyKey: input.idempotencyKey }, signal),
        requestDigest,
      );
      if (replayed !== null) return exportOutput(replayed);

      const identity = await packs.prepareExport(
        access,
        {
          externalPackId: input.packId,
          expectedPackRevision: input.expectedPackRevision,
          publisherNamespace: input.metadata.publisherNamespace,
        },
        signal,
      );
      const snapshot = await packs.snapshotExportSelection(
        access,
        {
          knowledgeBaseIds: input.selection.knowledgeBaseIds,
          documentIds: input.selection.documentIds,
          maxDocuments: brainPackLimits.synchronousExportDocuments,
        },
        signal,
      );
      const source = buildBrainPackExportSource(snapshot, {
        packId: identity.externalPackId,
        packRevision: identity.packRevision,
        publisher: { namespace: input.metadata.publisherNamespace, displayName: input.metadata.publisherDisplayName },
        title: input.metadata.title,
        description: input.metadata.description,
        language: input.metadata.language,
      });
      const encoded = codec.encode(source);
      const expandedBytes = encoded.manifest.inventory.reduce((sum, entry) => sum + entry.byteSize, 0);
      if (expandedBytes > brainPackLimits.synchronousExportExpandedBytes) {
        throw new BrainPackError("PACK_LIMIT_EXCEEDED", "The selection is larger than a synchronous export allows.", [
          `expanded bytes: ${expandedBytes} > ${brainPackLimits.synchronousExportExpandedBytes}`,
        ]);
      }
      signal.throwIfAborted();
      const revalidated = await accessStore.revalidateAccess(access, "admin", signal);

      const artifact = await artifacts.put({
        kind: "export",
        ownerAccountId: revalidated.accountId,
        bytes: encoded.bytes,
        expiresAt: new Date(Date.parse(now()) + EXPORT_RETENTION_MS).toISOString(),
        expectedSha256: encoded.sha256,
      });
      const items: BrainPackItemRecordInput[] = [
        ...source.collections.map(
          (collection): BrainPackItemRecordInput => ({
            kind: "collection",
            itemKey: collection.key,
            collectionKey: null,
            title: collection.name,
            representation: null,
            contentSha256: null,
            byteSize: null,
            characterCount: null,
            payload: { name: collection.name, description: collection.description, documentKeys: collection.documentKeys },
          }),
        ),
        ...source.documents.map(
          (document): BrainPackItemRecordInput => ({
            kind: "document",
            itemKey: document.key,
            collectionKey: document.collectionKey,
            title: document.title,
            representation: document.representation,
            contentSha256: sha256Hex(document.content),
            byteSize: Buffer.byteLength(document.content, "utf8"),
            characterCount: document.content.length,
            payload: {
              tags: document.tags,
              sourceUri: document.sourceUri,
              attribution: document.attribution,
              localDocumentId: document.key.slice("doc-".length),
              sourceRevision: document.attribution.sourceRevision,
            },
          }),
        ),
      ];
      let recorded: Awaited<ReturnType<BrainPackStore["recordExport"]>>;
      try {
        recorded = await packs.recordExport(
          revalidated,
          {
            idempotencyKey: input.idempotencyKey,
            requestDigest,
            revision: {
              externalPackId: identity.externalPackId,
              packRevision: identity.packRevision,
              publisher: encoded.manifest.publisher,
              title: encoded.manifest.title,
              description: encoded.manifest.description,
              language: encoded.manifest.language,
              manifest: encoded.manifest,
              manifestSha256: canonicalDigest(encoded.manifest),
              createdAt: encoded.manifest.createdAt,
              items,
            },
            expectedPackRevision: input.expectedPackRevision,
            artifactId: artifact.id,
            selection: {
              knowledgeBaseIds: input.selection.knowledgeBaseIds,
              documentIds: input.selection.documentIds,
              frozenAt: snapshot.frozenAt,
            },
            receipt: {
              packId: identity.externalPackId,
              packRevision: identity.packRevision,
              artifactId: artifact.id,
              sha256: encoded.sha256,
              byteSize: encoded.byteSize,
              collectionCount: source.collections.length,
              documentCount: source.documents.length,
              frozenAt: snapshot.frozenAt,
            },
          },
          signal,
        );
      } catch (error) {
        await artifacts.remove(artifact.id).catch(() => undefined);
        throw error;
      }
      if (recorded.replayed) await artifacts.remove(artifact.id).catch(() => undefined);
      return exportOutput(recorded.run);
    },
  });

  function exportOutput(run: BrainPackRunRecord) {
    const receipt = exportReceipt(run);
    if (run.pack === null || run.packRevision === null) {
      throw new Error("An export run was stored without its pack identity.");
    }
    return {
      runId: run.id,
      status: run.status as "completed" | "failed" | "canceled" | "queued" | "snapshotting" | "encoding",
      packId: run.pack.externalPackId,
      packRevision: run.packRevision.number,
      artifactId: run.artifactId,
      receipt,
    };
  }

  const getExport = defineCapability({
    ...base(brainPackCapabilityContracts.knowledge_packs_export_get, titles.knowledge_packs_export_get),
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, { requiredRole: "admin" });
      const run = requireRun(await packs.getRun(access, input.runId, context.signal), "export");
      const artifact = run.artifactId === null ? null : await artifacts.head(run.artifactId);
      return {
        run: summarize(run),
        receipt: exportReceipt(run),
        artifact:
          artifact === null
            ? null
            : { id: artifact.id, sha256: artifact.sha256, byteSize: artifact.byteSize, expiresAt: artifact.expiresAt },
      };
    },
  });

  const startImport = defineCapability({
    ...base(brainPackCapabilityContracts.knowledge_packs_import, titles.knowledge_packs_import),
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, { requiredRole: "admin" });
      const { signal } = context;
      const requestDigest = brainPackRequestDigest({ artifactId: input.artifactId });
      const replayed = replayOrConflict(
        await packs.findRunByIdempotencyKey(access, { kind: "import", idempotencyKey: input.idempotencyKey }, signal),
        requestDigest,
      );
      if (replayed !== null) return { runId: replayed.id, status: importStatus(replayed) };

      const artifact = requireFound(await artifacts.read(input.artifactId), "Upload artifact");
      if (artifact.record.kind !== "upload" || artifact.record.ownerAccountId !== access.accountId) {
        throw new Error("Upload artifact was not found.");
      }
      signal.throwIfAborted();

      let pack: BrainPackImportCreateInput["pack"] = null;
      let failure: BrainPackImportCreateInput["failure"] = null;
      try {
        const decoded = codec.decode(artifact.bytes);
        pack = {
          decoded,
          manifestSha256: canonicalDigest(decoded.manifest),
          expandedBytes: decoded.manifest.inventory.reduce((sum, entry) => sum + entry.byteSize, 0),
        };
      } catch (error) {
        if (!(error instanceof BrainPackError)) throw error;
        failure = { code: error.code, message: error.message };
      }
      const { run } = await packs.createImportRun(
        access,
        { idempotencyKey: input.idempotencyKey, requestDigest, artifactId: input.artifactId, pack, failure },
        signal,
      );
      return { runId: run.id, status: importStatus(run) };
    },
  });

  function importStatus(run: BrainPackRunRecord) {
    return run.status as Exclude<BrainPackRunRecord["status"], "queued" | "snapshotting" | "encoding">;
  }

  const getImport = defineCapability({
    ...base(brainPackCapabilityContracts.knowledge_packs_import_get, titles.knowledge_packs_import_get),
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, { requiredRole: "admin" });
      const { signal } = context;
      const run = requireRun(await packs.getRun(access, input.runId, signal), "import");
      const preview = run.packRevision === null ? null : await packs.getImportPreview(access, run.id, signal);
      const page = await packs.listRunItems(access, { runId: run.id, cursor: input.cursor, limit: input.limit }, signal);
      return {
        run: summarize(run),
        preview:
          preview === null
            ? null
            : {
                ...preview,
                publisher: { ...preview.publisher },
                collections: preview.collections.map((collection) => ({ ...collection })),
                counts: { ...preview.counts },
                volume: { ...preview.volume },
                samples: preview.samples.map((sample) => ({ ...sample, excerpt: excerptOf(sample.excerpt) })),
              },
        items: { items: page.items.map(writableItem), nextCursor: page.nextCursor },
        receipt: importReceipt(run),
      };
    },
  });

  const reviewImport = defineCapability({
    ...base(brainPackCapabilityContracts.knowledge_packs_import_review, titles.knowledge_packs_import_review),
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, { requiredRole: "admin" });
      const result = requireFound(
        await packs.reviewImportRun(
          access,
          {
            runId: input.runId,
            expectedReviewVersion: input.expectedReviewVersion,
            collections: input.collections,
            items: input.items,
            projectId: input.projectId,
            tags: input.tags,
            idempotencyKey: input.idempotencyKey,
          },
          context.signal,
        ),
        "Import run",
      );
      return {
        runId: result.run.id,
        reviewVersion: result.run.reviewVersion,
        reviewDigest: result.reviewDigest,
        status: importStatus(result.run),
      };
    },
  });

  const publishImport = defineCapability({
    ...base(brainPackCapabilityContracts.knowledge_packs_import_publish, titles.knowledge_packs_import_publish),
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, { requiredRole: "admin" });
      const result = requireFound(
        await packs.queueImportPublication(
          access,
          { runId: input.runId, reviewDigest: input.reviewDigest, idempotencyKey: input.idempotencyKey, now: now() },
          context.signal,
        ),
        "Import run",
      );
      return { runId: result.run.id, status: importStatus(result.run), jobId: result.jobId };
    },
  });

  const listRuns = defineCapability({
    ...base(brainPackCapabilityContracts.knowledge_packs_runs_list, titles.knowledge_packs_runs_list),
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, { requiredRole: "admin" });
      const page = await packs.listRuns(
        access,
        {
          kind: input.kind,
          status: input.status,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        items: page.runs.map(summarize),
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      };
    },
  });

  const cancelRun = defineCapability({
    ...base(brainPackCapabilityContracts.knowledge_packs_runs_cancel, titles.knowledge_packs_runs_cancel),
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, { requiredRole: "admin" });
      const { signal } = context;
      const result = requireFound(
        await packs.cancelRun(access, { runId: input.runId, idempotencyKey: input.idempotencyKey, now: now() }, signal),
        "Run",
      );
      if (result.jobToCancel !== null) {
        await automation.requestCancel(result.jobToCancel, { requestedBy: access.accountId, now: now() }, signal);
      }
      return { runId: result.run.id, status: result.run.status, canceled: result.canceled };
    },
  });

  const retryRun = defineCapability({
    ...base(brainPackCapabilityContracts.knowledge_packs_runs_retry, titles.knowledge_packs_runs_retry),
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, { requiredRole: "admin" });
      const result = requireFound(
        await packs.retryRun(access, { runId: input.runId, idempotencyKey: input.idempotencyKey, now: now() }, context.signal),
        "Run",
      );
      return { runId: result.run.id, status: result.run.status };
    },
  });

  return {
    knowledge_packs_export: exportPack,
    knowledge_packs_export_get: getExport,
    knowledge_packs_import: startImport,
    knowledge_packs_import_get: getImport,
    knowledge_packs_import_review: reviewImport,
    knowledge_packs_import_publish: publishImport,
    knowledge_packs_runs_list: listRuns,
    knowledge_packs_runs_cancel: cancelRun,
    knowledge_packs_runs_retry: retryRun,
  } as const;
}
