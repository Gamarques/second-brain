import type { BrainAccessContext } from "./core.js";
import type { BrainSearchHit } from "./search.js";
import type { ReasonedAnswer } from "./entities.js";
export interface BrainQuestionInput {
  question: string;
  locale: "en" | "pt-BR" | "es";
  projectId: string | null;
}
export interface BrainQuestionProvider {
  answerAcrossBrain(
    input: {
      question: string;
      locale: BrainQuestionInput["locale"];
      evidence: readonly BrainSearchHit[];
    },
    signal: AbortSignal,
  ): Promise<ReasonedAnswer>;
}
export interface BrainQuestionReference {
  id: string;
  documentId: string;
  revisionId: string;
  knowledgeBaseId: string;
}
export interface BrainQuestionService {
  ask(
    access: BrainAccessContext,
    input: BrainQuestionInput,
    signal: AbortSignal,
  ): Promise<{
    answer: string;
    answerable: boolean;
    retrievedAt: string;
    evidenceCount: number;
    citations: {
      index: number;
      sourceType: BrainSearchHit["sourceType"];
      id: string;
      title: string;
      excerpt: string;
      projectId: string | null;
      knowledgeBaseId: string | null;
      documentId: string | null;
      revisionId: string | null;
    }[];
  }>;
}
