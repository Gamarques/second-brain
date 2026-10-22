import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../src/providers/openrouter-provider.js";

afterEach(() => vi.unstubAllGlobals());

describe("model diagnostics and request accounting", () => {
  it("probes a model with synthetic structured input and records only usage", async () => {
    const observeRequest = vi.fn(async () => undefined);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.0004 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenRouterProvider({ apiKey: "test-secret", observeRequest });
    await expect(provider.probe("test/model", new AbortController().signal)).resolves.toEqual({ ok: true });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toMatchObject({ model: "test/model", max_tokens: 128, provider: { zdr: true, data_collection: "deny", require_parameters: true }, response_format: { type: "json_schema" } });
    expect(observeRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "diagnostic", model: "test/model", outcome: "succeeded", inputTokens: 20, outputTokens: 5, cost: 0.0004, errorReason: null }));
    expect(JSON.stringify(observeRequest.mock.calls)).not.toMatch(/test-secret|messages|content/);
  });

  it("classifies privacy routing failures without persisting provider messages", async () => {
    const observeRequest = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "No endpoints found matching your data policy (Zero data retention). private account detail" } }, { status: 404 })));
    const provider = new OpenRouterProvider({ apiKey: "test-secret", observeRequest });
    await expect(provider.probe("test/model", new AbortController().signal)).rejects.toMatchObject({ code: "OPENROUTER_REQUEST_FAILED", reason: "privacy" });
    expect(observeRequest).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", errorReason: "privacy", inputTokens: null, cost: null }));
    expect(JSON.stringify(observeRequest.mock.calls)).not.toContain("private account");
  });

  it("does not fail model work when accounting is unavailable and preserves unknown cost", async () => {
    const observeRequest = vi.fn(async () => { throw new Error("database down"); });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ index: 0, embedding: [1, 0] }] })));
    const provider = new OpenRouterProvider({ apiKey: "test-secret", dimensions: 2, observeRequest });
    await expect(provider.embed(["private memory"], new AbortController().signal, "search_document")).resolves.toEqual([[1, 0]]);
    expect(observeRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "embedding", cost: null, inputTokens: null, outputTokens: null }));
    expect(JSON.stringify(observeRequest.mock.calls)).not.toContain("private memory");
  });
});

it("answers across typed brain sources with locale, ZDR and usage accounting", async () => {
  const observeRequest = vi.fn(async () => undefined);
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ answer: "A revisão é sexta-feira [1].", answerable: true, citationIndexes: [1] }) } }], usage: { prompt_tokens: 80, completion_tokens: 20, cost: 0.001 } }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new OpenRouterProvider({ apiKey: "test-secret", observeRequest });
  await provider.answerAcrossBrain({ question: "Quando é a revisão?", locale: "pt-BR", evidence: [{ sourceType: "project", id: "00000000-0000-4000-8000-000000000001", title: "Product review", excerpt: "The product review is on Friday.", score: 1, projectId: null, knowledgeBaseId: null, knowledgeBaseName: null, personIds: [], tags: [] }] }, new AbortController().signal);
  const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
  expect(body).toMatchObject({ provider: { zdr: true, data_collection: "deny", require_parameters: true }, response_format: { type: "json_schema" } });
  expect(JSON.parse(body.messages[1].content)).toMatchObject({ locale: "pt-BR", evidence: [{ type: "project", index: 1 }] });
  expect(observeRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "brain_ask", inputTokens: 80, outputTokens: 20, cost: 0.001 }));
});
