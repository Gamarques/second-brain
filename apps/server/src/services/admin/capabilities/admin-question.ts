import { z } from "zod";
import {
  brainSearchSourceTypes,
  type BrainAccessStore,
} from "@second-brain/engine/domain";
import type { BrainQuestionService } from "@second-brain/engine/domain/brain-question";
import { defineCapability } from "@second-brain/engine/capabilities/define";
import {
  idSchema,
  timestampSchema,
} from "@second-brain/engine/capabilities/schemas";
import { adminChannelAccess, requireAdminAccess } from "./admin-access.js";
export function createAdminQuestionCapabilities(
  access: BrainAccessStore,
  questions: BrainQuestionService,
) {
  return {
    admin_brain_question: defineCapability({
      title: "Ask across the brain",
      description:
        "Answers a question from bounded current memories, document excerpts, people, projects, decisions, goals and tasks. Returns source citations or an explicit lack of evidence. May use paid search and answer models.",
      input: z.object({
        question: z.string().trim().min(1).max(5000),
        locale: z.enum(["en", "pt-BR", "es"]).default("en"),
        projectId: idSchema.nullable().default(null),
      }),
      output: z.object({
        answer: z.string().max(8000),
        answerable: z.boolean(),
        retrievedAt: timestampSchema,
        evidenceCount: z.number().int().nonnegative().max(20),
        citations: z
          .array(
            z.object({
              index: z.number().int().min(1).max(20),
              sourceType: z.enum(brainSearchSourceTypes),
              id: idSchema,
              title: z.string().max(500),
              excerpt: z.string().max(700),
              projectId: idSchema.nullable(),
              knowledgeBaseId: idSchema.nullable(),
              documentId: idSchema.nullable(),
              revisionId: idSchema.nullable(),
            }),
          )
          .max(20),
      }),
      access: adminChannelAccess,
      timeoutMs: 120_000,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: true,
      },
      async run({ input, context }) {
        const result = await questions.ask(
          await requireAdminAccess(access, context),
          input,
          context.signal,
        );
        await requireAdminAccess(access, context);
        return result;
      },
    }),
  } as const;
}
