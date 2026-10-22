import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/ui/toast";
import { api } from "../lib/api";
import { LocaleProvider } from "../lib/i18n";
import { localeStorageKey } from "../lib/i18n/locale";
import { KnowledgePage } from "./knowledge";

const provenance = {
  kind: "account" as const,
  accountId: "00000000-0000-4000-8000-000000000001",
  clientId: null,
  source: "admin",
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <ToastProvider>
          <MemoryRouter>
            <KnowledgePage />
          </MemoryRouter>
        </ToastProvider>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe("KnowledgePage", () => {
  beforeEach(() => {
    window.localStorage.setItem(localeStorageKey, "en");
    vi.spyOn(api, "knowledgeBases").mockResolvedValue({
      knowledgeBases: [
        {
          id: "base-product",
          name: "Product guides",
          description: "Current product documentation.",
          documentCount: 12,
          provenance,
          createdAt: "2026-08-01T12:00:00.000Z",
          updatedAt: "2026-08-24T12:00:00.000Z",
        },
        {
          id: "base-meetings",
          name: "Meeting notes",
          description: null,
          documentCount: 4,
          provenance,
          createdAt: "2026-08-02T12:00:00.000Z",
          updatedAt: "2026-08-25T12:00:00.000Z",
        },
      ],
    });
  });

  it("offers import and export to an owner as links to their own pages", async () => {
    vi.spyOn(api, "me").mockResolvedValue({ accountId: "owner", email: "owner@example.test", role: "owner", connectedClientCount: 0 });
    renderPage();

    expect(await screen.findByRole("link", { name: "Import Brain Pack" })).toHaveAttribute("href", "/knowledge/packs/import");
    expect(screen.getByRole("link", { name: "Export Brain Pack" })).toHaveAttribute("href", "/knowledge/packs/export");
  });

  it("renders document folders as accessible rows instead of cards", async () => {
    renderPage();

    const list = await screen.findByRole("list", { name: "Document folders" });
    const rows = within(list).getAllByRole("listitem");

    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("heading", { name: "Product guides" })).toBeVisible();
    expect(within(rows[0]!).getByText("12 documents")).toBeVisible();
    expect(within(rows[0]!).getByRole("link", { name: "Product guides" })).toHaveAttribute("href", "/knowledge/base-product");
    expect(within(list).queryByRole("link", { name: /Open folder/i })).toBeNull();
    expect(within(rows[1]!).getByText("No description yet.")).toBeVisible();
  });
});
