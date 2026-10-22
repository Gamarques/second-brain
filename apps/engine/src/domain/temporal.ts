import type {
  ActorAttribution,
  ActorProvenance,
  TemporalCoverage,
} from "./core.js";
import type { Reminder, Task, TaskGoalLink } from "./entities.js";

export const versionOperations = [
  "created",
  "updated",
  "started",
  "completed",
  "reopened",
  "canceled",
] as const;
export type VersionOperation = (typeof versionOperations)[number];

export interface TaskVersion {
  readonly id: string;
  readonly taskId: string;
  readonly version: number;
  readonly operation: VersionOperation;
  readonly snapshot: Omit<
    Task,
    "version" | "historyCompleteFrom" | "provenance" | "createdAt" | "updatedAt"
  >;
  readonly goalLinks: readonly TaskGoalLink[];
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly changedFields: readonly string[];
  readonly provenance: ActorAttribution;
  readonly activityEventId: string;
}

export interface ReminderVersion {
  readonly id: string;
  readonly reminderId: string;
  readonly version: number;
  readonly operation: VersionOperation;
  readonly snapshot: Omit<
    Reminder,
    "version" | "historyCompleteFrom" | "provenance" | "createdAt" | "updatedAt"
  >;
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly changedFields: readonly string[];
  readonly provenance: ActorAttribution;
  readonly activityEventId: string;
}

export const activityEventEntityTypes = [
  "task",
  "task_list",
  "task_relation",
  "reminder",
  "memory",
  "decision",
  "project",
  "person",
  "goal",
  "priority_plan",
  "knowledge_base",
  "knowledge_document",
  "activity",
  "automation_settings",
] as const;
export type ActivityEventEntityType = (typeof activityEventEntityTypes)[number];

export const activityEventActions = [
  "created",
  "updated",
  "started",
  "completed",
  "reopened",
  "canceled",
  "deleted",
  "superseded",
  "revoked",
  "linked",
  "retracted",
] as const;
export type ActivityEventAction = (typeof activityEventActions)[number];

export const activityKinds = ["work_session", "progress_note", "meeting", "communication"] as const;
export type ActivityKind = (typeof activityKinds)[number];

export const activityTimeBases = ["instant", "explicit_interval"] as const;
export type ActivityTimeBasis = (typeof activityTimeBases)[number];

export interface ActivityGoalAllocation {
  readonly goalId: string;
  readonly allocationPercent: number;
}

export interface ActivityEvent {
  readonly id: string;
  readonly entityType: ActivityEventEntityType;
  readonly entityId: string;
  readonly action: ActivityEventAction;
  readonly occurredAt: string;
  readonly effectiveAt: string;
  readonly changedFields: readonly string[];
  readonly afterVersionId: string | null;
  readonly contentHash: string | null;
  readonly analysisAllowed: boolean;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly provenance: ActorProvenance;
  readonly recordedAt: string;
}

export interface Activity {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly occurredAt: string;
  readonly endedAt: string | null;
  readonly timeBasis: ActivityTimeBasis;
  readonly taskId: string | null;
  readonly projectId: string | null;
  readonly summary: string | null;
  readonly analysisAllowed: boolean;
  readonly allocations: readonly ActivityGoalAllocation[];
  readonly idempotencyKey: string;
  readonly provenance: ActorAttribution;
  readonly recordedAt: string;
  readonly retractedAt: string | null;
  readonly retractionReason: string | null;
}

export const goalStatuses = ["active", "paused", "achieved", "abandoned"] as const;
export type GoalStatus = (typeof goalStatuses)[number];

export interface Goal {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly successCriteria: string | null;
  readonly status: GoalStatus;
  readonly targetAt: string | null;
  readonly projectId: string | null;
  readonly version: number;
  readonly historyCompleteFrom: string;
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GoalVersion {
  readonly id: string;
  readonly goalId: string;
  readonly version: number;
  readonly operation: VersionOperation;
  readonly snapshot: Omit<
    Goal,
    "version" | "historyCompleteFrom" | "provenance" | "createdAt" | "updatedAt"
  >;
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly changedFields: readonly string[];
  readonly provenance: ActorAttribution;
  readonly activityEventId: string;
}

export interface PriorityPlanItem {
  readonly goalId: string;
  readonly rank: number;
  readonly intendedSharePercent: number | null;
}

/** A plan without a project is the brain-wide (general) plan. */
export interface PriorityPlan {
  readonly id: string;
  readonly projectId: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly version: number;
  readonly currentVersionId: string;
  readonly items: readonly PriorityPlanItem[];
  readonly note: string | null;
  readonly provenance: ActorAttribution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PriorityPlanVersion {
  readonly id: string;
  readonly priorityPlanId: string;
  readonly version: number;
  readonly projectId: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly items: readonly PriorityPlanItem[];
  readonly note: string | null;
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly provenance: ActorAttribution;
}

export interface CompletedTaskAlignment {
  readonly linkedCount: number;
  readonly unlinkedCount: number;
  readonly alignedLinkedCount: number;
  readonly nonPriorityLinkedCount: number;
  readonly rateAmongLinked: number | null;
}

export interface RecordedIntervalAlignment {
  readonly sessionCount: number;
  readonly rawRecordedMinutes: number;
  readonly overlappingMinutes: number;
  readonly allocatedMinutes: number;
  readonly priorityAllocatedMinutes: number;
  readonly rateAmongAllocated: number | null;
}

export interface ActivitySummary {
  readonly from: string;
  readonly to: string;
  readonly timeZone: string;
  readonly tasksCreated: number;
  readonly tasksStarted: number;
  readonly tasksCompleted: number;
  readonly tasksReopened: number;
  readonly tasksCanceled: number;
  readonly remindersScheduled: number;
  readonly remindersCompleted: number;
  readonly overdueTasksAtEnd: number;
  readonly pendingPastDueRemindersAtEnd: number;
  readonly completedTasks: CompletedTaskAlignment;
  readonly recordedIntervals: RecordedIntervalAlignment;
  readonly sourceEventIds: readonly string[];
  readonly sourceActivityIds: readonly string[];
  readonly provenanceHash: string;
  readonly coverage: TemporalCoverage;
}
