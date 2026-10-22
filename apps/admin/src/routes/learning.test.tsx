import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import type { IngestionStatus, LearningDreaming, LearningItem } from "../lib/learning-types";
import { pendingSuggestionsQuery } from "../lib/learning-queries";
import { LearningDreamingPage, LearningIngestionPage, LearningPage } from "./learning";

const id = "00000000-0000-4000-8000-000000000002";
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(localeStorageKey, "en");
});
function show(kind: "dreaming" | "ingestion") {
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
        <MemoryRouter initialEntries={[`/learning/${kind}/${id}`]}>
          <Routes>
            <Route
              path="/learning/dreaming/:changeId"
              element={<LearningDreamingPage />}
            />
            <Route
              path="/learning/ingestion/:runId"
              element={<LearningIngestionPage />}
            />
          </Routes>
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}
it("keeps the inbox rendering after Home and the sidebar have already cached the pending suggestions", async () => {
  vi.spyOn(api, "learningList").mockResolvedValue({
    items: [{ id: "c1", kind: "dreaming", status: "awaiting_review", title: "Status updates should go out before 9am.", summary: "", createdAt: "2026-09-05T00:00:00Z" } as never],
    nextCursor: null,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.fetchQuery(pendingSuggestionsQuery());

  render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <MemoryRouter initialEntries={["/learning"]}>
          <Routes>
            <Route element={<LearningPage />} path="/learning" />
          </Routes>
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Status updates should go out before 9am.")).toBeVisible();
});

it("shows stored evidence and confirms a Dreaming approval before making any change", async () => {
  const user = userEvent.setup();
  const item: LearningDreaming = {
    changeId: id,
    runId: id,
    localDate: "2026-09-04",
    fingerprint: "a".repeat(64),
    proposal: {
      operation: "create",
      content: "The review is on Friday.",
      category: null,
      tags: [],
      sourceQuotes: ["The review is on Friday."],
    },
    target: null,
    evidence: [
      {
        id,
        type: "activity",
        entityId: id,
        excerpt: "The review is on Friday.",
        effectiveAt: "2026-09-04T00:00:00Z",
        redacted: false,
      },
    ],
    blockedReason: null,
    receipt: null,
  };
  vi.spyOn(api, "learningDreaming").mockImplementation(async () => ({
    result: item,
  }));
  const approve = vi
    .spyOn(api, "reviewDreaming")
    .mockImplementation(async () => {
      item.receipt = {
        changeId: id,
        decision: "accept",
        resultMemoryId: id,
        reviewedAt: "2026-09-05T00:00:00Z",
      };
      return item.receipt;
    });
  show("dreaming");
  expect(await screen.findByText("Source evidence")).toBeVisible();
  expect(screen.getAllByText("The review is on Friday.")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Approve" }));
  expect(approve).not.toHaveBeenCalled();
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }),
  );
  expect(await screen.findByText("Approved")).toBeVisible();
  expect(approve).toHaveBeenCalledWith(
    expect.objectContaining({
      changeId: id,
      fingerprint: "a".repeat(64),
      decision: "accept",
    }),
  );
});
it("requires an explicit choice for every imported suggestion and applies only after saving and confirming", async () => {
  const user = userEvent.setup();
  const data: IngestionStatus = {
    run: {
      id,
      status: "awaiting_review",
      proposalDigest: "a".repeat(64),
      reviewedDigest: null,
      proposalModel: "test",
    },
    proposals: [
      {
        id,
        payload: {
          kind: "reminder",
          message: "Bring the review notes",
          remindAt: "2026-09-06T12:00:00Z",
        },
        confidence: 0.9,
        sourceQuote: "Bring the review notes on Sunday.",
      },
    ],
    review: null,
    receipts: [],
  };
  vi.spyOn(api, "ingestionStatus").mockImplementation(async () => ({
    result: structuredClone(data),
  }));
  const save = vi
    .spyOn(api, "reviewIngestion")
    .mockImplementation(async (input) => {
      data.review = { reviewDigest: "b".repeat(64), items: input.items };
      data.run.status = "reviewed";
      return data.review;
    });
  const commit = vi
    .spyOn(api, "commitIngestion")
    .mockImplementation(async () => {
      data.run.status = "completed";
      data.receipts = [
        {
          proposalId: id,
          entityId: id,
          entityType: "reminder",
          status: "committed",
          reason: null,
        },
      ];
      return { run: data.run, receipts: data.receipts };
    });
  show("ingestion");
  expect(
    await screen.findByRole("button", { name: "Save review" }),
  ).toBeDisabled();
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Choose a decision" }),
    "accept",
  );
  await user.click(screen.getByRole("button", { name: "Save review" }));
  expect(
    await screen.findByRole("button", { name: "Apply approved suggestions" }),
  ).toBeEnabled();
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      items: [{ proposalId: id, decision: "accept" }],
    }),
  );
  expect(commit).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Apply approved suggestions" }),
  );
  expect(commit).not.toHaveBeenCalled();
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Apply approved suggestions",
    }),
  );
  expect((await screen.findAllByText("Applied"))[0]).toBeVisible();
  expect(commit).toHaveBeenCalledWith(
    expect.objectContaining({ reviewedDigest: "b".repeat(64) }),
  );
});

function showInbox() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LocaleProvider>
        <MemoryRouter initialEntries={["/learning"]}>
          <Routes>
            <Route element={<LearningPage />} path="/learning" />
          </Routes>
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );
  return { user };
}
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
function inboxItem(overrides: Partial<LearningItem> & { id: string }): LearningItem {
  return { kind: "dreaming", title: `Item ${overrides.id}`, status: "policy_denied", count: 1, createdAt: hoursAgo(1), ...overrides };
}

it("keeps pending rows quiet: the title is the link, Review is the action, and the expected status and single counts stay out", async () => {
  const list = vi.spyOn(api, "learningList").mockImplementation(async (input) => ({
    items:
      input.status !== "pending"
        ? []
        : input.kind === "dreaming"
          ? [
              inboxItem({ id: "c1", title: "Status updates should go out before 9am." }),
              inboxItem({ id: "c2", kind: "ingestion", status: "awaiting_review", count: 3, title: "Three at once" }),
              inboxItem({ id: "c3", kind: "ingestion", status: "reviewed", title: "Saved but not applied" }),
            ]
          : [inboxItem({ id: "i1", kind: "ingestion", status: "awaiting_review" })],
    nextCursor: null,
  }));
  const { user } = showInbox();

  expect(await screen.findByRole("link", { name: "Status updates should go out before 9am." })).toHaveAttribute("href", "/learning/dreaming/c1");
  expect(screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/learning/"))).toHaveLength(3);
  expect(screen.getAllByText("Review")).toHaveLength(3);
  expect(screen.queryByText("Review suggestions")).not.toBeInTheDocument();
  expect(screen.queryByText("Awaiting review")).not.toBeInTheDocument();
  expect(screen.queryByText("1 suggestion")).not.toBeInTheDocument();
  expect(screen.getByText("3 suggestions")).toBeVisible();
  expect(screen.getByText("Review saved")).toBeVisible();
  expect(screen.getByRole("tab", { name: "Nightly suggestions" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Imported learning" })).toHaveAttribute("aria-selected", "false");
  expect(await screen.findByText("4 pending")).toBeVisible();
  expect(screen.getByRole("button", { name: "Pending 3" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-pressed", "false");

  await user.click(screen.getByRole("button", { name: "History" }));

  expect(await screen.findByText("No suggestions in this view")).toBeVisible();
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ kind: "dreaming", status: "history" }), expect.anything());
  expect(screen.getByRole("button", { name: "Pending 3" })).toHaveAttribute("aria-pressed", "false");
});

it("groups the inbox into this week and earlier, folds a long earlier group, and keeps the newest first", async () => {
  const week = [inboxItem({ id: "w1", createdAt: hoursAgo(2) }), inboxItem({ id: "w2", createdAt: hoursAgo(70) })];
  const earlier = Array.from({ length: 6 }, (_, index) => inboxItem({ id: `e${index}`, createdAt: hoursAgo((10 + index) * 24) }));
  vi.spyOn(api, "learningList").mockImplementation(async (input) => ({
    items: input.kind === "dreaming" && input.status === "pending" ? [...week, ...earlier] : [],
    nextCursor: null,
  }));
  const { user } = showInbox();

  expect(await screen.findByText("This week")).toBeVisible();
  expect(screen.getByText("This week").closest("details")).toHaveAttribute("open");
  expect(screen.getByText("Earlier").closest("details")).not.toHaveAttribute("open");
  expect(screen.getByRole("link", { name: "Item w1" })).toBeVisible();
  expect(screen.getByRole("link", { hidden: true, name: "Item e0" })).not.toBeVisible();
  expect(screen.getAllByRole("link", { hidden: true, name: /^Item / }).map((link) => link.textContent)).toEqual([
    "Item w1",
    "Item w2",
    ...earlier.map((item) => item.title),
  ]);

  await user.click(screen.getByText("Earlier"));

  expect(screen.getByRole("link", { name: "Item e0" })).toBeVisible();
});
