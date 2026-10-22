import { createEngine } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { createIngestionCapabilities } from "../src/capabilities/ingestion.js";
import {
  ingestionProposalPayloadDigest,
  ingestionReviewDigest,
} from "../src/domain.js";
import type {
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
  IngestProposal,
  IngestReceipt,
  IngestReview,
  IngestRun,
  IngestionModelResult,
  IngestionProvider,
  IngestionStore,
  ReviewedIngestionCommitter,
} from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const sourceId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";
const proposalId = "00000000-0000-4000-8000-000000000005";
const reviewId = "00000000-0000-4000-8000-000000000006";
const receiptId = "00000000-0000-4000-8000-000000000007";
const entityId = "00000000-0000-4000-8000-000000000008";
const listId = "00000000-0000-4000-8000-000000000009";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const instant = "2026-08-16T12:00:00.000Z";
const principal = { id: accountId };

function run(overrides: Partial<IngestRun> = {}): IngestRun {
  return {
    id: runId,
    sourceId,
    status: "awaiting_review",
    proposalProvider: "test-provider",
    proposalModel: "test-model",
    schemaVersion: "ingestion-proposal/v1",
    proposalCount: 1,
    proposalDigest: digestA,
    responseDigest: digestB,
    reviewedDigest: null,
    createdAt: instant,
    updatedAt: instant,
    ...overrides,
  };
}

function proposal(overrides: Partial<IngestProposal> = {}): IngestProposal {
  return {
    id: proposalId,
    runId,
    ordinal: 0,
    payload: {
      kind: "memory",
      content: "Ada drinks café.",
      category: "preference",
      tags: ["coffee"],
      projectId: null,
      personIds: [],
    },
    confidence: 0.91,
    sourceStart: 11,
    sourceEnd: 15,
    sourceQuote: "café",
    payloadDigest: digestB,
    createdAt: instant,
    ...overrides,
  };
}

function review(): IngestReview {
  return {
    id: reviewId,
    runId,
    reviewDigest: digestB,
    items: [{ proposalId, decision: "accept", replacement: null }],
    provenance: {
      kind: "account",
      accountId,
      clientId: null,
      source: "direct",
    },
    createdAt: instant,
  };
}

function receipt(overrides: Partial<IngestReceipt> = {}): IngestReceipt {
  return {
    id: receiptId,
    runId,
    proposalId,
    entityType: "memory",
    entityId,
    status: "committed",
    reason: null,
    effectDigest: digestA,
    createdAt: instant,
    ...overrides,
  };
}

function sourceSpan(excerpt: string, quote: string) {
  const start = excerpt.indexOf(quote);
  if (start < 0) throw new Error("Test quote was not found.");
  return { start, end: start + quote.length, quote };
}

function confidenceModelResult(
  excerpt: string,
  confidence: number,
): IngestionModelResult {
  return {
    payload: {
      proposals: [{
        payload: {
          kind: "memory",
          content: "Ada drinks café.",
          category: null,
          tags: [],
          projectId: null,
          personIds: [],
        },
        confidence,
        sourceSpan: sourceSpan(excerpt, "café"),
      }],
    },
    provider: "test-provider",
    model: "test-model",
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

interface HarnessOptions {
  readonly modelResult?: IngestionModelResult;
  readonly createReplay?: boolean;
  readonly pendingReplay?: boolean;
  readonly committedReceipts?: readonly IngestReceipt[];
  readonly tombstonedReview?: boolean;
  readonly configuredProvider?: string;
  readonly configuredModel?: string;
  readonly proposeFailures?: number;
}

function setup(options: HarnessOptions = {}) {
  const accessRequests: BrainAccessRequest[] = [];
  const savedProposalInputs: Parameters<IngestionStore["saveProposals"]>[2][] = [];
  const savedReviewInputs: Parameters<IngestionStore["saveReview"]>[2][] = [];
  const commitInputs: Parameters<ReviewedIngestionCommitter["commitReviewedRun"]>[2][] = [];
  const modelCalls: Parameters<IngestionProvider["propose"]>[0][] = [];
  const events: string[] = [];
  const access: BrainAccessContext = {
    accountId,
    role: "owner",
    actor: {
      kind: "account",
      accountId,
      clientId: null,
      source: "direct",
      requestId: "request",
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
  const persistedAttribution = {
    kind: "account" as const,
    accountId: options.tombstonedReview ? null : accountId,
    clientId: null,
    source: "direct" as const,
  };
  let currentRun = options.pendingReplay
    ? run({
        status: "proposing",
        proposalCount: 0,
        proposalDigest: null,
        responseDigest: null,
      })
    : run();
  let currentProposals: readonly IngestProposal[] = options.pendingReplay ? [] : [proposal()];
  let currentReview: IngestReview | null = {
    ...review(),
    provenance: persistedAttribution,
  };
  let currentReceipts: readonly IngestReceipt[] = options.committedReceipts ?? [receipt()];
  let sourceExists = (options.createReplay ?? false) || (options.pendingReplay ?? false);

  const accessStore: BrainAccessStore = {
    async resolveAccess(request) {
      accessRequests.push(request);
      return {
        ...access,
        actor: {
          ...access.actor,
          requestId: request.requestId,
          source: request.source,
        },
      };
    },
    async revalidateAccess(value) {
      return value;
    },
    async getTimeZone() {
      return "America/Sao_Paulo";
    },
  };

  const ingestionStore: IngestionStore = {
    async createSourceAndRun(_access, input) {
      events.push("reserve");
      const created = !sourceExists;
      if (created) {
        sourceExists = true;
        currentRun = run({
          status: "proposing",
          proposalCount: 0,
          proposalDigest: null,
          responseDigest: null,
          proposalProvider: input.proposalProvider,
          proposalModel: input.proposalModel,
        });
      }
      return {
        source: {
          id: sourceId,
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
          excerpt: input.excerpt,
          capturedAt: input.capturedAt,
          provenance: persistedAttribution,
          createdAt: instant,
        },
        run: currentRun,
        created,
      };
    },
    async saveProposals(_access, _runId, input) {
      events.push("save");
      savedProposalInputs.push(input);
      currentProposals = input.proposals.map((item, index) => ({
        ...item,
        id: index === 0 ? proposalId : `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
        runId,
        createdAt: instant,
      }));
      currentRun = run({
        proposalCount: currentProposals.length,
        responseDigest: input.responseDigest,
      });
      currentReview = null;
      currentReceipts = [];
      return { run: currentRun, proposals: currentProposals };
    },
    async saveReview(_access, _runId, input) {
      savedReviewInputs.push(input);
      currentReview = {
        id: reviewId,
        runId,
        reviewDigest: input.reviewDigest,
        items: input.items,
        provenance: persistedAttribution,
        createdAt: instant,
      };
      return currentReview;
    },
    async getRunStatus() {
      return {
        run: currentRun,
        proposals: currentProposals,
        review: currentReview,
        receipts: currentReceipts,
      };
    },
  };
  const ingestionCommitter: ReviewedIngestionCommitter = {
    async commitReviewedRun(_access, _runId, input) {
      commitInputs.push(input);
      currentRun = run({ status: "completed", reviewedDigest: input.reviewedDigest });
      return { run: currentRun, receipts: currentReceipts };
    },
  };

  const excerpt = "Ada drinks café every morning.";
  const modelResult: IngestionModelResult = options.modelResult ?? {
    payload: {
      proposals: [{
        payload: {
          kind: "task",
          listId,
          title: "Buy beans",
          description: null,
          priority: "normal",
          dueAt: "2026-08-17T12:30:00+05:30",
          projectId: null,
          goalIds: [],
        },
        confidence: 0.8,
        sourceSpan: sourceSpan(excerpt, "café"),
      }],
    },
    provider: options.configuredProvider ?? "test-provider",
    model: options.configuredModel ?? "test-model",
    finishReason: "stop",
    usage: { inputTokens: 20, outputTokens: 10 },
  };
  let remainingProposeFailures = options.proposeFailures ?? 0;
  const provider: IngestionProvider = {
    ingestionProvider: options.configuredProvider ?? "test-provider",
    ingestionModel: options.configuredModel ?? "test-model",
    async propose(input) {
      events.push("propose");
      modelCalls.push(input);
      if (remainingProposeFailures > 0) {
        remainingProposeFailures -= 1;
        throw new Error("The OpenRouter request timed out.");
      }
      return modelResult;
    },
  };

  const capabilities = createIngestionCapabilities(
    accessStore,
    ingestionStore,
    ingestionCommitter,
    provider,
  );
  const engine = createEngine({
    name: "ingestion-test",
    version: "1.0.0",
    capabilities,
  });
  return {
    engine,
    capabilities,
    excerpt,
    accessRequests,
    savedProposalInputs,
    savedReviewInputs,
    commitInputs,
    modelCalls,
    events,
  };
}

describe("reviewed ingestion capabilities", () => {
  it("exposes separate capabilities and no legacy auto-commit capability", () => {
    const { capabilities, engine } = setup();

    expect(Object.keys(capabilities)).toEqual([
      "ingestion_propose",
      "ingestion_review",
      "ingestion_commit",
      "ingestion_status",
    ]);
    expect(capabilities.ingestion_propose.annotations).toEqual({
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: true,
    });
    expect(capabilities.ingestion_commit.annotations).toMatchObject({
      destructive: true,
      idempotent: true,
      openWorld: true,
    });
    expect(engine.list().find(({ id }) => id === "ingestion_propose")?.annotations)
      .toEqual({
        readOnly: false,
        destructive: false,
        idempotent: true,
        openWorld: true,
      });
  });

  it("requires authentication before resolving brain access", async () => {
    const { engine, accessRequests } = setup();

    await expect(engine.invoke("ingestion_status", { runId }, { principal: null }))
      .rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(accessRequests).toHaveLength(0);
  });

  it("persists cited proposals without committing content and canonicalizes offset timestamps", async () => {
    const {
      engine,
      excerpt,
      savedProposalInputs,
      accessRequests,
      modelCalls,
      commitInputs,
      events,
    } = setup();

    const result = await engine.invoke(
      "ingestion_propose",
      {
        excerpt,
        capturedAt: "2026-08-16T17:30:00+05:30",
        idempotencyKey: "conversation:42",
      },
      { principal, source: "direct", requestId: "request-propose" },
    );

    expect(result.replayed).toBe(false);
    expect(result.proposalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.payload).toMatchObject({
      kind: "task",
      dueAt: "2026-08-17T07:00:00.000Z",
    });
    expect(result.proposals[0]?.sourceQuote).toBe("café");
    expect(savedProposalInputs).toHaveLength(1);
    const savedProposal = savedProposalInputs[0]?.proposals[0];
    if (savedProposal === undefined) throw new Error("Expected a saved proposal.");
    expect(savedProposal?.payloadDigest).toBe(
      ingestionProposalPayloadDigest(savedProposal.payload),
    );
    expect(savedProposal).toMatchObject({ sourceStart: 11, sourceEnd: 15 });
    expect(modelCalls[0]?.capturedAt).toBe("2026-08-16T12:00:00.000Z");
    expect(accessRequests[0]).toMatchObject({ requiredRole: "editor" });
    expect(commitInputs).toHaveLength(0);
    expect(events).toEqual(["reserve", "propose", "save"]);
  });

  it("rejects ungrounded UTF-16 source spans with a stable sanitized error", async () => {
    const excerpt = "Ada drinks café every morning.";
    const { engine, savedProposalInputs } = setup({
      modelResult: {
        payload: {
          proposals: [{
            payload: {
              kind: "memory",
              content: "Ada drinks café.",
              category: null,
              tags: [],
              projectId: null,
              personIds: [],
            },
            confidence: 1,
            sourceSpan: { ...sourceSpan(excerpt, "café"), quote: "tea" },
          }],
        },
        provider: "secret-provider-error",
        model: "test-model",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });

    const failure: unknown = await engine.invoke(
      "ingestion_propose",
      { excerpt, idempotencyKey: "bad-span" },
      { principal },
    ).then(() => null).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "EXECUTION_FAILED" });
    expect((failure as { cause?: Error }).cause?.message).toBe(
      "The ingestion model could not produce a valid proposal set.",
    );
    expect((failure as { cause?: Error }).cause?.message).not.toContain("secret");
    expect(savedProposalInputs).toHaveLength(0);
  });

  it("repairs miscounted offsets when the model quote appears verbatim in the excerpt", async () => {
    const excerpt = "Ada drinks café every morning.";
    const { engine, savedProposalInputs } = setup({
      modelResult: {
        payload: {
          proposals: [{
            payload: {
              kind: "memory",
              content: "Ada drinks café.",
              category: null,
              tags: [],
              projectId: null,
              personIds: [],
            },
            confidence: 1,
            sourceSpan: { start: 2, end: 6, quote: "café" },
          }],
        },
        provider: "test-provider",
        model: "test-model",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    });

    const result = await engine.invoke(
      "ingestion_propose",
      { excerpt, idempotencyKey: "repaired-span" },
      { principal },
    );

    expect(result.proposals[0]).toMatchObject({
      sourceStart: 11,
      sourceEnd: 15,
      sourceQuote: "café",
    });
    expect(savedProposalInputs[0]?.proposals[0]).toMatchObject({
      sourceStart: 11,
      sourceEnd: 15,
    });
  });

  it("retries transient model failures and fails only when every attempt fails", async () => {
    const recovered = setup({ proposeFailures: 2 });
    const result = await recovered.engine.invoke(
      "ingestion_propose",
      { excerpt: recovered.excerpt, idempotencyKey: "retry-recovered" },
      { principal },
    );
    expect(result.replayed).toBe(false);
    expect(recovered.events.filter((event) => event === "propose")).toHaveLength(3);

    const exhausted = setup({ proposeFailures: 3 });
    const failure: unknown = await exhausted.engine.invoke(
      "ingestion_propose",
      { excerpt: exhausted.excerpt, idempotencyKey: "retry-exhausted" },
      { principal },
    ).then(() => null).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "EXECUTION_FAILED" });
    expect((failure as { cause?: Error }).cause?.message).toBe(
      "The ingestion model could not produce a valid proposal set.",
    );
    expect(exhausted.events.filter((event) => event === "propose")).toHaveLength(3);
  });

  it("accepts a task proposal without a stated task list and normalizes empty nullable text", async () => {
    const excerpt = "Ada owns the follow-up task for the launch review.";
    const { engine, savedProposalInputs } = setup({
      modelResult: {
        payload: {
          proposals: [{
            payload: {
              kind: "task",
              listId: null,
              title: "Follow-up task for the launch review",
              description: "",
              priority: "high",
              dueAt: null,
              projectId: null,
              goalIds: [],
            },
            confidence: 0.9,
            sourceSpan: sourceSpan(excerpt, "Ada owns the follow-up task"),
          }],
        },
        provider: "test-provider",
        model: "test-model",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    });

    const result = await engine.invoke(
      "ingestion_propose",
      { excerpt, idempotencyKey: "task-without-list" },
      { principal },
    );

    expect(result.proposals[0]?.payload).toMatchObject({
      kind: "task",
      listId: null,
      description: null,
    });
    expect(savedProposalInputs[0]?.proposals[0]?.payload).toMatchObject({
      listId: null,
      description: null,
    });
  });

  it("rejects a model envelope that does not match the configured provider identity", async () => {
    const excerpt = "Ada drinks café every morning.";
    const { engine, savedProposalInputs, events } = setup({
      modelResult: {
        payload: {
          proposals: [{
            payload: {
              kind: "memory",
              content: "Ada drinks café.",
              category: null,
              tags: [],
              projectId: null,
              personIds: [],
            },
            confidence: 1,
            sourceSpan: sourceSpan(excerpt, "café"),
          }],
        },
        provider: "unexpected-provider",
        model: "test-model",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    });

    const failure: unknown = await engine.invoke(
      "ingestion_propose",
      { excerpt, idempotencyKey: "mismatched-envelope" },
      { principal },
    ).then(() => null).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "EXECUTION_FAILED" });
    expect((failure as { cause?: Error }).cause?.message).toBe(
      "The ingestion model could not produce a valid proposal set.",
    );
    expect(savedProposalInputs).toHaveLength(0);
    expect(events).toEqual(["reserve", "propose"]);
  });

  it("accepts three confidence decimals and rejects values the database would round", async () => {
    const excerpt = "Ada drinks café every morning.";
    const accepted = setup({ modelResult: confidenceModelResult(excerpt, 0.123) });
    const rejected = setup({ modelResult: confidenceModelResult(excerpt, 0.1234) });

    await expect(accepted.engine.invoke(
      "ingestion_propose",
      { excerpt, idempotencyKey: "confidence:accepted" },
      { principal },
    )).resolves.toMatchObject({ proposals: [{ confidence: 0.123 }] });

    const failure: unknown = await rejected.engine.invoke(
      "ingestion_propose",
      { excerpt, idempotencyKey: "confidence:rejected" },
      { principal },
    ).then(() => null).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "EXECUTION_FAILED" });
    expect((failure as { cause?: Error }).cause?.message).toBe(
      "The ingestion model could not produce a valid proposal set.",
    );
    expect(rejected.savedProposalInputs).toHaveLength(0);
  });

  it("recovers the persisted proposal set on an idempotent replay", async () => {
    const { engine, excerpt, savedProposalInputs, modelCalls, events } = setup({
      createReplay: true,
    });

    const result = await engine.invoke(
      "ingestion_propose",
      { excerpt, idempotencyKey: "conversation:42" },
      { principal },
    );

    expect(result.replayed).toBe(true);
    expect(result.proposals).toMatchObject([{ id: proposalId, payload: { kind: "memory" } }]);
    expect(savedProposalInputs).toHaveLength(0);
    expect(modelCalls).toHaveLength(0);
    expect(events).toEqual(["reserve"]);
  });

  it("does not call the provider again after a lost propose response", async () => {
    const { engine, excerpt, modelCalls, events } = setup();
    const input = { excerpt, idempotencyKey: "conversation:lost-response" };

    const first = await engine.invoke("ingestion_propose", input, { principal });
    const replay = await engine.invoke("ingestion_propose", input, { principal });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.run.id).toBe(first.run.id);
    expect(replay.proposalDigest).toBe(first.proposalDigest);
    expect(modelCalls).toHaveLength(1);
    expect(events).toEqual(["reserve", "propose", "save", "reserve"]);
  });

  it("recovers a completed historical run after the configured model changes", async () => {
    const { engine, excerpt, modelCalls } = setup({
      createReplay: true,
      configuredProvider: "new-provider",
      configuredModel: "new-model",
    });

    const result = await engine.invoke(
      "ingestion_propose",
      { excerpt, idempotencyKey: "conversation:historical" },
      { principal },
    );

    expect(result.replayed).toBe(true);
    expect(result.run).toMatchObject({
      proposalProvider: "test-provider",
      proposalModel: "test-model",
    });
    expect(modelCalls).toHaveLength(0);
  });

  it("resumes a reserved proposing run after a pre-model crash", async () => {
    const { engine, excerpt, modelCalls, events } = setup({ pendingReplay: true });

    const result = await engine.invoke(
      "ingestion_propose",
      { excerpt, idempotencyKey: "conversation:reserved" },
      { principal },
    );

    expect(result.replayed).toBe(true);
    expect(result.proposals).toHaveLength(1);
    expect(modelCalls).toHaveLength(1);
    expect(events).toEqual(["reserve", "propose", "save"]);
  });

  it("reviews only explicit proposal IDs and cannot inject replacement records", async () => {
    const { engine, savedReviewInputs } = setup();

    const result = await engine.invoke(
      "ingestion_review",
      {
        runId,
        proposalDigest: digestA,
        items: [{ proposalId, decision: "accept" }],
        idempotencyKey: "review:42",
      },
      { principal },
    );

    expect(result.items).toEqual([{ proposalId, decision: "accept", replacement: null }]);
    expect(result.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(savedReviewInputs[0]).toMatchObject({
      expectedProposalDigest: digestA,
      items: [{ proposalId, decision: "accept", replacement: null }],
    });
    expect(result.reviewDigest).toBe(ingestionReviewDigest({
      runId,
      proposalDigest: digestA,
      items: [{ proposalId, decision: "accept", replacement: null }],
    }));

    await expect(engine.invoke(
      "ingestion_review",
      {
        runId,
        proposalDigest: digestA,
        items: [{
          proposalId,
          decision: "accept",
          // @ts-expect-error The runtime must reject replacement payload injection.
          replacement: {
            kind: "memory",
            content: "Injected",
            category: null,
            tags: [],
            projectId: null,
            personIds: [],
          },
        }],
        idempotencyKey: "review:43",
      },
      { principal },
    )).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("commits the reviewed digest and returns one exact-once receipt", async () => {
    const { engine, commitInputs } = setup();

    const result = await engine.invoke(
      "ingestion_commit",
      {
        runId,
        reviewedDigest: digestB,
        mode: "durable_partial",
        idempotencyKey: "commit:42",
      },
      { principal },
    );

    expect(commitInputs).toEqual([{
      reviewedDigest: digestB,
      mode: "durable_partial",
      idempotencyKey: "commit:42",
    }]);
    expect(result.receipts).toMatchObject([{
      proposalId,
      entityId,
      status: "committed",
    }]);
  });

  it("reviews and commits an exact empty proposal set without deadlocking", async () => {
    const excerpt = "Nothing durable was discussed.";
    const { engine } = setup({
      modelResult: {
        payload: { proposals: [] },
        provider: "test-provider",
        model: "test-model",
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 2 },
      },
    });

    const proposed = await engine.invoke(
      "ingestion_propose",
      { excerpt, idempotencyKey: "conversation:empty" },
      { principal },
    );
    const reviewed = await engine.invoke(
      "ingestion_review",
      {
        runId: proposed.run.id,
        proposalDigest: proposed.proposalDigest,
        items: [],
        idempotencyKey: "review:empty",
      },
      { principal },
    );
    const committed = await engine.invoke(
      "ingestion_commit",
      {
        runId: proposed.run.id,
        reviewedDigest: reviewed.reviewDigest,
        idempotencyKey: "commit:empty",
      },
      { principal },
    );

    expect(proposed.proposals).toEqual([]);
    expect(reviewed.items).toEqual([]);
    expect(committed.receipts).toEqual([]);
  });

  it("fails output validation if a store returns two effects for one proposal", async () => {
    const { engine } = setup({
      committedReceipts: [receipt(), receipt({ id: "00000000-0000-4000-8000-000000000010" })],
    });

    await expect(engine.invoke(
      "ingestion_commit",
      { runId, reviewedDigest: digestB, idempotencyKey: "commit:duplicate" },
      { principal },
    )).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
  });

  it("reads status with viewer access and never calls the model", async () => {
    const { engine, accessRequests, modelCalls } = setup({ tombstonedReview: true });

    const result = await engine.invoke(
      "ingestion_status",
      { runId },
      { principal },
    );

    expect(result).toMatchObject({
      result: {
        run: { id: runId },
        proposals: [{ id: proposalId }],
        review: {
          id: reviewId,
          provenance: {
            kind: "account",
            accountId: null,
            clientId: null,
            source: "direct",
          },
        },
        receipts: [{ id: receiptId }],
      },
    });
    expect(accessRequests[0]).toMatchObject({ requiredRole: "viewer" });
    expect(modelCalls).toHaveLength(0);
  });
});
