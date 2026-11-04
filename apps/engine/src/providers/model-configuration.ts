import { z } from "zod";
import type { EnvironmentRecord } from "../env.js";
import type { ModelRequestObserver } from "../domain/model-usage.js";
import { createModelProvider } from "../runtime-config.js";
import { OpenAICompatibleRequestError, OpenAICompatibleTransportError } from "./openai-compatible-adapter.js";
import { OpenRouterProvider, OpenRouterRequestError, OpenRouterTransportError } from "./openrouter-provider.js";
import {
  createProfileProvider,
  parseProviderRegistry,
  usesProviderRegistry,
  type ProviderRegistryConfiguration,
} from "./provider-registry.js";

export interface ModelConfigurationReader {
  read(signal: AbortSignal): Promise<{ environment: EnvironmentRecord; configurationRevision: number }>;
}

const endpointsSchema = z.object({ data: z.array(z.object({
  model_id: z.string().min(1).max(300), model_name: z.string().max(500),
  supported_parameters: z.array(z.string()),
})).max(10_000) });

/** Whether every profile bound to a role has a credential (or needs none). */
function registryHasCredentials(registry: ProviderRegistryConfiguration): boolean {
  const bound = new Set([registry.embedding.profile, ...Object.values(registry.chat).flat().map((entry) => entry.profile)]);
  return [...bound].every((name) => {
    const profile = registry.profiles.get(name)!;
    return profile.apiKey !== undefined || profile.allowUnauthenticated;
  });
}

/**
 * With the provider registry, a probe model may name its profile as
 * `<profile>:<model>`; a bare model is probed on the answer role's primary
 * profile. The OpenRouter catalog stays OpenRouter-specific.
 */
function registryProbeTarget(registry: ProviderRegistryConfiguration, model: string) {
  const separator = model.indexOf(":");
  const named = separator < 0 ? undefined : registry.profiles.get(model.slice(0, separator).toLowerCase());
  return named === undefined
    ? { profile: registry.profiles.get(registry.chat.answer[0]!.profile)!, model }
    : { profile: named, model: model.slice(separator + 1) };
}

function failureReason(error: unknown) {
  return error instanceof OpenRouterRequestError ||
    error instanceof OpenRouterTransportError ||
    error instanceof OpenAICompatibleRequestError ||
    error instanceof OpenAICompatibleTransportError
    ? error.reason
    : "unknown" as const;
}

/** The catalog is advisory; only a paid synthetic request validates current routing. */
export function createModelConfigurationService(reader: ModelConfigurationReader, observeRequest: ModelRequestObserver) {
  return {
    async status(signal: AbortSignal) {
      const resolved = await reader.read(signal);
      const hasApiKey = usesProviderRegistry(resolved.environment)
        ? registryHasCredentials(parseProviderRegistry(resolved.environment, { requireCredentials: false }))
        : Boolean(resolved.environment.OPENROUTER_API_KEY);
      return { revision: resolved.configurationRevision, hasApiKey, models: createModelProvider(resolved.environment).modelNames };
    },
    async models(signal: AbortSignal) {
      const response = await fetch("https://openrouter.ai/api/v1/endpoints/zdr", { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: "error" });
      if (!response.ok) throw new OpenRouterRequestError(response.status);
      const parsed = endpointsSchema.parse(await response.json());
      const unique = new Map<string, { id: string; name: string }>();
      for (const endpoint of parsed.data) {
        if (endpoint.supported_parameters.includes("structured_outputs") && endpoint.supported_parameters.includes("response_format")) unique.set(endpoint.model_id, { id: endpoint.model_id, name: endpoint.model_name });
      }
      return { models: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 1_000), checkedAt: new Date().toISOString() };
    },
    async probe(input: { model: string; apiKey?: string | undefined }, signal: AbortSignal) {
      const resolved = await reader.read(signal);
      const startedAt = Date.now();
      let provider: { probe(model: string, signal: AbortSignal): Promise<{ ok: true }> };
      let model = input.model;
      if (usesProviderRegistry(resolved.environment)) {
        const target = registryProbeTarget(parseProviderRegistry(resolved.environment, { requireCredentials: false }), input.model);
        const apiKey = input.apiKey ?? target.profile.apiKey;
        if (!apiKey && !target.profile.allowUnauthenticated) return { ok: false, reason: "authentication" as const, model: input.model, checkedAt: new Date().toISOString(), durationMs: 0 };
        model = target.model;
        provider = createProfileProvider({ ...target.profile, requestTimeoutMs: 30_000 }, { embeddingModel: target.model, chatModel: target.model }, observeRequest, apiKey);
      } else {
        const apiKey = input.apiKey ?? resolved.environment.OPENROUTER_API_KEY;
        if (!apiKey) return { ok: false, reason: "authentication" as const, model: input.model, checkedAt: new Date().toISOString(), durationMs: 0 };
        provider = new OpenRouterProvider({ apiKey, ...(resolved.environment.OPENROUTER_BASE_URL ? { baseUrl: resolved.environment.OPENROUTER_BASE_URL } : {}), requestTimeoutMs: 30_000, observeRequest });
      }
      try {
        await provider.probe(model, signal);
        return { ok: true, reason: null, model: input.model, checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt };
      } catch (error) {
        signal.throwIfAborted();
        return { ok: false, reason: failureReason(error), model: input.model, checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt };
      }
    },
  };
}

export type ModelConfigurationService = ReturnType<typeof createModelConfigurationService>;
