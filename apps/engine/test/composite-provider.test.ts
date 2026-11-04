import { describe, expect, it, vi } from "vitest";

import type { DreamingModelResult, IngestionModelResult } from "../src/domain.js";
import {
  CompositeModelProvider,
  isFailoverEligible,
  type ChatRoute,
  type ServedRoute,
} from "../src/providers/composite-provider.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import {
  OpenAICompatibleRequestError,
  OpenAICompatibleTransportError,
} from "../src/providers/openai-compatible-adapter.js";
import { OpenRouterRequestError, OpenRouterTransportError } from "../src/providers/openrouter-adapter.js";
import { snapshot } from "./support/openrouter-fixtures.js";

type Outcome = unknown | Error;

/** A fake provider whose chat operations replay scripted outcomes in order. */
function fakeProvider(kind: string, model: string, outcomes: Outcome[]) {
  const next = async () => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    if (outcome === undefined) throw new Error("unexpected call");
    return outcome;
  };
  return {
    provider: kind,
    model: `${kind}/embedding`,
    modelRevision: "rev-1",
    dimensions: 1_536,
    ingestionProvider: kind,
    ingestionModel: model,
    embed: vi.fn(next),
    answer: vi.fn(next),
    reason: vi.fn(next),
    answerAcrossBrain: vi.fn(next),
    propose: vi.fn(next),
    createPlan: vi.fn(next),
    verifyUpdates: vi.fn(next),
  };
}

type Fake = ReturnType<typeof fakeProvider>;

function route(profile: string, fake: Fake): ChatRoute {
  return { profile, model: fake.ingestionModel, provider: fake as unknown as ModelProvider };
}

function composite(answer: readonly Fake[], options: { embedding?: Fake; served?: ServedRoute[] } = {}) {
  const routes = answer.map((fake, index) => route(`p${index}`, fake));
  return new CompositeModelProvider({
    embedding: (options.embedding ?? fakeProvider("embedder", "embed-model", [])) as unknown as ModelProvider,
    chat: { answer: routes, ingestion: routes, dreaming: routes, verification: routes },
    ingestionIdentity: {
      provider: answer.map((fake) => fake.provider).join(","),
      model: answer.map((fake) => fake.ingestionModel).join(","),
    },
    ...(options.served === undefined ? {} : { onServed: (served: ServedRoute) => options.served!.push(served) }),
  });
}

const question = { question: "Where?", contexts: [] };
const live = () => new AbortController().signal;

describe("failover eligibility", () => {
  const eligible: readonly [string, unknown][] = [
    ["429 after retries", new OpenAICompatibleRequestError(429, "Go", 3)],
    ["OpenRouter 429", new OpenRouterRequestError(429)],
    ["402 credits", new OpenAICompatibleRequestError(402, "Go")],
    ["403 edge block", new OpenAICompatibleRequestError(403, "Go", 1, true)],
    ["OpenRouter 403", new OpenRouterRequestError(403)],
    ["500", new OpenRouterRequestError(500)],
    ["502", new OpenAICompatibleRequestError(502, "Go")],
    ["503 after retries", new OpenAICompatibleRequestError(503, "Go", 3)],
    ["network", new OpenAICompatibleTransportError("down", "network")],
    ["provider timeout", new OpenRouterTransportError("slow", "timeout")],
  ];
  const ineligible: readonly [string, unknown][] = [
    ["400", new OpenAICompatibleRequestError(400, "Go")],
    ["OpenRouter 400", new OpenRouterRequestError(400)],
    ["401", new OpenAICompatibleRequestError(401, "Go")],
    ["404", new OpenRouterRequestError(404)],
    ["422", new OpenAICompatibleRequestError(422, "Go")],
    ["malformed response JSON", new OpenAICompatibleTransportError("bad", "malformed")],
    ["invalid completion", new Error("The answer model returned an invalid structured answer.")],
    ["abort reason", new DOMException("aborted", "AbortError")],
  ];

  it.each(eligible)("fails over on %s", (_name, error) => {
    expect(isFailoverEligible(error, live())).toBe(true);
  });

  it.each(ineligible)("stops on %s", (_name, error) => {
    expect(isFailoverEligible(error, live())).toBe(false);
  });

  it("never fails over once the caller's signal is aborted, whatever the error", () => {
    const controller = new AbortController();
    controller.abort();
    for (const [, error] of eligible) expect(isFailoverEligible(error, controller.signal)).toBe(false);
  });
});

describe("CompositeModelProvider failover", () => {
  it("moves to the next entry when the primary exhausts its 429 retries", async () => {
    const served: ServedRoute[] = [];
    const primary = fakeProvider("opencode-go", "deepseek-v4.1-flash", [new OpenAICompatibleRequestError(429, "OpenCode Go", 3)]);
    const backup = fakeProvider("openrouter", "deepseek/deepseek-v4-flash", ["from backup"]);
    const provider = composite([primary, backup], { served });
    await expect(provider.answer(question, live())).resolves.toBe("from backup");
    expect(primary.answer).toHaveBeenCalledOnce();
    expect(backup.answer).toHaveBeenCalledOnce();
    expect(served).toEqual([{ role: "answer", profile: "p1", model: "deepseek/deepseek-v4-flash", index: 1 }]);
  });

  it("records the primary when it serves", async () => {
    const served: ServedRoute[] = [];
    const primary = fakeProvider("opencode-go", "a", ["primary"]);
    const backup = fakeProvider("openrouter", "b", []);
    await expect(composite([primary, backup], { served }).reason({} as never, live())).resolves.toBe("primary");
    expect(backup.reason).not.toHaveBeenCalled();
    expect(served).toEqual([{ role: "answer", profile: "p0", model: "a", index: 0 }]);
  });

  it("does not fail over on a 400", async () => {
    const error = new OpenAICompatibleRequestError(400, "OpenCode Go");
    const primary = fakeProvider("opencode-go", "a", [error]);
    const backup = fakeProvider("openrouter", "b", ["unused"]);
    await expect(composite([primary, backup]).answerAcrossBrain({} as never, live())).rejects.toBe(error);
    expect(backup.answerAcrossBrain).not.toHaveBeenCalled();
  });

  it("does not fail over on an invalid completion", async () => {
    const error = new Error("The verification model returned an invalid structured result.");
    const primary = fakeProvider("opencode-go", "a", [error]);
    const backup = fakeProvider("openrouter", "b", ["unused"]);
    await expect(composite([primary, backup]).verifyUpdates([], live())).rejects.toBe(error);
    expect(backup.verifyUpdates).not.toHaveBeenCalled();
  });

  it("does not fail over when the caller aborts", async () => {
    const controller = new AbortController();
    const reason = new DOMException("stop", "AbortError");
    const primary = fakeProvider("opencode-go", "a", []);
    primary.answer.mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    const backup = fakeProvider("openrouter", "b", ["unused"]);
    await expect(composite([primary, backup]).answer(question, controller.signal)).rejects.toBe(reason);
    expect(backup.answer).not.toHaveBeenCalled();
  });

  it("does not fail over when the caller's own deadline expires during a retryable failure", async () => {
    const controller = new AbortController();
    const primary = fakeProvider("opencode-go", "a", []);
    primary.createPlan.mockImplementation(async () => {
      controller.abort(new DOMException("deadline", "TimeoutError"));
      throw new OpenAICompatibleTransportError("The OpenCode Go request timed out.", "timeout");
    });
    const backup = fakeProvider("openrouter", "b", ["unused"]);
    await expect(composite([primary, backup]).createPlan(snapshot, { maxOutputTokens: 10, timeoutMs: 10 }, controller.signal)).rejects.toThrow(/timed out/u);
    expect(backup.createPlan).not.toHaveBeenCalled();
  });

  it("fails over through several entries and reports the last classified error when all fail", async () => {
    const first = fakeProvider("opencode-go", "a", [new OpenAICompatibleRequestError(503, "OpenCode Go", 3)]);
    const second = fakeProvider("openai", "b", [new OpenAICompatibleTransportError("The OpenAI request could not be completed.", "network")]);
    const last = new OpenRouterRequestError(402);
    const third = fakeProvider("openrouter", "c", [last]);
    const error = await composite([first, second, third]).answer(question, live()).catch((caught: unknown) => caught);
    expect(error).toBe(last);
    expect((error as OpenRouterRequestError).reason).toBe("credits");
    for (const fake of [first, second, third]) expect(fake.answer).toHaveBeenCalledOnce();
  });

  it("passes a single entry's error through unchanged", async () => {
    const error = new OpenAICompatibleRequestError(429, "OpenCode Go", 3);
    const only = fakeProvider("opencode-go", "a", [error]);
    await expect(composite([only]).answer(question, live())).rejects.toBe(error);
  });

  it("returns ingestion results under the declared failover identity", async () => {
    const result: IngestionModelResult = {
      payload: { proposals: [] },
      provider: "openrouter",
      model: "b",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    };
    const primary = fakeProvider("opencode-go", "a", [new OpenAICompatibleRequestError(429, "OpenCode Go", 3)]);
    const backup = fakeProvider("openrouter", "b", [result]);
    const provider = composite([primary, backup]);
    expect(provider.ingestionProvider).toBe("opencode-go,openrouter");
    expect(provider.ingestionModel).toBe("a,b");
    await expect(provider.propose({} as never, live())).resolves.toEqual({
      ...result,
      provider: "opencode-go,openrouter",
      model: "a,b",
    });
  });

  it("keeps the serving entry's identity on dreaming results", async () => {
    const result: DreamingModelResult = {
      payload: {},
      provider: "openrouter",
      model: "b",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    };
    const primary = fakeProvider("opencode-go", "a", [new OpenAICompatibleRequestError(503, "OpenCode Go", 3)]);
    const backup = fakeProvider("openrouter", "b", [result]);
    await expect(
      composite([primary, backup]).createPlan(snapshot, { maxOutputTokens: 10, timeoutMs: 10 }, live()),
    ).resolves.toEqual(result);
  });

  it("never fails over embeddings and takes identity from the embedding provider", async () => {
    const error = new OpenRouterRequestError(503);
    const embedding = fakeProvider("openrouter", "unused", [error]);
    const chat = fakeProvider("opencode-go", "a", [[[0.1]]]);
    const provider = composite([chat], { embedding });
    expect([provider.provider, provider.model, provider.modelRevision, provider.dimensions]).toEqual([
      "openrouter",
      "openrouter/embedding",
      "rev-1",
      1_536,
    ]);
    await expect(provider.embed(["x"], live(), "search_query")).rejects.toBe(error);
    expect(embedding.embed).toHaveBeenCalledOnce();
    expect(chat.embed).not.toHaveBeenCalled();
  });

  it("requires at least one entry per chat role", () => {
    expect(
      () =>
        new CompositeModelProvider({
          embedding: fakeProvider("e", "m", []) as unknown as ModelProvider,
          chat: { answer: [], ingestion: [], dreaming: [], verification: [] },
          ingestionIdentity: { provider: "x", model: "y" },
        }),
    ).toThrow(/at least one provider entry/u);
  });
});
