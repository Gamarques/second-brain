import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible-adapter.js";
import { PROVIDER_PRESETS } from "../src/providers/provider-presets.js";

/** Exercises the real fetch/HTTP stack (headers, status codes, Retry-After) against a local server. */
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

interface Seen { readonly headers: IncomingHttpHeaders; readonly body: Record<string, unknown> }

async function start(statuses: readonly number[], extraHeaders: Record<string, string> = {}): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      const status = statuses[Math.min(seen.length - 1, statuses.length - 1)] ?? 200;
      res.setHeader("content-type", "application/json");
      for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
      if (status !== 200) {
        res.statusCode = status;
        res.end(JSON.stringify({ error: { message: "nope" } }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, seen };
}

const provider = (baseUrl: string) =>
  new OpenAICompatibleProvider({
    ...PROVIDER_PRESETS["opencode-go"].options,
    baseUrl,
    apiKey: "test-key",
    embeddingModel: "embed-x",
    answerModel: "answer-x",
    requestTimeoutMs: 10_000,
  });

describe("OpenAI-compatible provider over a real HTTP server", () => {
  it("retries 429 honoring Retry-After and keeps identifying headers on every attempt", async () => {
    const { url, seen } = await start([429, 429, 200], { "retry-after": "0" });
    await expect(provider(url).probe("answer-x", new AbortController().signal)).resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(3);
    const sessions = new Set(seen.map((s) => s.headers["x-opencode-session"]));
    expect(sessions.size).toBe(1);
    for (const s of seen) {
      expect(s.headers["user-agent"]).toMatch(/^second-brain\//u);
      expect(s.headers.authorization).toBe("Bearer test-key");
      expect(s.body).not.toHaveProperty("provider");
      expect(s.body.model).toBe("answer-x");
    }
  });

  it("does not retry a 402 and reports it without the provider body", async () => {
    const { url, seen } = await start([402]);
    const error = await provider(url).probe("answer-x", new AbortController().signal).catch((e: unknown) => e);
    expect(seen).toHaveLength(1);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("nope");
  });

  it("gives up after the attempt limit on a persistent 429", async () => {
    const { url, seen } = await start([429], { "retry-after": "0" });
    const error = await provider(url).probe("answer-x", new AbortController().signal).catch((e: unknown) => e);
    expect(seen).toHaveLength(3);
    expect(error).toBeInstanceOf(Error);
  });
});
