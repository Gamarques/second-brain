import { z } from "zod";
import type { BrainAccessContext, BrainSearchHit } from "../domain.js";
import type {
  BrainQuestionInput,
  BrainQuestionProvider,
  BrainQuestionReference,
  BrainQuestionService,
} from "../domain/brain-question.js";
const resultSchema = z
  .object({
    answer: z.string().trim().min(1).max(8000),
    answerable: z.boolean(),
    citationIndexes: z.array(z.number().int().positive()).max(20),
  })
  .strict();
export function createBrainQuestionService(dependencies: {
  retrieve(
    access: BrainAccessContext,
    input: BrainQuestionInput,
    signal: AbortSignal,
  ): Promise<readonly BrainSearchHit[]>;
  revalidate(access: BrainAccessContext, signal: AbortSignal): Promise<void>;
  references(
    access: BrainAccessContext,
    hits: readonly BrainSearchHit[],
    signal: AbortSignal,
  ): Promise<readonly BrainQuestionReference[]>;
  provider: BrainQuestionProvider;
}): BrainQuestionService {
  return {
    async ask(access, input, signal) {
      signal.throwIfAborted();
      await dependencies.revalidate(access, signal);
      const retrieved = await dependencies.retrieve(access, input, signal);
      signal.throwIfAborted();
      const retrievedAt = new Date().toISOString();
      let characters = 0;
      const seen = new Set<string>();
      const evidence: BrainSearchHit[] = [];
      for (const hit of retrieved) {
        const key = `${hit.sourceType}:${hit.id}`;
        if (
          seen.has(key) ||
          !Number.isFinite(hit.score) ||
          hit.score < 0.25 ||
          !hit.excerpt.trim()
        )
          continue;
        const excerpt = hit.excerpt.slice(0, 700);
        const title = hit.title.slice(0, 500);
        if (
          evidence.length >= 20 ||
          characters + excerpt.length + title.length > 12000
        )
          break;
        seen.add(key);
        characters += excerpt.length + title.length;
        evidence.push({ ...hit, title, excerpt });
      }
      const empty = {
        answer: "",
        answerable: false,
        retrievedAt,
        evidenceCount: evidence.length,
        citations: [],
      };
      if (!evidence.length) return empty;
      const references = await dependencies.references(
        access,
        evidence,
        signal,
      );
      await dependencies.revalidate(access, signal);
      const result = resultSchema.parse(
        await dependencies.provider.answerAcrossBrain(
          { question: input.question, locale: input.locale, evidence },
          signal,
        ),
      );
      await dependencies.revalidate(access, signal);
      signal.throwIfAborted();
      if (!result.answerable) {
        if (result.citationIndexes.length)
          throw new Error("An unanswerable response cannot contain citations.");
        return empty;
      }
      const indexes = result.citationIndexes;
      const inline = [...result.answer.matchAll(/\[(\d+)\]/g)].map((match) =>
        Number(match[1]),
      );
      if (
        !indexes.length ||
        new Set(indexes).size !== indexes.length ||
        indexes.some(
          (index) => index > evidence.length || (inline.length > 0 && !inline.includes(index)),
        ) ||
        inline.some((index) => !indexes.includes(index))
      )
        throw new Error("The answer contains unsupported citations.");
      // Structured citation metadata can be valid even when a provider omits
      // text markers. Render only the already validated indexes, without
      // changing the answer's claims or making another model request.
      const answer = inline.length === 0
        ? `${result.answer}\n\n${indexes.map((index) => `[${index}]`).join(" ")}`
        : result.answer;
      if (answer.length > 8000) throw new Error("The answer exceeds the response limit.");
      return {
        answer,
        answerable: true,
        retrievedAt,
        evidenceCount: evidence.length,
        citations: indexes.map((index) => {
          const item = evidence[index - 1]!;
          const reference =
            item.sourceType === "knowledge_chunk"
              ? references.find((value) => value.id === item.id)
              : undefined;
          return {
            index,
            sourceType: item.sourceType,
            id: item.id,
            title: item.title,
            excerpt: item.excerpt,
            projectId: item.projectId,
            knowledgeBaseId: reference?.knowledgeBaseId ?? item.knowledgeBaseId,
            documentId: reference?.documentId ?? null,
            revisionId: reference?.revisionId ?? null,
          };
        }),
      };
    },
  };
}
