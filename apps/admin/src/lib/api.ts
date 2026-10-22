import type { NotificationChannel, ReminderItem, DeliveryItem } from "./notification-types";
import type { BriefingAction, BriefingSnapshot, BrainAnswer, ProjectRecord, ProjectContextItem, ProjectSection } from "./workspace-types";
import type { IngestionStatus, LearningDreaming, LearningItem, LearningReceipt, ReviewDecision } from "./learning-types";
import type { DreamingCalendar } from "./dreaming-calendar-types";
import type {
  BrainPackExportInput,
  BrainPackExportResult,
  BrainPackExportRun,
  BrainPackImportRun,
  BrainPackImportStart,
  BrainPackImportPublishResult,
  BrainPackImportReviewInput,
  BrainPackImportReviewResult,
  BrainPackRunsPage,
  BrainPackRunsQuery,
  BrainPackRunStatus,
} from "./brain-pack-types";
import type { ModelConfiguration, ModelProbe, ModelUsage, ModelOperation } from "./model-types";
import type {
  AdminIdentity,
  AuditEvent,
  AutomationJob,
  AutomationSettings,
  BrainMapSnapshot,
  ConfigEntries,
  ConfigurationRestartResult,
  CursorPage,
  DreamingRun,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeRevision,
  MemoryRecord,
  Overview,
  ProblemDetails,
  WorkerHealth,
} from "./api-types";
import { translate } from "./i18n/catalog";
import { defaultLocale, type Locale } from "./i18n/locale";
import { getOAuthAccessToken, refreshOAuthAccessToken } from "./oauth";

export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails;

  constructor(status: number, problem: ProblemDetails) {
    super(problem.detail ?? problem.message ?? problem.title ?? `Request failed with status ${status}.`);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }

  get conflict(): boolean {
    return this.status === 409 || this.status === 412;
  }
}

type QueryValue = string | number | boolean | null | undefined;
type RequestOptions = Omit<RequestInit, "signal"> & {
  query?: Record<string, QueryValue> | undefined;
  signal?: AbortSignal | undefined;
};

function withQuery(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

/** Sends with the bearer token, refreshing it once on a 401, and turns failures into `ApiError`. */
async function authorizedFetch(
  path: string,
  options: RequestOptions & { accept: string },
): Promise<Response> {
  const { query, headers, signal, accept, ...init } = options;
  const url = withQuery(path, query);
  const send = async (accessToken: string) => {
    return fetch(url, {
      ...init,
      ...(signal === undefined ? {} : { signal }),
      credentials: "omit",
      headers: {
        Accept: accept,
        Authorization: `Bearer ${accessToken}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
    });
  };
  const accessToken = await getOAuthAccessToken();
  let response = await send(accessToken);
  if (response.status === 401) response = await send(await refreshOAuthAccessToken(accessToken));
  if (!response.ok) {
    let problem: ProblemDetails = {};
    try {
      problem = (await response.json()) as ProblemDetails;
    } catch {
      problem = { title: response.statusText };
    }
    throw new ApiError(response.status, problem);
  }
  return response;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await authorizedFetch(path, { ...options, accept: "application/json" });
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Reads a picked file as bytes; older engines expose only `FileReader`. */
function fileBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsArrayBuffer(file);
  });
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function attachmentFileName(disposition: string | null, fallback: string): string {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/iu.exec(disposition ?? "");
  const name = match?.[1] === undefined ? fallback : decodeURIComponent(match[1]);
  return name.replaceAll(/[\\/]+/gu, "-");
}

export interface BrainPackUploadReceipt {
  artifactId: string;
  sha256: string;
  byteSize: number;
  expiresAt: string;
}

export const api = {
  /** Sends a `.brainpack` archive as raw bytes; the server checks the declared SHA-256 against what arrived. */
  uploadBrainPack: async (file: File, signal?: AbortSignal) => {
    const bytes = await fileBytes(file);
    return request<BrainPackUploadReceipt>("/api/admin/packs/uploads", {
      method: "POST",
      body: bytes,
      headers: { "Content-Type": "application/octet-stream", "X-Content-Sha256": await sha256Hex(bytes) },
      signal,
    });
  },
  brainPackDownloadUrl: (runId: string) => `/api/admin/packs/exports/${encodeURIComponent(runId)}/download`,
  /** The download needs the bearer token, so it is fetched here and handed over as a named blob. */
  downloadBrainPack: async (runId: string, signal?: AbortSignal) => {
    const response = await authorizedFetch(api.brainPackDownloadUrl(runId), { accept: "application/zip", signal });
    return {
      blob: await response.blob(),
      fileName: attachmentFileName(response.headers.get("Content-Disposition"), `${runId}.brainpack`),
    };
  },
  /** Freezes the selection into a pack; synchronous within the version 1 limits, so the receipt usually comes back at once. */
  exportBrainPack: (input: BrainPackExportInput) => request<BrainPackExportResult>("/api/admin/engine/knowledge-packs-export", { method: "POST", body: JSON.stringify(input) }),
  brainPackExport: (runId: string, signal?: AbortSignal) => request<BrainPackExportRun>("/api/admin/engine/knowledge-packs-export-get", { method: "POST", body: JSON.stringify({ runId }), signal }),
  importBrainPack: (input: { artifactId: string; idempotencyKey: string }) => request<BrainPackImportStart>("/api/admin/engine/knowledge-packs-import", { method: "POST", body: JSON.stringify(input) }),
  brainPackImport: (input: { runId: string; cursor: string | null; limit: number }, signal?: AbortSignal) => request<BrainPackImportRun>("/api/admin/engine/knowledge-packs-import-get", { method: "POST", body: JSON.stringify(input), signal }),
  reviewBrainPackImport: (input: BrainPackImportReviewInput) => request<BrainPackImportReviewResult>("/api/admin/engine/knowledge-packs-import-review", { method: "POST", body: JSON.stringify(input) }),
  publishBrainPackImport: (input: { runId: string; reviewDigest: string; idempotencyKey: string }) => request<BrainPackImportPublishResult>("/api/admin/engine/knowledge-packs-import-publish", { method: "POST", body: JSON.stringify(input) }),
  brainPackRuns: (query: BrainPackRunsQuery, signal?: AbortSignal) => request<BrainPackRunsPage>("/api/admin/engine/knowledge-packs-runs-list", { method: "POST", body: JSON.stringify(query), signal }),
  cancelBrainPackRun: (input: { runId: string; idempotencyKey: string }) => request<{ runId: string; status: BrainPackRunStatus; canceled: boolean }>("/api/admin/engine/knowledge-packs-runs-cancel", { method: "POST", body: JSON.stringify(input) }),
  retryBrainPackRun: (input: { runId: string; idempotencyKey: string }) => request<{ runId: string; status: BrainPackRunStatus }>("/api/admin/engine/knowledge-packs-runs-retry", { method: "POST", body: JSON.stringify(input) }),
  briefing: (signal?: AbortSignal) => request<BriefingSnapshot>("/api/admin/engine/briefing-get", { method: "POST", body: "{}", signal }),
  actOnBriefing: (input: { reportId: string; insightIndex: number; expectedDigest: string; kind: "task" | "reminder" | "resolve"; text?: string | null; listId?: string | null; projectId?: string | null; dueAt?: string | null; idempotencyKey: string }) => request<BriefingAction>("/api/admin/engine/briefing-act", { method: "POST", body: JSON.stringify(input) }),
  taskLists: (signal?: AbortSignal) => request<{ taskLists: { id: string; name: string }[] }>("/api/admin/engine/task-lists-list", { method: "POST", body: "{}", signal }),
  createTaskList: (input: { name: string; idempotencyKey: string }) => request<{ id: string; name: string }>("/api/admin/engine/task-lists-create", { method: "POST", body: JSON.stringify(input) }),
  notificationChannels: (signal?: AbortSignal) => request<{ channels: NotificationChannel[]; encryptionAvailable: boolean }>("/api/admin/engine/notification-channels-list", { method: "POST", body: "{}", signal }),
  saveNotificationChannel: (input: { id: string; kind: "slack" | "telegram"; name: string; destination: string; token?: string; enabled: boolean; expectedRevision: number }) => request<NotificationChannel>("/api/admin/engine/notification-channel-save", { method: "POST", body: JSON.stringify(input) }),
  notificationDeliveries: (input: { cursor?: string | null; limit?: number }, signal?: AbortSignal) => request<{ deliveries: DeliveryItem[]; nextCursor: string | null }>("/api/admin/engine/notification-deliveries-list", { method: "POST", body: JSON.stringify(input), signal }),
  reminders: (input: { includeCompleted?: boolean; cursor?: string | null; limit?: number }, signal?: AbortSignal) => request<{ reminders: ReminderItem[]; nextCursor: string | null }>("/api/admin/engine/reminders-list", { method: "POST", body: JSON.stringify(input), signal }),
  createReminder: (input: { message: string; remindAt: string; idempotencyKey: string }) => request<ReminderItem>("/api/admin/engine/reminders-create", { method: "POST", body: JSON.stringify(input) }),
  updateReminder: (input: { id: string; expectedVersion: number; completed?: boolean; remindAt?: string; idempotencyKey: string }) => request<unknown>("/api/admin/engine/reminders-update", { method: "POST", body: JSON.stringify(input) }),
  projects: (cursor?: string | null, signal?: AbortSignal) => request<{ projects: ProjectRecord[]; nextCursor: string | null }>("/api/admin/engine/projects-list", { method: "POST", body: JSON.stringify({ cursor: cursor ?? null }), signal }),
  project: (projectId: string, signal?: AbortSignal) => request<{ result: { project: ProjectRecord; counts: Record<ProjectSection, number> } | null }>("/api/admin/engine/project-get", { method: "POST", body: JSON.stringify({ projectId }), signal }),
  projectSection: (input: { projectId: string; section: ProjectSection; cursor?: string | null }, signal?: AbortSignal) => request<{ items: ProjectContextItem[]; nextCursor: string | null }>("/api/admin/engine/project-section", { method: "POST", body: JSON.stringify(input), signal }),
  updateTask: (input: { id: string; expectedVersion: number; status: "done" | "todo"; idempotencyKey: string }) => request<unknown>("/api/admin/engine/tasks-update", { method: "POST", body: JSON.stringify(input) }),
  askBrain: (input: { question: string; locale: Locale; projectId: string | null }, signal?: AbortSignal) => request<BrainAnswer>("/api/admin/engine/brain-question", { method: "POST", body: JSON.stringify(input), signal }),
  learningList: (input: { kind: "ingestion" | "dreaming"; status: "pending" | "history"; cursor?: string | null }, signal?: AbortSignal) => request<{ items: LearningItem[]; nextCursor: string | null }>("/api/admin/engine/learning-list", { method: "POST", body: JSON.stringify(input), signal }),
  learningDreaming: (changeId: string, signal?: AbortSignal) => request<{ result: LearningDreaming | null }>("/api/admin/engine/learning-dreaming-get", { method: "POST", body: JSON.stringify({ changeId }), signal }),
  reviewDreaming: (input: { changeId: string; fingerprint: string; decision: ReviewDecision; idempotencyKey: string }) => request<LearningReceipt>("/api/admin/engine/learning-dreaming-review", { method: "POST", body: JSON.stringify(input) }),
  ingestionStatus: (runId: string, signal?: AbortSignal) => request<{ result: IngestionStatus | null }>("/api/admin/engine/ingestion-status", { method: "POST", body: JSON.stringify({ runId }), signal }),
  reviewIngestion: (input: { runId: string; proposalDigest: string; items: { proposalId: string; decision: ReviewDecision }[]; idempotencyKey: string }) => request<NonNullable<IngestionStatus["review"]>>("/api/admin/engine/ingestion-review", { method: "POST", body: JSON.stringify(input) }),
  commitIngestion: (input: { runId: string; reviewedDigest: string; idempotencyKey: string }) => request<{ run: IngestionStatus["run"]; receipts: IngestionStatus["receipts"] }>("/api/admin/engine/ingestion-commit", { method: "POST", body: JSON.stringify({ ...input, mode: "atomic" }) }),
  dreamingCalendar: (month: string, signal?: AbortSignal) => request<DreamingCalendar>("/api/admin/engine/dreaming-calendar", { method: "POST", body: JSON.stringify({ month }), signal }),
  retryDreaming: (input: { jobId: string; idempotencyKey: string }) => request<{ jobId: string; sourceJobId: string; created: boolean; mode: "preview" }>("/api/admin/engine/dreaming-retry", { method: "POST", body: JSON.stringify(input) }),
  modelConfiguration: (signal?: AbortSignal) => request<ModelConfiguration>("/api/admin/engine/model-configuration", { method: "POST", body: "{}", signal }),
  modelCatalog: (signal?: AbortSignal) => request<{ models: Array<{ id: string; name: string }>; checkedAt: string }>("/api/admin/engine/model-catalog", { method: "POST", body: "{}", signal }),
  probeModel: (input: { model: string; apiKey?: string }, signal?: AbortSignal) => request<ModelProbe>("/api/admin/engine/model-probe", { method: "POST", body: JSON.stringify(input), signal }),
  modelUsage: (input: { days: number; operation?: ModelOperation; model?: string }, signal?: AbortSignal) => request<ModelUsage>("/api/admin/engine/model-usage", { method: "POST", body: JSON.stringify(input), signal }),
  me: (signal?: AbortSignal) => request<AdminIdentity>("/api/admin/me", { signal }),
  overview: async (signal?: AbortSignal): Promise<Overview> => {
    const [settings, jobs, workerResult, memories, bases, config, latest] = await Promise.all([
      api.automationSettings(signal),
      api.jobs({ limit: 100 }, signal),
      api.workers(signal),
      api.memories({ limit: 100 }, signal),
      api.knowledgeBases(signal),
      api.config(signal),
      api.latestDreamingReport(),
    ]);
    const workers = workerResult.workers;
    return {
      settings,
      workerSummary: {
        healthy: workers.filter((worker) => worker.state === "healthy").length,
        stale: workers.filter((worker) => worker.state === "stale").length,
        offline: workers.filter((worker) => worker.state === "offline").length,
      },
      jobSummary: {
        pending: jobs.items.filter((job) => job.status === "pending" || job.status === "retry_wait").length,
        running: jobs.items.filter((job) => job.status === "running").length,
        failed: jobs.items.filter((job) => job.status === "failed").length,
      },
      counts: {
        memories: memories.memories.length,
        knowledgeBases: bases.knowledgeBases.length,
        knowledgeDocuments: bases.knowledgeBases.reduce((sum, base) => sum + (base.documentCount ?? 0), 0),
      },
      latestReport: latest.report,
      configuration: { pendingChanges: 0, restartRequired: config.restartRequired },
    };
  },

  config: async (signal?: AbortSignal, locale: Locale = defaultLocale): Promise<ConfigEntries> => {
    const result = await request<{
      revision: number;
      restartRequired: boolean;
      variables: Array<{ name: string; secret: boolean; configured: boolean; value?: string | null; restartRequired: true }>;
    }>("/api/admin/config/entries", { signal });
    return {
      revision: result.revision,
      restartRequired: result.restartRequired,
      entries: result.variables.map((variable) => ({
        name: variable.name,
        category: "models" as const,
        description: translate(locale, variable.name === "OPENROUTER_API_KEY" ? "configuration.entryDescription.openrouterApiKey" : "configuration.entryDescription.default"),
        isSet: variable.configured,
        isSecret: variable.secret,
        editable: true,
        source: "database" as const,
        restartTargets: ["engine", "admin", "automation-worker"],
        maskedValue: variable.secret ? (variable.configured ? "••••••••" : null) : variable.value ?? null,
        stagedValue: null,
        validationError: null,
      })),
    };
  },
  stageConfig: (input: { expectedRevision: number; changes: Array<{ name: string; value: string | null }>; idempotencyKey: string }) =>
    request<{ revision: number; changedNames: string[]; restartRequired: boolean; updatedAt: string | null; replayed: boolean }>("/api/admin/config/staged", { method: "PATCH", body: JSON.stringify(input) }),
  restartConfigurationServices: (input: { expectedRevision: number; idempotencyKey: string }) =>
    request<ConfigurationRestartResult>("/api/admin/config/restart", { method: "POST", body: JSON.stringify(input) }),

  automationSettings: (signal?: AbortSignal) => request<AutomationSettings>("/api/admin/automation/settings", { signal }),
  updateAutomationSettings: (input: Partial<AutomationSettings> & { expectedRevision: number; idempotencyKey: string }) =>
    request<AutomationSettings>("/api/admin/automation/settings", { method: "PATCH", body: JSON.stringify(input) }),
  enqueueDreaming: (input: { localDate?: string; idempotencyKey: string }) =>
    request<{ job: AutomationJob; created: boolean }>("/api/admin/dreaming/runs", { method: "POST", body: JSON.stringify(input) }),
  dreamingRun: (id: string, signal?: AbortSignal) => request<{ report: DreamingRun["report"] }>(`/api/admin/dreaming/runs/${id}`, { signal }),
  latestDreamingReport: () => request<{ report: DreamingRun["report"] }>("/api/admin/engine/dreaming-report-get", { method: "POST", body: "{}" }),

  jobs: (query: { status?: string; kind?: string; cursor?: string; limit?: number }, signal?: AbortSignal) =>
    request<CursorPage<AutomationJob>>("/api/admin/automation/jobs", { query, signal }),
  workers: (signal?: AbortSignal) => request<{ workers: WorkerHealth[] }>("/api/admin/automation/workers", { signal }),

  brainMap: (days: 7 | 30 | 90, signal?: AbortSignal) =>
    request<BrainMapSnapshot>("/api/admin/brain-map", { query: { days, nodeLimit: 250 }, signal }),

  memories: (query: Record<string, QueryValue>, signal?: AbortSignal) => request<{ memories: MemoryRecord[]; nextCursor: string | null }>("/api/admin/memories", { query, signal }),
  searchMemories: (query: string, signal?: AbortSignal) => request<{ matches: Array<MemoryRecord & { score: number }> }>("/api/admin/memories/search", { query: { query }, signal }),
  createMemory: (input: Record<string, unknown>) => request<MemoryRecord>("/api/admin/memories", { method: "POST", body: JSON.stringify(input) }),
  updateMemory: (id: string, input: Record<string, unknown>) => request<MemoryRecord>(`/api/admin/memories/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteMemory: (id: string, idempotencyKey: string) => request<void>(`/api/admin/memories/${id}`, { method: "DELETE", body: JSON.stringify({ idempotencyKey }) }),

  knowledgeBases: (signal?: AbortSignal) => request<{ knowledgeBases: KnowledgeBase[] }>("/api/admin/knowledge/bases", { signal }),
  createKnowledgeBase: (input: { name: string; description: string | null; idempotencyKey: string }) => request<KnowledgeBase>("/api/admin/knowledge/bases", { method: "POST", body: JSON.stringify(input) }),
  knowledgeDocuments: (baseId: string, query: { cursor?: string; limit?: number }, signal?: AbortSignal) => request<CursorPage<KnowledgeDocument>>(`/api/admin/knowledge/bases/${baseId}/documents`, { query, signal }),
  knowledgeDocument: (baseId: string, documentId: string, signal?: AbortSignal) => request<{ document: KnowledgeDocument; revision: KnowledgeRevision; content: string }>(`/api/admin/knowledge/bases/${baseId}/documents/${documentId}`, { signal }),
  knowledgeRevisions: (baseId: string, documentId: string, query: { cursor?: string; limit?: number }, signal?: AbortSignal) => request<{ revisions: KnowledgeRevision[]; nextCursor: string | null }>(`/api/admin/knowledge/bases/${baseId}/documents/${documentId}/revisions`, { query, signal }),
  createKnowledgeRevision: (baseId: string, input: Record<string, unknown>) => request<{ document: KnowledgeDocument; revision: KnowledgeRevision }>(`/api/admin/knowledge/bases/${baseId}/documents`, { method: "POST", body: JSON.stringify(input) }),
  askKnowledge: (baseId: string, question: string) => request<{ answer: string; citations: Array<{ documentTitle: string; content: string; score: number }> }>(`/api/admin/knowledge/bases/${baseId}/ask`, { method: "POST", body: JSON.stringify({ question, topK: 5 }) }),

  auditEvents: (query: Record<string, QueryValue>, signal?: AbortSignal) => request<CursorPage<AuditEvent>>("/api/admin/audit/events", { query, signal }),
};
