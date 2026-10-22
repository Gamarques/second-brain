import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/ui/toast";
import { api, ApiError } from "../lib/api";
import type { BrainPackImportRun, BrainPackRunStatus, BrainPackRunSummary } from "../lib/brain-pack-types";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { BrainPackImportRunPage, BrainPackImportStartPage, BrainPacksPage } from "./brain-packs";

const publisher = { namespace: "academy.example", displayName: "Example" };
const packId = "00000000-0000-4000-8000-000000000100";

function summary(status: BrainPackRunStatus, overrides: Partial<BrainPackRunSummary> = {}): BrainPackRunSummary {
  return {
    id: "run-1",
    kind: "import",
    status,
    packId,
    packRevision: 3,
    publisher,
    title: "Product guides",
    artifactId: "art-1",
    reviewVersion: 0,
    reviewDigest: null,
    progress: null,
    sanitizedError: null,
    createdAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function importRun(status: BrainPackRunStatus, overrides: Partial<BrainPackImportRun> = {}): BrainPackImportRun {
  const withPreview = status !== "uploaded" && status !== "validating" && status !== "failed";
  return {
    run: summary(status),
    preview: withPreview
      ? {
          packId,
          packRevision: 3,
          publisher,
          title: "Product guides",
          description: "Onboarding guides and release notes.",
          language: "en",
          createdAt: "2026-09-06T10:00:00.000Z",
          manifestSha256: "b".repeat(64),
          collections: [{ key: "guides", name: "Guides", description: null, documentCount: 2 }],
          counts: { collections: 1, documents: 2, new: 1, updated: 0, unchanged: 0, conflicting: 1, invalid: 0 },
          volume: { expandedBytes: 20_480, documentCharacters: 18_000, estimatedChunks: 16 },
          samples: [{ itemKey: "getting-started", title: "Getting started", excerpt: "Install the CLI and sign in." }],
        }
      : null,
    items: {
      items: withPreview
        ? [
            { itemKey: "getting-started", collectionKey: "guides", title: "Getting started", classification: "new", decision: null, expectedLocalRevision: null, localDocumentId: null, localRevision: null, result: null, resultDocumentId: null, resultRevisionId: null, sanitizedError: null },
            { itemKey: "release-notes", collectionKey: "guides", title: "Release notes", classification: "conflicting", decision: null, expectedLocalRevision: null, localDocumentId: "doc-9", localRevision: 4, result: null, resultDocumentId: null, resultRevisionId: null, sanitizedError: null },
          ]
        : [],
      nextCursor: null,
    },
    receipt: null,
    ...overrides,
  };
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<BrainPacksPage />} path="/knowledge/packs" />
              <Route element={<BrainPackImportStartPage />} path="/knowledge/packs/import" />
              <Route element={<BrainPackImportRunPage />} path="/knowledge/packs/imports/:runId" />
              <Route element={<p>Documents page</p>} path="/knowledge" />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe("Brain Pack history", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.setItem(localeStorageKey, "en");
    vi.spyOn(api, "knowledgeBases").mockResolvedValue({ knowledgeBases: [] });
  });

  it("lists runs with a toned status, offering Cancel while active and Retry after a failure", async () => {
    vi.spyOn(api, "brainPackRuns").mockResolvedValue({
      items: [
        summary("indexing", { id: "run-a", progress: { stage: "indexing", processedItems: 3, totalItems: 12 } }),
        summary("failed", { id: "run-b", sanitizedError: "PACK_INTEGRITY_FAILED", reviewDigest: "d".repeat(64) }),
        summary("completed", { id: "run-c", kind: "export", completedAt: "2026-09-07T11:00:00.000Z" }),
        summary("failed", { id: "run-d", sanitizedError: "PACK_MANIFEST_INVALID", reviewDigest: null }),
      ],
      nextCursor: null,
    });
    const cancel = vi.spyOn(api, "cancelBrainPackRun").mockResolvedValue({ runId: "run-a", status: "indexing", canceled: false });
    const user = userEvent.setup();
    renderAt("/knowledge/packs");

    const list = await screen.findByRole("list", { name: "Brain Pack runs" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText("Indexing")).toBeVisible();
    expect(within(rows[0]!).getByText("3 of 12")).toBeVisible();
    expect(within(rows[1]!).getByText("Failed")).toBeVisible();
    expect(within(rows[1]!).getByRole("button", { name: "Retry" })).toBeVisible();
    expect(within(rows[2]!).getByRole("button", { name: "Download" })).toBeVisible();
    expect(within(rows[3]!).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(within(list).getAllByText("Example")).toHaveLength(4);

    await user.click(within(rows[0]!).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-a" })));
    expect(await screen.findByText("Cancellation requested. The run stops at its next step.")).toBeVisible();
  });

  it("names the active-import limit when a second import is started", async () => {
    vi.spyOn(api, "uploadBrainPack").mockResolvedValue({ artifactId: "art-1", sha256: "c".repeat(64), byteSize: 1024, expiresAt: "2026-09-08T10:00:00.000Z" });
    vi.spyOn(api, "importBrainPack").mockRejectedValue(new ApiError(409, { error: "PACK_LIMIT_EXCEEDED", message: "A Brain Pack size or active import limit was exceeded." }));
    const user = userEvent.setup();
    renderAt("/knowledge/packs/import");

    const input = await screen.findByLabelText(/pack/i);
    await user.upload(input, new File([new Uint8Array([80, 75, 3, 4])], "team.brainpack", { type: "application/zip" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Finish or cancel your active import before starting another.");
  });

  it("draws an empty state that points at both directions", async () => {
    vi.spyOn(api, "brainPackRuns").mockResolvedValue({ items: [], nextCursor: null });
    renderAt("/knowledge/packs");

    expect(await screen.findByText("No packs yet")).toBeVisible();
    expect(screen.getByRole("link", { name: "Import Brain Pack" })).toHaveAttribute("href", "/knowledge/packs/import");
    expect(document.querySelector("[data-illustration] svg")).not.toBeNull();
  });
});

describe("Brain Pack import", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.setItem(localeStorageKey, "en");
    vi.spyOn(api, "knowledgeBases").mockResolvedValue({
      knowledgeBases: [{ id: "base-1", name: "Guides", description: null, provenance: { kind: "account", accountId: null, clientId: null, source: "admin" }, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", documentCount: 3 }],
    });
  });

  it("uploads the file, starts the run and moves to its page", async () => {
    const upload = vi.spyOn(api, "uploadBrainPack").mockResolvedValue({ artifactId: "art-1", sha256: "c".repeat(64), byteSize: 1024, expiresAt: "2026-09-08T10:00:00.000Z" });
    const start = vi.spyOn(api, "importBrainPack").mockResolvedValue({ runId: "run-1", status: "validating" });
    vi.spyOn(api, "brainPackImport").mockResolvedValue(importRun("validating"));
    const user = userEvent.setup();
    renderAt("/knowledge/packs/import");

    const file = new File([new Uint8Array([80, 75, 3, 4])], "guides-r3.brainpack", { type: "application/zip" });
    await user.upload(screen.getByLabelText("Choose a .brainpack file"), file);

    await waitFor(() => expect(upload).toHaveBeenCalledWith(file, expect.anything()));
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "art-1" })));
    expect(await screen.findByText("Checking entries, hashes and references. No AI is involved.")).toBeVisible();
  });

  it("refuses a file that is not a pack before uploading anything", async () => {
    const upload = vi.spyOn(api, "uploadBrainPack");
    // Browsers let people pick "All files" past the accept filter, so the page has to check the name itself.
    const user = userEvent.setup({ applyAccept: false });
    renderAt("/knowledge/packs/import");

    await user.upload(screen.getByLabelText("Choose a .brainpack file"), new File(["x"], "notes.txt", { type: "text/plain" }));

    expect(await screen.findByText("Choose a .brainpack file.")).toBeVisible();
    expect(upload).not.toHaveBeenCalled();
  });

  it("previews the pack, seeds destinations and decisions, then freezes the review with the expected revisions", async () => {
    vi.spyOn(api, "brainPackImport").mockResolvedValue(importRun("awaiting_review"));
    const review = vi.spyOn(api, "reviewBrainPackImport").mockResolvedValue({ runId: "run-1", reviewVersion: 1, reviewDigest: "d".repeat(64), status: "reviewed" });
    const user = userEvent.setup();
    renderAt("/knowledge/packs/imports/run-1");

    expect(await screen.findByRole("heading", { name: "Product guides" })).toBeVisible();
    expect(screen.getByText("Example")).toBeVisible();
    expect(screen.getByText("1 new")).toBeVisible();
    expect(screen.getByText("1 edited here too")).toBeVisible();
    expect(screen.getByLabelText("Destination for Guides")).toHaveValue("base-1");
    expect(screen.getByLabelText("Decision for Getting started")).toHaveValue("create");
    expect(screen.getByLabelText("Decision for Release notes")).toHaveValue("keep_local");
    expect(screen.getByText("Yours is revision 4")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("Decision for Release notes"), "update");
    await user.click(screen.getByRole("button", { name: "Freeze review" }));

    await waitFor(() => expect(review).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      expectedReviewVersion: 0,
      collections: [{ collectionKey: "guides", destination: { knowledgeBaseId: "base-1" } }],
      items: [
        { itemKey: "getting-started", decision: "create", expectedLocalRevision: null },
        { itemKey: "release-notes", decision: "update", expectedLocalRevision: 4 },
      ],
    })));
  });

  it("publishes a frozen review with its digest and shows progress with a cancel", async () => {
    vi.spyOn(api, "brainPackImport")
      .mockResolvedValueOnce(importRun("reviewed", { run: summary("reviewed", { reviewVersion: 1, reviewDigest: "d".repeat(64) }) }))
      .mockResolvedValue(importRun("indexing", { run: summary("indexing", { reviewVersion: 1, reviewDigest: "d".repeat(64), progress: { stage: "indexing", processedItems: 5, totalItems: 16 } }) }));
    const publish = vi.spyOn(api, "publishBrainPackImport").mockResolvedValue({ runId: "run-1", status: "indexing", jobId: "job-1" });
    const user = userEvent.setup();
    renderAt("/knowledge/packs/imports/run-1");

    await user.click(await screen.findByRole("button", { name: "Publish" }));

    await waitFor(() => expect(publish).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", reviewDigest: "d".repeat(64) })));
    expect(await screen.findByText("Indexing passages…")).toBeVisible();
    expect(screen.getByText("5 of 16")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel import" })).toBeVisible();
  });

  it("shows the receipt once published", async () => {
    vi.spyOn(api, "brainPackImport").mockResolvedValue(importRun("completed", {
      run: summary("completed", { completedAt: "2026-09-07T12:00:00.000Z" }),
      receipt: {
        runId: "run-1", packId, packRevision: 3, publishedAt: "2026-09-07T12:00:00.000Z",
        created: [{ itemKey: "getting-started", documentId: "doc-1", revisionId: "rev-1" }],
        updated: [{ itemKey: "release-notes", documentId: "doc-9", revisionId: "rev-9" }],
        skipped: [{ itemKey: "old", reason: "unchanged" }],
        excluded: [],
      },
    }));
    renderAt("/knowledge/packs/imports/run-1");

    expect(await screen.findByText("Published")).toBeVisible();
    expect(screen.getByText("1 created")).toBeVisible();
    expect(screen.getByText("1 updated")).toBeVisible();
    expect(screen.getByText("1 skipped")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Documents" })).toHaveAttribute("href", "/knowledge");
    expect(screen.getByRole("link", { name: "Calibrate my knowledge" })).toHaveAttribute("href", "/agent-resources");
  });

  it("explains a validation failure in plain words and offers to start over, not a retry", async () => {
    vi.spyOn(api, "brainPackImport").mockResolvedValue(importRun("failed", { run: summary("failed", { sanitizedError: "PACK_INTEGRITY_FAILED", reviewDigest: null }) }));
    renderAt("/knowledge/packs/imports/run-1");

    expect(await screen.findByText("The file does not match its own manifest. Ask the publisher to export it again.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start over" })).toHaveAttribute("href", "/knowledge/packs/import");
  });

  it("speaks Brazilian Portuguese on the history page", async () => {
    window.localStorage.setItem(localeStorageKey, "pt-BR");
    vi.spyOn(api, "brainPackRuns").mockResolvedValue({ items: [], nextCursor: null });
    renderAt("/knowledge/packs");

    expect(await screen.findByText("Nenhum pack ainda")).toBeVisible();
    expect(screen.getByRole("link", { name: "Importar Brain Pack" })).toBeVisible();
  });
});
