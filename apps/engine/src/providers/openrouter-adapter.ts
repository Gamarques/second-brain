import { z } from "zod";

import type { ModelFailureReason } from "../domain/model-usage.js";
import {
  normalizeBaseUrl,
  type ModelProviderAdapter,
  type ModelRequestContext,
  type ModelRequestExtras,
  type ModelRequestUsage,
} from "./adapter.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const reportedUsageSchema = z.object({
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().nullish(),
      completion_tokens: z.number().int().nonnegative().nullish(),
      cost: z.number().nonnegative().nullish(),
    })
    .nullish(),
});

export class OpenRouterRequestError extends Error {
  readonly code: "OPENROUTER_AUTHENTICATION_FAILED" | "OPENROUTER_REQUEST_FAILED";

  constructor(readonly status: number, readonly reason: ModelFailureReason = status === 401 || status === 403 ? "authentication" : status === 402 ? "credits" : status === 429 ? "rate_limit" : status === 404 || status === 503 ? "unavailable" : "unknown") {
    super(`The OpenRouter request failed with status ${status}.`);
    this.name = "OpenRouterRequestError";
    this.code =
      status === 401 || status === 403
        ? "OPENROUTER_AUTHENTICATION_FAILED"
        : "OPENROUTER_REQUEST_FAILED";
  }
}

export class OpenRouterTransportError extends Error {
  constructor(message: string, readonly reason: "timeout" | "network" | "malformed") {
    super(message);
    this.name = "OpenRouterTransportError";
  }
}

export interface OpenRouterAdapterOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly appUrl?: string;
  readonly appTitle?: string;
}

/**
 * OpenRouter specifics: app attribution headers, zero-data-retention routing
 * preferences on every request, reasoning disabled for structured chat, and
 * reported usage including cost.
 */
export class OpenRouterAdapter implements ModelProviderAdapter {
  readonly kind = "openrouter";
  readonly displayName = "OpenRouter";
  readonly baseUrl: string;
  readonly structuredOutput = "json_schema";

  private readonly apiKey: string | undefined;
  private readonly appUrl: string | undefined;
  private readonly appTitle: string;

  constructor(options: OpenRouterAdapterOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? OPENROUTER_BASE_URL, this.displayName);
    this.appUrl = options.appUrl;
    this.appTitle = options.appTitle ?? "second-brain";
  }

  hasCredential(): boolean {
    return Boolean(this.apiKey);
  }

  headers(): Record<string, string> {
    if (this.apiKey === undefined || this.apiKey.trim() === "") {
      throw new Error("OPENROUTER_API_KEY is required for semantic capabilities.");
    }
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      "x-title": this.appTitle,
      ...(this.appUrl === undefined ? {} : { "http-referer": this.appUrl }),
    };
  }

  requestExtras(context: ModelRequestContext): ModelRequestExtras {
    return {
      input: context.inputType === undefined ? {} : { input_type: context.inputType },
      generation: { reasoning: { enabled: false } },
      trailing: {
        ...(context.auditedUsage ? { usage: { include: true } } : {}),
        provider: {
          data_collection: "deny",
          zdr: true,
          ...(context.structured ? { require_parameters: true } : {}),
        },
      },
    };
  }

  extractUsage(payload: unknown): ModelRequestUsage | null {
    const parsed = reportedUsageSchema.safeParse(payload);
    if (!parsed.success) return null;
    return {
      inputTokens: parsed.data.usage?.prompt_tokens ?? null,
      outputTokens: parsed.data.usage?.completion_tokens ?? null,
      cost: parsed.data.usage?.cost ?? null,
    };
  }

  requestError(status: number, errorMessage: string): OpenRouterRequestError {
    return new OpenRouterRequestError(
      status,
      status === 404 && /zero data retention|data policy|privacy settings/i.test(errorMessage) ? "privacy" : undefined,
    );
  }

  transportError(message: string, reason: "timeout" | "network" | "malformed"): OpenRouterTransportError {
    return new OpenRouterTransportError(message, reason);
  }
}
