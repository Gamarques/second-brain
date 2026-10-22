import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import type { BrainAnswer } from "../lib/workspace-types";
import { AskPanel } from "./ask-panel";

const id = "00000000-0000-4000-8000-000000000002";
const answer: BrainAnswer = {
  answer: "Alex leads design.",
  answerable: true,
  retrievedAt: "2026-09-05T00:00:00Z",
  evidenceCount: 1,
  citations: [{ index: 1, sourceType: "person", id, title: "Alex", excerpt: "Design lead.", projectId: id, knowledgeBaseId: null, documentId: null, revisionId: null }],
};

function renderPanel(path: string) {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LocaleProvider>
        <MemoryRouter initialEntries={[path]}>
          <AskPanel onClose={onClose} open />
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("AskPanel", () => {
  beforeEach(() => {
    localStorage.setItem(localeStorageKey, "en");
  });

  it("asks within the open project by default and can widen to the whole brain", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "project").mockResolvedValue({
      result: { project: { id, name: "Product review", description: null, status: "active", version: 1 }, counts: { tasks: 0, goals: 0, decisions: 0, people: 0, documents: 0, memories: 0 } },
    });
    const ask = vi.spyOn(api, "askBrain").mockResolvedValue(answer);
    renderPanel(`/projects/${id}`);

    expect(await screen.findByRole("tab", { name: "Product review" })).toHaveAttribute("aria-selected", "true");
    await user.type(screen.getByRole("textbox"), "Who leads design?{Enter}");
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ question: "Who leads design?", projectId: id }), expect.anything());
    expect(await screen.findByText("Alex leads design.")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Whole brain" }));
    await user.type(screen.getByRole("textbox"), "And overall?{Enter}");
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ question: "And overall?", projectId: null }), expect.anything()));
  });

  it("answers from one document folder when opened inside it", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "knowledgeBases").mockResolvedValue({
      knowledgeBases: [{ id, name: "Product guides", description: null, provenance: { kind: "account", accountId: null, clientId: null, source: "test" }, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }],
    });
    const askFolder = vi.spyOn(api, "askKnowledge").mockResolvedValue({ answer: "Ship on Friday.", citations: [{ documentTitle: "Release plan", content: "We ship on Friday.", score: 0.9 }] });
    renderPanel(`/knowledge/${id}`);

    expect(await screen.findByRole("tab", { name: "Product guides" })).toHaveAttribute("aria-selected", "true");
    await user.type(screen.getByRole("textbox"), "When do we ship?{Enter}");
    expect(askFolder).toHaveBeenCalledWith(id, "When do we ship?");
    expect(await screen.findByText("Ship on Friday.")).toBeVisible();
  });

  it("closes with Escape and clears the conversation on request", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "askBrain").mockResolvedValue(answer);
    const { onClose } = renderPanel("/memories");

    await user.type(screen.getByRole("textbox"), "Hello?{Enter}");
    expect(await screen.findByText("Alex leads design.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear conversation" }));
    expect(screen.queryByText("Alex leads design.")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
