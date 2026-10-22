import { describe, expect, it } from "vitest";

import { brainPackCapabilityContracts } from "../src/capabilities/brain-pack-schemas.js";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("Brain Pack capability contracts", () => {
  it("declares all nine capabilities with input and output schemas and administrative access", () => {
    expect(Object.keys(brainPackCapabilityContracts).sort()).toEqual([
      "knowledge_packs_export",
      "knowledge_packs_export_get",
      "knowledge_packs_import",
      "knowledge_packs_import_get",
      "knowledge_packs_import_publish",
      "knowledge_packs_import_review",
      "knowledge_packs_runs_cancel",
      "knowledge_packs_runs_list",
      "knowledge_packs_runs_retry",
    ]);
    for (const contract of Object.values(brainPackCapabilityContracts)) {
      expect(contract.minimumRole).toBe("admin");
      expect(typeof contract.description).toBe("string");
      expect(contract.annotations.readOnly).toBeTypeOf("boolean");
      expect(contract.annotations.openWorld).toBeTypeOf("boolean");
      expect(contract.timeoutMs).toBeGreaterThan(0);
    }
    expect(brainPackCapabilityContracts.knowledge_packs_import_publish.annotations.openWorld).toBe(true);
    expect(brainPackCapabilityContracts.knowledge_packs_import_get.annotations.readOnly).toBe(true);
  });

  it("validates an export request and requires an idempotency key", () => {
    const { input } = brainPackCapabilityContracts.knowledge_packs_export;
    const metadata = {
      title: "Engineering pack",
      description: null,
      publisherNamespace: "acme.engineering",
      publisherDisplayName: "Acme",
      language: "en",
    };
    expect(
      input.safeParse({
        selection: { knowledgeBaseIds: [uuid], documentIds: [] },
        metadata,
        packId: null,
        expectedPackRevision: null,
        idempotencyKey: "export-1",
      }).success,
    ).toBe(true);
    expect(
      input.safeParse({
        selection: { knowledgeBaseIds: [], documentIds: [] },
        metadata,
        packId: null,
        expectedPackRevision: null,
        idempotencyKey: "k",
      }).success,
    ).toBe(false);
    expect(
      input.safeParse({
        selection: { knowledgeBaseIds: [uuid], documentIds: [] },
        metadata,
        packId: null,
        expectedPackRevision: null,
      }).success,
    ).toBe(false);
  });

  it("validates a review with destinations and per-item decisions", () => {
    const { input } = brainPackCapabilityContracts.knowledge_packs_import_review;
    const valid = input.safeParse({
      runId: uuid,
      expectedReviewVersion: 0,
      collections: [
        { collectionKey: "onboarding", destination: { knowledgeBaseId: uuid } },
        {
          collectionKey: "architecture",
          destination: { createKnowledgeBase: { name: "Architecture", description: null } },
        },
      ],
      items: [
        { itemKey: "runbook-deploy", decision: "create", expectedLocalRevision: null },
        { itemKey: "architecture-notes", decision: "update", expectedLocalRevision: 4 },
      ],
      projectId: null,
      tags: ["imported"],
      idempotencyKey: "review-1",
    });
    expect(valid.success).toBe(true);
    expect(
      input.safeParse({
        ...valid.data,
        items: [{ itemKey: "x", decision: "update", expectedLocalRevision: null }],
      }).success,
    ).toBe(false);
    expect(
      input.safeParse({
        ...valid.data,
        collections: [{ collectionKey: "onboarding", destination: {} }],
      }).success,
    ).toBe(false);
  });

  it("pages run lists with a bounded limit", () => {
    const { input } = brainPackCapabilityContracts.knowledge_packs_runs_list;
    expect(input.safeParse({ kind: "import", status: null, cursor: null, limit: 20 }).success).toBe(true);
    expect(input.safeParse({ kind: null, status: null, cursor: null, limit: 500 }).success).toBe(false);
  });

  it("shapes the import receipt", () => {
    const { output } = brainPackCapabilityContracts.knowledge_packs_import_get;
    const parsed = output.safeParse({
      run: {
        id: uuid,
        kind: "import",
        status: "completed",
        packId: uuid,
        packRevision: 3,
        publisher: { namespace: "acme.engineering", displayName: "Acme" },
        title: "Pack",
        artifactId: uuid,
        reviewVersion: 2,
        reviewDigest: "a".repeat(64),
        progress: { stage: "completed", processedItems: 4, totalItems: 4 },
        sanitizedError: null,
        createdAt: "2026-09-07T12:00:00.000Z",
        updatedAt: "2026-09-07T12:05:00.000Z",
        completedAt: "2026-09-07T12:05:00.000Z",
      },
      preview: null,
      items: { items: [], nextCursor: null },
      receipt: {
        runId: uuid,
        packId: uuid,
        packRevision: 3,
        publishedAt: "2026-09-07T12:05:00.000Z",
        created: [{ itemKey: "runbook-deploy", documentId: uuid, revisionId: uuid }],
        updated: [],
        skipped: [{ itemKey: "x", reason: "unchanged" }],
        excluded: [],
      },
    });
    expect(parsed.success).toBe(true);
  });
});
