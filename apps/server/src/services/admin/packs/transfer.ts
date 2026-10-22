import { createHash } from "node:crypto";

import { apiSecurityHeaders, json } from "../responses.js";
import { AdminHttpSecurityError, requireAdminBinaryMutationSecurity } from "../security.js";
import type { ResolvedAdminSession } from "../session.js";
import type { BrainPackArtifactRecord, BrainPackArtifactStore } from "./artifacts.js";

/** Compressed archive limit; the domain enforces the expanded limits after validation. */
export const defaultMaximumUploadBytes = 64 * 1024 * 1024;
const uploadRetentionMs = 24 * 60 * 60 * 1_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export interface ResolvedExportArtifact {
  readonly record: BrainPackArtifactRecord;
  readonly bytes: Uint8Array;
  readonly packId: string;
  readonly packRevision: number;
}

export interface BrainPackTransferDependencies {
  readonly artifacts: BrainPackArtifactStore;
  /**
   * Finds the archive an export run produced, as visible to this principal.
   * `null` when the run does not exist or is not visible; the engine owns the
   * run tables, so this stays an injected resolver.
   */
  readonly resolveExportArtifact: (
    runId: string,
    principal: { readonly id: string },
    signal: AbortSignal,
  ) => Promise<ResolvedExportArtifact | null>;
  readonly now?: () => Date;
  readonly maximumUploadBytes?: number;
}

export class BrainPackTransferError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 405 | 410 | 413,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrainPackTransferError";
  }
}

export type BrainPackTransferMatch =
  | { readonly kind: "upload" }
  | { readonly kind: "download"; readonly runId: string };

export function matchBrainPackTransfer(pathname: string): BrainPackTransferMatch | null {
  if (pathname === "/api/admin/packs/uploads") return { kind: "upload" };
  const download = /^\/api\/admin\/packs\/exports\/([^/]+)\/download$/u.exec(pathname);
  if (download !== null) return { kind: "download", runId: download[1]! };
  return null;
}

function tooLarge(): BrainPackTransferError {
  return new BrainPackTransferError(413, "ADMIN_BODY_TOO_LARGE", "Request body is too large.");
}

/** Reads the whole body but never buffers more than `maximum` bytes. */
async function readBoundedBody(request: Request, maximum: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > maximum)) {
    throw tooLarge();
  }
  if (request.body === null) {
    throw new BrainPackTransferError(400, "ADMIN_BODY_EMPTY", "Request body is empty.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function safeFileName(packId: string, packRevision: number): string {
  const stem = packId.replaceAll(/[^A-Za-z0-9._-]+/gu, "-").replaceAll(/^-+|-+$/gu, "").slice(0, 80) || "brain-pack";
  return `${stem}-r${Math.max(0, Math.trunc(packRevision))}.brainpack`;
}

async function handleUpload(
  request: Request,
  session: ResolvedAdminSession,
  dependencies: BrainPackTransferDependencies,
  trustedOrigin: string,
): Promise<Response> {
  requireAdminBinaryMutationSecurity(request, trustedOrigin);
  if (session.role !== "admin" && session.role !== "owner") {
    throw new BrainPackTransferError(403, "ADMIN_ACCESS_DENIED", "Forbidden.");
  }
  const declaredDigest = request.headers.get("x-content-sha256")?.trim().toLowerCase();
  if (declaredDigest !== undefined && !sha256Pattern.test(declaredDigest)) {
    throw new BrainPackTransferError(400, "ADMIN_CONTENT_HASH_MISMATCH", "The declared SHA-256 is not a valid digest.");
  }
  const bytes = await readBoundedBody(request, dependencies.maximumUploadBytes ?? defaultMaximumUploadBytes);
  if (bytes.byteLength === 0) {
    throw new BrainPackTransferError(400, "ADMIN_BODY_EMPTY", "Request body is empty.");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (declaredDigest !== undefined && declaredDigest !== sha256) {
    throw new BrainPackTransferError(400, "ADMIN_CONTENT_HASH_MISMATCH", "The body does not match the declared SHA-256.");
  }
  const now = (dependencies.now ?? (() => new Date()))();
  const record = await dependencies.artifacts.put(
    {
      kind: "upload",
      ownerAccountId: session.accountId,
      bytes,
      expiresAt: new Date(now.getTime() + uploadRetentionMs).toISOString(),
    },
    request.signal,
  );
  return json(200, {
    artifactId: record.id,
    sha256: record.sha256,
    byteSize: record.byteSize,
    expiresAt: record.expiresAt,
  });
}

async function handleDownload(
  request: Request,
  runId: string,
  session: ResolvedAdminSession,
  dependencies: BrainPackTransferDependencies,
): Promise<Response> {
  if (request.method !== "GET") {
    throw new AdminHttpSecurityError(405, "ADMIN_METHOD_DENIED", "Brain Pack downloads require GET.");
  }
  if (!uuidPattern.test(runId)) {
    throw new BrainPackTransferError(404, "NOT_FOUND", "Not found.");
  }
  const resolved = await dependencies.resolveExportArtifact(runId, session.principal, request.signal);
  if (resolved === null) {
    throw new BrainPackTransferError(404, "NOT_FOUND", "Not found.");
  }
  const administrative = session.role === "admin" || session.role === "owner";
  if (resolved.record.ownerAccountId !== session.accountId && !administrative) {
    throw new BrainPackTransferError(403, "ADMIN_ACCESS_DENIED", "Forbidden.");
  }
  const now = (dependencies.now ?? (() => new Date()))();
  if (resolved.record.expiresAt <= now.toISOString()) {
    throw new BrainPackTransferError(410, "ADMIN_ARTIFACT_EXPIRED", "This export is no longer available.");
  }
  return new Response(resolved.bytes, {
    status: 200,
    headers: {
      ...apiSecurityHeaders,
      "content-type": "application/zip",
      "content-length": String(resolved.bytes.byteLength),
      "content-disposition": `attachment; filename="${safeFileName(resolved.packId, resolved.packRevision)}"`,
    },
  });
}

/**
 * The two routes that move archive bytes. Authentication happened before this
 * point; every failure is thrown so the caller records it like any other
 * admin request outcome.
 */
export function handleBrainPackTransfer(
  request: Request,
  match: BrainPackTransferMatch,
  session: ResolvedAdminSession,
  dependencies: BrainPackTransferDependencies,
  trustedOrigin: string,
): Promise<Response> {
  return match.kind === "upload"
    ? handleUpload(request, session, dependencies, trustedOrigin)
    : handleDownload(request, match.runId, session, dependencies);
}
