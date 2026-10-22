import { describe, expect, it, vi } from "vitest";

import type { BrainAccessContext, BrainPackRunRecord } from "@second-brain/engine/domain";
import { BrainAccessDeniedError } from "@second-brain/engine/database/stores/access-store";
import { createExportArtifactResolver } from "../src/services/admin/packs/resolve.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000010";
const artifactId = "00000000-0000-4000-8000-000000000020";
const signal = new AbortController().signal;

const access: BrainAccessContext = {
  accountId,
  role: "owner",
  actor: {
    kind: "account",
    accountId,
    clientId: null,
    source: "direct",
    requestId: "r",
    correlationId: null,
    causationId: null,
    dreamingRunId: null,
  },
};

function run(overrides: Partial<BrainPackRunRecord> = {}): BrainPackRunRecord {
  return {
    id: runId,
    kind: "export",
    status: "completed",
    ownerAccountId: accountId,
    pack: {
      id: "local-pack",
      externalPackId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60",
      publisher: { namespace: "acme", displayName: "Acme" },
      owned: true,
    },
    packRevision: { id: "rev", number: 3, title: "Pack", manifestSha256: "a".repeat(64) },
    artifactId,
    jobId: null,
    idempotencyKey: "k",
    requestDigest: "b".repeat(64),
    reviewVersion: 0,
    reviewDigest: null,
    review: null,
    exportSelection: null,
    progress: null,
    receipt: null,
    sanitizedError: null,
    cancelRequestedAt: null,
    createdAt: "2026-09-07T12:00:00.000Z",
    updatedAt: "2026-09-07T12:00:00.000Z",
    completedAt: "2026-09-07T12:00:00.000Z",
    ...overrides,
  };
}

const record = {
  id: artifactId,
  kind: "export" as const,
  ownerAccountId: accountId,
  sha256: "c".repeat(64),
  byteSize: 3,
  contentType: "application/zip" as const,
  createdAt: "2026-09-07T12:00:00.000Z",
  expiresAt: "2026-09-14T12:00:00.000Z",
};

function resolver(overrides: { run?: BrainPackRunRecord | null; denied?: boolean; artifact?: boolean } = {}) {
  const resolveAccess = vi.fn(async () => {
    if (overrides.denied) throw new BrainAccessDeniedError();
    return access;
  });
  const getRun = vi.fn(async () => (overrides.run === undefined ? run() : overrides.run));
  const read = vi.fn(async () => (overrides.artifact === false ? null : { record, bytes: new Uint8Array([1, 2, 3]) }));
  return {
    resolve: createExportArtifactResolver({ access: { resolveAccess }, packs: { getRun }, artifacts: { read } }),
    resolveAccess,
    getRun,
    read,
  };
}

describe("createExportArtifactResolver", () => {
  it("resolves the archive of a visible export run with its pack identity", async () => {
    const { resolve, resolveAccess, getRun } = resolver();

    await expect(resolve(runId, { id: accountId }, signal)).resolves.toEqual({
      record,
      bytes: new Uint8Array([1, 2, 3]),
      packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60",
      packRevision: 3,
    });
    expect(resolveAccess).toHaveBeenCalledWith(
      expect.objectContaining({ principal: { id: accountId }, requiredRole: "admin", source: "direct", correlationId: null }),
      signal,
    );
    expect(getRun).toHaveBeenCalledWith(access, runId, signal);
  });

  it("answers null for a denied principal, an unknown run, an import run, or a missing archive", async () => {
    await expect(resolver({ denied: true }).resolve(runId, { id: accountId }, signal)).resolves.toBeNull();
    await expect(resolver({ run: null }).resolve(runId, { id: accountId }, signal)).resolves.toBeNull();
    await expect(resolver({ run: run({ kind: "import" }) }).resolve(runId, { id: accountId }, signal)).resolves.toBeNull();
    await expect(resolver({ run: run({ artifactId: null }) }).resolve(runId, { id: accountId }, signal)).resolves.toBeNull();
    await expect(resolver({ artifact: false }).resolve(runId, { id: accountId }, signal)).resolves.toBeNull();
  });
});
