import type {
  ActorProvenance,
  BrainAccessContext,
  CursorPosition,
  TemporalCoverage,
} from "./core.js";
import type { Decision, Memory, Reminder, Task } from "./entities.js";
import type {
  KnowledgeBaseCatalogEntry,
  PersonIndexEntry,
} from "./search.js";
import type { Goal, PriorityPlan } from "./temporal.js";

export interface BrainContextSnapshot {
  readonly generatedAt: string;
  readonly asOf: string;
  readonly purpose: string | null;
  readonly currentPriorities: readonly PriorityPlan[];
  readonly activeGoals: readonly Goal[];
  readonly activeDecisions: readonly Decision[];
  readonly relevantMemories: readonly Memory[];
  readonly openTasks: readonly Task[];
  readonly pendingReminders: readonly Reminder[];
  readonly knowledgeBases: readonly KnowledgeBaseCatalogEntry[];
  readonly peopleIndex: readonly PersonIndexEntry[];
  readonly coverage: TemporalCoverage;
}

export interface BrainHandoff {
  readonly id: string;
  readonly fromClientId: string | null;
  readonly title: string;
  readonly summary: string;
  readonly nextActions: readonly string[];
  readonly entityRefs: readonly {
    readonly type: "memory" | "decision" | "task" | "reminder" | "goal" | "project";
    readonly id: string;
  }[];
  readonly provenance: ActorProvenance;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface ContextStore {
  loadContext(
    access: BrainAccessContext,
    input: {
      readonly purpose: string | null;
      readonly asOf: string;
      readonly limits: {
        readonly memories: number;
        readonly decisions: number;
        readonly tasks: number;
        readonly reminders: number;
        readonly goals: number;
      };
    },
    signal: AbortSignal,
  ): Promise<BrainContextSnapshot>;
  createHandoff(
    access: BrainAccessContext,
    input: {
      readonly title: string;
      readonly summary: string;
      readonly nextActions: readonly string[];
      readonly entityRefs: BrainHandoff["entityRefs"];
      readonly expiresAt: string | null;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<BrainHandoff>;
  listHandoffs(
    access: BrainAccessContext,
    input: {
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly items: readonly BrainHandoff[];
    readonly nextCursor: CursorPosition | null;
  }>;
}
