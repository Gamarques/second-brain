import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentRecord } from "../src/env.js";
import { createModelConfigurationService } from "../src/providers/model-configuration.js";
import { completion } from "./support/openrouter-fixtures.js";

const environment: EnvironmentRecord = {
  AI_PROVIDERS: "go,or",
  AI_PROVIDER_GO_PRESET: "opencode-go",
  AI_PROVIDER_GO_API_KEY: "go-key",
  AI_PROVIDER_OR_KIND: "openrouter",
  AI_PROVIDER_OR_API_KEY: "or-key",
  AI_EMBEDDING: "or:google/gemini-embedding-001",
  AI_ANSWER: "go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash",
};

function service(env: EnvironmentRecord) {
  return createModelConfigurationService(
    { read: async () => ({ environment: env, configurationRevision: 3 }) },
    async () => undefined,
  );
}

function stubFetch(reply: () => Response) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return reply();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model configuration with the provider registry", () => {
  it("reports credentials and role bindings", async () => {
    await expect(service(environment).status(new AbortController().signal)).resolves.toEqual({
      revision: 3,
      hasApiKey: true,
      models: {
        embedding: "or:google/gemini-embedding-001",
        answer: "go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash",
        ingestion: "go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash",
        dreaming: "go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash",
        verification: "go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash",
      },
    });
    const { AI_PROVIDER_GO_API_KEY: _unused, ...missingKey } = environment;
    await expect(service(missingKey).status(new AbortController().signal)).resolves.toMatchObject({ hasApiKey: false });
  });

  it("probes a bare model on the answer role's primary profile", async () => {
    const calls = stubFetch(() => completion({ ok: true }));
    const result = await service(environment).probe({ model: "deepseek-v4.1-flash" }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, reason: null, model: "deepseek-v4.1-flash" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer go-key");
    expect(calls[0]!.body.model).toBe("deepseek-v4.1-flash");
  });

  it("probes a <profile>:<model> target on that profile with an optional key override", async () => {
    const calls = stubFetch(() => completion({ ok: true }));
    const result = await service(environment).probe({ model: "or:deepseek/deepseek-v4-flash", apiKey: "candidate-key" }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, model: "or:deepseek/deepseek-v4-flash" });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer candidate-key");
    expect(calls[0]!.body).toMatchObject({ model: "deepseek/deepseek-v4-flash", provider: { zdr: true } });
  });

  it("classifies OpenAI-compatible failures and missing keys", async () => {
    stubFetch(() => Response.json({ error: { message: "no funds" } }, { status: 402 }));
    await expect(service(environment).probe({ model: "go:glm-5.2" }, new AbortController().signal)).resolves.toMatchObject({ ok: false, reason: "credits" });
    const { AI_PROVIDER_GO_API_KEY: _unused, ...missingKey } = environment;
    await expect(service(missingKey).probe({ model: "go:glm-5.2" }, new AbortController().signal)).resolves.toMatchObject({ ok: false, reason: "authentication", durationMs: 0 });
  });
});
