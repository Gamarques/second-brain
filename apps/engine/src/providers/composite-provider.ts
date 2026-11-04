import type { BrainQuestionProvider } from "../domain/brain-question.js";
import type {
  AnswerProvider,
  DreamingModelResult,
  DreamingProvider,
  DreamingVerificationProvider,
  EmbeddingInputType,
  EmbeddingProvider,
  IngestionModelResult,
  IngestionProvider,
} from "../domain.js";
import type { ModelProvider } from "./model-provider.js";
import { OpenAICompatibleRequestError, OpenAICompatibleTransportError } from "./openai-compatible-adapter.js";
import { OpenRouterRequestError, OpenRouterTransportError } from "./openrouter-adapter.js";
import type { ChatRole } from "./provider-registry.js";

/** One entry of a role's ordered failover list. */
export interface ChatRoute {
  readonly profile: string;
  readonly model: string;
  /** A provider whose chat operations all use `model`. */
  readonly provider: ModelProvider;
}

/** Which failover entry served a chat request; internal, never persisted. */
export interface ServedRoute {
  readonly role: ChatRole;
  readonly profile: string;
  readonly model: string;
  /** Zero-based position in the role's failover list. */
  readonly index: number;
}

export interface CompositeModelProviderOptions {
  readonly embedding: ModelProvider;
  readonly chat: Readonly<Record<ChatRole, readonly ChatRoute[]>>;
  /** The identity an ingestion run records before the call; see `ingestionIdentity`. */
  readonly ingestionIdentity: { readonly provider: string; readonly model: string };
  readonly onServed?: (served: ServedRoute) => void;
}

const FAILOVER_STATUSES = new Set([402, 403, 429]);

/**
 * Whether a failed request may move on to the next failover entry: exhausted
 * rate limits, server errors, exhausted credits, edge blocks, network
 * failures, and provider timeouts. Validation failures, invalid completions,
 * other client errors, and every caller abort stop at the failing entry.
 */
export function isFailoverEligible(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  if (error instanceof OpenRouterRequestError || error instanceof OpenAICompatibleRequestError) {
    return FAILOVER_STATUSES.has(error.status) || (error.status >= 500 && error.status <= 599);
  }
  if (error instanceof OpenRouterTransportError || error instanceof OpenAICompatibleTransportError) {
    return error.reason === "timeout" || error.reason === "network";
  }
  return false;
}

function requireRoutes(chat: CompositeModelProviderOptions["chat"]): void {
  for (const [role, routes] of Object.entries(chat)) {
    if (routes.length === 0) throw new Error(`The ${role} role needs at least one provider entry.`);
  }
}

/**
 * Delegates every model operation to the provider bound to its role.
 * Embeddings use exactly one provider and never fail over; chat roles try
 * their ordered entries and fail over only on retryable provider conditions.
 */
export class CompositeModelProvider
  implements
    EmbeddingProvider,
    AnswerProvider,
    IngestionProvider,
    DreamingProvider,
    DreamingVerificationProvider,
    BrainQuestionProvider
{
  readonly provider: string;
  readonly model: string;
  readonly modelRevision: string;
  readonly dimensions: number;
  readonly ingestionProvider: string;
  readonly ingestionModel: string;

  private readonly embedding: ModelProvider;
  private readonly chat: CompositeModelProviderOptions["chat"];
  private readonly onServed: ((served: ServedRoute) => void) | undefined;

  constructor(options: CompositeModelProviderOptions) {
    requireRoutes(options.chat);
    this.embedding = options.embedding;
    this.provider = options.embedding.provider;
    this.model = options.embedding.model;
    this.modelRevision = options.embedding.modelRevision;
    this.dimensions = options.embedding.dimensions;
    this.chat = options.chat;
    this.ingestionProvider = options.ingestionIdentity.provider;
    this.ingestionModel = options.ingestionIdentity.model;
    this.onServed = options.onServed;
  }

  /** The routes bound to a chat role, primary first. */
  routes(role: ChatRole): readonly ChatRoute[] {
    return this.chat[role];
  }

  private async failover<T>(
    role: ChatRole,
    signal: AbortSignal,
    call: (provider: ModelProvider) => Promise<T>,
  ): Promise<T> {
    const routes = this.chat[role];
    for (let index = 0; ; index += 1) {
      const route = routes[index]!;
      try {
        const result = await call(route.provider);
        this.onServed?.({ role, profile: route.profile, model: route.model, index });
        return result;
      } catch (error) {
        if (index === routes.length - 1 || !isFailoverEligible(error, signal)) throw error;
      }
    }
  }

  embed(
    texts: readonly string[],
    signal: AbortSignal,
    inputType: EmbeddingInputType,
  ): Promise<readonly (readonly number[])[]> {
    return this.embedding.embed(texts, signal, inputType);
  }

  answer(...args: Parameters<AnswerProvider["answer"]>): ReturnType<AnswerProvider["answer"]> {
    return this.failover("answer", args[1], (provider) => provider.answer(...args));
  }

  reason(...args: Parameters<AnswerProvider["reason"]>): ReturnType<AnswerProvider["reason"]> {
    return this.failover("answer", args[1], (provider) => provider.reason(...args));
  }

  answerAcrossBrain(
    ...args: Parameters<BrainQuestionProvider["answerAcrossBrain"]>
  ): ReturnType<BrainQuestionProvider["answerAcrossBrain"]> {
    return this.failover("answer", args[1], (provider) => provider.answerAcrossBrain(...args));
  }

  /**
   * The result carries the ingestion identity declared before the call, so a
   * failover entry still matches the persisted run; usage observations record
   * the model that actually served.
   */
  async propose(...args: Parameters<IngestionProvider["propose"]>): Promise<IngestionModelResult> {
    const result = await this.failover("ingestion", args[1], (provider) => provider.propose(...args));
    return { ...result, provider: this.ingestionProvider, model: this.ingestionModel };
  }

  /** Dreaming records the identity of the entry that actually served the plan. */
  createPlan(...args: Parameters<DreamingProvider["createPlan"]>): Promise<DreamingModelResult> {
    return this.failover("dreaming", args[2], (provider) => provider.createPlan(...args));
  }

  verifyUpdates(
    ...args: Parameters<DreamingVerificationProvider["verifyUpdates"]>
  ): ReturnType<DreamingVerificationProvider["verifyUpdates"]> {
    return this.failover("verification", args[1], (provider) => provider.verifyUpdates(...args));
  }
}
