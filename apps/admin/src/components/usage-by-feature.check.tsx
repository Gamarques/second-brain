import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { UsageByFeature } from "./usage-by-feature";

function renderUsage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LocaleProvider>
        <MemoryRouter>
          <UsageByFeature />
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

const group = { model: "x/y", failures: 0, inputTokens: 1, outputTokens: 1, reportedCost: 0, costCoverage: 1, tokenCoverage: 1, averageDurationMs: 1 } as const;

describe("UsageByFeature", () => {
  beforeEach(() => {
    window.localStorage.setItem(localeStorageKey, "en");
  });

  it("sums requests per feature and orders the busiest first, at most four", async () => {
    vi.spyOn(api, "modelUsage").mockResolvedValue({
      since: "", observedAt: "", truncated: false, failures: [],
      groups: [
        { ...group, operation: "brain_ask", requests: 5 },
        { ...group, operation: "brain_ask", model: "z/w", requests: 7 },
        { ...group, operation: "embedding", requests: 30 },
        { ...group, operation: "dreaming", requests: 2 },
        { ...group, operation: "ingestion", requests: 3 },
        { ...group, operation: "verification", requests: 1 },
      ],
    });
    renderUsage();

    const meters = await screen.findAllByRole("meter");
    expect(meters.map((meter) => meter.getAttribute("aria-label"))).toEqual(["Search indexing", "Brain answers", "Learning", "Nightly review"]);
    expect(meters[1]).toHaveAttribute("aria-valuenow", "12");
    expect(screen.getByText("12 requests")).toBeVisible();
  });

  it("renders nothing when there is no usage or the request fails", async () => {
    vi.spyOn(api, "modelUsage").mockRejectedValue(new Error("nope"));
    const { container } = renderUsage();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
