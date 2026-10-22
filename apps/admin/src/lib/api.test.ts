import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./oauth", () => ({
  getOAuthAccessToken: vi.fn(async () => "oauth-access-token"),
  refreshOAuthAccessToken: vi.fn(async () => "refreshed-access-token"),
}));

import { api, ApiError } from "./api";
import { refreshOAuthAccessToken } from "./oauth";

describe("admin API client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows every runtime affected by a staged engine configuration", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          revision: 4,
          restartRequired: true,
          variables: [
            {
              name: "OPENROUTER_ANSWER_MODEL",
              secret: false,
              configured: true,
              value: "provider/model",
              restartRequired: true,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(api.config()).resolves.toMatchObject({
      entries: [
        {
          restartTargets: ["engine", "admin", "automation-worker"],
        },
      ],
    });
  });

  it("sends the OAuth bearer token without cookie credentials or a CSRF header", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ accountId: "00000000-0000-4000-8000-000000000001", role: "owner" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ revision: 2, restartRequired: true, restartTargets: ["engine"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ revision: 2, targets: ["engine", "admin", "automation-worker"], requestedAt: "2026-08-23T12:00:00.000Z", replayed: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await api.me();
    await api.stageConfig({ expectedRevision: 1, changes: [{ name: "OPENROUTER_ANSWER_MODEL", value: "provider/model" }], idempotencyKey: "stage:one" });
    await api.restartConfigurationServices({ expectedRevision: 2, idempotencyKey: "restart:two" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/me",
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({ Authorization: "Bearer oauth-access-token" }),
      }),
    );
    const mutation = fetchMock.mock.calls.at(-2);
    expect(mutation?.[0]).toBe("/api/admin/config/staged");
    expect(mutation?.[1]).toEqual(expect.objectContaining({
      credentials: "omit",
      headers: expect.objectContaining({ Authorization: "Bearer oauth-access-token" }),
    }));
    expect(mutation?.[1]?.headers).not.toEqual(expect.objectContaining({ "x-second-brain-csrf": expect.anything() }));
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/admin/config/restart");
  });

  it("surfaces RFC 9457 conflict details without losing the status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ title: "Revision conflict", detail: "The settings changed elsewhere." }),
        { status: 409, headers: { "Content-Type": "application/problem+json" } },
      ),
    );

    await expect(api.automationSettings()).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      conflict: true,
      message: "The settings changed elsewhere.",
    } satisfies Partial<ApiError>);
  });

  it("identifies the rejected token and retries a 401 only once", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ title: "Unauthorized" }, { status: 401 }),
    );

    await expect(api.me()).rejects.toMatchObject({ status: 401 });

    expect(refreshOAuthAccessToken).toHaveBeenCalledWith("oauth-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer refreshed-access-token",
    }));
  });

  it("uploads a Brain Pack as raw bytes with its SHA-256 and the bearer token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ artifactId: "artifact-1", sha256: "abc", byteSize: 3, expiresAt: "2026-09-08T12:00:00.000Z" }),
    );
    const file = new File([new Uint8Array([1, 2, 3])], "team.brainpack", { type: "application/octet-stream" });

    await expect(api.uploadBrainPack(file)).resolves.toMatchObject({ artifactId: "artifact-1" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/packs/uploads");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer oauth-access-token",
      "Content-Type": "application/octet-stream",
      "X-Content-Sha256": "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    }));
    expect(init?.credentials).toBe("omit");
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("builds the download address for an export and fetches it as a named file", async () => {
    expect(api.brainPackDownloadUrl("00000000-0000-4000-8000-000000000010")).toBe(
      "/api/admin/packs/exports/00000000-0000-4000-8000-000000000010/download",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="pack-abc-r3.brainpack"' },
      }),
    );

    const download = await api.downloadBrainPack("00000000-0000-4000-8000-000000000010");

    expect(download.fileName).toBe("pack-abc-r3.brainpack");
    expect(download.blob.size).toBe(2);
    expect(download.blob.type).toBe("application/zip");
  });
});

describe("Brain Pack capabilities", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts each capability's input to its admin engine path", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await api.exportBrainPack({ selection: { knowledgeBaseIds: ["b1"], documentIds: [] }, metadata: { title: "Guides", description: null, publisherNamespace: "academy.example", publisherDisplayName: "Example", language: null }, packId: null, expectedPackRevision: null, idempotencyKey: "k1" });
    await api.brainPackExport("run-1");
    await api.importBrainPack({ artifactId: "art-1", idempotencyKey: "k2" });
    await api.brainPackImport({ runId: "run-2", cursor: null, limit: 100 });
    await api.reviewBrainPackImport({ runId: "run-2", expectedReviewVersion: 0, collections: [], items: [], projectId: null, tags: [], idempotencyKey: "k3" });
    await api.publishBrainPackImport({ runId: "run-2", reviewDigest: "a".repeat(64), idempotencyKey: "k4" });
    await api.brainPackRuns({ kind: null, status: null, cursor: null, limit: 50 });
    await api.cancelBrainPackRun({ runId: "run-2", idempotencyKey: "k5" });
    await api.retryBrainPackRun({ runId: "run-2", idempotencyKey: "k6" });

    const paths = fetchMock.mock.calls.map(([url]) => String(url));
    expect(paths).toEqual([
      "/api/admin/engine/knowledge-packs-export",
      "/api/admin/engine/knowledge-packs-export-get",
      "/api/admin/engine/knowledge-packs-import",
      "/api/admin/engine/knowledge-packs-import-get",
      "/api/admin/engine/knowledge-packs-import-review",
      "/api/admin/engine/knowledge-packs-import-publish",
      "/api/admin/engine/knowledge-packs-runs-list",
      "/api/admin/engine/knowledge-packs-runs-cancel",
      "/api/admin/engine/knowledge-packs-runs-retry",
    ]);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(secondBody).toEqual({ runId: "run-1" });
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit).method === "POST")).toBe(true);
  });
});
