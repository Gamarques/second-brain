import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/ui/toast";
import { api } from "../lib/api";
import type { AutomationJob, AutomationSettings } from "../lib/api-types";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { DreamingPage } from "./dreaming";

const settings: AutomationSettings = {
  timeZone: "America/Sao_Paulo",
  reminderDeliveryEnabled: false, dreamingEnabled: true,
  dreamLocalTime: "02:00",
  nextDreamAt: "2026-08-26T05:00:00.000Z",
  dreamingMode: "preview",
  dailyInputTokenLimit: 10_000,
  dailyOutputTokenLimit: 2_000,
  revision: 3,
  updatedAt: "2026-08-25T12:00:00.000Z",
};

const completedJob: AutomationJob = {
  id: "00000000-0000-4000-8000-000000000101",
  kind: "daily_dreaming",
  canonicalKey: "daily-dreaming:2026-08-24",
  scheduledFor: "2026-08-25T05:00:00.000Z",
  status: "completed",
  attemptCount: 1,
  nextAttemptAt: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  cancelRequestedAt: null,
  sanitizedError: null,
  createdAt: "2026-08-25T05:00:00.000Z",
  updatedAt: "2026-08-25T05:01:00.000Z",
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <LocaleProvider>
          <ToastProvider>
            <DreamingPage />
          </ToastProvider>
        </LocaleProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("DreamingPage", () => {
  beforeEach(() => {
    window.localStorage.setItem(localeStorageKey, "en");
    vi.spyOn(api, "automationSettings").mockResolvedValue(settings);
    vi.spyOn(api, "jobs").mockResolvedValue({ items: [completedJob], nextCursor: null });
    vi.spyOn(api, "enqueueDreaming").mockResolvedValue({ job: completedJob, created: true });
    vi.spyOn(api, "config").mockResolvedValue({ revision: 2, restartRequired: false, entries: [] });
  });

  it("leads with one immediate review action and keeps the optional date hidden", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("button", { name: "Review yesterday" })).toBeVisible();
    expect(screen.getByText("Practice run — your memories will not change.")).toBeVisible();
    expect(screen.queryByLabelText("Day to review")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Choose another day" }));

    expect(screen.getByLabelText("Day to review")).toBeVisible();
  });

  it("summarizes the automatic review before revealing editable settings", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("Automatic review is on")).toBeVisible();
    expect(screen.queryByLabelText("Local time")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Daily input limit")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change automatic review" }));

    expect(screen.getByLabelText("Local time")).toBeVisible();
    expect(screen.getByLabelText("Time zone")).toHaveValue("America/Sao_Paulo");
    expect(screen.queryByLabelText("Daily input limit")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save schedule" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Advanced settings" }));

    expect(screen.getByLabelText("Daily input limit")).toBeVisible();
  });

  it("shows the saved schedule zone and links directly to the dreaming model", async () => {
    renderPage();
    expect(await screen.findByText("Every day at 02:00 (America/Sao_Paulo)")).toBeVisible();
    expect(screen.getByRole("link", { name: "Configure model and API key" })).toHaveAttribute("href", "/configuration/environment?focus=dreaming");
  });

  it("shows the saved model together with unapplied configuration changes", async () => {
    vi.mocked(api.config).mockResolvedValue({ revision: 4, restartRequired: true, entries: [{
      name: "OPENROUTER_DREAMING_MODEL", category: "models", description: "Daily review model.",
      isSet: true, isSecret: false, editable: true, source: "database", restartTargets: ["automation-worker"],
      maskedValue: "provider/saved-model", stagedValue: null, validationError: null,
    }] });
    renderPage();
    expect(await screen.findByText("Model saved in this panel: provider/saved-model")).toBeVisible();
    expect(screen.getByText("Saved changes need to be applied")).toBeVisible();
  });

  it("keeps model lookup failures visible without claiming a server default", async () => {
    vi.mocked(api.config).mockRejectedValue(new Error("Configuration lookup failed."));
    renderPage();
    expect(await screen.findByText("Configuration lookup failed.")).toBeVisible();
    expect(screen.queryByText("Server default selected. This panel does not report the server’s model name.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review yesterday" })).toBeVisible();
  });

  it.each(["pending", "running", "retry_wait"] as const)("reports the existing %s review as active", async (status) => {
    vi.mocked(api.enqueueDreaming).mockResolvedValue({ job: { ...completedJob, status }, created: false });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Review yesterday" }));
    expect(await screen.findByText(/Follow the existing review in Recent reviews/)).toBeVisible();
  });

  it("explains provider failures without requiring technical details to be opened", async () => {
    vi.mocked(api.jobs).mockResolvedValue({ items: [{ ...completedJob, status: "failed", sanitizedError: "DREAMING_PROVIDER_FAILED" }], nextCursor: null });
    renderPage();

    const recent = await screen.findByRole("region", { name: "Recent reviews" });
    expect(await within(recent).findByText("The AI provider could not complete this review.")).toBeVisible();
    expect(within(recent).getByRole("link", { name: "Review model settings" })).toHaveAttribute("href", "/configuration/environment?focus=dreaming");
  });

  it.each(["failed", "completed", "canceled"] as const)("reports an existing %s review without claiming it was queued", async (status) => {
    vi.mocked(api.enqueueDreaming).mockResolvedValue({ job: { ...completedJob, status }, created: false });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Review yesterday" }));

    expect(await screen.findByText("A review already exists for this day")).toBeVisible();
    expect(screen.getByText(/No new review was queued/)).toBeVisible();
    expect(screen.queryByText("A review is already waiting")).not.toBeInTheDocument();
  });

  it("names the selected day on the submit action and sends that day", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Choose another day" }));
    await user.type(screen.getByLabelText("Day to review"), "2026-08-23");
    await user.click(screen.getByRole("button", { name: "Review 2026-08-23" }));
    expect(api.enqueueDreaming).toHaveBeenCalledWith(expect.objectContaining({ localDate: "2026-08-23" }));
  });

  it("does not start a review while automatic review is off", async () => {
    vi.mocked(api.automationSettings).mockResolvedValue({ ...settings, reminderDeliveryEnabled: false, dreamingEnabled: false, nextDreamAt: null });
    renderPage();

    expect(await screen.findByText("Turn on automatic review first")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review yesterday" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save schedule" })).toBeDisabled();
  });

  it("requires unsaved schedule changes to be saved before reviewing", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Change automatic review" }));

    await user.clear(screen.getByLabelText("Local time"));
    await user.type(screen.getByLabelText("Local time"), "03:00");

    expect(screen.getByText("Save your changes first")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review yesterday" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save schedule" })).toBeEnabled();
  });

  it("keeps job identifiers and retry information behind review details", async () => {
    const user = userEvent.setup();
    renderPage();

    const recent = await screen.findByRole("region", { name: "Recent reviews" });
    expect(within(recent).getByText("Completed")).toBeVisible();
    expect(within(recent).queryByText("daily-dreaming:2026-08-24")).not.toBeInTheDocument();

    await user.click(within(recent).getByRole("button", { name: "Show details" }));

    expect(within(recent).getByText("daily-dreaming:2026-08-24")).toBeVisible();
    expect(within(recent).getByText("1 attempt")).toBeVisible();
  });

  it("shows one dot per recent review and does not repeat the recap label", async () => {
    renderPage();

    const recent = await screen.findByRole("region", { name: "Recent reviews" });
    const outcomes = within(recent).getByRole("list", { name: /last review/i });
    expect(within(outcomes).getAllByRole("listitem")).toHaveLength(1);
    expect(within(recent).queryByText("Nightly recap")).not.toBeInTheDocument();
  });

  it("keeps the schedule, the model and the run in one card", async () => {
    renderPage();

    await screen.findByText("Automatic review is on");
    const cards = document.querySelectorAll(".rounded-xl.border.bg-card");
    const withSchedule = [...cards].filter((card) => card.textContent?.includes("Automatic review is on"));
    expect(withSchedule).toHaveLength(1);
    expect(withSchedule[0]).toHaveTextContent("Review yesterday");
    expect(withSchedule[0]).toHaveTextContent("Configure model and API key");
  });

  it("uses the same plain-language hierarchy in Brazilian Portuguese", async () => {
    window.localStorage.setItem(localeStorageKey, "pt-BR");
    renderPage();

    expect(await screen.findByRole("button", { name: "Revisar ontem" })).toBeVisible();
    expect(screen.getByText("Revisão automática ativada")).toBeVisible();
    expect(screen.getByRole("button", { name: "Alterar revisão automática" })).toBeVisible();
    expect(screen.queryByText(/job|worker|token|IANA/i)).not.toBeInTheDocument();
  });
});
