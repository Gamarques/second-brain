export type ProjectSection =
  | "tasks"
  | "goals"
  | "decisions"
  | "people"
  | "documents"
  | "memories";
export const projectSections: ProjectSection[] = [
  "tasks",
  "goals",
  "decisions",
  "people",
  "documents",
  "memories",
];
export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "paused" | "completed" | "archived";
  version: number;
}
export interface ProjectContextItem {
  id: string;
  title: string;
  body: string | null;
  status: string | null;
  version: number | null;
  date: string | null;
  priority: string | null;
  knowledgeBaseId: string | null;
  tags: string[];
}
export interface BrainAnswer {
  answer: string;
  answerable: boolean;
  retrievedAt: string;
  evidenceCount: number;
  citations: {
    index: number;
    sourceType:
      | "memory"
      | "knowledge_chunk"
      | "knowledge_base"
      | "project"
      | "decision"
      | "goal"
      | "person"
      | "task";
    id: string;
    title: string;
    excerpt: string;
    projectId: string | null;
    knowledgeBaseId: string | null;
    documentId: string | null;
    revisionId: string | null;
  }[];
}
export interface BriefingAction {
  id: string;
  kind: "task" | "reminder" | "resolve";
  entityId: string | null;
}
export interface BriefingInsight {
  reportId: string;
  runId: string;
  localDate: string;
  index: number;
  digest: string;
  kind: "open_loop" | "contradiction";
  statement: string;
  confidence: "low" | "medium" | "high";
  evidence: { type: string; id: string; excerpt: string }[];
  actions: BriefingAction[];
}
export interface BriefingSnapshot {
  timeZone: string;
  generatedAt: string;
  recentSince: string;
  insightsSince: string;
  truncated: boolean;
  recent: {
    type: "memory" | "decision" | "document";
    id: string;
    title: string;
    occurredAt: string;
    projectId: string | null;
    knowledgeBaseId: string | null;
  }[];
  dueTasks: {
    id: string;
    title: string;
    dueAt: string;
    projectId: string | null;
    version: number;
  }[];
  dueReminders: {
    id: string;
    message: string;
    remindAt: string;
    version: number;
  }[];
  insights: BriefingInsight[];
}
