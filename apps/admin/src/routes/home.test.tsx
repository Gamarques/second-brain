import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import type { Overview } from "../lib/api-types";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import type { BrainAnswer, BriefingSnapshot } from "../lib/workspace-types";
import { HomePage } from "./home";

const id = "00000000-0000-4000-8000-000000000002";

const overview: Overview = {
  settings: {
    timeZone: "UTC",
    dreamingEnabled: true,
    reminderDeliveryEnabled: false,
    dreamLocalTime: "03:00",
    nextDreamAt: "2026-09-06T03:00:00Z",
    dreamingMode: "preview",
    dailyInputTokenLimit: 1,
    dailyOutputTokenLimit: 1,
    revision: 1,
    updatedAt: "2026-09-05T00:00:00Z",
  },
  workerSummary: { healthy: 1, stale: 0, offline: 0 },
  jobSummary: { pending: 0, running: 0, failed: 0 },
  counts: { memories: 12, knowledgeBases: 1, knowledgeDocuments: 3 },
  latestReport: null,
  configuration: { pendingChanges: 0, restartRequired: false },
};

const emptyBriefing: BriefingSnapshot = {
  timeZone: "UTC",
  generatedAt: "2026-09-05T00:00:00Z",
  recentSince: "2026-09-04T00:00:00Z",
  insightsSince: "2026-08-05T00:00:00Z",
  truncated: false,
  recent: [],
  dueTasks: [],
  dueReminders: [],
  insights: [],
};

const result: BrainAnswer = {
  answer: "The review is on Friday [1].",
  answerable: true,
  retrievedAt: "2026-09-05T00:00:00Z",
  evidenceCount: 1,
  citations: [
    {
      index: 1,
      sourceType: "knowledge_chunk",
      id,
      title: "Review schedule",
      excerpt: "The review is on Friday.",
      projectId: null,
      knowledgeBaseId: id,
      documentId: id,
      revisionId: id,
    },
  ],
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(localeStorageKey, "en");
  vi.spyOn(api, "overview").mockResolvedValue(structuredClone(overview));
  vi.spyOn(api, "briefing").mockResolvedValue(structuredClone(emptyBriefing));
  vi.spyOn(api, "learningList").mockResolvedValue({ items: [], nextCursor: null });
});

function show(path = "/") {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <LocaleProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<HomePage />} path="/" />
          </Routes>
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

it("answers from the home question box and cancels a stale request", async () => {
  const user = userEvent.setup();
  let resolveFirst!: (answer: BrainAnswer) => void;
  const ask = vi
    .spyOn(api, "askBrain")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValue(result);
  show();
  await user.type(screen.getByLabelText("What would you like to know?"), "First question");
  await user.click(screen.getByRole("button", { name: "Ask" }));
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(ask.mock.calls[0]![1]?.aborted).toBe(true);
  await user.clear(screen.getByLabelText("What would you like to know?"));
  await user.type(screen.getByLabelText("What would you like to know?"), "When is the review?");
  await user.click(screen.getByRole("button", { name: "Ask" }));
  expect(await screen.findByText(result.answer)).toBeVisible();
  expect(screen.getByRole("link", { name: "Open document" })).toHaveAttribute("href", `/knowledge/${id}/documents/${id}`);
  await act(async () => {
    resolveFirst({ ...result, answer: "Obsolete answer [1]." });
  });
  expect(screen.queryByText("Obsolete answer [1].")).not.toBeInTheDocument();
  expect(screen.getByText(result.answer)).toBeVisible();
});

it("scopes the question to a project from the query string", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "project").mockResolvedValue({
    result: { project: { id, name: "Product review", description: null, status: "active", version: 1 }, counts: { tasks: 0, goals: 0, decisions: 0, people: 0, documents: 0, memories: 0 } },
  });
  const ask = vi.spyOn(api, "askBrain").mockResolvedValue(result);
  show(`/?project=${id}`);
  expect(await screen.findByText("Searching within: Product review")).toBeVisible();
  await user.type(screen.getByLabelText("What would you like to know?"), "Status?");
  await user.click(screen.getByRole("button", { name: "Ask" }));
  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ projectId: id }), expect.anything());
});

it("turns a nightly insight into a task only after explicit confirmation with the chosen destination", async () => {
  const user = userEvent.setup();
  const snapshot: BriefingSnapshot = {
    ...emptyBriefing,
    insights: [
      {
        reportId: id,
        runId: id,
        index: 0,
        digest: "a".repeat(64),
        kind: "open_loop",
        statement: "Prepare the product review",
        confidence: "high",
        localDate: "2026-09-04",
        evidence: [{ type: "activity", id, excerpt: "The review needs preparation." }],
        actions: [],
      },
    ],
  };
  vi.mocked(api.briefing).mockImplementation(async () => structuredClone(snapshot));
  vi.spyOn(api, "taskLists").mockResolvedValue({ taskLists: [{ id, name: "Product work" }] });
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [], nextCursor: null });
  const action = vi.spyOn(api, "actOnBriefing").mockImplementation(async () => {
    const saved = { id, kind: "task" as const, entityId: id };
    snapshot.insights[0]!.actions = [saved];
    return saved;
  });
  show();
  await user.click(await screen.findByRole("button", { name: "Create task" }));
  expect(action).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Create task" });
  expect(await within(dialog).findByRole("option", { name: "Product work" })).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
  expect(await screen.findByRole("button", { name: "Task created" })).toBeDisabled();
  expect(action).toHaveBeenCalledWith(
    expect.objectContaining({ reportId: id, insightIndex: 0, expectedDigest: "a".repeat(64), kind: "task", text: "Prepare the product review", listId: id }),
  );
});

it("prefills the question box from an insight", async () => {
  const user = userEvent.setup();
  vi.mocked(api.briefing).mockResolvedValue({
    ...emptyBriefing,
    insights: [
      {
        reportId: id,
        runId: id,
        index: 0,
        digest: "a".repeat(64),
        kind: "contradiction",
        statement: "Status updates are daily in one note and weekly in another",
        confidence: "medium",
        localDate: "2026-09-04",
        evidence: [],
        actions: [],
      },
    ],
  });
  show();
  await user.click(await screen.findByRole("button", { name: "Ask about this" }));
  expect(screen.getByLabelText("What would you like to know?")).toHaveValue("Status updates are daily in one note and weekly in another");
});

it("invites the founder to turn on the nightly review and counts pending suggestions", async () => {
  vi.mocked(api.overview).mockResolvedValue({ ...structuredClone(overview), settings: { ...overview.settings, dreamingEnabled: false } });
  vi.mocked(api.learningList).mockResolvedValue({
    items: [
      { id: "s1", kind: "dreaming", title: "One", status: "awaiting_review", count: 1, createdAt: "2026-09-05T00:00:00Z" },
      { id: "s2", kind: "dreaming", title: "Two", status: "awaiting_review", count: 1, createdAt: "2026-09-05T00:00:00Z" },
    ],
    nextCursor: null,
  });
  show();
  expect(await screen.findByText("Turn on the nightly review")).toBeVisible();
  expect(screen.getByRole("link", { name: /Set the schedule/ })).toHaveAttribute("href", "/automation/dreaming");
  expect(await screen.findByText("2 memory suggestions are waiting for your approval")).toBeVisible();
  expect(screen.getByRole("link", { name: /Review suggestions/ })).toHaveAttribute("href", "/learning");
  expect(screen.getByRole("link", { name: /Open brain map/ })).toHaveAttribute("href", "/brain-map");
});

it("suggests questions that fit the brain's real state and shows how much the whole brain holds", async () => {
  vi.spyOn(api, "briefing").mockResolvedValue({
    ...structuredClone(emptyBriefing),
    dueReminders: [{ id: "r1", message: "Call the accountant", remindAt: "2026-09-01T09:00:00Z", version: 1 }],
  });
  show();

  expect(await screen.findByRole("button", { name: "What am I late on?" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "What is due this week?" })).not.toBeInTheDocument();
  expect(await screen.findByText("Whole brain · 12 memories")).toBeVisible();
});

it("falls back to the general suggestions when nothing is due", async () => {
  show();

  expect(await screen.findByRole("button", { name: "What is due this week?" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "What am I late on?" })).not.toBeInTheDocument();
});
