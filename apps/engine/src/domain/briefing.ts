import type { BrainAccessContext } from "./core.js";
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
export interface BriefingActionInput {
  reportId: string;
  insightIndex: number;
  expectedDigest: string;
  kind: "task" | "reminder" | "resolve";
  text: string | null;
  listId: string | null;
  projectId: string | null;
  dueAt: string | null;
  idempotencyKey: string;
}
export interface BriefingStore {
  get(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<BriefingSnapshot>;
  act(
    access: BrainAccessContext,
    input: BriefingActionInput,
    signal: AbortSignal,
  ): Promise<BriefingAction>;
}
export class BriefingConflictError extends Error {
  readonly code = "BRIEFING_CONFLICT";
  constructor() {
    super(
      "This insight has changed or already has a different action. Refresh the briefing.",
    );
  }
}
