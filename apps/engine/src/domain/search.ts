export const brainSearchSourceTypes = [
  "memory",
  "knowledge_chunk",
  "knowledge_base",
  "project",
  "decision",
  "goal",
  "person",
  "task",
] as const;
export type BrainSearchSourceType = (typeof brainSearchSourceTypes)[number];

export const brainSearchIntents = [
  "lookup_person",
  "lookup_topic",
  "general",
] as const;
export type BrainSearchIntent = (typeof brainSearchIntents)[number];

export interface BrainSearchHit {
  readonly sourceType: BrainSearchSourceType;
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly score: number;
  readonly knowledgeBaseId: string | null;
  readonly knowledgeBaseName: string | null;
  readonly projectId: string | null;
  readonly personIds: readonly string[];
  readonly tags: readonly string[];
}

export interface KnowledgeBaseCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export interface PersonIndexProject {
  readonly id: string;
  readonly name: string;
}

export interface PersonIndexKnowledgeBase {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export interface PersonIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly summary: string | null;
  readonly tags: readonly string[];
  readonly relatedProjects: readonly PersonIndexProject[];
  readonly relatedKnowledgeBases: readonly PersonIndexKnowledgeBase[];
}

export interface BrainSearchSuggestion {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly reason: string;
}

export interface BrainSearchRouting {
  readonly intent: BrainSearchIntent;
  readonly subject: string;
  readonly guidance: string;
}

export interface BrainSearchResult {
  readonly query: string;
  readonly routing: BrainSearchRouting;
  readonly hits: readonly BrainSearchHit[];
  readonly people: readonly PersonIndexEntry[];
  readonly knowledgeBases: readonly KnowledgeBaseCatalogEntry[];
  readonly suggestedKnowledgeBases: readonly BrainSearchSuggestion[];
}

const PERSON_PREFIX =
  /^(?:quem\s+(?:é|e|foi|era|sao|são)|who(?:'s|\s+is|\s+are|\s+was))\s+/iu;
const TOPIC_PREFIX =
  /^(?:o\s+que\s+(?:é|e|foi|era|sao|são)|what(?:'s|\s+is|\s+are|\s+was)|(?:o\s+)?que\s+(?:você|voce|tu|vc)?\s*(?:sabe|conhece)\s+sobre|what\s+do\s+you\s+know\s+about|(?:informa[cç][aã]o(?:es)?|info(?:rmation)?)\s+(?:sobre|about)|tell\s+me\s+about)\s+/iu;

function stripQueryNoise(value: string): string {
  return value.replace(/^[\s¿¡]+/u, "").replace(/[?!.\s]+$/u, "").trim();
}

function subjectAfterPrefix(query: string, prefix: RegExp): string | null {
  const match = prefix.exec(query);
  if (match === null) return null;
  const subject = stripQueryNoise(query.slice(match[0].length));
  return subject.length > 0 ? subject : stripQueryNoise(query);
}

export function classifyBrainSearchQuery(query: string): {
  readonly intent: BrainSearchIntent;
  readonly subject: string;
} {
  const normalized = stripQueryNoise(query);
  const personSubject = subjectAfterPrefix(normalized, PERSON_PREFIX);
  if (personSubject !== null) {
    return { intent: "lookup_person", subject: personSubject };
  }
  const topicSubject = subjectAfterPrefix(normalized, TOPIC_PREFIX);
  if (topicSubject !== null) {
    return { intent: "lookup_topic", subject: topicSubject };
  }
  return { intent: "general", subject: normalized };
}

export function brainSearchGuidance(intent: BrainSearchIntent): string {
  if (intent === "lookup_person") {
    return "This query looks like a person lookup. Search results include people and every knowledge base; do not stop at memories.";
  }
  if (intent === "lookup_topic") {
    return "This query looks like a topic lookup. Review knowledge-base hits and suggestedKnowledgeBases in addition to memories.";
  }
  return "Results combine memories, knowledge bases, people, projects, decisions, goals, and tasks. The knowledgeBases catalog lists what each base covers.";
}

export function lexicalMatchScore(
  haystack: string,
  needle: string,
): number {
  const hay = haystack.trim().toLocaleLowerCase("en-US");
  const query = needle.trim().toLocaleLowerCase("en-US");
  if (hay.length === 0 || query.length === 0) return 0;
  if (hay === query) return 1;
  if (hay.includes(query)) return 0.92;
  const tokens = query.split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((token) => hay.includes(token)).length;
  if (matched === 0) return 0;
  if (matched === tokens.length) return 0.8;
  return 0.45 * (matched / tokens.length);
}
