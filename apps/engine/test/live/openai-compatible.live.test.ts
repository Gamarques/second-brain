import { describe, expect, it } from "vitest";

import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible-adapter.js";

/**
 * Manual smoke test against a real OpenAI-compatible provider. It is excluded
 * from the default suite by vitest.config.ts and skipped unless
 * OPENAI_COMPATIBLE_LIVE=1. Run it with:
 *
 *   OPENAI_COMPATIBLE_LIVE=1 LIVE_BASE_URL=... LIVE_API_KEY=... LIVE_MODEL=... \
 *   LIVE_USER_AGENT=... LIVE_SESSION_HEADER=... npx vitest run test/live
 *
 * The API key is read once and never logged, asserted on, or interpolated
 * into a message.
 */
const live = process.env.OPENAI_COMPATIBLE_LIVE === "1";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required for the live smoke test.`);
  return value;
}

describe.skipIf(!live)("OpenAI-compatible provider live smoke test", () => {
  const provider = () => {
    const model = requiredEnv("LIVE_MODEL");
    return {
      model,
      provider: new OpenAICompatibleProvider({
        baseUrl: requiredEnv("LIVE_BASE_URL"),
        apiKey: requiredEnv("LIVE_API_KEY"),
        userAgent: requiredEnv("LIVE_USER_AGENT"),
        sessionHeader: requiredEnv("LIVE_SESSION_HEADER"),
        kind: "live-smoke",
        displayName: "Live provider",
        embeddingModel: "unused/embedding-model",
        answerModel: model,
        // Reasoning models count thinking tokens as completion tokens.
        minCompletionTokens: 4_096,
        requestTimeoutMs: 90_000,
      }),
    };
  };

  it("passes the structured configuration probe", { timeout: 120_000 }, async () => {
    const { model, provider: client } = provider();
    await expect(client.probe(model, new AbortController().signal)).resolves.toEqual({ ok: true });
  });

  it("answers a grounded question with a citation", { timeout: 120_000 }, async () => {
    const { provider: client } = provider();
    const answer = await client.answer(
      {
        question: "Which database does the project use?",
        contexts: [
          {
            chunkId: "chunk-1",
            documentId: "document-1",
            revisionId: "revision-1",
            documentTitle: "Architecture",
            content: "The project stores all records in PostgreSQL.",
            score: 1,
            spaceId: "space-1",
            knowledgeBaseId: "base-1",
            knowledgeBaseName: "Architecture",
          },
        ],
      },
      new AbortController().signal,
    );
    expect(answer).toMatch(/PostgreSQL/u);
    expect(answer).toMatch(/\[1\]/u);
  });
});
