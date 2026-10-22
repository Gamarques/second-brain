import { and, eq, inArray } from "drizzle-orm";
import { classifyBrainSearchQuery } from "../../domain.js";
import type { EmbeddingProvider } from "../../domain.js";
import type { BrainQuestionProvider } from "../../domain/brain-question.js";
import { createBrainSearchQueryEmbeddings } from "../../capabilities/brain-search.js";
import { createBrainQuestionService } from "../../services/brain-question.js";
import {
  knowledgeChunks,
  knowledgeDocumentRevisions,
  knowledgeDocuments,
} from "../schema/content.js";
import { DrizzleBrainAccessStore } from "./access-store.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type { SecondBrainDatabase } from "./database.js";
import { DrizzleEmbeddingSpaceStore } from "./embedding-space-store.js";
import { DrizzleBrainSearchStore } from "./search-store.js";

export function createDrizzleBrainQuestionService(
  database: SecondBrainDatabase,
  models: EmbeddingProvider & BrainQuestionProvider,
) {
  const accessStore = new DrizzleBrainAccessStore(database);
  const spaces = new DrizzleEmbeddingSpaceStore(database);
  const search = new DrizzleBrainSearchStore(database);
  return createBrainQuestionService({
    provider: models,
    async revalidate(access, signal) {
      await accessStore.revalidateAccess(access, "viewer", signal);
    },
    async retrieve(access, input, signal) {
      const { subject, intent } = classifyBrainSearchQuery(input.question);
      const embeddings = await createBrainSearchQueryEmbeddings(
        access,
        subject,
        spaces,
        models,
        signal,
      );
      const result = await search.search(
        access,
        {
          query: input.question,
          subject,
          intent,
          embeddings,
          projectId: input.projectId,
          limit: 30,
        },
        signal,
      );
      return result.hits;
    },
    async references(access, hits, signal) {
      const ids = hits
        .filter((item) => item.sourceType === "knowledge_chunk")
        .map((item) => item.id);
      if (!ids.length) return [];
      return database.transaction(async (tx) => {
        await authorizeBrainTransaction(tx, access, "viewer", signal);
        const rows = await tx
          .select({
            id: knowledgeChunks.id,
            documentId: knowledgeDocuments.id,
            revisionId: knowledgeDocumentRevisions.id,
            knowledgeBaseId: knowledgeDocuments.knowledgeBaseId,
          })
          .from(knowledgeChunks)
          .innerJoin(
            knowledgeDocumentRevisions,
            eq(knowledgeDocumentRevisions.id, knowledgeChunks.revisionId),
          )
          .innerJoin(
            knowledgeDocuments,
            and(
              eq(knowledgeDocuments.id, knowledgeDocumentRevisions.documentId),
              eq(
                knowledgeDocuments.currentRevisionNumber,
                knowledgeDocumentRevisions.revisionNumber,
              ),
            ),
          )
          .where(inArray(knowledgeChunks.id, ids))
          .limit(20);
        signal.throwIfAborted();
        return rows;
      });
    },
  });
}
