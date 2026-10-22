import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { DreamingCalendar } from "./dreaming-calendar";

beforeEach(() => {
  localStorage.setItem(localeStorageKey, "en");
  vi.spyOn(api, "dreamingCalendar").mockResolvedValue({ month: "2026-08", timeZone: "UTC", today: "2026-09-04", truncated: false, items: [
    { jobId: "failed-job", localDate: "2026-08-23", status: "failed", attemptCount: 5, runId: "failed-run", reportRunId: null, replayOfRunId: null, sourceJobId: null, mode: "preview", timeZone: "UTC", model: "test/model", sanitizedError: "DREAMING_PROVIDER_FAILED", createdAt: "2026-08-24T03:00:00Z", updatedAt: "2026-08-24T04:00:00Z", canRetry: true },
  ] });
  vi.spyOn(api, "retryDreaming").mockResolvedValue({ jobId: "replay-job", sourceJobId: "failed-job", created: true, mode: "preview" });
});
it("opens day history and explicitly confirms a preview replay without hiding the previous failure", async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LocaleProvider><DreamingCalendar timeZone="UTC" enabled /></LocaleProvider></QueryClientProvider></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Review month"), { target: { value: "2026-08" } });
  await user.click(await screen.findByRole("button", { name: /August 23.*Failed/i }));
  await user.click(screen.getByRole("button", { name: "Reprocess in preview" }));
  expect(api.retryDreaming).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toHaveTextContent("The original attempt and its effects remain in the history.");
  await user.click(screen.getByRole("button", { name: "Create preview replay" }));
  expect(api.retryDreaming).toHaveBeenCalledWith({ jobId: "failed-job", idempotencyKey: expect.any(String) });
  expect(await screen.findByText("Preview replay queued")).toBeVisible();
});

it("marks a failed day with a dot instead of a tinted cell", async () => {
  render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LocaleProvider><DreamingCalendar timeZone="UTC" enabled /></LocaleProvider></QueryClientProvider></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Review month"), { target: { value: "2026-08" } });

  const day = await screen.findByRole("button", { name: /August 23.*Failed/i });
  expect(day.className).not.toMatch(/bg-danger-surface|border-danger/);
  expect(day.querySelector('[data-status="failed"]')).not.toBeNull();
});
