import type {
  AutomationJob,
  AutomationJobKind,
  AutomationJobStatus,
} from "@second-brain/engine/domain/automation";
import type {
  BrainAccessContext,
  BrainRole,
  CursorPosition,
  Page,
} from "@second-brain/engine/domain/core";
import type { DreamingMode } from "@second-brain/engine/domain/dreaming";

/** The complete operator-visible settings snapshot. */
export interface AdminAutomationSettings {
  readonly timeZone: string;
  readonly dreamingEnabled: boolean;
  readonly dreamLocalTime: string;
  readonly nextDreamAt: string | null;
  readonly dreamingMode: DreamingMode;
  readonly dailyInputTokenLimit: number;
  readonly dailyOutputTokenLimit: number;
  readonly reminderDeliveryEnabled: boolean;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface AdminAutomationWorkerStatus {
  readonly workerId: string;
  readonly version: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly health: "healthy" | "stale";
}

export interface AdminAutomationStatus {
  readonly observedAt: string;
  readonly workers: readonly AdminAutomationWorkerStatus[];
  readonly jobs: {
    readonly pending: number;
    readonly running: number;
    readonly retryWait: number;
    readonly failed: number;
    readonly lastCompletedAt: string | null;
  };
}

export interface AdminAutomationSettingsChanges {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly timeZone?: string | undefined;
  readonly dreamingEnabled?: boolean | undefined;
  readonly dreamLocalTime?: string | undefined;
  readonly dreamingMode?: DreamingMode | undefined;
  readonly dailyInputTokenLimit?: number | undefined;
  readonly dailyOutputTokenLimit?: number | undefined;
  readonly reminderDeliveryEnabled?: boolean | undefined;
}

/** Database operations used only by the non-MCP administrative engine. */
export interface AdminAutomationStore {
  getSettings(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<AdminAutomationSettings>;
  updateSettings(
    access: BrainAccessContext,
    changes: AdminAutomationSettingsChanges,
    signal: AbortSignal,
  ): Promise<AdminAutomationSettings | null>;
  getStatus(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<AdminAutomationStatus>;
  listJobs(
    access: BrainAccessContext,
    input: {
      readonly kind: AutomationJobKind | null;
      readonly status: AutomationJobStatus | null;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<Page<AutomationJob>>;
  enqueueDreamingRun(
    access: BrainAccessContext,
    input: {
      readonly localDate: string | null;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly job: AutomationJob; readonly created: boolean }>;
}

export const adminBrainMapNodeTypes = [
  "memory",
  "knowledge_base",
  "document",
  "person",
  "project",
] as const;
export type AdminBrainMapNodeType = (typeof adminBrainMapNodeTypes)[number];

export const adminBrainMapEdgeTypes = [
  "contains",
  "mentions",
  "belongs_to",
  "participates_in",
  "covers",
] as const;
export type AdminBrainMapEdgeType = (typeof adminBrainMapEdgeTypes)[number];

export interface AdminBrainMapCounts {
  readonly memories: number;
  readonly knowledgeBases: number;
  readonly documents: number;
  readonly people: number;
  readonly projects: number;
}

export interface AdminBrainMapNode {
  readonly id: string;
  readonly type: AdminBrainMapNodeType;
  readonly label: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly version: number | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

export interface AdminBrainMapEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: AdminBrainMapEdgeType;
}

export interface AdminBrainMapSeriesPoint extends AdminBrainMapCounts {
  readonly date: string;
  readonly total: number;
}

export interface AdminBrainMapSnapshot {
  readonly generatedAt: string;
  readonly periodDays: number;
  readonly counts: AdminBrainMapCounts;
  readonly totalItems: number;
  readonly growth: number;
  /** Connections between the bounded nodes returned in this snapshot. */
  readonly explicitConnections: number;
  /** Nodes with at least one connection in this bounded snapshot. */
  readonly connectedItems: number;
  readonly connectedCoverage: number;
  readonly truncated: boolean;
  readonly nodes: readonly AdminBrainMapNode[];
  readonly edges: readonly AdminBrainMapEdge[];
  readonly series: readonly AdminBrainMapSeriesPoint[];
}

/** Database operations used only by the non-MCP brain map. */
export interface AdminBrainMapStore {
  getBrainMap(
    access: BrainAccessContext,
    input: { readonly days: number; readonly nodeLimit: number },
    signal: AbortSignal,
  ): Promise<AdminBrainMapSnapshot>;
}

export const adminAuditCategories = [
  "domain",
  "administration",
  "authentication",
  "automation",
] as const;
export type AdminAuditCategory = (typeof adminAuditCategories)[number];

export const adminAuditOutcomes = ["succeeded", "denied", "failed"] as const;
export type AdminAuditOutcome = (typeof adminAuditOutcomes)[number];

export interface AdminAuditEvent {
  readonly id: string;
  readonly category: AdminAuditCategory;
  readonly action: string;
  readonly outcome: AdminAuditOutcome;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly actorAccountId: string | null;
  readonly actorRole: BrainRole | null;
  readonly requestId: string;
  readonly errorCode: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface AdminAuditStore {
  listAuditEvents(
    access: BrainAccessContext,
    input: {
      readonly category: AdminAuditCategory | null;
      readonly action: string | null;
      readonly outcome: AdminAuditOutcome | null;
      readonly actorAccountId: string | null;
      readonly targetType: string | null;
      readonly from: string | null;
      readonly to: string | null;
      readonly cursor: CursorPosition | null;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<Page<AdminAuditEvent>>;
}

export class AdminRevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor() {
    super("The record changed after it was loaded.");
    this.name = "AdminRevisionConflictError";
  }
}
