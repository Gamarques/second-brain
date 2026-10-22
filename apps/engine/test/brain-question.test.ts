import { createEngine } from "@invokta/core";
import { expect, it, vi } from "vitest";
import { defineCapability } from "../src/capabilities/define.js";
import { z } from "zod";
import { createBrainQuestionService } from "../src/services/brain-question.js";
import type { BrainAccessContext } from "../src/domain.js";
const access: BrainAccessContext = {
  accountId: "00000000-0000-4000-8000-000000000001",
  role: "admin",
  actor: {
    kind: "account",
    accountId: "00000000-0000-4000-8000-000000000001",
    clientId: null,
    source: "direct",
    requestId: "test",
    correlationId: null,
    causationId: null,
    dreamingRunId: null,
  },
};
function subject() {
  const hits = ["memory", "knowledge_chunk"].map((sourceType, index) => ({
    sourceType: sourceType as "memory" | "knowledge_chunk",
    id: `00000000-0000-4000-8000-00000000000${index + 2}`,
    title: "Project review",
    excerpt: "The project review is on Friday.",
    score: 0.9,
    knowledgeBaseId: null,
    knowledgeBaseName: null,
    projectId: null,
    personIds: [],
    tags: [],
  }));
  const retrieve = vi.fn(async () => hits);
  const revalidate = vi.fn(async () => undefined);
  const answerAcrossBrain = vi.fn(async () => ({
    answer: "The review is on Friday [2].",
    answerable: true,
    citationIndexes: [2],
  }));
  const service = createBrainQuestionService({
    retrieve,
    revalidate,
    references: vi.fn(async () => []),
    provider: { answerAcrossBrain },
  });
  const engine = createEngine({
    name: "question",
    version: "1",
    capabilities: {
      question: defineCapability({
        title: "Question",
        description: "Question service boundary test.",
        input: z.object({ question: z.string() }),
        output: z.looseObject({}),
        access: "public",
        async run({ input, context }) {
          return service.ask(
            access,
            { ...input, locale: "en", projectId: null },
            context.signal,
          );
        },
      }),
    },
  });
  return { engine, retrieve, answerAcrossBrain, revalidate, hits };
}
it("grounds one answer across memories and documents while preserving citation positions", async () => {
  const { engine, answerAcrossBrain } = subject();
  await expect(
    engine.invoke("question", { question: "When is the project review?" }),
  ).resolves.toMatchObject({
    answerable: true,
    citations: [{ index: 2, sourceType: "knowledge_chunk" }],
  });
  expect(answerAcrossBrain).toHaveBeenCalledWith(
    expect.objectContaining({
      evidence: expect.arrayContaining([
        expect.objectContaining({ sourceType: "knowledge_chunk" }),
      ]),
    }),
    expect.any(AbortSignal),
  );
});
it("does not call the answer model when retrieval has no evidence", async () => {
  const { engine, retrieve, answerAcrossBrain } = subject();
  retrieve.mockResolvedValue([]);
  await expect(
    engine.invoke("question", { question: "Unrecorded fact" }),
  ).resolves.toMatchObject({ answerable: false, citations: [] });
  expect(answerAcrossBrain).not.toHaveBeenCalled();
});
it("rejects unsupported citation positions and revalidates access after model work", async () => {
  const { engine, answerAcrossBrain, revalidate } = subject();
  answerAcrossBrain.mockResolvedValueOnce({
    answer: "Friday [3].",
    answerable: true,
    citationIndexes: [2],
  });
  await expect(
    engine.invoke("question", { question: "When?" }),
  ).rejects.toBeDefined();
  answerAcrossBrain.mockImplementationOnce(async () => {
    revalidate.mockRejectedValueOnce(new Error("Revoked access"));
    return { answer: "Friday [2].", answerable: true, citationIndexes: [2] };
  });
  await expect(
    engine.invoke("question", { question: "When?" }),
  ).rejects.toBeDefined();
});

it("renders validated source markers when the provider supplies citation metadata without inline markers", async () => {
  const { engine, answerAcrossBrain } = subject();
  answerAcrossBrain.mockResolvedValueOnce({ answer: "The review is on Friday.", answerable: true, citationIndexes: [2] });
  await expect(engine.invoke("question", { question: "When?" })).resolves.toMatchObject({ answer: "The review is on Friday.\n\n[2]", citations: [{ index: 2, sourceType: "knowledge_chunk" }] });
  expect(answerAcrossBrain).toHaveBeenCalledTimes(1);
  answerAcrossBrain.mockResolvedValueOnce({ answer: "Friday.", answerable: true, citationIndexes: [3] });
  await expect(engine.invoke("question", { question: "When?" })).rejects.toBeDefined();
  answerAcrossBrain.mockResolvedValueOnce({ answer: "Friday.", answerable: true, citationIndexes: [] });
  await expect(engine.invoke("question", { question: "When?" })).rejects.toBeDefined();
});
