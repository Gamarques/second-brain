import { z } from "zod";

import type {
  BrainAccessStore,
  DreamingReport,
  DreamingReportSelector,
  DreamingStore,
} from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import { dreamingReportSchema, idSchema, localDateSchema } from "./schemas.js";

const reportInputSchema = z
  .object({
    localDate: localDateSchema.optional(),
    runId: idSchema.optional(),
  })
  .superRefine(({ localDate, runId }, context) => {
    if (localDate !== undefined && runId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "localDate and runId are mutually exclusive.",
      });
    }
  });

function reportSelector(input: {
  readonly localDate?: string | undefined;
  readonly runId?: string | undefined;
}): DreamingReportSelector {
  if (input.runId !== undefined) return { kind: "run_id", runId: input.runId };
  if (input.localDate !== undefined) {
    return { kind: "local_date", localDate: input.localDate };
  }
  return { kind: "latest" };
}

function writableReport(report: DreamingReport) {
  return {
    ...report,
    insights: report.insights.map((insight) => ({
      ...insight,
      evidence: insight.evidence.map((citation) => ({ ...citation })),
    })),
    memoriesCreated: report.memoriesCreated.map((memory) => ({ ...memory })),
    memoriesUpdated: report.memoriesUpdated.map((memory) => ({ ...memory })),
    skipped: report.skipped.map((skip) => ({ ...skip })),
    coverageWarnings: [...report.coverageWarnings],
  };
}

export function createDreamingReportCapabilities(
  accessStore: BrainAccessStore,
  dreamingStore: DreamingStore,
) {
  const getReport = defineCapability({
    title: "Get a dreaming report",
    description:
      "Returns the latest or selected completed daily dreaming report, including cited insights, memory changes, skips, and coverage warnings. It never starts a dreaming run.",
    input: reportInputSchema,
    output: z.object({ report: dreamingReportSchema.nullable() }),
    access: "authenticated",
    timeoutMs: 30_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const report = await dreamingStore.getReport(
        access,
        reportSelector(input),
        context.signal,
      );
      return { report: report === null ? null : writableReport(report) };
    },
  });

  return { dreaming_report_get: getReport } as const;
}
