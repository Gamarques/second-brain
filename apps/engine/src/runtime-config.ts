import type { ModelRequestObserver } from "./domain/model-usage.js";
import type { EmbeddingProvider } from "./domain.js";
import {
  EngineStartupError,
  requireEnvironment,
  type EnvironmentRecord,
} from "./env.js";
import { OpenRouterProvider } from "./providers/openrouter-provider.js";

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

export interface ConfiguredModelProvider {
  readonly provider: OpenRouterProvider;
  readonly embeddingIdentity: EmbeddingProviderIdentity;
  readonly dreamingModel: string;
  readonly modelNames: Readonly<Record<string, string>>;
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

/**
 * The sole environment-to-model composition path, so embedding spaces cannot
 * be provisioned with an identity different from the serving model. Missing
 * OPENROUTER_API_KEY is tolerated at construction and fails on first model
 * call, which lets the conventional engine composition root build without
 * configuration; validated runtimes require the key through
 * createConfiguredModelProvider instead.
 */
export function createModelProvider(
  environment: EnvironmentRecord = process.env,
  observeRequest?: ModelRequestObserver,
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

/**
 * The fail-closed variant for validated runtimes: bootstrap, the capability
 * runtime, and the automation worker refuse to start without a real key.
 */
export function createConfiguredModelProvider(
  environment: EnvironmentRecord = process.env,
  observeRequest?: ModelRequestObserver,
): ConfiguredModelProvider {
  requireEnvironment(["OPENROUTER_API_KEY"], { env: environment });
  return createModelProvider(environment, observeRequest);
}
