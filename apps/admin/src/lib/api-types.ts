export type Role = "viewer" | "editor" | "admin" | "owner";
export type CursorPage<T> = { items: T[]; nextCursor: string | null };

export interface AdminIdentity {
  accountId: string;
  email: string;
  role: Role;
  connectedClientCount: number;
}

export interface WorkerHealth {
  workerId: string;
  version: string;
  startedAt: string;
  lastSeenAt: string;
  state: "healthy" | "stale" | "offline";
  activeJobId: string | null;
}

export interface AutomationSettings {
  timeZone: string;
  dreamingEnabled: boolean;
  reminderDeliveryEnabled: boolean;
  dreamLocalTime: string;
  nextDreamAt: string | null;
  dreamingMode: "preview" | "apply";
  dailyInputTokenLimit: number;
  dailyOutputTokenLimit: number;
  revision: number;
  updatedAt: string;
}

export type JobStatus =
  | "pending"
  | "running"
  | "retry_wait"
  | "completed"
  | "failed"
  | "canceled";

export interface AutomationJob {
  id: string;
  kind: "daily_dreaming" | "reminder_delivery";
  canonicalKey: string;
  scheduledFor: string;
  status: JobStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cancelRequestedAt: string | null;
  sanitizedError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DreamingRunStatus =
  | "pending"
  | "collecting"
  | "analyzing"
  | "verifying"
  | "applying"
  | "completed"
  | "completed_with_skips"
  | "retryable_failed"
  | "failed"
  | "canceled";

export interface DreamingCitation {
  type: string;
  id: string;
  versionId: string | null;
  excerpt: string;
}

export interface DreamingReport {
  id: string;
  runId: string;
  localDate: string;
  generatedAt: string;
  mode: "preview" | "apply";
  status: "completed" | "completed_with_skips";
  summary: string;
  insights: Array<{
    kind: "observation" | "contradiction" | "open_loop" | "pattern_hypothesis";
    statement: string;
    confidence: "low" | "medium" | "high";
    evidence: DreamingCitation[];
  }>;
  memoriesCreated: Array<{ id: string; content: string }>;
  memoriesUpdated: Array<{ id: string; previousMemoryId: string; content: string }>;
  skipped: Array<{ reason: string }>;
  coverageWarnings: string[];
}

export interface DreamingRun {
  id: string;
  localDate: string;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  mode: "preview" | "apply";
  status: DreamingRunStatus;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  attemptCount: number;
  sanitizedError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  report: DreamingReport | null;
}

export interface Overview {
  settings: AutomationSettings;
  workerSummary: { healthy: number; stale: number; offline: number };
  jobSummary: { pending: number; running: number; failed: number };
  counts: { memories: number; knowledgeBases: number; knowledgeDocuments: number };
  latestReport: DreamingReport | null;
  configuration: { pendingChanges: number; restartRequired: boolean };
}

export type BrainMapNodeType = "memory" | "knowledge_base" | "document" | "person" | "project";
export type BrainMapEdgeType = "contains" | "mentions" | "belongs_to" | "participates_in" | "covers";

export interface BrainMapCounts {
  memories: number;
  knowledgeBases: number;
  documents: number;
  people: number;
  projects: number;
}

export interface BrainMapNode {
  id: string;
  type: BrainMapNodeType;
  label: string;
  description: string | null;
  tags: string[];
  version: number | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface BrainMapEdge {
  id: string;
  source: string;
  target: string;
  type: BrainMapEdgeType;
}

export interface BrainMapSeriesPoint extends BrainMapCounts {
  date: string;
  total: number;
}

export interface BrainMapSnapshot {
  generatedAt: string;
  periodDays: number;
  counts: BrainMapCounts;
  totalItems: number;
  growth: number;
  explicitConnections: number;
  connectedItems: number;
  connectedCoverage: number;
  truncated: boolean;
  nodes: BrainMapNode[];
  edges: BrainMapEdge[];
  series: BrainMapSeriesPoint[];
}

export interface ConfigEntry {
  name: string;
  category: "database" | "models" | "network" | "authentication" | "worker" | "deployment";
  description: string;
  isSet: boolean;
  isSecret: boolean;
  editable: boolean;
  source: "environment" | "file" | "database" | "default";
  restartTargets: string[];
  maskedValue: string | null;
  stagedValue: string | null;
  hasStagedChange?: boolean;
  validationError: string | null;
}

export interface ConfigEntries {
  revision: number;
  entries: ConfigEntry[];
  restartRequired: boolean;
}

export interface ConfigurationRestartResult {
  revision: number;
  targets: ["engine", "admin", "automation-worker"];
  requestedAt: string;
  replayed: boolean;
}

export interface Provenance {
  kind: "account" | "oauth_client" | "import" | "dreaming" | "system";
  accountId: string | null;
  clientId: string | null;
  source: string;
}

export interface MemoryRecord {
  id: string;
  lineageId: string;
  version: number;
  supersedesId: string | null;
  content: string;
  category: string | null;
  tags: string[];
  projectId: string | null;
  personIds: string[];
  effectiveAt: string;
  capturedAt: string | null;
  supersededBy: string | null;
  supersededAt: string | null;
  provenance: Provenance;
  sourceExcerpt: string | null;
  contentHash: string;
  createdAt: string;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  provenance: Provenance;
  createdAt: string;
  updatedAt: string;
  documentCount?: number;
}

export interface KnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  currentRevision: number;
  title: string;
  sourceUri: string | null;
  tags: string[];
  projectId: string | null;
  personIds: string[];
  provenance: Provenance;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRevision {
  id: string;
  documentId: string;
  version: number;
  contentHash: string;
  chunkCount: number;
  provenance: Provenance;
  createdAt: string;
  content?: string;
}

export interface AuditEvent {
  id: string;
  category: "domain" | "administration" | "authentication" | "automation";
  action: string;
  outcome: "succeeded" | "denied" | "failed";
  targetType: string | null;
  targetId: string | null;
  occurredAt: string;
  actorAccountId: string | null;
  actorRole: Role | null;
  requestId: string;
  errorCode: string | null;
  metadata: Record<string, unknown>;
}

export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  message?: string;
  error?: string;
  code?: string;
  errors?: Record<string, string[]>;
  current?: unknown;
}
