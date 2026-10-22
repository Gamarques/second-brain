import { z } from "zod";
import type { EnvironmentRecord } from "../env.js";
import type { ModelRequestObserver } from "../domain/model-usage.js";
import { createModelProvider } from "../runtime-config.js";
import { OpenRouterProvider, OpenRouterRequestError, OpenRouterTransportError } from "./openrouter-provider.js";

export interface ModelConfigurationReader {
  read(signal: AbortSignal): Promise<{ environment: EnvironmentRecord; configurationRevision: number }>;
}

const endpointsSchema = z.object({ data: z.array(z.object({
  model_id: z.string().min(1).max(300), model_name: z.string().max(500),
  supported_parameters: z.array(z.string()),
})).max(10_000) });

/** The catalog is advisory; only a paid synthetic request validates current routing. */
export function createModelConfigurationService(reader: ModelConfigurationReader, observeRequest: ModelRequestObserver) {
  return {
    async status(signal: AbortSignal) {
      const resolved = await reader.read(signal);
      return { revision: resolved.configurationRevision, hasApiKey: Boolean(resolved.environment.OPENROUTER_API_KEY), models: createModelProvider(resolved.environment).modelNames };
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
      const apiKey = input.apiKey ?? resolved.environment.OPENROUTER_API_KEY;
      const startedAt = Date.now();
      if (!apiKey) return { ok: false, reason: "authentication" as const, model: input.model, checkedAt: new Date().toISOString(), durationMs: 0 };
      const provider = new OpenRouterProvider({ apiKey, ...(resolved.environment.OPENROUTER_BASE_URL ? { baseUrl: resolved.environment.OPENROUTER_BASE_URL } : {}), requestTimeoutMs: 30_000, observeRequest });
      try {
        await provider.probe(input.model, signal);
        return { ok: true, reason: null, model: input.model, checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt };
      } catch (error) {
        signal.throwIfAborted();
        return { ok: false, reason: error instanceof OpenRouterRequestError || error instanceof OpenRouterTransportError ? error.reason : "unknown" as const, model: input.model, checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt };
      }
    },
  };
}

export type ModelConfigurationService = ReturnType<typeof createModelConfigurationService>;
