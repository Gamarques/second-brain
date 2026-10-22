import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/ui/toast";
import { api, ApiError } from "../lib/api";
import type { BrainPackExportResult } from "../lib/brain-pack-types";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { BrainPackExportPage } from "./brain-pack-export";

const provenance = { kind: "account" as const, accountId: "00000000-0000-4000-8000-000000000001", clientId: null, source: "admin" };
const packId = "00000000-0000-4000-8000-000000000100";

const result = (overrides: Partial<BrainPackExportResult> = {}): BrainPackExportResult => ({
  runId: "run-1",
  status: "completed",
  packId,
  packRevision: 1,
  artifactId: "art-1",
  receipt: { runId: "run-1", packId, packRevision: 1, artifactId: "art-1", sha256: "e".repeat(64), byteSize: 20_480, collectionCount: 1, documentCount: 12, frozenAt: "2026-09-07T12:00:00.000Z" },
  ...overrides,
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<BrainPackExportPage />} path="/knowledge/packs/export" />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe("BrainPackExportPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(localeStorageKey, "en");
    vi.spyOn(api, "me").mockResolvedValue({ accountId: "owner", email: "jane@example.academy", role: "owner", connectedClientCount: 0 });
    vi.spyOn(api, "knowledgeBases").mockResolvedValue({
      knowledgeBases: [
        { id: "base-product", name: "Product guides", description: "Guides.", documentCount: 12, provenance, createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" },
        { id: "base-meetings", name: "Meeting notes", description: null, documentCount: 4, provenance, createdAt: "2026-08-02T12:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z" },
      ],
    });
  });

  it("suggests the title and publisher, exports the selection, and remembers the publisher", async () => {
    const exportPack = vi.spyOn(api, "exportBrainPack").mockResolvedValue(result());
    const user = userEvent.setup();
    renderAt("/knowledge/packs/export");

    expect(await screen.findByRole("heading", { name: "Choose what to share" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Product guides" }));

    expect(screen.getByLabelText("Pack title")).toHaveValue("Product guides");
    const chooseStep = screen.getByRole("heading", { name: "Choose what to share" }).parentElement!;
    expect(within(chooseStep).getByText("1 folder")).toBeVisible();
    expect(within(chooseStep).getAllByText("12 documents")).toHaveLength(2);
    const publisher = screen.getByTestId("brain-pack-publisher");
    expect(within(publisher).getByText("Example")).toBeVisible();
    expect(within(publisher).getByText("academy.example")).toBeVisible();
    expect(within(publisher).getByText("English")).toBeVisible();
    const preview = screen.getByTestId("brain-pack-preview");
    expect(within(preview).getByText("Product guides")).toBeVisible();
    expect(within(preview).getByText("Revision 1")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(exportPack).toHaveBeenCalledWith(expect.objectContaining({
      selection: { knowledgeBaseIds: ["base-product"], documentIds: [] },
      metadata: { title: "Product guides", description: null, publisherNamespace: "academy.example", publisherDisplayName: "Example", language: "en" },
      packId: null,
      expectedPackRevision: null,
    })));
    expect(await screen.findByText("Pack ready")).toBeVisible();
    expect(screen.getByText(`${packId}-r1.brainpack`)).toBeVisible();
    expect(screen.getByText("20 KB")).toBeVisible();
    expect(screen.getByRole("button", { name: "Download .brainpack" })).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem("second-brain-admin.brain-pack-publisher") ?? "{}")).toEqual({ namespace: "academy.example", displayName: "Example", language: "en" });
  });

  it("starts from a remembered publisher and lets it be changed before exporting", async () => {
    window.localStorage.setItem("second-brain-admin.brain-pack-publisher", JSON.stringify({ namespace: "academy.example", displayName: "Example", language: "pt-BR" }));
    const exportPack = vi.spyOn(api, "exportBrainPack").mockResolvedValue(result());
    const user = userEvent.setup();
    renderAt("/knowledge/packs/export");

    await user.click(await screen.findByRole("checkbox", { name: "Meeting notes" }));
    await user.click(screen.getByText("Publisher and language"));
    await user.clear(screen.getByLabelText("Publisher name"));
    await user.type(screen.getByLabelText("Publisher name"), "Example Academy");
    await user.selectOptions(screen.getByLabelText("Language"), "es");
    await user.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(exportPack).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ title: "Meeting notes", publisherNamespace: "academy.example", publisherDisplayName: "Example Academy", language: "es" }),
    })));
  });

  it("explains the direct-export limit in plain words", async () => {
    vi.spyOn(api, "exportBrainPack").mockRejectedValue(new ApiError(422, { code: "PACK_LIMIT_EXCEEDED", detail: "Selection exceeds 200 documents." }));
    const user = userEvent.setup();
    renderAt("/knowledge/packs/export");

    await user.click(await screen.findByRole("checkbox", { name: "Product guides" }));
    await user.click(screen.getByRole("button", { name: "Export" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This selection is too large for a direct export.");
  });

  it("re-exports an owned pack with its next revision when opened from the history", async () => {
    const exportPack = vi.spyOn(api, "exportBrainPack").mockResolvedValue(result({ packRevision: 3, receipt: { ...result().receipt!, packRevision: 3 } }));
    const user = userEvent.setup();
    renderAt(`/knowledge/packs/export?packId=${packId}&revision=3&title=Guides`);

    await user.click(await screen.findByRole("checkbox", { name: "Product guides" }));
    expect(screen.getByLabelText("Pack title")).toHaveValue("Guides");
    expect(within(screen.getByTestId("brain-pack-preview")).getByText("Revision 3")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(exportPack).toHaveBeenCalledWith(expect.objectContaining({ packId, expectedPackRevision: 2 })));
    expect(await screen.findByText(`${packId}-r3.brainpack`)).toBeVisible();
  });
});
