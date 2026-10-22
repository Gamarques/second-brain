import { createEngine } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import { createBrainAskCapabilities } from "../src/capabilities/brain-ask.js";
import {
  DECISION_EMBEDDING_RECIPE_VERSION,
  MEMORY_EMBEDDING_RECIPE_VERSION,
} from "../src/domain.js";
import type {
  AnswerProvider,
  BrainAccessContext,
  BrainAccessStore,
  BrainEvidenceStore,
  EmbeddingEntityType,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
  EvidenceItem,
  EvidenceSearchResult,
} from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const memorySpaceId = "00000000-0000-4000-8000-000000000004";
const decisionSpaceId = "00000000-0000-4000-8000-000000000005";
const principal = { id: accountId };
const noEvidenceAnswer =
  "Your second brain has no recorded information that answers this.";
const before = "2026-08-15T12:00:00.000Z";
const asOf = "2026-08-16T12:00:00.000Z";
const after = "2026-08-17T12:00:00.000Z";

function id(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function accessFor(requestId: string): BrainAccessContext {
  return {
    accountId,
    role: "owner",
    actor: {
      kind: "account",
      accountId,
      clientId: null,
      source: "direct",
      requestId,
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
}

function space(
  entityType: "memory" | "decision",
  idValue: string,
): EmbeddingSpace {
  return {
    id: idValue,
    entityType,
    provider: "fake",
    model: "embed-v1",
    modelRevision: "2026-08-01",
    recipeVersion:
      entityType === "memory"
        ? MEMORY_EMBEDDING_RECIPE_VERSION
        : DECISION_EMBEDDING_RECIPE_VERSION,
    dimensions: 3,
    metric: "cosine",
    status: "active",
    createdAt: before,
    promotedAt: before,
    retiredAt: null,
  };
}

function evidence(
  sequence: number,
  type: EvidenceItem["type"],
  content: string,
  overrides: Partial<EvidenceItem> = {},
): EvidenceItem {
  return {
    type,
    id: id(100 + sequence),
    versionId: null,
    content,
    score: 0.9 - sequence / 100,
    effectiveAt: before,
    recordedAt: before,
    supersededAt: null,
    sourceIds: [],
    ...overrides,
  };
}

function result(
  items: readonly EvidenceItem[],
  overrides: Partial<EvidenceSearchResult["coverage"]> = {},
): EvidenceSearchResult {
  return {
    evidence: items,
    coverage: {
      completeFrom: "2026-01-01T00:00:00.000Z",
      requestedAsOf: null,
      complete: true,
      warnings: [],
      ...overrides,
    },
  };
}

function setup(initial = result([])) {
  const accessRequests: Parameters<BrainAccessStore["resolveAccess"]>[0][] = [];
  const revalidations: string[] = [];
  const accessStore: BrainAccessStore = {
    async resolveAccess(request) {
      accessRequests.push(request);
      return accessFor(request.requestId);
    },
    async revalidateAccess(access, role) {
      revalidations.push(role);
      return access;
    },
    async getTimeZone() {
      return "America/Sao_Paulo";
    },
  };

  const spaces = new Map<EmbeddingEntityType, EmbeddingSpace | null>([
    ["memory", space("memory", memorySpaceId)],
    ["decision", space("decision", decisionSpaceId)],
  ]);
  const embeddingSpaces: EmbeddingSpaceStore = {
    async getActiveSpace(_access, entityType) {
      return spaces.get(entityType) ?? null;
    },
    async createSpace() {
      throw new Error("not used");
    },
    async promoteSpace() {
      throw new Error("not used");
    },
  };

  const embedCalls: string[][] = [];
  const embeddings: EmbeddingProvider = {
    provider: "fake",
    model: "embed-v1",
    modelRevision: "2026-08-01",
    dimensions: 3,
    async embed(texts) {
      embedCalls.push([...texts]);
      return texts.map(() => [1, 0, 0]);
    },
  };

  let evidenceResult = initial;
  const evidenceCalls: Parameters<BrainEvidenceStore["searchEvidence"]>[1][] =
    [];
  const evidenceStore: BrainEvidenceStore = {
    async searchEvidence(_access, input) {
      evidenceCalls.push(input);
      return evidenceResult;
    },
  };

  let answer = "A grounded answer.";
  let answerable = true;
  let citationIndexes: readonly number[] = [1];
  const reasonCalls: Parameters<AnswerProvider["reason"]>[0][] = [];
  const answers: AnswerProvider = {
    async answer() {
      throw new Error("not used");
    },
    async reason(input) {
      reasonCalls.push(input);
      return { answer, answerable, citationIndexes };
    },
  };

  const capabilities = createBrainAskCapabilities(
    accessStore,
    evidenceStore,
    embeddingSpaces,
    embeddings,
    answers,
  );
  const engine = createEngine({ name: "test", version: "1.0.0", capabilities });
  return {
    engine,
    controls: {
      accessRequests,
      revalidations,
      embedCalls,
      evidenceCalls,
      reasonCalls,
      setEvidence(value: EvidenceSearchResult) {
        evidenceResult = value;
      },
      setSpace(entityType: EmbeddingEntityType, value: EmbeddingSpace | null) {
        spaces.set(entityType, value);
      },
      setReason(value: {
        answer?: string;
        answerable?: boolean;
        citationIndexes?: readonly number[];
      }) {
        answer = value.answer ?? answer;
        answerable = value.answerable ?? answerable;
        citationIndexes = value.citationIndexes ?? citationIndexes;
      },
    },
  };
}

describe("brain_ask", () => {
  it("uses distinct tagged spaces and grounds reasoning across cognitive and activity evidence", async () => {
    const items = [
      evidence(1, "memory", "We do not use microservices."),
      evidence(2, "decision", "Decision: use a modular monolith."),
      evidence(3, "goal", "Goal: launch the product."),
      evidence(4, "priority_plan", "Priority #1: product launch."),
      evidence(5, "activity", "Activity: worked on infrastructure."),
    ];
    const { engine, controls } = setup(result(items));
    controls.setReason({ citationIndexes: [1, 2, 3, 4, 5] });

    const response = await engine.invoke(
      "brain_ask",
      {
        question: "Are my actions aligned with the launch?",
        topK: 10,
      },
      { principal },
    );

    expect(response.citations.map(({ type }) => type)).toEqual([
      "memory",
      "decision",
      "goal",
      "priority_plan",
      "activity",
    ]);
    expect(response.coverage).toEqual({
      completeFrom: "2026-01-01T00:00:00.000Z",
      requestedAsOf: null,
      complete: true,
      warnings: [],
    });
    expect(controls.embedCalls).toEqual([
      ["Are my actions aligned with the launch?"],
    ]);
    expect(controls.evidenceCalls[0]!.embeddings).toMatchObject({
      memories: { spaceId: memorySpaceId, vector: [1, 0, 0] },
      decisions: { spaceId: decisionSpaceId, vector: [1, 0, 0] },
      insights: null,
    });
    expect(controls.evidenceCalls[0]!.limits).toMatchObject({
      priorities: 4,
      activities: 12,
    });
    expect(controls.accessRequests[0]).toMatchObject({
      requiredRole: "viewer",
    });
    expect(controls.revalidations).toEqual(["viewer", "viewer"]);
  });

  it("uses lexical and state evidence without calling embeddings when no semantic space exists", async () => {
    const task = evidence(1, "task", "Open task: reply to Ana.");
    const { engine, controls } = setup(result([task]));
    controls.setSpace("memory", null);
    controls.setSpace("decision", null);

    const response = await engine.invoke(
      "brain_ask",
      { question: "What am I forgetting?" },
      { principal },
    );

    expect(response.citations).toHaveLength(1);
    expect(controls.embedCalls).toHaveLength(0);
    expect(controls.evidenceCalls[0]!.embeddings).toEqual({
      memories: null,
      decisions: null,
      insights: null,
    });
  });

  it("fails closed instead of mixing an incompatible active space", async () => {
    const { engine, controls } = setup();
    controls.setSpace("decision", {
      ...space("decision", decisionSpaceId),
      recipeVersion: MEMORY_EMBEDDING_RECIPE_VERSION,
    });

    await expect(
      engine.invoke(
        "brain_ask",
        { question: "What did I decide?" },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
    expect(controls.evidenceCalls).toHaveLength(0);
  });

  it("filters future and already superseded or revoked evidence before calling the model", async () => {
    const valid = evidence(1, "decision", "The valid decision.");
    const future = evidence(2, "decision", "A future decision.", {
      effectiveAt: after,
      recordedAt: after,
      score: 1,
    });
    const revoked = evidence(3, "decision", "A revoked decision.", {
      supersededAt: before,
      score: 0.99,
    });
    const { engine, controls } = setup(
      result([future, revoked, valid], { requestedAsOf: asOf }),
    );

    const response = await engine.invoke(
      "brain_ask",
      { question: "What did I decide?", asOf },
      { principal },
    );

    expect(response.citations.map(({ id: evidenceId }) => evidenceId)).toEqual([
      valid.id,
    ]);
    expect(
      controls.reasonCalls[0]!.evidence.map(({ id: evidenceId }) => evidenceId),
    ).toEqual([valid.id]);
  });

  it("rejects a direct future asOf before access, embeddings, or evidence retrieval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(asOf));
    try {
      const { engine, controls } = setup();

      await expect(
        engine.invoke(
          "brain_ask",
          { question: "What will I know?", asOf: after },
          { principal },
        ),
      ).rejects.toMatchObject({
        code: "INPUT_INVALID",
        message: "asOf must not be in the future.",
        publicDetails: { field: "asOf" },
      });
      expect(controls.accessRequests).toHaveLength(0);
      expect(controls.embedCalls).toHaveLength(0);
      expect(controls.evidenceCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a future instant expressed with a timezone offset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(asOf));
    try {
      const { engine, controls } = setup();

      await expect(
        engine.invoke(
          "brain_ask",
          {
            question: "What will I know?",
            asOf: "2026-08-16T09:00:00.001-03:00",
          },
          { principal },
        ),
      ).rejects.toMatchObject({ code: "INPUT_INVALID" });
      expect(controls.accessRequests).toHaveLength(0);
      expect(controls.evidenceCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("canonicalizes an offset-equivalent present cutoff for retrieval, coverage, and reasoning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(asOf));
    try {
      const item = evidence(1, "memory", "Known at the cutoff.");
      const { engine, controls } = setup(
        result([item], { requestedAsOf: asOf }),
      );

      const response = await engine.invoke(
        "brain_ask",
        {
          question: "What is known now?",
          asOf: "2026-08-16T09:00:00-03:00",
        },
        { principal },
      );

      expect(controls.evidenceCalls[0]!.asOf).toBe(asOf);
      expect(controls.reasonCalls[0]!.asOf).toBe(asOf);
      expect(controls.reasonCalls[0]!.referenceTime).toBe(asOf);
      expect(response.coverage.requestedAsOf).toBe(asOf);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes real incomplete temporal coverage through and prevents high confidence", async () => {
    const { engine, controls } = setup(
      result(
        [evidence(1, "memory", "First."), evidence(2, "memory", "Second.")],
        { complete: false, warnings: ["Activity history begins recently."] },
      ),
    );
    controls.setReason({ citationIndexes: [1, 2] });

    const response = await engine.invoke(
      "brain_ask",
      { question: "What pattern is present?" },
      { principal },
    );

    expect(response.confidence).toBe("low");
    expect(response.coverage.warnings).toEqual([
      "Activity history begins recently.",
    ]);
    expect(controls.reasonCalls[0]!.coverage).toEqual(response.coverage);
    expect(controls.reasonCalls[0]!.confidence).toBe("low");
  });

  it("returns an honest no-evidence answer without calling the model", async () => {
    const { engine, controls } = setup(result([]));

    await expect(
      engine.invoke(
        "brain_ask",
        { question: "What is unknown?" },
        { principal },
      ),
    ).resolves.toEqual({
      answer: noEvidenceAnswer,
      confidence: "none",
      coverage: {
        completeFrom: "2026-01-01T00:00:00.000Z",
        requestedAsOf: null,
        complete: true,
        warnings: [],
      },
      citations: [],
    });
    expect(controls.reasonCalls).toHaveLength(0);
  });

  it("normalizes an unanswerable provider result without accepting its citations", async () => {
    const { engine, controls } = setup(
      result([evidence(1, "memory", "A record.")]),
    );
    controls.setReason({
      answer: "An unsupported guess.",
      answerable: false,
      citationIndexes: [0],
    });

    await expect(
      engine.invoke(
        "brain_ask",
        { question: "Can this be answered?" },
        { principal },
      ),
    ).resolves.toMatchObject({
      answer: noEvidenceAnswer,
      confidence: "none",
      citations: [],
    });
  });

  it.each([
    { citationIndexes: [] },
    { citationIndexes: [0] },
    { citationIndexes: [2] },
    { citationIndexes: [1.5] },
  ])(
    "rejects invalid one-based citation indexes $citationIndexes",
    async ({ citationIndexes }) => {
      const { engine, controls } = setup(
        result([evidence(1, "memory", "A record.")]),
      );
      controls.setReason({ citationIndexes });

      await expect(
        engine.invoke(
          "brain_ask",
          { question: "What is recorded?" },
          { principal },
        ),
      ).rejects.toMatchObject({
        code: "EXECUTION_FAILED",
        cause: expect.objectContaining({
          message:
            "Answer provider returned invalid one-based citation indexes.",
        }),
      });
    },
  );

  it("deduplicates citation indexes while preserving the provider's order", async () => {
    const first = evidence(1, "memory", "First.");
    const second = evidence(2, "decision", "Second.");
    const { engine, controls } = setup(result([first, second]));
    controls.setReason({ citationIndexes: [2, 2, 1] });

    const response = await engine.invoke(
      "brain_ask",
      { question: "What is recorded?" },
      { principal },
    );

    expect(response.citations.map(({ id: evidenceId }) => evidenceId)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("rejects coverage for a different temporal query", async () => {
    const { engine, controls } = setup(
      result([evidence(1, "memory", "A record.")], { requestedAsOf: after }),
    );

    await expect(
      engine.invoke(
        "brain_ask",
        { question: "What was recorded?", asOf },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
    expect(controls.reasonCalls).toHaveLength(0);
  });

  it("validates input and authentication at the engine boundary", async () => {
    const { engine } = setup();

    await expect(
      engine.invoke("brain_ask", { question: "   " }, { principal }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke("brain_ask", { question: "Valid" }, { principal: null }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      engine.invoke(
        "brain_ask",
        { question: "Valid", topK: 31 },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
});
