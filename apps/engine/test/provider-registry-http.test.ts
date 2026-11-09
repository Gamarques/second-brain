import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { ModelRequestObservation } from "../src/domain/model-usage.js";
import type { EnvironmentRecord } from "../src/env.js";
import type { ServedRoute } from "../src/providers/composite-provider.js";
import { OpenAICompatibleRequestError } from "../src/providers/openai-compatible-adapter.js";
import { createConfiguredModelProvider } from "../src/runtime-config.js";

/**
 * End-to-end registry composition over the real fetch/HTTP stack: two local
 * servers stand in for two providers, profile "a" (OpenAI-compatible) and
 * profile "b" (OpenRouter protocol). No request leaves the loopback interface.
 */
interface Seen {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

interface Reply {
  readonly status: number;
  readonly json: unknown;
  readonly headers?: Record<string, string>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start(reply: (seen: Seen, count: number) => Reply): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = {
        path: req.url ?? "",
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      };
      seen.push(request);
      const { status, json, headers = {} } = reply(request, seen.length);
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.end(JSON.stringify(json));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const answerReply: Reply = {
  status: 200,
  json: {
    choices: [{ finish_reason: "stop", message: { content: '{"answer":"Stored in PostgreSQL [1].","answerable":true,"citationIndexes":[1]}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
};
const embeddingReply: Reply = {
  status: 200,
  json: { data: [{ index: 0, embedding: Array.from({ length: 1_536 }, () => 0.001) }] },
};
const failure = (status: number): Reply => ({ status, json: { error: { message: "upstream detail" } }, headers: { "retry-after": "0" } });

const context = {
  chunkId: "chunk-1",
  documentId: "document-1",
  revisionId: "revision-1",
  documentTitle: "Architecture",
  content: "Data lives in PostgreSQL.",
  score: 0.9,
  spaceId: "space-1",
  knowledgeBaseId: "base-1",
  knowledgeBaseName: "Architecture",
};
const question = { question: "Where is the data stored?", contexts: [context] };

function environment(a: string, b: string, answer: string): EnvironmentRecord {
  return {
    AI_PROVIDERS: "a,b",
    AI_PROVIDER_A_KIND: "openai-compatible",
    AI_PROVIDER_A_BASE_URL: `${a}/v1`,
    AI_PROVIDER_A_API_KEY: "key-a",
    AI_PROVIDER_A_SESSION_HEADER: "x-opencode-session",
    AI_PROVIDER_B_KIND: "openrouter",
    AI_PROVIDER_B_BASE_URL: `${b}/api/v1`,
    AI_PROVIDER_B_API_KEY: "key-b",
    AI_EMBEDDING: "a:embed-a",
    AI_ANSWER: answer,
  };
}

function compose(env: EnvironmentRecord) {
  const observed: ModelRequestObservation[] = [];
  const served: ServedRoute[] = [];
  const configured = createConfiguredModelProvider(
    env,
    async (observation) => {
      observed.push(observation);
    },
    { onServed: (route) => served.push(route) },
  );
  return { ...configured, observed, served };
}

describe("provider registry over real HTTP", () => {
  it("serves embeddings from profile A and chat from profile B", async () => {
    const a = await start((seen) => (seen.path === "/v1/embeddings" ? embeddingReply : failure(500)));
    const b = await start(() => answerReply);
    const { provider, embeddingIdentity, served } = compose(environment(a.origin, b.origin, "b:chat-b"));

    const vectors = await provider.embed(["hello"], new AbortController().signal, "search_query");
    expect(vectors[0]).toHaveLength(1_536);
    await expect(provider.answer(question, new AbortController().signal)).resolves.toBe("Stored in PostgreSQL [1].");

    expect(embeddingIdentity).toEqual({ provider: "openai-compatible", model: "embed-a", modelRevision: "provider-managed", dimensions: 1_536 });
    expect(a.seen.map((s) => s.path)).toEqual(["/v1/embeddings"]);
    expect(a.seen[0]!.body).toMatchObject({ model: "embed-a", input: ["hello"], encoding_format: "float", dimensions: 1_536 });
    expect(a.seen[0]!.headers.authorization).toBe("Bearer key-a");
    expect(a.seen[0]!.headers["user-agent"]).toMatch(/^second-brain\//u);
    expect(b.seen.map((s) => s.path)).toEqual(["/api/v1/chat/completions"]);
    expect(b.seen[0]!.headers.authorization).toBe("Bearer key-b");
    expect(b.seen[0]!.headers["x-title"]).toBe("second-brain");
    expect(b.seen[0]!.body).toMatchObject({ model: "chat-b", provider: { zdr: true, data_collection: "deny" } });
    expect(served).toEqual([{ role: "answer", profile: "b", model: "chat-b", index: 0 }]);
  });

  it("fails chat over from profile A to profile B after A exhausts its 503 retries", async () => {
    const a = await start((seen) => (seen.path === "/v1/embeddings" ? embeddingReply : failure(503)));
    const b = await start(() => answerReply);
    const { provider, served, observed } = compose(environment(a.origin, b.origin, "a:chat-a,b:chat-b"));

    await expect(provider.answer(question, new AbortController().signal)).resolves.toBe("Stored in PostgreSQL [1].");

    expect(a.seen.map((s) => [s.path, s.body.model])).toEqual([
      ["/v1/chat/completions", "chat-a"],
      ["/v1/chat/completions", "chat-a"],
      ["/v1/chat/completions", "chat-a"],
    ]);
    expect(new Set(a.seen.map((s) => s.headers["x-opencode-session"])).size).toBe(1);
    expect(a.seen[0]!.body).not.toHaveProperty("provider");
    expect(b.seen.map((s) => [s.path, s.body.model])).toEqual([["/api/v1/chat/completions", "chat-b"]]);
    expect(served).toEqual([{ role: "answer", profile: "b", model: "chat-b", index: 1 }]);
    // The usage hook records each entry's own request, so the serving model is visible there.
    expect(observed.map((o) => [o.operation, o.model, o.outcome, o.errorReason])).toEqual([
      ["knowledge_ask", "chat-a", "failed", "unavailable"],
      ["knowledge_ask", "chat-b", "succeeded", null],
    ]);
  });

  it("fails a separately bound chat role over on a 429 from profile A", async () => {
    const a = await start(() => failure(429));
    const b = await start(() => ({
      status: 200,
      json: {
        choices: [{ finish_reason: "stop", message: { content: '{"results":[{"supported":true,"sameFact":true,"contradictionResolved":false,"quoteIndexes":[0]}]}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    }));
    const { provider, served } = compose({ ...environment(a.origin, b.origin, "a:chat-a,b:chat-b"), AI_VERIFICATION: "a:verify-a,b:verify-b" });
    const change = {
      target: { content: "x", contentHash: "h", effectiveAt: null },
      proposal: { operation: "update" as const, targetMemoryIndex: 0, content: "y", category: null, tags: [], sourceQuotes: ["q"], evidenceIndexes: [0] },
      citedQuotes: ["q"],
    };
    await expect(provider.verifyUpdates([change as never], new AbortController().signal)).resolves.toEqual([
      { supported: true, sameFact: true, contradictionResolved: false, quoteIndexes: [0] },
    ]);
    expect(a.seen).toHaveLength(3);
    expect(b.seen.map((s) => s.body.model)).toEqual(["verify-b"]);
    expect(served).toEqual([{ role: "verification", profile: "b", model: "verify-b", index: 1 }]);
  });

  it("does not fail over when profile A rejects the request with 400", async () => {
    const a = await start(() => failure(400));
    const b = await start(() => answerReply);
    const { provider, served } = compose(environment(a.origin, b.origin, "a:chat-a,b:chat-b"));

    const error = await provider.answer(question, new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAICompatibleRequestError);
    expect((error as OpenAICompatibleRequestError).status).toBe(400);
    expect((error as Error).message).not.toContain("upstream detail");
    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(0);
    expect(served).toEqual([]);
  });

  it("never fails over embeddings", async () => {
    const a = await start(() => failure(503));
    const b = await start(() => embeddingReply);
    const { provider } = compose(environment(a.origin, b.origin, "b:chat-b"));

    await expect(provider.embed(["hello"], new AbortController().signal, "search_document")).rejects.toBeInstanceOf(OpenAICompatibleRequestError);
    expect(a.seen.length).toBeGreaterThan(0);
    expect(b.seen).toHaveLength(0);
  });
});
