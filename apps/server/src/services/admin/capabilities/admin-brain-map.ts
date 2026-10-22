import { z } from "zod";

import {
  adminBrainMapEdgeTypes,
  adminBrainMapNodeTypes,
  type AdminBrainMapStore,
} from "../domain.js";
import { adminChannelAccess, requireAdminAccess } from "./admin-access.js";
import { defineCapability } from "@second-brain/engine/capabilities/define";
import {
  idSchema,
  timestampSchema,
} from "@second-brain/engine/capabilities/schemas";
import type { BrainAccessStore } from "@second-brain/engine/domain";

const countsSchema = z.object({
  memories: z.number().int().nonnegative(),
  knowledgeBases: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  people: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
});

const nodeSchema = z.object({
  id: idSchema,
  type: z.enum(adminBrainMapNodeTypes),
  label: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(2_000).nullable(),
  tags: z.array(z.string().trim().min(1).max(200)).max(50),
  version: z.number().int().positive().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema.nullable(),
});

const edgeSchema = z.object({
  id: z.string().trim().min(1).max(500),
  source: idSchema,
  target: idSchema,
  type: z.enum(adminBrainMapEdgeTypes),
});

const seriesPointSchema = countsSchema.extend({
  date: z.string().date(),
  total: z.number().int().nonnegative(),
});

export function createAdminBrainMapCapabilities(
  accessStore: BrainAccessStore,
  brainMap: AdminBrainMapStore,
) {
  const getBrainMap = defineCapability({
    title: "Get brain map",
    description:
      "Returns a bounded, read-only graph and retained-content growth series for the browser administration panel.",
    input: z.object({
      days: z.number().int().min(7).max(90).default(30),
      nodeLimit: z.number().int().min(25).max(500).default(250),
    }),
    output: z.object({
      generatedAt: timestampSchema,
      periodDays: z.number().int().min(7).max(90),
      counts: countsSchema,
      totalItems: z.number().int().nonnegative(),
      growth: z.number().int().nonnegative(),
      explicitConnections: z.number().int().nonnegative(),
      connectedItems: z.number().int().nonnegative(),
      connectedCoverage: z.number().min(0).max(1),
      truncated: z.boolean(),
      nodes: z.array(nodeSchema).max(500),
      edges: z.array(edgeSchema).max(5_000),
      series: z.array(seriesPointSchema).max(90),
    }),
    access: adminChannelAccess,
    timeoutMs: 10_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const access = await requireAdminAccess(accessStore, context);
      const snapshot = await brainMap.getBrainMap(access, input, context.signal);
      return {
        ...snapshot,
        nodes: snapshot.nodes.map((node) => ({ ...node, tags: [...node.tags] })),
        edges: snapshot.edges.map((edge) => ({ ...edge })),
        series: snapshot.series.map((point) => ({ ...point })),
      };
    },
  });

  return { admin_brain_map_get: getBrainMap } as const;
}
