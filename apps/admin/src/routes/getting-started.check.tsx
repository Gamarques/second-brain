import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { ConfigEntries, Overview } from "../lib/api-types";
import { LocaleProvider } from "../lib/i18n";
import { GettingStartedPage } from "./getting-started";

const overview: Overview = {
  settings: { timeZone: "UTC", reminderDeliveryEnabled: false, dreamingEnabled: true, dreamLocalTime: "03:00", nextDreamAt: "2026-08-25T03:00:00.000Z", dreamingMode: "preview", dailyInputTokenLimit: 1, dailyOutputTokenLimit: 1, revision: 1, updatedAt: "2026-08-24T00:00:00.000Z" },
  workerSummary: { healthy: 1, stale: 0, offline: 0 },
  jobSummary: { pending: 0, running: 0, failed: 0 },
  counts: { memories: 0, knowledgeBases: 0, knowledgeDocuments: 0 },
  latestReport: null,
  configuration: { pendingChanges: 0, restartRequired: false },
};

const configEntries: ConfigEntries = {
  revision: 1,
  restartRequired: false,
  entries: [{ name: "OPENROUTER_API_KEY", category: "models", description: "", isSet: true, isSecret: true, editable: true, source: "database", restartTargets: [], maskedValue: "••••", stagedValue: null, validationError: null }],
};

vi.mock("../lib/api", () => ({
  api: {
    overview: vi.fn(async () => overview),
    config: vi.fn(async () => configEntries),
    me: vi.fn(async () => ({ accountId: "account-1", email: "owner@example.test", role: "owner", connectedClientCount: 0 })),
  },
}));

function renderPage() {
  render(
    <LocaleProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <GettingStartedPage />
        </MemoryRouter>
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

describe("GettingStartedPage", () => {
  it("treats the AI key as the only required setup step", async () => {
    renderPage();

    const apiKeyStep = await screen.findByText("Add your AI key");
    const apiKeyRow = apiKeyStep.closest("div.rounded-xl") as HTMLElement;
    expect(within(apiKeyRow).getByText("Done")).toBeVisible();
    expect(screen.getByText("1 of 2 steps done")).toBeVisible();
  });

  it("makes connecting an app the payoff, not an optional aside", async () => {
    renderPage();

    const heading = await screen.findByText("Then: connect your AI");
    const connectCard = heading.closest("div.rounded-xl") as HTMLElement;
    expect(within(connectCard).getByRole("link", { name: /Connect your AI/ })).toHaveAttribute("href", "/connect");
    expect(within(connectCard).getByText("Not yet")).toBeVisible();
  });

  it("keeps memories optional so they never look like a blocker", async () => {
    renderPage();

    await screen.findByText("Later, if you want");
    const memoryRow = screen.getByText("Remember the first thing").closest("div.rounded-xl") as HTMLElement;
    expect(within(memoryRow).getByText("Not yet")).toBeVisible();
  });

  it("links each step straight to the screen that completes it", async () => {
    renderPage();

    await screen.findByText("Add your AI key");
    expect(screen.getByRole("link", { name: /Add it in Settings/ })).toHaveAttribute("href", "/configuration/environment");
    expect(screen.getByRole("link", { name: /Remember this/ })).toHaveAttribute("href", "/memories");
  });

  it("does not put a glossary on the setup path", async () => {
    renderPage();

    await screen.findByText("Add your AI key");
    expect(screen.queryByRole("button", { name: "Help" })).not.toBeInTheDocument();
    expect(screen.queryByText("Stuck on a word?")).not.toBeInTheDocument();
  });
});
