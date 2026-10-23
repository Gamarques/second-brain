import type { EmbeddingInputType } from "../domain.js";
import type { ModelFailureReason, ModelOperation } from "../domain/model-usage.js";

/**
 * How a provider is asked for structured JSON output. Only strict JSON Schema
 * response formats are supported today.
 */
export type StructuredOutputMode = "json_schema";

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
  requestError(status: number, errorMessage: string): ModelProviderRequestError;
  transportError(message: string, reason: "timeout" | "network" | "malformed"): Error;
  /** Optional advisory catalog of models usable with structured output. */
  listModels?(signal: AbortSignal): Promise<readonly ModelCatalogEntry[]>;
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
