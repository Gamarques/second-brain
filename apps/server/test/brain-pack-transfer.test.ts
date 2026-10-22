import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { AdminAuditRecorder, AdminBoundaryAuditEvent } from "../src/services/admin/audit.js";
import { createAdminHttpHandler } from "../src/services/admin/http.js";
import type {
  BrainPackArtifactRecord,
  BrainPackArtifactStore,
} from "../src/services/admin/packs/artifacts.js";
import type { ResolvedExportArtifact } from "../src/services/admin/packs/transfer.js";

const origin = "https://brain.example.com";
const accountId = "00000000-0000-4000-8000-000000000001";
const otherAccountId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000010";
const now = new Date("2026-09-07T12:00:00.000Z");

function session(role: "admin" | "owner" = "owner") {
  return {
    accountId,
    email: "owner@example.test",
    role,
    connectedClientCount: 2,
    principal: { id: accountId },
    oauthClientId: "second-brain-admin" as const,
    scopes: ["admin:panel"],
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type MemoryArtifacts = BrainPackArtifactStore & {
  readonly records: Map<string, { record: BrainPackArtifactRecord; bytes: Uint8Array }>;
};

/** The in-memory stand-in for the engine-owned store, enough to prove the transport. */
function memoryArtifacts(): MemoryArtifacts {
  const records = new Map<string, { record: BrainPackArtifactRecord; bytes: Uint8Array }>();
  let next = 1;
  return {
    records,
    async put(input) {
      const id = `00000000-0000-4000-8000-0000000000${String(next).padStart(2, "0")}`;
      next += 1;
      const record: BrainPackArtifactRecord = {
        id,
        kind: input.kind,
        ownerAccountId: input.ownerAccountId,
        sha256: sha256(input.bytes),
        byteSize: input.bytes.byteLength,
        contentType: "application/zip",
        createdAt: now.toISOString(),
        expiresAt: input.expiresAt,
      };
      records.set(id, { record, bytes: input.bytes });
      return record;
    },
    async head(id) {
      return records.get(id)?.record ?? null;
    },
    async read(id) {
      return records.get(id) ?? null;
    },
    async remove(id) {
      return records.delete(id);
    },
    async expire(at) {
      let removed = 0;
      for (const [id, entry] of records) {
        if (entry.record.expiresAt <= at) {
          records.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

function upload(bytes: Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/admin/packs/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      origin,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: bytes,
    // Streaming request bodies need an explicit duplex mode in the fetch standard.
    ...(bytes instanceof ReadableStream ? { duplex: "half" as const } : {}),
  } as RequestInit);
}

function handler(options: {
  artifacts?: MemoryArtifacts;
  resolveExportArtifact?: (runId: string, principal: { id: string }, signal: AbortSignal) => Promise<ResolvedExportArtifact | null>;
  sessions?: { resolve(headers: Headers, signal: AbortSignal): Promise<ReturnType<typeof session>> };
  audit?: AdminAuditRecorder;
  maximumUploadBytes?: number;
} = {}) {
  const artifacts = options.artifacts ?? memoryArtifacts();
  return {
    artifacts,
    handle: createAdminHttpHandler({
      trustedOrigin: origin,
      sessions: options.sessions ?? { async resolve() { return session(); } },
      ...(options.audit ? { audit: options.audit } : {}),
      packs: {
        artifacts,
        resolveExportArtifact: options.resolveExportArtifact ?? (async () => null),
        now: () => now,
        ...(options.maximumUploadBytes === undefined ? {} : { maximumUploadBytes: options.maximumUploadBytes }),
      },
    }),
  };
}

describe("Brain Pack upload route", () => {
  it("stores an octet-stream body for the session's account and returns its receipt", async () => {
    const bytes = new TextEncoder().encode("PK not really a zip but bytes");
    const subject = handler();

    const response = await subject.handle(upload(bytes, { "x-content-sha256": sha256(bytes) }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { artifactId: string };
    expect(body).toEqual({
      artifactId: "00000000-0000-4000-8000-000000000001",
      sha256: sha256(bytes),
      byteSize: bytes.byteLength,
      expiresAt: "2026-09-08T12:00:00.000Z",
    });
    const stored = subject.artifacts.records.get(body.artifactId);
    expect(stored?.record).toMatchObject({ kind: "upload", ownerAccountId: accountId, contentType: "application/zip" });
    expect(Buffer.from(stored!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts a streamed body without a content length and stops reading past the cap", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024).fill(7);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const subject = handler({ maximumUploadBytes: 4096 });

    const response = await subject.handle(upload(stream));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "ADMIN_BODY_TOO_LARGE" });
    expect(pulled).toBeLessThan(16);
    expect(subject.artifacts.records.size).toBe(0);
  });

  it("rejects a declared length above the cap before reading the body", async () => {
    const subject = handler({ maximumUploadBytes: 8 });

    const response = await subject.handle(upload(new Uint8Array(16), { "content-length": "16" }));

    expect(response.status).toBe(413);
  });

  it("requires application/octet-stream on this route and keeps JSON mutations JSON-only", async () => {
    const subject = handler();

    const wrongType = await subject.handle(
      new Request(`${origin}/api/admin/packs/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
        body: "{}",
      }),
    );
    expect(wrongType.status).toBe(415);

    const jsonRouteWithBinary = await subject.handle(
      new Request(`${origin}/api/admin/memories`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", origin, "sec-fetch-site": "same-origin" },
        body: new Uint8Array(4),
      }),
    );
    expect(jsonRouteWithBinary.status).toBe(415);
  });

  it("denies cross-site and anonymous uploads and audits the outcome", async () => {
    const record = vi.fn(async (_event: AdminBoundaryAuditEvent, _signal: AbortSignal) => undefined);
    const crossSite = handler({ audit: { record } });
    const denied = await crossSite.handle(
      upload(new Uint8Array(4), { "sec-fetch-site": "cross-site" }),
    );
    expect(denied.status).toBe(403);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "request_outcome", outcome: "denied", errorCode: "ADMIN_FETCH_SITE_DENIED", method: "POST" }),
      expect.any(AbortSignal),
    );

    const anonymous = handler({
      sessions: {
        async resolve() {
          throw Object.assign(new Error("denied"), { code: "ADMIN_SESSION_DENIED" });
        },
      },
    });
    expect((await anonymous.handle(upload(new Uint8Array(4)))).status).toBe(401);
  });

  it("rejects a body whose hash does not match the declared digest, and an empty body", async () => {
    const subject = handler();

    const mismatch = await subject.handle(upload(new Uint8Array([1, 2, 3]), { "x-content-sha256": "0".repeat(64) }));
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({ error: "ADMIN_CONTENT_HASH_MISMATCH" });

    const empty = await subject.handle(upload(new Uint8Array(0)));
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({ error: "ADMIN_BODY_EMPTY" });
    expect(subject.artifacts.records.size).toBe(0);
  });

  it("returns 404 when the transfer routes are not configured", async () => {
    const handle = createAdminHttpHandler({ trustedOrigin: origin, sessions: { async resolve() { return session(); } } });

    expect((await handle(upload(new Uint8Array(4)))).status).toBe(404);
  });
});

describe("Brain Pack download route", () => {
  function exported(overrides: Partial<BrainPackArtifactRecord> = {}): ResolvedExportArtifact {
    const bytes = new TextEncoder().encode("archive-bytes");
    return {
      record: {
        id: "00000000-0000-4000-8000-000000000020",
        kind: "export",
        ownerAccountId: accountId,
        sha256: sha256(bytes),
        byteSize: bytes.byteLength,
        contentType: "application/zip",
        createdAt: "2026-09-07T11:00:00.000Z",
        expiresAt: "2026-09-14T11:00:00.000Z",
        ...overrides,
      },
      bytes,
      packId: "pack-abc",
      packRevision: 3,
    };
  }

  it("streams the archive with a download disposition, its length, and no caching", async () => {
    const resolve = vi.fn(async () => exported());
    const subject = handler({ resolveExportArtifact: resolve });

    const response = await subject.handle(new Request(`${origin}/api/admin/packs/exports/${runId}/download`));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-length")).toBe("13");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="pack-abc-r3.brainpack"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("archive-bytes");
    expect(resolve).toHaveBeenCalledWith(runId, { id: accountId }, expect.any(AbortSignal));
  });

  it("answers 410 once the export has expired and 404 when the run is unknown", async () => {
    const expired = handler({ resolveExportArtifact: async () => exported({ expiresAt: "2026-09-07T11:59:59.000Z" }) });
    const gone = await expired.handle(new Request(`${origin}/api/admin/packs/exports/${runId}/download`));
    expect(gone.status).toBe(410);
    await expect(gone.json()).resolves.toMatchObject({ error: "ADMIN_ARTIFACT_EXPIRED" });

    const unknown = handler();
    expect((await unknown.handle(new Request(`${origin}/api/admin/packs/exports/${runId}/download`))).status).toBe(404);
  });

  it("serves another account's export to an administrator and rejects malformed run IDs or methods", async () => {
    const foreign = async () => exported({ ownerAccountId: otherAccountId });
    const admin = handler({ resolveExportArtifact: foreign, sessions: { async resolve() { return session("admin"); } } });
    expect((await admin.handle(new Request(`${origin}/api/admin/packs/exports/${runId}/download`))).status).toBe(200);

    const subject = handler({ resolveExportArtifact: foreign });
    expect((await subject.handle(new Request(`${origin}/api/admin/packs/exports/not-a-uuid/download`))).status).toBe(404);
    expect(
      (
        await subject.handle(
          new Request(`${origin}/api/admin/packs/exports/${runId}/download`, {
            method: "POST",
            headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(405);
  });
});
