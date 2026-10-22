import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { UsagePage } from "./usage";

beforeEach(() => {
  localStorage.clear(); localStorage.setItem(localeStorageKey, "en");
  vi.spyOn(api, "modelUsage").mockResolvedValue({ since: "2026-08-04T00:00:00Z", observedAt: "2026-09-04T00:00:00Z", truncated: false, failures: [], groups: [
    { operation: "dreaming", model: "test/model", requests: 2, failures: 0, inputTokens: 100, outputTokens: 30, reportedCost: 8, costCoverage: 1, tokenCoverage: 1, averageDurationMs: 500 },
  ] });
});
it("labels incomplete costs and warns about the browser budget independently of model filters", async () => {
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LocaleProvider><UsagePage /></LocaleProvider></QueryClientProvider>);
  expect(await screen.findByText("Some requests have no reported cost. The displayed total is partial.")).toBeVisible();
  await user.type(screen.getByLabelText("30-day spending notice (USD)"), "10");
  expect(screen.getByText("At least 80% of your 30-day spending notice has been reached.")).toBeVisible();
  await user.type(screen.getByLabelText("Model"), "absent");
  expect(screen.getByText("At least 80% of your 30-day spending notice has been reached.")).toBeVisible();
  expect(screen.getByText("No requests in this selection")).toBeVisible();
  expect(screen.getByText("No requests in this selection").previousElementSibling).toHaveAttribute("data-illustration");
});
