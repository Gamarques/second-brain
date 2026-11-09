import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ModelFailureReason, ModelRequestObserver } from "../domain/model-usage.js";
import { SECOND_BRAIN_VERSION } from "../version.js";
import {
  normalizeBaseUrl,
  type ModelProviderAdapter,
  type ModelRequestContext,
  type ModelRequestExtras,
  type ModelRequestFailure,
  type ModelRequestUsage,
  type ModelRetryPolicy,
  type StructuredOutputMode,
} from "./adapter.js";
import { ModelProvider } from "./model-provider.js";

export const OPENAI_COMPATIBLE_KIND = "openai-compatible";
export const DEFAULT_USER_AGENT = `second-brain/${SECOND_BRAIN_VERSION}`;

/** Retries 429 and 503 up to three attempts, waiting at most 10 seconds at a time. */
export const DEFAULT_OPENAI_COMPATIBLE_RETRY_POLICY: ModelRetryPolicy = {
  maxAttempts: 3,
  retryableStatuses: [429, 503],
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
};

const reportedTokensSchema = z.object({
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().nullish(),
      completion_tokens: z.number().int().nonnegative().nullish(),
    })
    .nullish(),
});

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const RESERVED_HEADERS = new Set(["authorization", "content-type", "user-agent"]);
const KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export type OpenAICompatibleErrorCode =
  | "OPENAI_COMPATIBLE_AUTHENTICATION_FAILED"
  | "OPENAI_COMPATIBLE_INSUFFICIENT_FUNDS"
  | "OPENAI_COMPATIBLE_BLOCKED"
  | "OPENAI_COMPATIBLE_RATE_LIMITED"
  | "OPENAI_COMPATIBLE_REQUEST_FAILED";

/**
 * A non-success HTTP status. The message names the provider, the status, and
 * an actionable classification, never the provider's response body.
 */
export class OpenAICompatibleRequestError extends Error {
  readonly code: OpenAICompatibleErrorCode;
  readonly reason: ModelFailureReason;

  constructor(
    readonly status: number,
    displayName: string,
    readonly attempts = 1,
    edgeBlocked = false,
  ) {
    const classified = classify(status, edgeBlocked);
    super(classified.message(displayName, attempts));
    this.name = "OpenAICompatibleRequestError";
    this.code = classified.code;
    this.reason = classified.reason;
  }
}

function classify(status: number, edgeBlocked: boolean): {
  readonly code: OpenAICompatibleErrorCode;
  readonly reason: ModelFailureReason;
  readonly message: (name: string, attempts: number) => string;
} {
  const after = (attempts: number) => (attempts > 1 ? ` after ${attempts} attempts` : "");
  switch (true) {
    case status === 401:
      return {
        code: "OPENAI_COMPATIBLE_AUTHENTICATION_FAILED",
        reason: "authentication",
        message: (name) => `The ${name} API key was rejected (status 401).`,
      };
    case status === 402:
      return {
        code: "OPENAI_COMPATIBLE_INSUFFICIENT_FUNDS",
        reason: "credits",
        message: (name) => `The ${name} account has insufficient funds or reached its usage limit (status 402).`,
      };
    case status === 403 && edgeBlocked:
      return {
        code: "OPENAI_COMPATIBLE_BLOCKED",
        reason: "authentication",
        message: (name) =>
          `The ${name} edge blocked the request (status 403, error code 1010); configure a distinct User-Agent.`,
      };
    case status === 403:
      return {
        code: "OPENAI_COMPATIBLE_BLOCKED",
        reason: "authentication",
        message: (name) => `The ${name} request was refused (status 403).`,
      };
    case status === 429:
      return {
        code: "OPENAI_COMPATIBLE_RATE_LIMITED",
        reason: "rate_limit",
        message: (name, attempts) => `The ${name} rate or usage limit was reached (status 429)${after(attempts)}.`,
      };
    case status === 404 || status === 503:
      return {
        code: "OPENAI_COMPATIBLE_REQUEST_FAILED",
        reason: "unavailable",
        message: (name, attempts) => `The ${name} model or endpoint is unavailable (status ${status})${after(attempts)}.`,
      };
    default:
      return {
        code: "OPENAI_COMPATIBLE_REQUEST_FAILED",
        reason: "unknown",
        message: (name, attempts) => `The ${name} request failed with status ${status}${after(attempts)}.`,
      };
  }
}

export class OpenAICompatibleTransportError extends Error {
  constructor(message: string, readonly reason: "timeout" | "network" | "malformed") {
    super(message);
    this.name = "OpenAICompatibleTransportError";
  }
}

export interface OpenAICompatibleAdapterOptions {
  /** Provider base URL ending before `/chat/completions`, for example `https://opencode.ai/zen/v1`. */
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Allows requests without an API key, for local servers such as Ollama. */
  readonly allowUnauthenticated?: boolean;
  /** Provider id recorded in embedding-space identity and audit records. */
  readonly kind?: string;
  readonly displayName?: string;
  readonly structuredOutput?: StructuredOutputMode;
  /** Additional request headers; they cannot replace authorization, content type, user agent, or session. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Sent on every request; edge firewalls reject generic HTTP library user agents. */
  readonly userAgent?: string;
  /** Header carrying a stable per-instance session id, for example `x-opencode-session`. */
  readonly sessionHeader?: string;
  /** Session id sent in `sessionHeader`; defaults to a random UUID per adapter instance. */
  readonly sessionId?: string;
  /** Whether embedding requests carry `dimensions`; defaults to true. */
  readonly sendDimensions?: boolean;
  /** Whether embedding requests carry the non-standard `input_type` hint; defaults to false. */
  readonly sendInputType?: boolean;
  /** Lower bound for chat `max_tokens`, leaving room for reasoning tokens. */
  readonly minCompletionTokens?: number;
  /** Multiplier applied to each operation's chat `max_tokens` budget; defaults to 1. */
  readonly completionTokenMultiplier?: number;
  /** Fields merged into every chat request, for example a provider-specific reasoning switch. */
  readonly chatRequestExtras?: Readonly<Record<string, unknown>>;
  /** Retry policy for 429 and 503; `false` disables retries. */
  readonly retry?: Partial<ModelRetryPolicy> | false;
}

function nonNegativeInteger(value: number, message: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(message);
  return value;
}

function headerValue(value: string, message: string): string {
  if (value.trim() === "" || /[\r\n\0]/u.test(value)) throw new Error(message);
  return value;
}

/**
 * A provider that speaks the standard OpenAI `/chat/completions` and
 * `/embeddings` protocol: OpenCode Zen and Go, OpenAI, DeepSeek, Groq,
 * LiteLLM, vLLM, Ollama, and similar. It sends only standard fields plus
 * explicitly configured extras, never reports cost, and identifies itself
 * with a project user agent.
 */
export class OpenAICompatibleAdapter implements ModelProviderAdapter {
  readonly kind: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly structuredOutput: StructuredOutputMode;
  readonly retryPolicy: ModelRetryPolicy | undefined;
  readonly sendsEmbeddingDimensions: boolean;

  private readonly apiKey: string | undefined;
  private readonly allowUnauthenticated: boolean;
  private readonly fixedHeaders: Readonly<Record<string, string>>;
  private readonly sendInputType: boolean;
  private readonly minCompletionTokens: number;
  private readonly completionTokenMultiplier: number;
  private readonly chatRequestExtras: Readonly<Record<string, unknown>>;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.kind = options.kind ?? OPENAI_COMPATIBLE_KIND;
    if (!KIND.test(this.kind)) {
      throw new Error("Provider kind must be 1-64 lowercase letters, digits, dots, underscores, or hyphens.");
    }
    this.displayName = headerValue(options.displayName ?? "OpenAI-compatible provider", "Provider display name must not be blank.");
    this.baseUrl = normalizeBaseUrl(options.baseUrl, this.displayName);
    this.structuredOutput = options.structuredOutput ?? "json_schema";
    if (!["json_schema", "json_object", "prompt"].includes(this.structuredOutput)) {
      throw new Error(`${this.displayName} structured output mode must be json_schema, json_object, or prompt.`);
    }
    this.apiKey = options.apiKey;
    this.allowUnauthenticated = options.allowUnauthenticated ?? false;
    this.sendsEmbeddingDimensions = options.sendDimensions ?? true;
    this.sendInputType = options.sendInputType ?? false;
    this.minCompletionTokens = nonNegativeInteger(
      options.minCompletionTokens ?? 0,
      `${this.displayName} minimum completion tokens must be a non-negative integer.`,
    );
    this.completionTokenMultiplier = options.completionTokenMultiplier ?? 1;
    if (!Number.isFinite(this.completionTokenMultiplier) || this.completionTokenMultiplier < 1) {
      throw new Error(`${this.displayName} completion token multiplier must be a finite number of at least 1.`);
    }
    this.chatRequestExtras = { ...options.chatRequestExtras };
    for (const key of Object.keys(this.chatRequestExtras)) {
      if (["model", "messages", "response_format", "temperature", "max_tokens"].includes(key)) {
        throw new Error(`${this.displayName} chat request extras cannot replace "${key}".`);
      }
    }
    this.retryPolicy = options.retry === false ? undefined : { ...DEFAULT_OPENAI_COMPATIBLE_RETRY_POLICY, ...options.retry };
    if (this.retryPolicy !== undefined) {
      if (!Number.isInteger(this.retryPolicy.maxAttempts) || this.retryPolicy.maxAttempts < 1 || this.retryPolicy.maxAttempts > 3) {
        throw new Error(`${this.displayName} retry attempts must be an integer from 1 to 3.`);
      }
      nonNegativeInteger(this.retryPolicy.baseDelayMs, `${this.displayName} retry delay must be a non-negative integer.`);
      nonNegativeInteger(this.retryPolicy.maxDelayMs, `${this.displayName} retry delay cap must be a non-negative integer.`);
    }

    const sessionHeader = options.sessionHeader?.toLowerCase();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
      const lower = name.toLowerCase();
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(lower) || lower === sessionHeader) {
        throw new Error(`${this.displayName} extra header "${name}" is invalid or reserved.`);
      }
      headers[lower] = headerValue(value, `${this.displayName} extra header "${name}" must have a single-line value.`);
    }
    headers["user-agent"] = headerValue(
      options.userAgent ?? DEFAULT_USER_AGENT,
      `${this.displayName} user agent must be a non-blank single line.`,
    );
    if (sessionHeader !== undefined) {
      if (!HEADER_NAME.test(sessionHeader) || RESERVED_HEADERS.has(sessionHeader)) {
        throw new Error(`${this.displayName} session header "${options.sessionHeader}" is invalid or reserved.`);
      }
      headers[sessionHeader] = headerValue(
        options.sessionId ?? randomUUID(),
        `${this.displayName} session id must be a non-blank single line.`,
      );
    }
    this.fixedHeaders = headers;
  }

  hasCredential(): boolean {
    return (this.apiKey !== undefined && this.apiKey.trim() !== "") || this.allowUnauthenticated;
  }

  headers(): Record<string, string> {
    const authenticated = this.apiKey !== undefined && this.apiKey.trim() !== "";
    if (!authenticated && !this.allowUnauthenticated) {
      throw new Error(`An API key for ${this.displayName} is required for semantic capabilities.`);
    }
    return {
      ...(authenticated ? { authorization: `Bearer ${this.apiKey}` } : {}),
      "content-type": "application/json",
      ...this.fixedHeaders,
    };
  }

  /** Chat extras trail the body so the configuration probe carries them too. */
  requestExtras(context: ModelRequestContext): ModelRequestExtras {
    return {
      input: this.sendInputType && context.inputType !== undefined ? { input_type: context.inputType } : {},
      generation: {},
      trailing: context.operation === "embedding" ? {} : this.chatRequestExtras,
    };
  }

  completionTokens(requested: number): number {
    return Math.max(this.minCompletionTokens, Math.ceil(requested * this.completionTokenMultiplier));
  }

  /** Token counts only; cost is never reported by these APIs and never estimated. */
  extractUsage(payload: unknown): ModelRequestUsage | null {
    const parsed = reportedTokensSchema.safeParse(payload);
    if (!parsed.success) return null;
    return {
      inputTokens: parsed.data.usage?.prompt_tokens ?? null,
      outputTokens: parsed.data.usage?.completion_tokens ?? null,
      cost: null,
    };
  }

  requestError(status: number, _errorMessage: string, failure: ModelRequestFailure): OpenAICompatibleRequestError {
    return new OpenAICompatibleRequestError(
      status,
      this.displayName,
      failure.attempts,
      status === 403 && /error code:?\s*1010/iu.test(failure.body),
    );
  }

  transportError(message: string, reason: "timeout" | "network" | "malformed"): OpenAICompatibleTransportError {
    return new OpenAICompatibleTransportError(message, reason);
  }
}

export interface OpenAICompatibleProviderOptions extends OpenAICompatibleAdapterOptions {
  readonly observeRequest?: ModelRequestObserver;
  readonly embeddingModel: string;
  readonly embeddingModelRevision?: string;
  readonly answerModel: string;
  readonly ingestionModel?: string;
  readonly dreamingModel?: string;
  readonly verificationModel?: string;
  readonly dimensions?: number;
  readonly requestTimeoutMs?: number;
}

/** A model provider backed by any OpenAI-compatible HTTP API. */
export class OpenAICompatibleProvider extends ModelProvider {
  constructor(options: OpenAICompatibleProviderOptions) {
    super(new OpenAICompatibleAdapter(options), options);
  }
}
