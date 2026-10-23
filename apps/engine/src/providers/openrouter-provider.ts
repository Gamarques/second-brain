import type { ModelRequestObserver } from "../domain/model-usage.js";
import { ModelProvider } from "./model-provider.js";
import { OpenRouterAdapter } from "./openrouter-adapter.js";

export { OpenRouterRequestError, OpenRouterTransportError } from "./openrouter-adapter.js";

const DEFAULT_EMBEDDING_MODEL = "google/gemini-embedding-001";
const DEFAULT_ANSWER_MODEL = "deepseek/deepseek-v4-flash";

export interface OpenRouterProviderOptions {
  readonly observeRequest?: ModelRequestObserver;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly embeddingModel?: string;
  readonly embeddingModelRevision?: string;
  readonly answerModel?: string;
  readonly ingestionModel?: string;
  readonly dreamingModel?: string;
  readonly verificationModel?: string;
  readonly dimensions?: number;
  readonly appUrl?: string;
  readonly appTitle?: string;
  readonly requestTimeoutMs?: number;
}

/** The OpenRouter-backed model provider configured from `OPENROUTER_*` settings. */
export class OpenRouterProvider extends ModelProvider {
  override readonly provider = "openrouter";
  override readonly ingestionProvider = "openrouter";

  constructor(options: OpenRouterProviderOptions = {}) {
    super(new OpenRouterAdapter(options), {
      ...options,
      embeddingModel: options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
      answerModel: options.answerModel ?? DEFAULT_ANSWER_MODEL,
    });
  }
}
