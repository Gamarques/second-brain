import { describe, expect, it } from "vitest";

import { BrainPackError, brainPackReviewDigest } from "../src/domain/brain-pack.js";
import { buildBrainPackExportSource } from "../src/domain/brain-pack-export.js";
import {
  classifyBrainPackImportItem,
  resolveBrainPackReview,
} from "../src/domain/brain-pack-import.js";

const runId = "00000000-0000-4000-8000-00000000000a";
const documentId = "00000000-0000-4000-8000-00000000000b";
const revisionId = "00000000-0000-4000-8000-00000000000c";
const otherRevisionId = "00000000-0000-4000-8000-00000000000d";
const knowledgeBaseId = "00000000-0000-4000-8000-00000000000e";
const manifestSha256 = "1".repeat(64);
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

describe("classifyBrainPackImportItem", () => {
  const mapping = {
    documentId,
    importedPackRevision: 2,
    importedContentSha256: hashA,
    localRevisionId: revisionId,
  };
  const local = { documentId, currentRevision: 3, currentRevisionId: revisionId };

  it("calls an item new when nothing maps it", () => {
    expect(classifyBrainPackImportItem({ packRevision: 1, contentSha256: hashA, mapping: null, local: null })).toEqual({
      classification: "new",
      localDocumentId: null,
      localRevision: null,
    });
  });

  it("calls an item unchanged when the mapped text already matches", () => {
    expect(classifyBrainPackImportItem({ packRevision: 3, contentSha256: hashA, mapping, local })).toEqual({
      classification: "unchanged",
      localDocumentId: documentId,
      localRevision: 3,
    });
  });

  it("calls an item updated when the pack changed and the local document did not", () => {
    expect(classifyBrainPackImportItem({ packRevision: 3, contentSha256: hashB, mapping, local })).toMatchObject({
      classification: "updated",
    });
  });

  it("calls an item conflicting when both the pack and the local document changed", () => {
    expect(
      classifyBrainPackImportItem({
        packRevision: 3,
        contentSha256: hashB,
        mapping,
        local: { ...local, currentRevision: 4, currentRevisionId: otherRevisionId },
      }),
    ).toMatchObject({ classification: "conflicting", localRevision: 4 });
  });

  it("refuses to roll a mapping back to an older pack revision", () => {
    expect(classifyBrainPackImportItem({ packRevision: 1, contentSha256: hashB, mapping, local })).toMatchObject({
      classification: "invalid",
    });
  });
});

describe("resolveBrainPackReview", () => {
  const runItems = [
    { itemKey: "fresh", collectionKey: "notes", classification: "new", localDocumentId: null, localRevision: null },
    { itemKey: "moved", collectionKey: "notes", classification: "updated", localDocumentId: documentId, localRevision: 3 },
    { itemKey: "same", collectionKey: "guides", classification: "unchanged", localDocumentId: documentId, localRevision: 3 },
    { itemKey: "old", collectionKey: "guides", classification: "invalid", localDocumentId: documentId, localRevision: 3 },
  ] as const;
  const base = {
    runId,
    manifestSha256,
    packCollections: [{ key: "notes" }, { key: "guides" }],
    runItems,
    existingKnowledgeBaseIds: new Set([knowledgeBaseId]),
  };
  const collections = [
    { collectionKey: "notes", destination: { knowledgeBaseId } },
    { collectionKey: "guides", destination: { createKnowledgeBase: { name: "Guides", description: null } } },
  ];

  it("freezes decisions, marks unlisted items excluded and returns the digest publication must present", () => {
    const resolved = resolveBrainPackReview({
      ...base,
      review: {
        collections,
        items: [
          { itemKey: "fresh", decision: "create", expectedLocalRevision: null },
          { itemKey: "moved", decision: "update", expectedLocalRevision: 3 },
          { itemKey: "same", decision: "skip", expectedLocalRevision: null },
        ],
        projectId: null,
        tags: ["imported"],
      },
    });

    expect(resolved.items).toEqual([
      { itemKey: "fresh", decision: "create", expectedLocalRevision: null, destinationKnowledgeBaseId: knowledgeBaseId },
      { itemKey: "moved", decision: "update", expectedLocalRevision: 3, destinationKnowledgeBaseId: knowledgeBaseId },
      { itemKey: "same", decision: "skip", expectedLocalRevision: null, destinationKnowledgeBaseId: null },
    ]);
    expect(resolved.excludedItemKeys).toEqual(["old"]);
    expect(resolved.frozen.tags).toEqual(["imported"]);
    expect(resolved.reviewDigest).toBe(
      brainPackReviewDigest({ runId, manifestSha256, collections, items: resolved.frozen.items }),
    );
  });

  it("rejects decisions that do not fit the classification", () => {
    expect(() =>
      resolveBrainPackReview({
        ...base,
        review: {
          collections,
          items: [{ itemKey: "old", decision: "update", expectedLocalRevision: 3 }],
          projectId: null,
          tags: [],
        },
      }),
    ).toThrow(/old/u);
    expect(() =>
      resolveBrainPackReview({
        ...base,
        review: {
          collections,
          items: [{ itemKey: "fresh", decision: "update", expectedLocalRevision: 1 }],
          projectId: null,
          tags: [],
        },
      }),
    ).toThrow(/fresh/u);
  });

  it("treats a wrong expected revision as a revision conflict", () => {
    let caught: unknown;
    try {
      resolveBrainPackReview({
        ...base,
        review: {
          collections,
          items: [{ itemKey: "moved", decision: "update", expectedLocalRevision: 2 }],
          projectId: null,
          tags: [],
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrainPackError);
    expect((caught as BrainPackError).code).toBe("PACK_REVISION_CONFLICT");
  });

  it("requires a destination for every collection an imported item lands in", () => {
    expect(() =>
      resolveBrainPackReview({
        ...base,
        review: {
          collections: [collections[0]!],
          items: [{ itemKey: "same", decision: "separate_copy", expectedLocalRevision: 3 }],
          projectId: null,
          tags: [],
        },
      }),
    ).toThrow(/guides/u);
  });

  it("rejects unknown collections, unknown items, duplicates and missing knowledge bases", () => {
    const review = { projectId: null, tags: [] as const };
    expect(() =>
      resolveBrainPackReview({
        ...base,
        review: { ...review, collections: [{ collectionKey: "nope", destination: { knowledgeBaseId } }], items: [] },
      }),
    ).toThrow(/nope/u);
    expect(() =>
      resolveBrainPackReview({
        ...base,
        review: { ...review, collections, items: [{ itemKey: "ghost", decision: "skip", expectedLocalRevision: null }] },
      }),
    ).toThrow(/ghost/u);
    expect(() =>
      resolveBrainPackReview({
        ...base,
        review: {
          ...review,
          collections,
          items: [
            { itemKey: "fresh", decision: "skip", expectedLocalRevision: null },
            { itemKey: "fresh", decision: "create", expectedLocalRevision: null },
          ],
        },
      }),
    ).toThrow(/fresh/u);
    expect(() =>
      resolveBrainPackReview({
        ...base,
        review: {
          ...review,
          collections: [{ collectionKey: "notes", destination: { knowledgeBaseId: otherRevisionId } }],
          items: [],
        },
      }),
    ).toThrow(/knowledge base/u);
  });
});

describe("buildBrainPackExportSource", () => {
  it("derives stable keys from local identifiers and labels representations honestly", () => {
    const source = buildBrainPackExportSource(
      {
        frozenAt: "2026-09-07T10:00:00.000Z",
        knowledgeBases: [
          {
            id: knowledgeBaseId,
            name: "Notes",
            description: "Working notes",
            documents: [
              {
                id: documentId,
                title: "Alpha",
                tags: ["a"],
                sourceUri: "https://example.test/alpha",
                revision: { id: revisionId, number: 2, contentHash: hashA },
                content: "Alpha text",
                representation: "canonical",
                origin: null,
              },
              {
                id: otherRevisionId,
                title: "Beta",
                tags: [],
                sourceUri: null,
                revision: { id: otherRevisionId, number: 1, contentHash: hashB },
                content: "Beta text",
                representation: "reconstructed",
                origin: {
                  publisher: { namespace: "acme", displayName: "Acme" },
                  packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60",
                  packRevision: 4,
                  packTitle: "Upstream",
                  itemKey: "beta",
                  authors: [{ name: "Alex", uri: null }],
                },
              },
            ],
          },
        ],
      },
      {
        packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f61",
        packRevision: 1,
        publisher: { namespace: "local.brain", displayName: "Local" },
        title: "My pack",
        description: null,
        language: "en",
      },
    );

    expect(source.manifest).toEqual({
      formatVersion: 1,
      packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f61",
      packRevision: 1,
      publisher: { namespace: "local.brain", displayName: "Local" },
      title: "My pack",
      description: null,
      createdAt: "2026-09-07T10:00:00.000Z",
      language: "en",
    });
    expect(source.collections).toEqual([
      {
        key: `kb-${knowledgeBaseId}`,
        name: "Notes",
        description: "Working notes",
        documentKeys: [`doc-${documentId}`, `doc-${otherRevisionId}`],
      },
    ]);
    expect(source.documents[0]).toMatchObject({
      key: `doc-${documentId}`,
      collectionKey: `kb-${knowledgeBaseId}`,
      representation: "canonical",
      attribution: { authors: [], origin: null, sourceRevision: { number: 2, contentSha256: hashA } },
      references: [],
    });
    expect(source.documents[1]).toMatchObject({
      representation: "reconstructed",
      attribution: {
        authors: [{ name: "Alex", uri: null }],
        origin: { publisherNamespace: "acme", packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60", itemKey: "beta", packRevision: 4 },
      },
    });
  });
});
