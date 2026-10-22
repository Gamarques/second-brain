import { z } from "zod";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import { modelFailureReasons, modelOperations } from "@second-brain/engine/domain/model-usage";
import type { ModelConfigurationService } from "@second-brain/engine/providers/model-configuration";
import type { DrizzleModelUsageStore } from "@second-brain/engine/database/stores/model-usage-store";
import { defineCapability } from "@second-brain/engine/capabilities/define";
import { timestampSchema } from "@second-brain/engine/capabilities/schemas";
import { adminChannelAccess, requireAdminAccess } from "./admin-access.js";

const modelId = z.string().trim().min(1).max(300);
const count = z.number().int().nonnegative();
const amount = z.number().nonnegative();
const modelNames = z.record(z.string(), modelId);
const readAnnotations = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;

export function createAdminModelCapabilities(access: BrainAccessStore, models: ModelConfigurationService, usage: Pick<DrizzleModelUsageStore, "summary" | "runtimes">) {
  return {
    admin_model_configuration_get: defineCapability({
      title: "Inspect model configuration", description: "Returns resolved saved model names and separately observed live service revisions, without credentials.",
      input: z.object({}), output: z.object({ saved: z.object({ revision: count, hasApiKey: z.boolean(), models: modelNames }), runtimes: z.array(z.object({ id: z.uuid(), service: z.string(), configurationRevision: count, models: modelNames, startedAt: timestampSchema, lastSeenAt: timestampSchema, healthy: z.boolean() })).max(100) }),
      access: adminChannelAccess, timeoutMs: 10_000, annotations: readAnnotations,
      async run({ context }) {
        await requireAdminAccess(access, context, "admin");
        const [saved, runtimes] = await Promise.all([models.status(context.signal), usage.runtimes(context.signal)]);
        return { saved, runtimes };
      },
    }),
    admin_model_catalog_list: defineCapability({
      title: "Find models with private structured outputs", description: "Lists live OpenRouter ZDR endpoints supporting structured output; a probe is still required to validate account routing.",
      input: z.object({}), output: z.object({ models: z.array(z.object({ id: modelId, name: z.string() })).max(1_000), checkedAt: timestampSchema }),
      access: adminChannelAccess, timeoutMs: 20_000, annotations: { ...readAnnotations, openWorld: true },
      async run({ context }) { await requireAdminAccess(access, context, "admin"); return models.models(context.signal); },
    }),
    admin_model_probe: defineCapability({
      title: "Test model configuration", description: "Runs one paid synthetic structured completion with ZDR using a draft or saved key. No brain content is sent and no configuration is changed.",
      input: z.object({ model: modelId, apiKey: z.string().trim().min(1).max(4_096).optional() }),
      output: z.object({ ok: z.boolean(), reason: z.enum(modelFailureReasons).nullable(), model: modelId, checkedAt: timestampSchema, durationMs: count }),
      access: adminChannelAccess, timeoutMs: 40_000, annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
      async run({ input, context }) { await requireAdminAccess(access, context, "owner"); return models.probe(input, context.signal); },
    }),
    admin_model_usage_get: defineCapability({
      title: "Read model request consumption", description: "Aggregates recorded request tokens, charged credits, latency and transport failures within a bounded period. Unknown charges remain explicitly uncovered.",
      input: z.object({ days: z.number().int().min(1).max(90).default(30), operation: z.enum(modelOperations).optional(), model: modelId.optional() }),
      output: z.object({ since: timestampSchema, observedAt: timestampSchema, truncated: z.boolean(), groups: z.array(z.object({ operation: z.enum(modelOperations), model: modelId, requests: count, failures: count, inputTokens: amount, outputTokens: amount, reportedCost: amount, costCoverage: count, tokenCoverage: count, averageDurationMs: amount })).max(500), failures: z.array(z.object({ reason: z.enum(modelFailureReasons).nullable(), count })) }),
      access: adminChannelAccess, timeoutMs: 15_000, annotations: readAnnotations,
      async run({ input, context }) { await requireAdminAccess(access, context, "admin"); return usage.summary(input, context.signal); },
    }),
  } as const;
}
