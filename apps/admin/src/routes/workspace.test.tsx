import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { ProjectPage } from "./projects";
const id = "00000000-0000-4000-8000-000000000002";
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(localeStorageKey, "en");
});
function show(path: string) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <LocaleProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectPage />} />
          </Routes>
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}
it("uses the stored task version and loads another project section on demand", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "project").mockResolvedValue({
    result: {
      project: {
        id,
        name: "Product review",
        description: null,
        status: "active",
        version: 1,
      },
      counts: {
        tasks: 1,
        goals: 0,
        decisions: 0,
        people: 0,
        documents: 1,
        memories: 0,
      },
    },
  });
  const section = vi
    .spyOn(api, "projectSection")
    .mockImplementation(async (input) => ({
      items: [
        {
          id,
          title: input.section === "tasks" ? "Prepare notes" : "Review guide",
          body: "Stored context",
          status: input.section === "tasks" ? "todo" : null,
          version: 4,
          date: null,
          priority: null,
          knowledgeBaseId: input.section === "documents" ? id : null,
          tags: [],
        },
      ],
      nextCursor: null,
    }));
  const update = vi.spyOn(api, "updateTask").mockResolvedValue({});
  show(`/projects/${id}`);
  await user.click(
    await screen.findByRole("button", { name: "Mark complete" }),
  );
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ id, expectedVersion: 4, status: "done" }),
  );
  await user.click(screen.getByRole("tab", { name: "Documents 1" }));
  expect(
    await screen.findByRole("link", { name: "Open document" }),
  ).toHaveAttribute("href", `/knowledge/${id}/documents/${id}`);
  expect(section.mock.calls.some(([input]) => input.section === "people")).toBe(
    false,
  );
});
