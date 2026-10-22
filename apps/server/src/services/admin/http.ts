import { randomUUID } from "node:crypto";

import {
  auditedAdminContentOperations,
  type AdminAuditRecorder,
  type AdminBoundaryAuditActor,
  type AdminBoundaryAuditEvent,
  type AuditedAdminContentOperation,
} from "./audit.js";
import {
  BrainPackTransferError,
  handleBrainPackTransfer,
  matchBrainPackTransfer,
  type BrainPackTransferDependencies,
} from "./packs/transfer.js";
import { apiSecurityHeaders, json } from "./responses.js";
import type { ResolvedAdminSession } from "./session.js";
import {
  AdminHttpSecurityError,
  requireAdminMutationSecurity,
} from "./security.js";

/**
 * JSON request bodies. A knowledge document may hold 1,000,000 characters, which
 * is up to 4,000,000 bytes of UTF-8 once encoded, so the cap follows the
 * documented character contract rather than the old 1 MiB.
 */
const maximumBodyBytes = 4 * 1024 * 1024;
const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
type EngineTarget = "public" | "admin";

interface EngineOperation {
  readonly target: EngineTarget;
  readonly capabilityId: string;
}

/** The browser channel has a closed catalog; request input never selects an ID. */
export const adminEngineOperations = {
  "reminders-update": { target: "public", capabilityId: "reminders_update" },
  "notification-channels-list": { target: "admin", capabilityId: "admin_notification_channels_list" },
  "notification-channel-save": { target: "admin", capabilityId: "admin_notification_channel_save" },
  "notification-deliveries-list": { target: "admin", capabilityId: "admin_notification_deliveries_list" },
  "reminders-list": { target: "public", capabilityId: "reminders_list" },
  "reminders-create": { target: "public", capabilityId: "reminders_create" },
  "briefing-get": { target: "admin", capabilityId: "admin_briefing_get" },
  "briefing-act": { target: "admin", capabilityId: "admin_briefing_act" },
  "project-get": { target: "admin", capabilityId: "admin_project_get" },
  "project-section": { target: "admin", capabilityId: "admin_project_section" },
  "brain-question": { target: "admin", capabilityId: "admin_brain_question" },
  "projects-list": { target: "public", capabilityId: "projects_list" },
  "task-lists-list": { target: "public", capabilityId: "task_lists_list" },
  "task-lists-create": { target: "public", capabilityId: "task_lists_create" },
  "tasks-update": { target: "public", capabilityId: "tasks_update" },
  "learning-list": { target: "admin", capabilityId: "admin_learning_list" },
  "learning-dreaming-get": { target: "admin", capabilityId: "admin_learning_dreaming_get" },
  "learning-dreaming-review": { target: "admin", capabilityId: "admin_learning_dreaming_review" },
  "ingestion-status": { target: "public", capabilityId: "ingestion_status" },
  "ingestion-review": { target: "public", capabilityId: "ingestion_review" },
  "ingestion-commit": { target: "public", capabilityId: "ingestion_commit" },
  "dreaming-calendar": { target: "admin", capabilityId: "admin_dreaming_calendar_get" },
  "dreaming-retry": { target: "admin", capabilityId: "admin_dreaming_retry" },
  "model-configuration": { target: "admin", capabilityId: "admin_model_configuration_get" },
  "model-catalog": { target: "admin", capabilityId: "admin_model_catalog_list" },
  "model-probe": { target: "admin", capabilityId: "admin_model_probe" },
  "model-usage": { target: "admin", capabilityId: "admin_model_usage_get" },
  "memories-create": { target: "public", capabilityId: "memories_create" },
  "memories-update": { target: "public", capabilityId: "memories_update" },
  "memories-search": { target: "public", capabilityId: "memories_search" },
  "memories-list": { target: "public", capabilityId: "memories_list" },
  "memories-delete": { target: "public", capabilityId: "memories_delete" },
  "knowledge-bases-create": { target: "public", capabilityId: "knowledge_bases_create" },
  "knowledge-bases-list": { target: "public", capabilityId: "knowledge_bases_list" },
  "knowledge-documents-list": { target: "public", capabilityId: "knowledge_documents_list" },
  "knowledge-documents-get": { target: "public", capabilityId: "knowledge_documents_get" },
  "knowledge-document-revisions-create": {
    target: "public",
    capabilityId: "knowledge_document_revisions_create",
  },
  "knowledge-document-revisions-list": {
    target: "public",
    capabilityId: "knowledge_document_revisions_list",
  },
  "knowledge-ask": { target: "public", capabilityId: "knowledge_ask" },
  "knowledge-packs-export": { target: "public", capabilityId: "knowledge_packs_export" },
  "knowledge-packs-export-get": { target: "public", capabilityId: "knowledge_packs_export_get" },
  "knowledge-packs-import": { target: "public", capabilityId: "knowledge_packs_import" },
  "knowledge-packs-import-get": { target: "public", capabilityId: "knowledge_packs_import_get" },
  "knowledge-packs-import-review": { target: "public", capabilityId: "knowledge_packs_import_review" },
  "knowledge-packs-import-publish": { target: "public", capabilityId: "knowledge_packs_import_publish" },
  "knowledge-packs-runs-list": { target: "public", capabilityId: "knowledge_packs_runs_list" },
  "knowledge-packs-runs-cancel": { target: "public", capabilityId: "knowledge_packs_runs_cancel" },
  "knowledge-packs-runs-retry": { target: "public", capabilityId: "knowledge_packs_runs_retry" },
  "dreaming-report-get": { target: "public", capabilityId: "dreaming_report_get" },
  "automation-settings-get": {
    target: "admin",
    capabilityId: "admin_automation_settings_get",
  },
  "automation-settings-update": {
    target: "admin",
    capabilityId: "admin_automation_settings_update",
  },
  "automation-status-get": {
    target: "admin",
    capabilityId: "admin_automation_status_get",
  },
  "automation-jobs-list": {
    target: "admin",
    capabilityId: "admin_automation_jobs_list",
  },
  "dreaming-runs-create": {
    target: "admin",
    capabilityId: "admin_dreaming_runs_create",
  },
  "audit-events-list": { target: "admin", capabilityId: "admin_audit_events_list" },
  "brain-map-get": { target: "admin", capabilityId: "admin_brain_map_get" },
  "environment-variables-list": {
    target: "admin",
    capabilityId: "admin_environment_variables_list",
  },
  "environment-variables-update": {
    target: "admin",
    capabilityId: "admin_environment_variables_update",
  },
  "environment-services-restart": {
    target: "admin",
    capabilityId: "admin_environment_services_restart",
  },
} as const satisfies Readonly<Record<string, EngineOperation>>;

export interface AdminSessionResolver {
  resolve(headers: Headers, signal: AbortSignal): Promise<ResolvedAdminSession>;
}

export interface AdminEngineInvoker {
  invoke(
    capabilityId: string,
    input: unknown,
    options: {
      readonly source: "direct";
      readonly principal: { readonly id: string };
      readonly requestId: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown>;
}

export interface AdminHttpDependencies {
  readonly trustedOrigin: string;
  readonly sessions: AdminSessionResolver;
  readonly publicEngine?: AdminEngineInvoker;
  readonly adminEngine?: AdminEngineInvoker;
  /** @deprecated Compatibility name for the public engine. */
  readonly engine?: AdminEngineInvoker;
  readonly audit?: AdminAuditRecorder;
  /** The Brain Pack transfer routes; absent until the artifact store is composed. */
  readonly packs?: BrainPackTransferDependencies;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > maximumBodyBytes)) {
    throw new AdminRequestError(413, "ADMIN_BODY_TOO_LARGE", "Request body is too large.");
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > maximumBodyBytes) {
    throw new AdminRequestError(413, "ADMIN_BODY_TOO_LARGE", "Request body is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AdminRequestError(400, "ADMIN_JSON_INVALID", "Request JSON is invalid.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AdminRequestError(400, "ADMIN_INPUT_INVALID", "Admin input must be an object.");
  }
  return parsed as Record<string, unknown>;
}

class AdminRequestError extends Error {
  constructor(
    readonly status: 400 | 405 | 413,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdminRequestError";
  }
}

function hasCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === code) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function publicFailure(error: unknown): Response {
  if (
    error instanceof AdminHttpSecurityError ||
    error instanceof AdminRequestError ||
    error instanceof BrainPackTransferError
  ) {
    return json(error.status, { error: error.code, message: error.message });
  }
  if (hasCode(error, "ADMIN_SESSION_DENIED")) {
    return json(401, { error: "ADMIN_SESSION_DENIED", message: "Authentication required." });
  }
  if (hasCode(error, "INPUT_INVALID")) {
    return json(400, { error: "ADMIN_INPUT_INVALID", message: "Admin input is invalid." });
  }
  if (hasCode(error, "FORBIDDEN")) {
    return json(403, { error: "ADMIN_ACCESS_DENIED", message: "Forbidden." });
  }
  if (hasCode(error, "REVISION_CONFLICT") || hasCode(error, "LEARNING_REVIEW_CONFLICT") || hasCode(error, "NOTIFICATION_CONFLICT") || hasCode(error, "BRIEFING_CONFLICT")) {
    return json(409, { error: "ADMIN_CONFLICT", message: "Admin request conflicted." });
  }
  if (hasCode(error, "PACK_LIMIT_EXCEEDED")) {
    return json(409, {
      error: "PACK_LIMIT_EXCEEDED",
      message: "A Brain Pack size or active import limit was exceeded.",
    });
  }
  if (hasCode(error, "OPENROUTER_AUTHENTICATION_FAILED")) {
    return json(502, {
      error: "ADMIN_PROVIDER_AUTHENTICATION_FAILED",
      message:
        "AI provider authentication failed. Update OPENROUTER_API_KEY in Configuration, restart services, and try again.",
    });
  }
  return json(500, { error: "ADMIN_REQUEST_FAILED", message: "Admin request failed." });
}

function publicErrorCode(error: unknown): string {
  if (
    error instanceof AdminHttpSecurityError ||
    error instanceof AdminRequestError ||
    error instanceof BrainPackTransferError
  ) {
    return error.code;
  }
  if (hasCode(error, "ADMIN_SESSION_DENIED")) return "ADMIN_SESSION_DENIED";
  if (hasCode(error, "INPUT_INVALID")) {
    return "ADMIN_INPUT_INVALID";
  }
  if (hasCode(error, "FORBIDDEN")) {
    return "ADMIN_ACCESS_DENIED";
  }
  if (hasCode(error, "REVISION_CONFLICT") || hasCode(error, "LEARNING_REVIEW_CONFLICT") || hasCode(error, "NOTIFICATION_CONFLICT") || hasCode(error, "BRIEFING_CONFLICT")) {
    return "ADMIN_CONFLICT";
  }
  if (hasCode(error, "PACK_LIMIT_EXCEEDED")) return "PACK_LIMIT_EXCEEDED";
  if (hasCode(error, "OPENROUTER_AUTHENTICATION_FAILED")) {
    return "ADMIN_PROVIDER_AUTHENTICATION_FAILED";
  }
  return "ADMIN_REQUEST_FAILED";
}

function auditOutcome(error: unknown): "denied" | "failed" {
  const status = publicFailure(error).status;
  return status === 401 ||
    status === 403 ||
    hasCode(error, "ADMIN_METHOD_DENIED")
    ? "denied"
    : "failed";
}

function auditMethod(method: string): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OTHER" {
  return method === "GET" ||
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
    ? method
    : "OTHER";
}

async function recordAudit(
  recorder: AdminAuditRecorder | undefined,
  event: AdminBoundaryAuditEvent,
  _signal: AbortSignal,
): Promise<void> {
  if (recorder === undefined) return;
  try {
    await recorder.record(event, AbortSignal.timeout(5_000));
  } catch {
    // Audit persistence is best-effort at this boundary; never replace the
    // primary authentication, authorization, or capability result.
  }
}

function auditActor(session: ResolvedAdminSession | undefined): AdminBoundaryAuditActor | null {
  return session === undefined
    ? null
    : { accountId: session.accountId, role: session.role };
}

function auditedContentCapability(
  operation: MatchedOperation | null,
): AuditedAdminContentOperation | null {
  if (
    operation === null ||
    operation.target !== "public" ||
    !Object.hasOwn(auditedAdminContentOperations, operation.capabilityId)
  ) {
    return null;
  }
  return operation.capabilityId as AuditedAdminContentOperation;
}

function auditTargetId(input: Record<string, unknown>): string | null {
  for (const name of ["id", "documentId"] as const) {
    const value = input[name];
    if (
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ) {
      return value;
    }
  }
  return null;
}

function validTargetOrigin(request: Request, trustedOrigin: string): boolean {
  try {
    return new URL(request.url).origin === trustedOrigin;
  } catch {
    return false;
  }
}

function queryInput(url: URL): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, value] of url.searchParams) {
    const current = input[name];
    input[name] = current === undefined
      ? value
      : Array.isArray(current)
        ? [...current, value]
        : [current, value];
  }
  for (const name of ["limit", "minimumScore", "revision", "days", "nodeLimit"] as const) {
    const value = input[name];
    if (typeof value === "string" && value !== "") input[name] = Number(value);
  }
  if (input.includeSuperseded === "true") input.includeSuperseded = true;
  if (input.includeSuperseded === "false") input.includeSuperseded = false;
  return input;
}

type ResultShape = "settings" | "jobs" | "workers" | "documents" | "audit";

interface MatchedOperation extends EngineOperation {
  readonly input: Record<string, unknown>;
  readonly mutation: boolean;
  readonly resultShape?: ResultShape;
  readonly emptyResponse?: boolean;
}

function bodyWith(body: Record<string, unknown>, required: Record<string, unknown>) {
  return { ...body, ...required };
}

async function matchRestOperation(request: Request, url: URL): Promise<MatchedOperation | null> {
  const { pathname } = url;
  const method = request.method;
  const body = async () => readJsonObject(request);

  if (pathname === "/api/admin/memories/search" && method === "GET") {
    return { ...adminEngineOperations["memories-search"], input: queryInput(url), mutation: false };
  }
  if (pathname === "/api/admin/memories" && method === "GET") {
    return { ...adminEngineOperations["memories-list"], input: queryInput(url), mutation: false };
  }
  if (pathname === "/api/admin/memories" && method === "POST") {
    return { ...adminEngineOperations["memories-create"], input: await body(), mutation: true };
  }
  const memory = /^\/api\/admin\/memories\/([^/]+)$/u.exec(pathname);
  if (memory !== null && method === "PATCH") {
    return { ...adminEngineOperations["memories-update"], input: bodyWith(await body(), { id: memory[1] }), mutation: true };
  }
  if (memory !== null && method === "DELETE") {
    return { ...adminEngineOperations["memories-delete"], input: bodyWith(await body(), { id: memory[1] }), mutation: true, emptyResponse: true };
  }

  if (pathname === "/api/admin/knowledge/bases" && method === "GET") {
    return { ...adminEngineOperations["knowledge-bases-list"], input: {}, mutation: false };
  }
  if (pathname === "/api/admin/knowledge/bases" && method === "POST") {
    return { ...adminEngineOperations["knowledge-bases-create"], input: await body(), mutation: true };
  }
  const documents = /^\/api\/admin\/knowledge\/bases\/([^/]+)\/documents$/u.exec(pathname);
  if (documents !== null && method === "GET") {
    return { ...adminEngineOperations["knowledge-documents-list"], input: { ...queryInput(url), knowledgeBaseId: documents[1] }, mutation: false, resultShape: "documents" };
  }
  if (documents !== null && method === "POST") {
    return { ...adminEngineOperations["knowledge-document-revisions-create"], input: bodyWith(await body(), { knowledgeBaseId: documents[1] }), mutation: true };
  }
  const revisions = /^\/api\/admin\/knowledge\/bases\/[^/]+\/documents\/([^/]+)\/revisions$/u.exec(pathname);
  if (revisions !== null && method === "GET") {
    return {
      ...adminEngineOperations["knowledge-document-revisions-list"],
      input: { ...queryInput(url), documentId: revisions[1] },
      mutation: false,
    };
  }
  const document = /^\/api\/admin\/knowledge\/bases\/[^/]+\/documents\/([^/]+)$/u.exec(pathname);
  if (document !== null && method === "GET") {
    return { ...adminEngineOperations["knowledge-documents-get"], input: { ...queryInput(url), documentId: document[1] }, mutation: false };
  }
  const ask = /^\/api\/admin\/knowledge\/bases\/([^/]+)\/ask$/u.exec(pathname);
  if (ask !== null && method === "POST") {
    return { ...adminEngineOperations["knowledge-ask"], input: bodyWith(await body(), { knowledgeBaseId: ask[1] }), mutation: true };
  }

  if (pathname === "/api/admin/automation/settings" && method === "GET") {
    return { ...adminEngineOperations["automation-settings-get"], input: {}, mutation: false, resultShape: "settings" };
  }
  if (pathname === "/api/admin/automation/settings" && method === "PATCH") {
    return { ...adminEngineOperations["automation-settings-update"], input: await body(), mutation: true, resultShape: "settings" };
  }
  if (pathname === "/api/admin/automation/jobs" && method === "GET") {
    return { ...adminEngineOperations["automation-jobs-list"], input: queryInput(url), mutation: false, resultShape: "jobs" };
  }
  if (pathname === "/api/admin/automation/workers" && method === "GET") {
    return { ...adminEngineOperations["automation-status-get"], input: {}, mutation: false, resultShape: "workers" };
  }
  if (pathname === "/api/admin/dreaming/runs" && method === "POST") {
    const input = await body();
    delete input.mode;
    delete input.reason;
    return { ...adminEngineOperations["dreaming-runs-create"], input, mutation: true };
  }
  const dreamingRun = /^\/api\/admin\/dreaming\/runs\/([^/]+)$/u.exec(pathname);
  if (dreamingRun !== null && method === "GET") {
    return { ...adminEngineOperations["dreaming-report-get"], input: { runId: dreamingRun[1] }, mutation: false };
  }

  if (pathname === "/api/admin/audit/events" && method === "GET") {
    return { ...adminEngineOperations["audit-events-list"], input: queryInput(url), mutation: false, resultShape: "audit" };
  }
  if (pathname === "/api/admin/brain-map" && method === "GET") {
    return { ...adminEngineOperations["brain-map-get"], input: queryInput(url), mutation: false };
  }
  if (pathname === "/api/admin/config/entries" && method === "GET") {
    return { ...adminEngineOperations["environment-variables-list"], input: {}, mutation: false };
  }
  if (pathname === "/api/admin/config/staged" && method === "PATCH") {
    const input = await body();
    if (Array.isArray(input.changes)) {
      input.changes = input.changes.map((change) => {
        if (typeof change !== "object" || change === null || !("name" in change)) return change;
        const candidate = change as { readonly name: unknown; readonly value?: unknown };
        return candidate.value === null
          ? { name: candidate.name, operation: "clear" }
          : { name: candidate.name, operation: "set", value: candidate.value };
      });
    }
    return { ...adminEngineOperations["environment-variables-update"], input, mutation: true };
  }
  if (pathname === "/api/admin/config/restart" && method === "POST") {
    return {
      ...adminEngineOperations["environment-services-restart"],
      input: await body(),
      mutation: true,
    };
  }
  return null;
}

function shapeResult(result: unknown, shape: ResultShape | undefined): unknown {
  if (shape === undefined || typeof result !== "object" || result === null) return result;
  const value = result as Record<string, unknown>;
  if (shape === "settings") return value.settings;
  if (shape === "jobs") return { items: value.jobs, nextCursor: value.nextCursor };
  if (shape === "documents") return { items: value.documents, nextCursor: value.nextCursor };
  if (shape === "audit") return { items: value.events, nextCursor: value.nextCursor };
  const workers = Array.isArray(value.workers)
    ? value.workers.map((worker) => {
        if (typeof worker !== "object" || worker === null) return worker;
        const item = worker as Record<string, unknown>;
        return { ...item, state: item.health, activeJobId: null };
      })
    : [];
  return { workers };
}

function getEngine(dependencies: AdminHttpDependencies, target: EngineTarget): AdminEngineInvoker {
  const engine = target === "admin"
    ? dependencies.adminEngine
    : dependencies.publicEngine ?? dependencies.engine;
  if (engine === undefined) throw new Error(`The ${target} admin HTTP engine is not configured.`);
  return engine;
}

/** A transport-only adapter: authenticate, validate, and call engine.invoke. */
export function createAdminHttpHandler(dependencies: AdminHttpDependencies) {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    let session: ResolvedAdminSession | undefined;
    let operation: MatchedOperation | null = null;
    let resolvingSession = false;
    let pathname = "";
    try {
      if (!validTargetOrigin(request, dependencies.trustedOrigin)) {
        const error = new AdminHttpSecurityError(
          403,
          "ADMIN_ORIGIN_DENIED",
          "Forbidden.",
        );
        await recordAudit(
          dependencies.audit,
          {
            kind: "request_outcome",
            actor: null,
            category: "administration",
            action: "administration.request",
            outcome: "denied",
            method: auditMethod(request.method),
            requestId,
            errorCode: error.code,
          },
          request.signal,
        );
        return publicFailure(error);
      }
      const url = new URL(request.url);
      pathname = url.pathname;
      resolvingSession = true;
      session = await dependencies.sessions.resolve(request.headers, request.signal);
      resolvingSession = false;
      if ((pathname === "/api/admin/session" || pathname === "/api/admin/me") && request.method === "GET") {
        return json(200, {
          accountId: session.accountId,
          email: session.email,
          role: session.role,
          connectedClientCount: session.connectedClientCount,
        });
      }

      const transfer = matchBrainPackTransfer(pathname);
      if (transfer !== null) {
        if (dependencies.packs === undefined) {
          await recordAudit(
            dependencies.audit,
            {
              kind: "request_outcome",
              actor: auditActor(session),
              category: "administration",
              action: "administration.request",
              outcome: "denied",
              method: auditMethod(request.method),
              requestId,
              errorCode: "ADMIN_ROUTE_NOT_FOUND",
            },
            request.signal,
          );
          return json(404, { error: "NOT_FOUND", message: "Not found." });
        }
        return await handleBrainPackTransfer(request, transfer, session, dependencies.packs, dependencies.trustedOrigin);
      }

      const engineMatch = /^\/api\/admin\/engine\/([a-z0-9-]+)$/u.exec(pathname);
      if (engineMatch !== null) {
        const selected = (adminEngineOperations as Readonly<Record<string, EngineOperation | undefined>>)[engineMatch[1]!];
        if (selected === undefined) {
          await recordAudit(
            dependencies.audit,
            {
              kind: "request_outcome",
              actor: auditActor(session),
              category: "administration",
              action: "administration.request",
              outcome: "denied",
              method: auditMethod(request.method),
              requestId,
              errorCode: "ADMIN_ROUTE_NOT_FOUND",
            },
            request.signal,
          );
          return json(404, { error: "NOT_FOUND", message: "Not found." });
        }
        requireAdminMutationSecurity(request, dependencies.trustedOrigin);
        operation = { ...selected, input: await readJsonObject(request), mutation: true };
      } else {
        if (mutationMethods.has(request.method)) {
          requireAdminMutationSecurity(request, dependencies.trustedOrigin);
        }
        operation = await matchRestOperation(request, url);
        if (operation === null) {
          await recordAudit(
            dependencies.audit,
            {
              kind: "request_outcome",
              actor: auditActor(session),
              category: "administration",
              action: "administration.request",
              outcome: "denied",
              method: auditMethod(request.method),
              requestId,
              errorCode: "ADMIN_ROUTE_NOT_FOUND",
            },
            request.signal,
          );
          return json(404, { error: "NOT_FOUND", message: "Not found." });
        }
      }

      const engine = getEngine(dependencies, operation.target);
      const result = operation.target === "public"
        ? await (engine.invoke as unknown as (
            capabilityId: string,
            input: unknown,
            options: {
              readonly source: "admin";
              readonly principal: { readonly id: string };
              readonly requestId: string;
      readonly signal?: AbortSignal;
            },
          ) => Promise<unknown>)(operation.capabilityId, operation.input, {
            source: "admin",
            principal: session.principal,
            requestId,
            signal: request.signal,
          })
        : await engine.invoke(operation.capabilityId, operation.input, {
            source: "direct",
            principal: session.principal,
            requestId,
            signal: request.signal,
          });
      if (operation.emptyResponse) return new Response(null, { status: 204, headers: apiSecurityHeaders });
      return json(200, shapeResult(result, operation.resultShape));
    } catch (error) {
      const errorCode = publicErrorCode(error);
      const contentCapability = auditedContentCapability(operation);
      if (contentCapability !== null && session !== undefined) {
        await recordAudit(
          dependencies.audit,
          {
            kind: "content_mutation_outcome",
            actor: auditActor(session),
            capabilityId: contentCapability,
            outcome: auditOutcome(error),
            targetId: operation === null ? null : auditTargetId(operation.input),
            requestId,
            errorCode,
          },
          request.signal,
        );
      } else {
        const authenticationFailure =
          resolvingSession ||
          errorCode === "ADMIN_SESSION_DENIED" ||
          pathname === "/api/admin/session" ||
          pathname === "/api/admin/me";
        await recordAudit(
          dependencies.audit,
          {
            kind: "request_outcome",
            actor: auditActor(session),
            category: authenticationFailure ? "authentication" : "administration",
            action: authenticationFailure
              ? "authentication.session"
              : "administration.request",
            outcome: auditOutcome(error),
            method: auditMethod(request.method),
            requestId,
            errorCode,
          },
          request.signal,
        );
      }
      return publicFailure(error);
    }
  };
}
