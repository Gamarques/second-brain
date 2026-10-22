import type { BrainRole } from "@second-brain/engine/domain/core";
import type {
  AdminAuditCategory,
  AdminAuditOutcome,
} from "./domain.js";

export interface AdminBoundaryAuditActor {
  readonly accountId: string;
  readonly role: BrainRole;
}

export const auditedAdminContentOperations = {
  memories_create: { action: "memory.created", targetType: "memory" },
  memories_update: { action: "memory.updated", targetType: "memory" },
  memories_delete: { action: "memory.deleted", targetType: "memory" },
  knowledge_bases_create: {
    action: "knowledge_base.created",
    targetType: "knowledge_base",
  },
  knowledge_document_revisions_create: {
    action: "knowledge_document.revision_created",
    targetType: "knowledge_document",
  },
} as const;

export type AuditedAdminContentOperation = keyof typeof auditedAdminContentOperations;

interface AuditBase {
  readonly actor: AdminBoundaryAuditActor | null;
  readonly requestId: string;
}

export type AdminBoundaryAuditEvent =
  | (AuditBase & {
      readonly kind: "content_mutation_outcome";
      readonly capabilityId: AuditedAdminContentOperation;
      readonly outcome: Extract<AdminAuditOutcome, "denied" | "failed">;
      readonly targetId: string | null;
      readonly errorCode: string;
    })
  | (AuditBase & {
      readonly kind: "request_outcome";
      readonly category: Extract<AdminAuditCategory, "administration" | "authentication">;
      readonly action: "administration.request" | "authentication.session";
      readonly outcome: Extract<AdminAuditOutcome, "denied" | "failed">;
      readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OTHER";
      readonly errorCode: string;
    });

export interface AdminAuditRecorder {
  record(event: AdminBoundaryAuditEvent, signal: AbortSignal): Promise<void>;
}

export interface AdminBoundaryAuditRow {
  readonly actor: AdminBoundaryAuditActor | null;
  readonly category: AdminAuditCategory;
  readonly action: string;
  readonly outcome: AdminAuditOutcome;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly requestId: string;
  readonly errorCode: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Maps a closed boundary event to the value persisted by infrastructure. */
export function adminBoundaryAuditRow(
  event: AdminBoundaryAuditEvent,
): AdminBoundaryAuditRow {
  if (event.kind === "content_mutation_outcome") {
    const descriptor = auditedAdminContentOperations[event.capabilityId];
    return {
      actor: event.actor,
      category: "domain",
      action: descriptor.action,
      outcome: event.outcome,
      targetType: descriptor.targetType,
      targetId: event.targetId,
      requestId: event.requestId,
      errorCode: event.errorCode,
      metadata: { capabilityId: event.capabilityId },
    };
  }
  return {
    actor: event.actor,
    category: event.category,
    action: event.action,
    outcome: event.outcome,
    targetType: null,
    targetId: null,
    requestId: event.requestId,
    errorCode: event.errorCode,
    metadata: { method: event.method },
  };
}
