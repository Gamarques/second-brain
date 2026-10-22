import { z } from "zod";

import type { BrainAccessStore, PriorityPlan, PriorityPlanStore } from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  cursorSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  idSchema,
  nullableTextSchema,
  priorityPlanItemSchema,
  priorityPlanSchema,
  requireFound,
  temporalCoverageSchema,
  timestampSchema,
} from "./schemas.js";

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  const scaled = value * 100;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  return Math.abs(scaled - Math.round(scaled)) <= tolerance;
}

function priorityItemErrors(
  items: readonly { readonly intendedSharePercent: number | null }[],
): readonly string[] {
  const errors: string[] = [];
  if (
    items.some(
      (item) =>
        item.intendedSharePercent !== null &&
        !hasAtMostTwoDecimalPlaces(item.intendedSharePercent),
    )
  ) {
    errors.push("Intended share percentages may have at most two decimal places.");
  }

  const specifiedCount = items.filter((item) => item.intendedSharePercent !== null).length;
  if (specifiedCount !== 0 && specifiedCount !== items.length) {
    errors.push("Intended share percentages must be specified for every item or none.");
  } else if (specifiedCount === items.length) {
    const total = items.reduce(
      (sum, item) => sum + (item.intendedSharePercent ?? 0),
      0,
    );
    if (Math.abs(total - 100) > 1e-8) {
      errors.push("Specified intended share percentages must total exactly 100.");
    }
  }
  return errors;
}

const priorityItemsInputSchema = z
  .array(priorityPlanItemSchema)
  .min(1)
  .max(20)
  .superRefine((items, context) => {
    const goalIds = new Set(items.map((item) => item.goalId));
    if (goalIds.size !== items.length) {
      context.addIssue({ code: "custom", message: "A goal may appear only once." });
    }
    const ranks = [...items.map((item) => item.rank)].sort((left, right) => left - right);
    if (ranks.some((rank, index) => rank !== index + 1)) {
      context.addIssue({ code: "custom", message: "Ranks must be unique and contiguous from 1." });
    }
    for (const message of priorityItemErrors(items)) {
      context.addIssue({ code: "custom", message });
    }
  });

const strictPriorityPlanSchema = priorityPlanSchema.superRefine((plan, context) => {
  for (const message of priorityItemErrors(plan.items)) {
    context.addIssue({ code: "custom", message });
  }
});

function validPeriod(start: string, end: string): boolean {
  return Date.parse(end) > Date.parse(start);
}

function writablePlan(plan: PriorityPlan) {
  return {
    ...plan,
    items: plan.items.map((item) => ({ ...item })),
    provenance: { ...plan.provenance },
  };
}

export function createPriorityCapabilities(
  accessStore: BrainAccessStore,
  priorities: PriorityPlanStore,
) {
  const createPriorityPlan = defineCapability({
    title: "Create a priority plan",
    description:
      "Creates a time-bounded strategic priority plan; task urgency remains a separate concept. Omit projectId to create the general plan not tied to a project.",
    input: z
      .object({
        projectId: idSchema.nullable().default(null),
        periodStart: timestampSchema,
        periodEnd: timestampSchema,
        items: priorityItemsInputSchema,
        note: nullableTextSchema.default(null),
        idempotencyKey: idempotencyKeySchema,
      })
      .refine((value) => validPeriod(value.periodStart, value.periodEnd), {
        message: "periodEnd must be after periodStart.",
      }),
    output: strictPriorityPlanSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const plan = await priorities.createPriorityPlan(
        access,
        {
          projectId: input.projectId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          items: input.items,
          note: input.note,
          idempotencyKey: input.idempotencyKey,
        },
        context.signal,
      );
      return writablePlan(requireFound(plan, "Linked record"));
    },
  });

  const updatePriorityPlan = defineCapability({
    title: "Update a priority plan",
    description: "Creates the next version of a priority plan with optimistic concurrency.",
    input: z
      .object({
        id: idSchema,
        periodStart: timestampSchema.optional(),
        periodEnd: timestampSchema.optional(),
        items: priorityItemsInputSchema.optional(),
        note: nullableTextSchema.optional(),
        expectedVersion: z.number().int().positive(),
        idempotencyKey: idempotencyKeySchema,
      })
      .refine(
        (value) =>
          value.periodStart !== undefined ||
          value.periodEnd !== undefined ||
          value.items !== undefined ||
          value.note !== undefined,
        { message: "At least one change is required." },
      )
      .refine(
        (value) =>
          value.periodStart === undefined ||
          value.periodEnd === undefined ||
          validPeriod(value.periodStart, value.periodEnd),
        { message: "periodEnd must be after periodStart." },
      ),
    output: strictPriorityPlanSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const plan = await priorities.updatePriorityPlan(
        access,
        input.id,
        {
          ...(input.periodStart === undefined ? {} : { periodStart: input.periodStart }),
          ...(input.periodEnd === undefined ? {} : { periodEnd: input.periodEnd }),
          ...(input.items === undefined ? {} : { items: input.items }),
          ...(input.note === undefined ? {} : { note: input.note }),
          precondition: {
            expectedVersion: input.expectedVersion,
            idempotencyKey: input.idempotencyKey,
          },
        },
        context.signal,
      );
      if (plan === null) {
        throw new Error("Priority plan was not found or its version did not match.");
      }
      return writablePlan(plan);
    },
  });

  const listPriorityPlans = defineCapability({
    title: "List priority plans",
    description:
      "Lists strategic priority plans, optionally restricted to one project or to plans active at one timestamp. A plan without projectId is the general plan.",
    input: z.object({
      projectId: idSchema.nullable().default(null),
      activeAt: timestampSchema.nullable().default(null),
      cursor: cursorSchema.nullable().default(null),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    output: z.object({
      priorityPlans: z.array(strictPriorityPlanSchema),
      nextCursor: cursorSchema.nullable(),
      coverage: temporalCoverageSchema,
    }),
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const page = await priorities.listPriorityPlans(
        access,
        {
          projectId: input.projectId,
          activeAt: input.activeAt,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        priorityPlans: page.items.map(writablePlan),
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
        coverage: temporalCoverageSchema.parse(page.coverage),
      };
    },
  });

  return {
    priorities_create: createPriorityPlan,
    priorities_update: updatePriorityPlan,
    priorities_list: listPriorityPlans,
  } as const;
}
