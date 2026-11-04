import type { BrainQuestionProvider } from "./domain/brain-question.js";
import type { ModelRequestObserver } from "./domain/model-usage.js";
import type {
  AnswerProvider,
  DreamingProvider,
  DreamingVerificationProvider,
  EmbeddingProvider,
  IngestionProvider,
} from "./domain.js";
import {
  EngineStartupError,
  requireEnvironment,
  type EnvironmentRecord,
} from "./env.js";
import {
  CompositeModelProvider,
  type ChatRoute,
  type ServedRoute,
} from "./providers/composite-provider.js";
import { OpenRouterProvider } from "./providers/openrouter-provider.js";
import {
  chatRoles,
  createProfileProvider,
  ingestionIdentity,
  parseProviderRegistry,
  readRequireZdr,
  usesProviderRegistry,
  type ChatRole,
  type ProviderRegistryConfiguration,
  type RoleEntry,
} from "./providers/provider-registry.js";

const defaults = {
  baseUrl: "https://openrouter.ai/api/v1",
  embeddingModel: "google/gemini-embedding-001",
  embeddingModelRevision: "provider-managed",
  answerModel: "deepseek/deepseek-v4-flash",
  dimensions: 1_536,
  requestTimeoutMs: 30_000,
} as const;

export interface EmbeddingProviderIdentity {
  readonly provider: string;
  readonly model: string;
  readonly modelRevision: string;
  readonly dimensions: number;
}

/** Every model role the runtime composes: one provider, or a per-role composite. */
export type RuntimeModelProvider = EmbeddingProvider &
  AnswerProvider &
  IngestionProvider &
  DreamingProvider &
  DreamingVerificationProvider &
  BrainQuestionProvider;

export interface ConfiguredModelProvider {
  readonly provider: RuntimeModelProvider;
  readonly embeddingIdentity: EmbeddingProviderIdentity;
  readonly dreamingModel: string;
  readonly modelNames: Readonly<Record<string, string>>;
}

export interface ModelProviderCompositionOptions {
  /** Called with the failover entry that served each chat request; internal diagnostics only. */
  readonly onServed?: (served: ServedRoute) => void;
}

function optionalValue(
  environment: EnvironmentRecord,
  name: string,
): string | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new EngineStartupError(`${name} must not be empty.`);
  }
  return value;
}

function positiveInteger(
  environment: EnvironmentRecord,
  name: string,
  fallback: number,
): number {
  const value = optionalValue(environment, name);
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/u.test(value)) {
    throw new EngineStartupError(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new EngineStartupError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function identityOf(provider: EmbeddingProvider): EmbeddingProviderIdentity {
  return {
    provider: provider.provider,
    model: provider.model,
    modelRevision: provider.modelRevision,
    dimensions: provider.dimensions,
  };
}

/** The `OPENROUTER_*` composition, used whenever no provider registry variable is set. */
function legacyModelProvider(
  environment: EnvironmentRecord,
  observeRequest: ModelRequestObserver | undefined,
): ConfiguredModelProvider {
  const apiKey = optionalValue(environment, "OPENROUTER_API_KEY");

  const answerModel =
    optionalValue(environment, "OPENROUTER_ANSWER_MODEL") ??
    defaults.answerModel;
  const dreamingModel =
    optionalValue(environment, "OPENROUTER_DREAMING_MODEL") ?? answerModel;
  const appUrl = optionalValue(environment, "OPENROUTER_APP_URL");

  try {
    const provider = new OpenRouterProvider({
      ...(observeRequest === undefined ? {} : { observeRequest }),
      ...(apiKey === undefined ? {} : { apiKey }),
      baseUrl:
        optionalValue(environment, "OPENROUTER_BASE_URL") ?? defaults.baseUrl,
      embeddingModel:
        optionalValue(environment, "OPENROUTER_EMBEDDING_MODEL") ??
        defaults.embeddingModel,
      embeddingModelRevision:
        optionalValue(environment, "OPENROUTER_EMBEDDING_MODEL_REVISION") ??
        defaults.embeddingModelRevision,
      answerModel,
      ingestionModel:
        optionalValue(environment, "OPENROUTER_INGESTION_MODEL") ?? answerModel,
      dreamingModel,
      verificationModel:
        optionalValue(environment, "OPENROUTER_VERIFICATION_MODEL") ??
        answerModel,
      dimensions: defaults.dimensions,
      ...(appUrl === undefined ? {} : { appUrl }),
      appTitle: "second-brain",
      requestTimeoutMs: positiveInteger(
        environment,
        "OPENROUTER_REQUEST_TIMEOUT_MS",
        defaults.requestTimeoutMs,
      ),
    });
    return {
      provider,
      embeddingIdentity: identityOf(provider),
      dreamingModel,
      modelNames: { embedding: provider.model, answer: answerModel, ingestion: provider.ingestionModel, dreaming: dreamingModel, verification: optionalValue(environment, "OPENROUTER_VERIFICATION_MODEL") ?? answerModel },
    };
  } catch (error) {
    if (error instanceof EngineStartupError) throw error;
    throw new EngineStartupError("Model provider configuration is invalid.");
  }
}

function bindingLabel(entries: readonly RoleEntry[]): string {
  return entries.map((entry) => `${entry.profile}:${entry.model}`).join(",");
}

/**
 * Composes a parsed provider registry: one provider for the embedding role
 * and one per chat failover entry. Embedding identity comes from the
 * embedding role's profile alone.
 */
export function composeRegistryModelProvider(
  registry: ProviderRegistryConfiguration,
  observeRequest?: ModelRequestObserver,
  options: ModelProviderCompositionOptions = {},
): ConfiguredModelProvider {
  const profile = (name: string) => registry.profiles.get(name)!;
  const embedding = createProfileProvider(
    profile(registry.embedding.profile),
    {
      embeddingModel: registry.embedding.model,
      embeddingModelRevision: registry.embedding.modelRevision,
      dimensions: registry.embedding.dimensions,
      chatModel: registry.embedding.model,
    },
    observeRequest,
  );
  const chat = {} as Record<ChatRole, readonly ChatRoute[]>;
  for (const role of chatRoles) {
    chat[role] = registry.chat[role].map((entry) => ({
      profile: entry.profile,
      model: entry.model,
      provider: createProfileProvider(
        profile(entry.profile),
        { embeddingModel: registry.embedding.model, chatModel: entry.model },
        observeRequest,
      ),
    }));
  }
  const provider = new CompositeModelProvider({
    embedding,
    chat,
    ingestionIdentity: ingestionIdentity(registry.chat.ingestion, registry.profiles),
    ...(options.onServed === undefined ? {} : { onServed: options.onServed }),
  });
  return {
    provider,
    embeddingIdentity: identityOf(provider),
    dreamingModel: registry.chat.dreaming[0]!.model,
    modelNames: {
      embedding: `${registry.embedding.profile}:${registry.embedding.model}`,
      answer: bindingLabel(registry.chat.answer),
      ingestion: bindingLabel(registry.chat.ingestion),
      dreaming: bindingLabel(registry.chat.dreaming),
      verification: bindingLabel(registry.chat.verification),
    },
  };
}

/**
 * The sole environment-to-model composition path, so embedding spaces cannot
 * be provisioned with an identity different from the serving model. With no
 * provider registry (`AI_*`) variable set it is exactly the `OPENROUTER_*`
 * provider. Missing API keys are tolerated at construction and fail on the
 * first model call, which lets the conventional engine composition root
 * build without configuration; validated runtimes require the keys through
 * createConfiguredModelProvider instead. Every other inconsistency fails
 * closed here.
 */
export function createModelProvider(
  environment: EnvironmentRecord = process.env,
  observeRequest?: ModelRequestObserver,
  options: ModelProviderCompositionOptions = {},
): ConfiguredModelProvider {
  if (!usesProviderRegistry(environment)) {
    // OpenRouter routing enforces zero data retention, so the policy flag only needs a valid value.
    readRequireZdr(environment);
    return legacyModelProvider(environment, observeRequest);
  }
  return composeRegistryModelProvider(
    parseProviderRegistry(environment, { requireCredentials: false }),
    observeRequest,
    options,
  );
}

/**
 * The fail-closed variant for validated runtimes: bootstrap, the capability
 * runtime, and the automation worker refuse to start without a real key for
 * every bound provider profile.
 */
export function createConfiguredModelProvider(
  environment: EnvironmentRecord = process.env,
  observeRequest?: ModelRequestObserver,
  options: ModelProviderCompositionOptions = {},
): ConfiguredModelProvider {
  if (!usesProviderRegistry(environment)) {
    requireEnvironment(["OPENROUTER_API_KEY"], { env: environment });
    return createModelProvider(environment, observeRequest);
  }
  return composeRegistryModelProvider(
    parseProviderRegistry(environment, { requireCredentials: true }),
    observeRequest,
    options,
  );
}

/** Credential check for entrypoints that validate the environment before composing models. */
export function requireModelProviderCredentials(
  environment: EnvironmentRecord = process.env,
): void {
  if (!usesProviderRegistry(environment)) {
    requireEnvironment(["OPENROUTER_API_KEY"], { env: environment });
    return;
  }
  parseProviderRegistry(environment, { requireCredentials: true });
}
