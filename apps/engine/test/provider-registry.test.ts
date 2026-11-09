import { describe, expect, it } from "vitest";

import { EngineStartupError, type EnvironmentRecord } from "../src/env.js";
import {
  createEnvironmentConfigurationManager,
  environmentConfigurationCatalog,
  environmentConfigurationItem,
  environmentConfigurationOverlay,
  providerProfileEditableSuffixes,
  type EnvironmentConfigurationState,
  type EnvironmentConfigurationStore,
} from "../src/environment-configuration.js";
import { CompositeModelProvider } from "../src/providers/composite-provider.js";
import { OpenRouterProvider } from "../src/providers/openrouter-provider.js";
import {
  parseProviderRegistry,
  providerProfileSuffixes,
  usesProviderRegistry,
} from "../src/providers/provider-registry.js";
import {
  createConfiguredModelProvider,
  createModelProvider,
  requireModelProviderCredentials,
} from "../src/runtime-config.js";

const GO_KEY = "sk-go-registry-secret";
const OR_KEY = "sk-or-registry-secret";

/** OpenCode Go for chat with OpenRouter failover, OpenRouter for embeddings. */
const base: EnvironmentRecord = {
  AI_PROVIDERS: "go,or",
  AI_PROVIDER_GO_PRESET: "opencode-go",
  AI_PROVIDER_GO_API_KEY: GO_KEY,
  AI_PROVIDER_OR_KIND: "openrouter",
  AI_PROVIDER_OR_API_KEY: OR_KEY,
  AI_EMBEDDING: "or:google/gemini-embedding-001",
  AI_ANSWER: "go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash",
};

function without(environment: EnvironmentRecord, ...names: string[]): EnvironmentRecord {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !names.includes(name)));
}

/** Asserts a fail-closed startup error that never echoes a secret value. */
function startupError(environment: EnvironmentRecord, compose = createConfiguredModelProvider): string {
  let caught: unknown;
  try {
    compose(environment);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EngineStartupError);
  const message = (caught as Error).message;
  for (const secret of [GO_KEY, OR_KEY, "header-secret-value"]) expect(message).not.toContain(secret);
  return message;
}

describe("provider registry selection", () => {
  it("keeps the legacy OpenRouter provider when no registry variable is set", () => {
    const configured = createConfiguredModelProvider({
      OPENROUTER_API_KEY: "test-key",
      // Unrelated AI_* names from other tools never select the registry.
      AI_AGENT: "some-agent",
      AI_MEMORY_LLM_PROVIDER: "opencode",
      AI_PROVIDERS: "",
    });
    expect(configured.provider).toBeInstanceOf(OpenRouterProvider);
    expect(configured.embeddingIdentity).toEqual({
      provider: "openrouter",
      model: "google/gemini-embedding-001",
      modelRevision: "provider-managed",
      dimensions: 1_536,
    });
  });

  it("accepts AI_REQUIRE_ZDR on the legacy path because OpenRouter routing is enforced", () => {
    expect(createConfiguredModelProvider({ OPENROUTER_API_KEY: "k", AI_REQUIRE_ZDR: "true" }).provider).toBeInstanceOf(OpenRouterProvider);
    expect(usesProviderRegistry({ AI_REQUIRE_ZDR: "true" })).toBe(false);
    expect(startupError({ OPENROUTER_API_KEY: "k", AI_REQUIRE_ZDR: "yes" })).toMatch(/AI_REQUIRE_ZDR must be one of: true, false/u);
  });

  it("still requires OPENROUTER_API_KEY on the legacy path", () => {
    expect(() => requireModelProviderCredentials({})).toThrow(/OPENROUTER_API_KEY/u);
    expect(() => requireModelProviderCredentials({ OPENROUTER_API_KEY: "k" })).not.toThrow();
  });

  it("composes the registry with per-role identities and failover defaults", () => {
    const configured = createConfiguredModelProvider(base);
    expect(configured.provider).toBeInstanceOf(CompositeModelProvider);
    const provider = configured.provider as CompositeModelProvider;
    // Embedding identity comes from the embedding profile only and keeps "openrouter".
    expect(configured.embeddingIdentity).toEqual({
      provider: "openrouter",
      model: "google/gemini-embedding-001",
      modelRevision: "provider-managed",
      dimensions: 1_536,
    });
    for (const role of ["answer", "ingestion", "dreaming", "verification"] as const) {
      expect(provider.routes(role).map((route) => [route.profile, route.model, route.provider.provider])).toEqual([
        ["go", "deepseek-v4.1-flash", "opencode-go"],
        ["or", "deepseek/deepseek-v4-flash", "openrouter"],
      ]);
    }
    expect(provider.ingestionProvider).toBe("opencode-go,openrouter");
    expect(provider.ingestionModel).toBe("deepseek-v4.1-flash,deepseek/deepseek-v4-flash");
    expect(configured.dreamingModel).toBe("deepseek-v4.1-flash");
    expect(configured.modelNames).toEqual({
      embedding: "or:google/gemini-embedding-001",
      answer: "go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash",
      ingestion: "go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash",
      dreaming: "go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash",
      verification: "go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash",
    });
  });

  it("binds roles independently and treats profile names case-insensitively", () => {
    const configured = createConfiguredModelProvider({
      ...base,
      AI_PROVIDERS: "Go,OR",
      AI_EMBEDDING: "OR:openai/text-embedding-3-small",
      AI_EMBEDDING_REVISION: "2026-10-01",
      AI_EMBEDDING_DIMENSIONS: "1536",
      AI_ANSWER: "go:deepseek-v4.1-flash",
      AI_INGESTION: "or:deepseek/deepseek-v4-flash",
      AI_DREAMING: "go:glm-5.2",
      AI_VERIFICATION: "or:qwen/qwen3.8-flash",
    });
    const provider = configured.provider as CompositeModelProvider;
    expect(configured.embeddingIdentity).toEqual({
      provider: "openrouter",
      model: "openai/text-embedding-3-small",
      modelRevision: "2026-10-01",
      dimensions: 1_536,
    });
    expect(provider.routes("ingestion").map((route) => route.model)).toEqual(["deepseek/deepseek-v4-flash"]);
    expect(provider.ingestionProvider).toBe("openrouter");
    expect(provider.ingestionModel).toBe("deepseek/deepseek-v4-flash");
    expect(provider.routes("dreaming").map((route) => route.model)).toEqual(["glm-5.2"]);
    expect(provider.routes("verification").map((route) => route.provider.provider)).toEqual(["openrouter"]);
  });

  it("loads preset defaults and lets explicit variables override them", () => {
    const registry = parseProviderRegistry(
      {
        ...base,
        AI_PROVIDER_GO_BASE_URL: "https://proxy.example.test/go/v1",
        AI_PROVIDER_GO_MIN_COMPLETION_TOKENS: "4096",
        AI_PROVIDER_GO_STRUCTURED: "json_object",
        AI_PROVIDER_GO_USER_AGENT: "second-brain-test/1",
        AI_PROVIDER_GO_EXTRA_HEADERS: '{"x-team":"brain"}',
        AI_PROVIDER_GO_REQUEST_TIMEOUT_MS: "45000",
      },
      { requireCredentials: true },
    );
    const go = registry.profiles.get("go")!;
    expect(go).toMatchObject({ kind: "openai-compatible", preset: "opencode-go", privacy: "attested", requestTimeoutMs: 45_000 });
    expect(go.adapter).toEqual({
      kind: "openai-compatible",
      options: {
        baseUrl: "https://proxy.example.test/go/v1",
        kind: "opencode-go",
        displayName: "OpenCode Go",
        structuredOutput: "json_object",
        sessionHeader: "x-opencode-session",
        sendDimensions: false,
        minCompletionTokens: 4_096,
        userAgent: "second-brain-test/1",
        extraHeaders: { "x-team": "brain" },
      },
    });
    expect(registry.profiles.get("or")).toMatchObject({ kind: "openrouter", privacy: "enforced", adapter: { kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } });
  });

  it("supports a generic OpenAI-compatible profile and the openrouter and ollama presets", () => {
    const registry = parseProviderRegistry(
      {
        AI_PROVIDERS: "custom,router,local",
        AI_PROVIDER_CUSTOM_KIND: "openai-compatible",
        AI_PROVIDER_CUSTOM_BASE_URL: "https://llm.example.test/v1",
        AI_PROVIDER_CUSTOM_API_KEY: GO_KEY,
        AI_PROVIDER_CUSTOM_SEND_DIMENSIONS: "false",
        AI_PROVIDER_ROUTER_PRESET: "openrouter",
        AI_PROVIDER_ROUTER_API_KEY: OR_KEY,
        AI_PROVIDER_LOCAL_PRESET: "ollama",
        AI_EMBEDDING: "local:nomic-embed-1536:latest",
        AI_ANSWER: "custom:my-model,router:deepseek/deepseek-v4-flash",
      },
      { requireCredentials: true },
    );
    expect(registry.profiles.get("custom")).toMatchObject({
      privacy: "none",
      adapter: { options: { kind: "openai-compatible", baseUrl: "https://llm.example.test/v1", sendDimensions: false } },
    });
    expect(registry.profiles.get("router")).toMatchObject({ kind: "openrouter", preset: "openrouter" });
    // The local Ollama preset needs no key; model ids may contain colons.
    expect(registry.profiles.get("local")).toMatchObject({ allowUnauthenticated: true, apiKey: undefined });
    expect(registry.embedding).toEqual({ profile: "local", model: "nomic-embed-1536:latest", modelRevision: "provider-managed", dimensions: 1_536 });
  });

  it("defers missing keys to the first call in the lenient composition only", () => {
    const environment = without(base, "AI_PROVIDER_GO_API_KEY");
    expect(createModelProvider(environment).provider).toBeInstanceOf(CompositeModelProvider);
    expect(startupError(environment)).toBe(
      'AI_PROVIDER_GO_API_KEY is required because profile "go" is bound in AI_ANSWER.',
    );
    expect(startupError(environment, (env) => requireModelProviderCredentials(env) as never)).toMatch(/AI_PROVIDER_GO_API_KEY/u);
  });

  it("does not require a key for a listed but unbound profile", () => {
    const configured = createConfiguredModelProvider({
      ...base,
      AI_PROVIDERS: "go,or,spare",
      AI_PROVIDER_SPARE_PRESET: "openai",
    });
    expect(configured.provider).toBeInstanceOf(CompositeModelProvider);
  });
});

describe("provider registry fails closed", () => {
  const cases: readonly (readonly [string, EnvironmentRecord, RegExp])[] = [
    ["registry variables without AI_PROVIDERS", { OPENROUTER_API_KEY: "k", AI_ANSWER: "go:model" }, /^AI_PROVIDERS is required when provider registry variables are set \(AI_ANSWER\)\.$/u],
    ["a profile variable without AI_PROVIDERS", { AI_PROVIDER_GO_API_KEY: GO_KEY }, /AI_PROVIDERS is required.*AI_PROVIDER_GO_API_KEY/u],
    ["an unknown profile in a chat role", { ...base, AI_DREAMING: "zen:glm-5.2" }, /^AI_DREAMING entry 1 names profile "zen", which AI_PROVIDERS does not list\.$/u],
    ["an unknown profile in the embedding role", { ...base, AI_EMBEDDING: "nope:model" }, /^AI_EMBEDDING entry 1 names profile "nope"/u],
    ["an embedding failover list", { ...base, AI_EMBEDDING: "or:google/gemini-embedding-001,go:other" }, /^AI_EMBEDDING accepts exactly one <profile>:<model> entry; embeddings never fail over/u],
    ["non-1536 embedding dimensions", { ...base, AI_EMBEDDING_DIMENSIONS: "768" }, /^AI_EMBEDDING_DIMENSIONS must be 1536 because the vector columns are vector\(1536\)\.$/u],
    ["malformed embedding dimensions", { ...base, AI_EMBEDDING_DIMENSIONS: "1.5k" }, /^AI_EMBEDDING_DIMENSIONS must be a positive integer\.$/u],
    ["an unknown preset", { ...base, AI_PROVIDER_GO_PRESET: "opencode-zen" }, /^AI_PROVIDER_GO_PRESET must be one of: opencode-go, openai, ollama, openrouter\.$/u],
    ["an unknown kind", { ...base, AI_PROVIDER_OR_KIND: "anthropic" }, /^AI_PROVIDER_OR_KIND must be one of: openrouter, openai-compatible\.$/u],
    ["a profile without kind or preset", { ...without(base, "AI_PROVIDER_OR_KIND") }, /^AI_PROVIDER_OR_KIND or AI_PROVIDER_OR_PRESET is required for profile "or"\.$/u],
    ["a kind contradicting the preset", { ...base, AI_PROVIDER_GO_KIND: "openrouter" }, /^AI_PROVIDER_GO_KIND must be openai-compatible for AI_PROVIDER_GO_PRESET=opencode-go\.$/u],
    ["AI_REQUIRE_ZDR with an attested profile bound", { ...base, AI_REQUIRE_ZDR: "true" }, /^AI_REQUIRE_ZDR=true refuses profile "go" bound in AI_ANSWER: AI_PROVIDER_GO_PRIVACY is attested, not enforced\.$/u],
    ["AI_REQUIRE_ZDR with OpenRouter declared below enforced", { ...base, AI_ANSWER: "or:m", AI_PROVIDER_OR_PRIVACY: "none", AI_REQUIRE_ZDR: "true" }, /AI_REQUIRE_ZDR=true refuses profile "or" bound in AI_EMBEDDING/u],
    ["an OpenAI-compatible profile claiming enforced privacy", { ...base, AI_PROVIDER_GO_PRIVACY: "enforced" }, /^AI_PROVIDER_GO_PRIVACY=enforced requires AI_PROVIDER_GO_KIND=openrouter/u],
    ["an unknown privacy level", { ...base, AI_PROVIDER_GO_PRIVACY: "zdr" }, /^AI_PROVIDER_GO_PRIVACY must be one of: enforced, attested, none\.$/u],
    ["an unknown structured output mode", { ...base, AI_PROVIDER_GO_STRUCTURED: "tools" }, /^AI_PROVIDER_GO_STRUCTURED must be one of: json_schema, json_object, prompt\.$/u],
    ["a weaker structured output on OpenRouter", { ...base, AI_PROVIDER_OR_STRUCTURED: "prompt" }, /^AI_PROVIDER_OR_STRUCTURED must be json_schema for AI_PROVIDER_OR_KIND=openrouter\.$/u],
    ["an OpenAI-compatible-only setting on OpenRouter", { ...base, AI_PROVIDER_OR_USER_AGENT: "x" }, /^AI_PROVIDER_OR_USER_AGENT is not supported by AI_PROVIDER_OR_KIND=openrouter\.$/u],
    ["extra headers that are not JSON", { ...base, AI_PROVIDER_GO_EXTRA_HEADERS: "x-token: header-secret-value" }, /^AI_PROVIDER_GO_EXTRA_HEADERS must be a JSON object of header names to string values\.$/u],
    ["extra headers with a non-string value", { ...base, AI_PROVIDER_GO_EXTRA_HEADERS: '{"x-n":1}' }, /^AI_PROVIDER_GO_EXTRA_HEADERS must be a JSON object/u],
    ["an extra header that replaces authorization", { ...base, AI_PROVIDER_GO_EXTRA_HEADERS: '{"Authorization":"Bearer header-secret-value"}' }, /^AI_PROVIDER_GO_\* configuration is invalid: OpenCode Go extra header "Authorization" is invalid or reserved\.$/u],
    ["a plain-HTTP remote base URL", { ...base, AI_PROVIDER_GO_BASE_URL: "http://example.test/v1" }, /^AI_PROVIDER_GO_\* configuration is invalid: OpenCode Go base URL must use HTTPS outside loopback development\.$/u],
    ["an OpenAI-compatible profile without a base URL", { ...base, AI_PROVIDER_GO_PRESET: "", AI_PROVIDER_GO_KIND: "openai-compatible" }, /^AI_PROVIDER_GO_BASE_URL is required for profile "go" without AI_PROVIDER_GO_PRESET\.$/u],
    ["a malformed timeout", { ...base, AI_PROVIDER_GO_REQUEST_TIMEOUT_MS: "0" }, /^AI_PROVIDER_GO_REQUEST_TIMEOUT_MS must be a positive integer\.$/u],
    ["malformed minimum completion tokens", { ...base, AI_PROVIDER_GO_MIN_COMPLETION_TOKENS: "-1" }, /^AI_PROVIDER_GO_MIN_COMPLETION_TOKENS must be a non-negative integer\.$/u],
    ["a malformed dimensions switch", { ...base, AI_PROVIDER_GO_SEND_DIMENSIONS: "no" }, /^AI_PROVIDER_GO_SEND_DIMENSIONS must be one of: true, false\.$/u],
    ["a variable for an unlisted profile", { ...base, AI_PROVIDER_ZEN_KIND: "openai-compatible" }, /^AI_PROVIDER_ZEN_KIND does not belong to a profile listed in AI_PROVIDERS\.$/u],
    ["a misspelled profile setting", { ...base, AI_PROVIDER_GO_BASEURL: "https://x.test" }, /^AI_PROVIDER_GO_BASEURL is not a recognized provider profile setting\.$/u],
    ["an entry without a model", { ...base, AI_ANSWER: "go" }, /^AI_ANSWER entry 1 must have the form <profile>:<model>\.$/u],
    ["an empty list entry", { ...base, AI_ANSWER: "go:a,,or:b" }, /^AI_ANSWER must not contain empty list entries\.$/u],
    ["a repeated failover entry", { ...base, AI_ANSWER: "go:a,GO:a" }, /^AI_ANSWER entry 2 repeats an earlier entry\.$/u],
    ["a failover list that is too long", { ...base, AI_ANSWER: "go:a,go:b,go:c,go:d,go:e,go:f" }, /^AI_ANSWER accepts at most 5 entries\.$/u],
    ["a missing answer binding", without(base, "AI_ANSWER"), /^AI_ANSWER is required as <profile>:<model>/u],
    ["a missing embedding binding", without(base, "AI_EMBEDDING"), /^AI_EMBEDDING is required as <profile>:<model>\.$/u],
    ["a repeated profile name", { ...base, AI_PROVIDERS: "go,or,GO" }, /^AI_PROVIDERS lists profile "go" more than once\.$/u],
    ["an invalid profile name", { ...base, AI_PROVIDERS: "go,or,my-zen" }, /^AI_PROVIDERS profile names must start with a letter/u],
    ["a blank registry value", { ...base, AI_INGESTION: "   " }, /^AI_INGESTION must not be blank\.$/u],
    ["an ingestion identity beyond the storage limit", { ...base, AI_INGESTION: `go:${"m".repeat(120)},or:${"n".repeat(120)}` }, /^AI_INGESTION is too long/u],
  ];

  it.each(cases)("rejects %s", (_name, environment, expected) => {
    expect(startupError(environment)).toMatch(expected);
  });

  it("applies the same validation to the lenient composition", () => {
    for (const [, environment, expected] of cases) {
      expect(startupError(environment, createModelProvider)).toMatch(expected);
    }
  });

  it("allows AI_REQUIRE_ZDR when every bound profile is enforced OpenRouter", () => {
    const configured = createConfiguredModelProvider({
      ...base,
      AI_ANSWER: "or:deepseek/deepseek-v4-flash",
      AI_REQUIRE_ZDR: "true",
    });
    expect(configured.provider).toBeInstanceOf(CompositeModelProvider);
  });
});

class MemoryConfigurationStore implements EnvironmentConfigurationStore {
  state: EnvironmentConfigurationState = { revision: 0, entries: {}, restartRequired: false, updatedAt: null };

  async read() {
    return this.state;
  }

  async stage(_access: unknown, input: Parameters<EnvironmentConfigurationStore["stage"]>[1]) {
    const entries = { ...this.state.entries } as Record<string, unknown>;
    for (const change of input.changes) {
      if (change.entry === null) delete entries[change.name];
      else entries[change.name] = change.entry;
    }
    this.state = { revision: this.state.revision + 1, entries: entries as EnvironmentConfigurationState["entries"], restartRequired: true, updatedAt: "2026-11-04T00:00:00.000Z" };
    return { revision: this.state.revision, changedNames: input.changes.map((change) => change.name), restartRequired: true, updatedAt: this.state.updatedAt, replayed: false };
  }

  async requestRestart() {
    return null;
  }
}

describe("provider registry administrative allowlist", () => {
  it("keeps the fixed OpenRouter catalog and adds registry names by definition", () => {
    expect(environmentConfigurationCatalog).toHaveLength(7);
    expect(environmentConfigurationItem("AI_PROVIDERS")).toEqual({ name: "AI_PROVIDERS", secret: false, restartRequired: true });
    expect(environmentConfigurationItem("AI_ANSWER")?.secret).toBe(false);
    expect(environmentConfigurationItem("AI_PROVIDER_GO_API_KEY")).toEqual({ name: "AI_PROVIDER_GO_API_KEY", secret: true, restartRequired: true });
    expect(environmentConfigurationItem("AI_PROVIDER_GO2_PRESET")?.secret).toBe(false);
    // Endpoint, embedding identity, and the privacy policy stay operator-only, like OPENROUTER_BASE_URL.
    for (const name of ["AI_PROVIDER_GO_BASE_URL", "AI_EMBEDDING", "AI_EMBEDDING_REVISION", "AI_EMBEDDING_DIMENSIONS", "AI_REQUIRE_ZDR", "AI_PROVIDER_GO_UNKNOWN", "AI_PROVIDER_my-go_KIND", "AI_AGENT"]) {
      expect(environmentConfigurationItem(name), name).toBeUndefined();
    }
    expect([...providerProfileEditableSuffixes]).toEqual(providerProfileSuffixes.filter((suffix) => suffix !== "BASE_URL"));
  });

  it("stages registry settings, encrypts profile keys, and lists them only once stored", async () => {
    const store = new MemoryConfigurationStore();
    const manager = createEnvironmentConfigurationManager({ store, encryptionKey: new Uint8Array(32).fill(7) });
    const access = {} as Parameters<typeof manager.stage>[0];
    expect((await manager.list(access)).variables).toHaveLength(7);
    await manager.stage(access, {
      expectedRevision: 0,
      idempotencyKey: "registry-setup",
      changes: [
        { name: "AI_PROVIDERS", operation: "set", value: "go" },
        { name: "AI_PROVIDER_GO_PRESET", operation: "set", value: "opencode-go" },
        { name: "AI_PROVIDER_GO_API_KEY", operation: "set", value: GO_KEY },
      ],
    });
    expect(JSON.stringify(store.state)).not.toContain(GO_KEY);
    expect(store.state.entries.AI_PROVIDER_GO_API_KEY).toMatchObject({ kind: "secret" });
    const listed = await manager.list(access);
    expect(listed.variables.slice(7)).toEqual([
      { name: "AI_PROVIDERS", secret: false, configured: true, value: "go", restartRequired: true },
      { name: "AI_PROVIDER_GO_API_KEY", secret: true, configured: true, restartRequired: true },
      { name: "AI_PROVIDER_GO_PRESET", secret: false, configured: true, value: "opencode-go", restartRequired: true },
    ]);
    expect(JSON.stringify(listed)).not.toContain(GO_KEY);
    expect(environmentConfigurationOverlay(store.state, new Uint8Array(32).fill(7))).toEqual({
      AI_PROVIDERS: "go",
      AI_PROVIDER_GO_PRESET: "opencode-go",
      AI_PROVIDER_GO_API_KEY: GO_KEY,
    });
    await expect(
      manager.stage(access, {
        expectedRevision: 1,
        idempotencyKey: "registry-endpoint",
        changes: [{ name: "AI_PROVIDER_GO_BASE_URL", operation: "set", value: "https://elsewhere.test/v1" }],
      }),
    ).rejects.toThrow("AI_PROVIDER_GO_BASE_URL is not an editable environment variable");
  });
});
