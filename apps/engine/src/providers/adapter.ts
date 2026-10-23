import type { EmbeddingInputType } from "../domain.js";
import type { ModelFailureReason, ModelOperation } from "../domain/model-usage.js";

/**
 * How a provider is asked for structured JSON output, in degradation order:
 * a strict JSON Schema response format, a plain JSON object response format,
 * or prompt instructions only. The two weaker modes describe the schema in
 * the prompt and allow one repair request when validation fails.
 */
export type StructuredOutputMode = "json_schema" | "json_object" | "prompt";

/**
 * Retry policy for transient HTTP statuses. Retries never exceed the request
 * timeout or outlive the caller's abort signal, and 400, 401, 402, and 403
 * are never retried whatever the policy lists.
 */
export interface ModelRetryPolicy {
  /** Total attempts, including the first request. */
  readonly maxAttempts: number;
  readonly retryableStatuses: readonly number[];
  /** Exponential backoff base when the response carries no Retry-After. */
  readonly baseDelayMs: number;
  /** Upper bound for any single wait, including a Retry-After value. */
  readonly maxDelayMs: number;
  /** Injectable wait used between attempts; rejects with the signal reason on abort. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Raw failure details handed to `requestError`; never surfaced to callers. */
export interface ModelRequestFailure {
  readonly body: string;
  readonly attempts: number;
}

export interface ModelRequestUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cost: number | null;
}

export interface ModelRequestContext {
  readonly operation: ModelOperation;
  /** True when the request carries a structured response format the provider must honor. */
  readonly structured: boolean;
  /** True when the caller persists an audit record and needs reported token usage. */
  readonly auditedUsage: boolean;
  readonly inputType?: EmbeddingInputType;
}

/**
 * Provider-specific request fields, grouped by where the generic request
 * body places them so the serialized field order stays stable.
 */
export interface ModelRequestExtras {
  /** Placed after the embedding input, for example an input-type hint. */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Placed after the chat response format, for example reasoning controls. */
  readonly generation?: Readonly<Record<string, unknown>>;
  /** Placed at the end of the body, for example usage accounting and routing preferences. */
  readonly trailing?: Readonly<Record<string, unknown>>;
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly name: string;
}

export type ModelProviderRequestError = Error & { readonly reason: ModelFailureReason };

/**
 * Everything that differs between model provider HTTP APIs. The shared
 * request, response, and validation logic lives in `ModelProvider`.
 */
export interface ModelProviderAdapter {
  /** Stable provider id recorded in embedding-space identity and audit records. */
  readonly kind: string;
  /** Human-readable provider name used in error messages. */
  readonly displayName: string;
  /** Normalized base URL without a trailing slash. */
  readonly baseUrl: string;
  readonly structuredOutput: StructuredOutputMode;
  /** Whether a credential is configured; it is not validated until `headers()`. */
  hasCredential(): boolean;
  /** Request headers; throws when the credential is missing. */
  headers(): Record<string, string>;
  requestExtras(context: ModelRequestContext): ModelRequestExtras;
  /** Reported usage and cost from a successful response, or null when absent or malformed. */
  extractUsage(payload: unknown): ModelRequestUsage | null;
  /** Error for a non-success HTTP status; `errorMessage` is the provider message, never surfaced. */
  requestError(status: number, errorMessage: string, failure: ModelRequestFailure): ModelProviderRequestError;
  transportError(message: string, reason: "timeout" | "network" | "malformed"): Error;
  /** Optional advisory catalog of models usable with structured output. */
  listModels?(signal: AbortSignal): Promise<readonly ModelCatalogEntry[]>;
  /** Retry policy for transient statuses; absent means a single attempt. */
  readonly retryPolicy?: ModelRetryPolicy | undefined;
  /** Whether embedding requests carry `dimensions`; absent means true. */
  readonly sendsEmbeddingDimensions?: boolean;
  /** Chat `max_tokens` for an operation's budget, for example room for reasoning tokens; absent keeps the budget. */
  completionTokens?(requested: number): number;
}

export function normalizeBaseUrl(value: string, displayName: string): string {
  const normalized = value.replace(/\/+$/, "");
  const url = new URL(normalized);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${displayName} base URL must use HTTPS outside loopback development.`);
  }
  return normalized;
}
