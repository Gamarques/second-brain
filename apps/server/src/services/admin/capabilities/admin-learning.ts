import { z } from "zod";
import type { BrainAccessStore } from "@second-brain/engine/domain";
import type { LearningReviewStore } from "@second-brain/engine/domain/learning-review";
import { defineCapability } from "@second-brain/engine/capabilities/define";
import {
  idSchema,
  idempotencyKeySchema,
  memorySchema,
  timestampSchema,
} from "@second-brain/engine/capabilities/schemas";
import { adminChannelAccess, requireAdminAccess } from "./admin-access.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const receipt = z.object({
  changeId: idSchema,
  decision: z.enum(["accept", "reject"]),
  resultMemoryId: idSchema.nullable(),
  reviewedAt: timestampSchema,
});
const commonProposal = {
  content: z.string().max(10000),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  sourceQuotes: z.array(z.string()),
  evidenceIndexes: z.array(z.number().int().nonnegative()),
};
export function createAdminLearningCapabilities(
  access: BrainAccessStore,
  store: LearningReviewStore,
) {
  return {
    admin_learning_list: defineCapability({
      title: "List learning suggestions",
      description:
        "Pages persisted ingestion runs or Dreaming preview suggestions awaiting human review, or their review history.",
      input: z.object({
        kind: z.enum(["ingestion", "dreaming"]),
        status: z.enum(["pending", "history"]).default("pending"),
        cursor: z.string().max(1000).nullable().optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      output: z.object({
        items: z
          .array(
            z.object({
              id: idSchema,
              kind: z.enum(["ingestion", "dreaming"]),
              title: z.string(),
              status: z.string(),
              count: z.number().int().nonnegative(),
              createdAt: timestampSchema,
            }),
          )
          .max(100),
        nextCursor: z.string().nullable(),
      }),
      access: adminChannelAccess,
      timeoutMs: 15_000,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      async run({ input, context }) {
        return store.list(
          await requireAdminAccess(access, context),
          input,
          context.signal,
        );
      },
    }),
    admin_learning_dreaming_get: defineCapability({
      title: "Read a Dreaming suggestion",
      description:
        "Loads immutable proposed content, cited evidence, the current target, review history and application guards.",
      input: z.object({ changeId: idSchema }),
      output: z.object({
        result: z
          .object({
            changeId: idSchema,
            runId: idSchema,
            localDate: z.string(),
            fingerprint: digest,
            proposal: z.discriminatedUnion("operation", [
              z.object({ operation: z.literal("create"), ...commonProposal }),
              z.object({
                operation: z.literal("update"),
                targetMemoryIndex: z.number().int().nonnegative(),
                ...commonProposal,
              }),
            ]),
            target: memorySchema.nullable(),
            evidence: z.array(
              z.object({
                id: idSchema,
                type: z.string(),
                entityId: idSchema,
                excerpt: z.string(),
                effectiveAt: timestampSchema,
                redacted: z.boolean(),
              }),
            ),
            blockedReason: z.string().nullable(),
            receipt: receipt.nullable(),
          })
          .nullable(),
      }),
      access: adminChannelAccess,
      timeoutMs: 15_000,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      async run({ input, context }) {
        const result = await store.getDreaming(
          await requireAdminAccess(access, context),
          input.changeId,
          context.signal,
        );
        return {
          result: result
            ? {
                ...result,
                proposal: {
                  ...result.proposal,
                  tags: [...result.proposal.tags],
                  sourceQuotes: [...result.proposal.sourceQuotes],
                  evidenceIndexes: [...result.proposal.evidenceIndexes],
                },
                target: result.target
                  ? {
                      ...result.target,
                      tags: [...result.target.tags],
                      personIds: [...result.target.personIds],
                    }
                  : null,
              }
            : null,
        };
      },
    }),
    admin_learning_dreaming_review: defineCapability({
      title: "Review a Dreaming suggestion",
      description:
        "Rejects a persisted preview suggestion or explicitly accepts it with fresh evidence, version guards and verification. Approval may use paid models. One durable decision is stored per suggestion.",
      input: z.object({
        changeId: idSchema,
        fingerprint: digest,
        decision: z.enum(["accept", "reject"]),
        idempotencyKey: idempotencyKeySchema,
      }),
      output: receipt,
      access: adminChannelAccess,
      timeoutMs: 120_000,
      annotations: {
        readOnly: false,
        destructive: true,
        idempotent: true,
        openWorld: true,
      },
      async run({ input, context }) {
        return store.reviewDreaming(
          {
            ...(await requireAdminAccess(access, context)),
            administrativeChannel: true,
          },
          input,
          context.signal,
        );
      },
    }),
  } as const;
}
