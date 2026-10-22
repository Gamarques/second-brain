import { describe, expect, it } from "vitest";

import {
  BRAIN_PACK_FORMAT_VERSION,
  BrainPackError,
  brainPackErrorCodes,
  brainPackDocumentContentPath,
  brainPackItemIdentity,
  brainPackItemKeySchema,
  brainPackLimits,
  brainPackManifestSchema,
  brainPackPublisherNamespaceSchema,
  brainPackReviewDigest,
  brainPackExportRunStatuses,
  brainPackImportRunStatuses,
} from "../src/domain/brain-pack.js";

describe("Brain Pack format contract", () => {
  it("pins version 1 and the limits the plan fixed", () => {
    expect(BRAIN_PACK_FORMAT_VERSION).toBe(1);
    expect(brainPackLimits.compressedBytes).toBe(64 * 1024 * 1024);
    expect(brainPackLimits.expandedBytes).toBe(256 * 1024 * 1024);
    expect(brainPackLimits.entries).toBe(2_000);
    expect(brainPackLimits.documentCharacters).toBe(1_000_000);
    expect(brainPackLimits.chunksPerRevision).toBe(1_000);
    expect(brainPackLimits.synchronousExportDocuments).toBe(200);
    expect(brainPackLimits.synchronousExportExpandedBytes).toBe(16 * 1024 * 1024);
    expect(brainPackLimits.embeddingBatchChunks).toBe(64);
    expect(brainPackLimits.activeImportRunsPerAccount).toBe(1);
    expect(brainPackLimits.activeImportRunsPerDeployment).toBe(2);
  });

  it("accepts stable lowercase keys and rejects anything path-like", () => {
    for (const key of ["a", "architecture-notes", "guia-de-bienvenida", "x1"]) {
      expect(brainPackItemKeySchema.safeParse(key).success, key).toBe(true);
    }
    for (const key of ["", "-lead", "trail-", "Upper", "with space", "../up", "a/b", "ação", "a".repeat(121)]) {
      expect(brainPackItemKeySchema.safeParse(key).success, key).toBe(false);
    }
    expect(brainPackPublisherNamespaceSchema.safeParse("acme.engineering").success).toBe(true);
    expect(brainPackPublisherNamespaceSchema.safeParse("acme..eng").success).toBe(false);
    expect(brainPackDocumentContentPath("runbook-deploy")).toBe("documents/runbook-deploy.md");
  });

  it("identifies an item by publisher namespace, pack ID and item key", () => {
    expect(
      brainPackItemIdentity({
        publisherNamespace: "acme.engineering",
        packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60",
        itemKey: "runbook-deploy",
      }),
    ).toBe("acme.engineering/0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60/runbook-deploy");
  });

  it("validates a manifest and rejects a different major version explicitly", () => {
    const manifest = {
      formatVersion: 1,
      packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60",
      packRevision: 1,
      publisher: { namespace: "acme.engineering", displayName: "Acme" },
      title: "Pack",
      description: null,
      createdAt: "2026-09-07T12:00:00.000Z",
      language: "pt-BR",
      inventory: [{ path: "collections.json", byteSize: 2, sha256: "a".repeat(64) }],
    };
    expect(brainPackManifestSchema.safeParse(manifest).success).toBe(true);
    expect(brainPackManifestSchema.safeParse({ ...manifest, formatVersion: 2 }).success).toBe(false);
    expect(brainPackManifestSchema.safeParse({ ...manifest, packRevision: 0 }).success).toBe(false);
    expect(
      brainPackManifestSchema.safeParse({ ...manifest, inventory: [{ ...manifest.inventory[0], sha256: "zz" }] }).success,
    ).toBe(false);
  });

  it("names every error code and carries details", () => {
    expect([...brainPackErrorCodes]).toEqual([
      "PACK_FORMAT_UNSUPPORTED",
      "PACK_MANIFEST_INVALID",
      "PACK_INTEGRITY_FAILED",
      "PACK_LIMIT_EXCEEDED",
      "PACK_REFERENCE_INVALID",
      "PACK_REVIEW_STALE",
      "PACK_REVISION_CONFLICT",
    ]);
    const error = new BrainPackError("PACK_REFERENCE_INVALID", "A reference points nowhere.", [
      "documents[0].references[0]",
    ]);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("PACK_REFERENCE_INVALID");
    expect(error.details).toEqual(["documents[0].references[0]"]);
    expect(error.name).toBe("BrainPackError");
  });

  it("lists the run states of both kinds", () => {
    expect([...brainPackImportRunStatuses]).toEqual([
      "uploaded",
      "validating",
      "awaiting_review",
      "reviewed",
      "indexing",
      "publishing",
      "completed",
      "failed",
      "canceled",
    ]);
    expect([...brainPackExportRunStatuses]).toEqual([
      "queued",
      "snapshotting",
      "encoding",
      "completed",
      "failed",
      "canceled",
    ]);
  });

  it("binds the review digest to the manifest, selection, destinations, decisions and expected revisions, independent of order", () => {
    const base = {
      runId: "11111111-1111-4111-8111-111111111111",
      manifestSha256: "b".repeat(64),
      collections: [
        {
          collectionKey: "onboarding",
          destination: { knowledgeBaseId: "22222222-2222-4222-8222-222222222222" },
        },
        {
          collectionKey: "architecture",
          destination: { createKnowledgeBase: { name: "Architecture", description: null } },
        },
      ],
      items: [
        { itemKey: "runbook-deploy", decision: "create" as const, expectedLocalRevision: null },
        { itemKey: "architecture-notes", decision: "update" as const, expectedLocalRevision: 4 },
      ],
    };
    const digest = brainPackReviewDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      brainPackReviewDigest({
        ...base,
        items: [...base.items].reverse(),
        collections: [...base.collections].reverse(),
      }),
    ).toBe(digest);
    expect(
      brainPackReviewDigest({
        ...base,
        items: [base.items[0]!, { ...base.items[1]!, expectedLocalRevision: 5 }],
      }),
    ).not.toBe(digest);
    expect(brainPackReviewDigest({ ...base, manifestSha256: "c".repeat(64) })).not.toBe(digest);
  });
});
