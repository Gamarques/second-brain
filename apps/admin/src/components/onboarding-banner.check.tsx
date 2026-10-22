import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigEntries, Overview } from "../lib/api-types";
import { LocaleProvider } from "../lib/i18n";
import { OnboardingBanner } from "./onboarding-banner";

let overview: Overview;
let configEntries: ConfigEntries;
let connectedClientCount: number;

vi.mock("../lib/api", () => ({
  api: {
    overview: vi.fn(async () => overview),
    config: vi.fn(async () => configEntries),
    me: vi.fn(async () => ({ accountId: "account-1", email: "owner@example.test", role: "owner", connectedClientCount })),
  },
}));

function incompleteOverview(): Overview {
  return {
    settings: { timeZone: "UTC", reminderDeliveryEnabled: false, dreamingEnabled: false, dreamLocalTime: "03:00", nextDreamAt: null, dreamingMode: "preview", dailyInputTokenLimit: 1, dailyOutputTokenLimit: 1, revision: 1, updatedAt: "2026-08-24T00:00:00.000Z" },
    workerSummary: { healthy: 0, stale: 0, offline: 0 },
    jobSummary: { pending: 0, running: 0, failed: 0 },
    counts: { memories: 0, knowledgeBases: 0, knowledgeDocuments: 0 },
    latestReport: null,
    configuration: { pendingChanges: 0, restartRequired: false },
  };
}

function configWithApiKey(isSet: boolean): ConfigEntries {
  return {
    revision: 1,
    restartRequired: false,
    entries: [{ name: "OPENROUTER_API_KEY", category: "models", description: "", isSet, isSecret: true, editable: true, source: "database", restartTargets: [], maskedValue: null, stagedValue: null, validationError: null }],
  };
}

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <LocaleProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <OnboardingBanner />
        </MemoryRouter>
      </QueryClientProvider>
    </LocaleProvider>,
  );
  return { client };
}

describe("OnboardingBanner", () => {
  beforeEach(() => {
    overview = incompleteOverview();
    configEntries = configWithApiKey(false);
    connectedClientCount = 0;
  });

  it("points a founder at the AI key first", async () => {
    renderBanner();

    expect(await screen.findByText("Do this next")).toBeVisible();
    expect(screen.getByText("Add your AI key")).toBeVisible();
    expect(screen.getByRole("link", { name: /Add it in Settings/ })).toHaveAttribute("href", "/configuration/environment");
    expect(screen.getByRole("link", { name: /See all steps/ })).toHaveAttribute("href", "/getting-started");
  });

  it("points at Connect your AI once the key is in", async () => {
    configEntries = configWithApiKey(true);
    renderBanner();

    expect(await screen.findByText("Do this next")).toBeVisible();
    expect(screen.getByRole("link", { name: /Connect your AI/ })).toHaveAttribute("href", "/connect");
  });

  it("renders nothing once the key is in and an app has been authorized", async () => {
    connectedClientCount = 1;
    overview = incompleteOverview();
    configEntries = configWithApiKey(true);
    const { client } = renderBanner();

    await waitFor(() => expect(client.getQueryState(["overview"])?.status).toBe("success"));
    await waitFor(() => expect(client.getQueryState(["configuration", "en"])?.status).toBe("success"));
    expect(screen.queryByText("Do this next")).not.toBeInTheDocument();
  });
});
