import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/ui/toast";
import { api } from "../lib/api";
import { LocaleProvider } from "../lib/i18n";
import { MemoriesPage } from "./memories";

const memory = {
  id: "00000000-0000-4000-8000-000000000010",
  lineageId: "00000000-0000-4000-8000-000000000011",
  version: 2,
  supersedesId: "00000000-0000-4000-8000-000000000012",
  content: "Prefers concise status updates with the decision shown first.",
  category: "communication",
  tags: ["preference", "updates"],
  projectId: null,
  personIds: [],
  effectiveAt: "2026-08-24T12:00:00.000Z",
  capturedAt: "2026-08-24T12:00:00.000Z",
  supersededBy: null,
  supersededAt: null,
  provenance: { kind: "account" as const, accountId: "account-1", clientId: null, source: "admin" },
  sourceExcerpt: null,
  contentHash: "hash-2",
  createdAt: "2026-08-24T12:00:00.000Z",
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <ToastProvider>
          <MemoryRouter>
            <MemoriesPage />
          </MemoryRouter>
        </ToastProvider>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe("MemoriesPage", () => {
  beforeEach(() => {
    vi.spyOn(api, "memories").mockResolvedValue({ memories: [], nextCursor: null });
  });

  it("renders a compact search toolbar and memory rows", async () => {
    vi.mocked(api.memories).mockResolvedValue({ memories: [memory], nextCursor: null });
    renderPage();

    expect(screen.getByRole("search").closest(".rounded-xl")).toBeNull();
    const list = await screen.findByRole("list", { name: "Memories" });
    const row = within(list).getByRole("listitem");

    expect(row).toHaveClass("py-3");
    expect(within(row).getByText(memory.content)).toBeVisible();
    expect(within(row).getByRole("button", { name: "Update" })).toBeVisible();
  });

  it("shows at most one pill per row, and only for the exception", async () => {
    vi.mocked(api.memories).mockResolvedValue({
      memories: [memory, { ...memory, id: "memory-old", lineageId: "lineage-old", version: 1, content: "Prefers long updates.", supersededBy: memory.id, supersededAt: memory.createdAt }],
      nextCursor: null,
    });
    renderPage();

    const list = await screen.findByRole("list", { name: "Memories" });
    const [current, older] = within(list).getAllByRole("listitem");
    expect(within(current!).queryByText("Current")).toBeNull();
    expect(within(current!).queryByText("communication")).toBeVisible();
    expect(within(current!).getByText("#preference #updates")).toBeVisible();
    expect(within(older!).getByText("Older version")).toBeVisible();
  });

  it("hides pagination until there is a next page", async () => {
    vi.mocked(api.memories).mockResolvedValue({ memories: [memory], nextCursor: null });
    const first = renderPage();
    await screen.findByRole("list", { name: "Memories" });
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    expect(screen.queryByText(/memor(y|ies) shown/)).toBeNull();
    first.unmount();

    vi.mocked(api.memories).mockResolvedValue({ memories: [memory], nextCursor: "page-2" });
    renderPage();
    await screen.findByRole("list", { name: "Memories" });
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("names the AI that saved a memory when the client says who it is", async () => {
    vi.mocked(api.memories).mockResolvedValue({
      memories: [{ ...memory, provenance: { kind: "oauth_client", accountId: "account-1", clientId: "claude-desktop", source: "Claude Desktop" } }],
      nextCursor: null,
    });
    renderPage();

    const list = await screen.findByRole("list", { name: "Memories" });
    expect(within(list).getByText("Saved by Claude")).toBeVisible();
  });

  it("opens memory creation from the primary page action", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Remember this" }));

    expect(screen.getByRole("dialog", { name: "Remember this" })).toBeVisible();
    expect(screen.getByLabelText("What should it remember?")).toBeVisible();
  });

  it("shows who saved each memory without opening the details", async () => {
    vi.mocked(api.memories).mockResolvedValue({
      memories: [memory, { ...memory, id: "memory-2", lineageId: "lineage-2", content: "Weekly summaries first.", provenance: { kind: "oauth_client", accountId: "account-1", clientId: "client-1", source: "mcp_http" } }],
      nextCursor: null,
    });
    renderPage();

    const list = await screen.findByRole("list", { name: "Memories" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(within(first!).getByText("Saved by you")).toBeVisible();
    expect(within(second!).getByText("Saved by your AI")).toBeVisible();
  });

  it("teaches the phrase to say to a connected AI when the brain is still empty", async () => {
    renderPage();

    expect(await screen.findByText("Say this to your connected AI")).toBeVisible();
    expect(screen.getByText("Remember that I prefer weekly summaries with decisions first.")).toBeVisible();
    expect(screen.getByRole("button", { name: /Copy example/ })).toBeVisible();
    expect(screen.getByRole("link", { name: "Connect your AI" })).toHaveAttribute("href", "/connect");
  });
});
