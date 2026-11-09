import type { OpenAICompatibleAdapterOptions } from "./openai-compatible-adapter.js";

/**
 * Ready-made settings for OpenAI-compatible providers. They carry no secrets:
 * the caller adds `apiKey`. `verified` records how much of the preset has been
 * exercised against the real service, so nobody assumes more than we know.
 */
export type ProviderPresetName = "opencode-go" | "opencode-zen" | "openai" | "ollama";

export interface ProviderPreset {
  readonly name: ProviderPresetName;
  readonly options: Omit<OpenAICompatibleAdapterOptions, "apiKey">;
  /** The provider's own privacy statement; never enforced by this code. */
  readonly privacy: "attested" | "none";
  readonly verified: "live" | "documented";
  readonly notes: string;
}

const REASONING_HEADROOM = 1_024;

export const PROVIDER_PRESETS: Readonly<Record<ProviderPresetName, ProviderPreset>> = {
  "opencode-go": {
    name: "opencode-go",
    options: {
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      kind: "opencode-go",
      displayName: "OpenCode Go",
      structuredOutput: "json_schema",
      sessionHeader: "x-opencode-session",
      sendDimensions: false,
      minCompletionTokens: REASONING_HEADROOM,
    },
    privacy: "attested",
    verified: "live",
    notes:
      "Plain model ids (`deepseek-v4.1-flash`); the `opencode-go/` prefix is rejected. Models Qwen and MiniMax need the Anthropic protocol. Chat only: no embedding models.",
  },
  "opencode-zen": {
    name: "opencode-zen",
    options: {
      baseUrl: "https://opencode.ai/zen/v1",
      kind: "opencode-zen",
      displayName: "OpenCode Zen",
      structuredOutput: "json_schema",
      sessionHeader: "x-opencode-session",
      sendDimensions: false,
      minCompletionTokens: REASONING_HEADROOM,
    },
    privacy: "attested",
    verified: "documented",
    notes: "Pay-as-you-go. Endpoint reachable; a funded account has not been exercised yet. Chat only: no embedding models.",
  },
  openai: {
    name: "openai",
    options: {
      baseUrl: "https://api.openai.com/v1",
      kind: "openai",
      displayName: "OpenAI",
      structuredOutput: "json_schema",
    },
    privacy: "none",
    verified: "documented",
    notes: "Supports embeddings with the `dimensions` parameter on text-embedding-3 models.",
  },
  ollama: {
    name: "ollama",
    options: {
      baseUrl: "http://localhost:11434/v1",
      kind: "ollama",
      displayName: "Ollama",
      structuredOutput: "json_object",
      allowUnauthenticated: true,
      sendDimensions: false,
    },
    privacy: "none",
    verified: "documented",
    notes: "Local server. Embedding dimensions are fixed by the model, so only a 1536-dimension model fits the current vector columns.",
  },
};
