import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/ui/toast";
import { api } from "../lib/api";
import type { ConfigEntries, ConfigEntry } from "../lib/api-types";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { ConfigurationPage } from "./configuration";

const keyEntry: ConfigEntry = {
  name: "OPENROUTER_API_KEY",
  category: "models",
  description: "The key Second Brain uses to talk to a model.",
  isSet: true,
  isSecret: true,
  editable: true,
  source: "database",
  restartTargets: ["engine", "admin", "automation-worker"],
  maskedValue: "••••••••",
  stagedValue: null,
  validationError: null,
};

const answerModelEntry: ConfigEntry = {
  name: "OPENROUTER_ANSWER_MODEL",
  category: "models",
  description: "Optional model setting.",
  isSet: true,
  isSecret: false,
  editable: true,
  source: "database",
  restartTargets: ["engine", "admin", "automation-worker"],
  maskedValue: "deepseek/deepseek-v4-flash",
  stagedValue: null,
  validationError: null,
};

function configuration(restartRequired = false): ConfigEntries {
  return {
    revision: 3,
    restartRequired,
    entries: [keyEntry, answerModelEntry, { ...answerModelEntry, name: "OPENROUTER_DREAMING_MODEL" }],
  };
}

function renderPage(path = "/configuration/environment") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <LocaleProvider>
          <ToastProvider>
            <ConfigurationPage />
          </ToastProvider>
        </LocaleProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("ConfigurationPage", () => {
  beforeEach(() => {
    window.localStorage.setItem(localeStorageKey, "en");
    vi.spyOn(api, "config").mockResolvedValue(configuration());
    vi.spyOn(api, "modelUsage").mockResolvedValue({
      since: "2026-08-31T00:00:00.000Z",
      observedAt: "2026-09-07T00:00:00.000Z",
      truncated: false,
      groups: [
        { operation: "brain_ask", model: "anthropic/claude-sonnet-4", requests: 40, failures: 0, inputTokens: 1, outputTokens: 1, reportedCost: 0.5, costCoverage: 1, tokenCoverage: 1, averageDurationMs: 100 },
        { operation: "embedding", model: "openai/text-embedding-3-small", requests: 300, failures: 0, inputTokens: 1, outputTokens: 0, reportedCost: 0.01, costCoverage: 1, tokenCoverage: 1, averageDurationMs: 10 },
      ],
      failures: [],
    });
    vi.spyOn(api, "stageConfig").mockResolvedValue({
      revision: 4,
      changedNames: ["OPENROUTER_API_KEY"],
      restartRequired: true,
      updatedAt: "2026-08-25T18:00:00.000Z",
      replayed: false,
    });
  });

  it("leads with one plain AI key form instead of a technical table", async () => {
    renderPage();

    expect(await screen.findByLabelText("OpenRouter API key")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("OPENROUTER_ANSWER_MODEL")).not.toBeInTheDocument();
  });

  it("says once that keys stay hidden, and shows last week's AI use as bars", async () => {
    renderPage();

    await screen.findByLabelText("OpenRouter API key");
    expect(screen.getAllByText(/never shown after saving/i)).toHaveLength(1);
    const meters = await screen.findAllByRole("meter");
    expect(meters).toHaveLength(2);
    expect(meters[0]).toHaveAccessibleName("Search indexing");
    expect(screen.getByRole("link", { name: "See details" })).toHaveAttribute("href", "/usage");
  });

  it("keeps technical settings behind one disclosure without repeating the AI key", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Advanced settings" }));

    const advanced = screen.getByRole("region", { name: "Advanced settings" });
    expect(within(advanced).getByText("OPENROUTER_ANSWER_MODEL")).toBeVisible();
    expect(within(advanced).getByLabelText("Answer model")).toBeVisible();
    expect(screen.getAllByLabelText("OpenRouter API key")).toHaveLength(1);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("exposes the saved dreaming model and focuses it from the review setup link", async () => {
    renderPage("/configuration/environment?focus=dreaming");

    const model = await screen.findByLabelText("Nightly review model");
    expect(model).toHaveValue("deepseek/deepseek-v4-flash");
    expect(model).toHaveFocus();
    expect(screen.getByRole("link", { name: "Check OpenRouter privacy requirements" })).toHaveAttribute("href", "https://openrouter.ai/docs/guides/features/zdr");
  });

  it("edits a saved model in place and discards the draft when restored", async () => {
    const user = userEvent.setup();
    renderPage();

    const model = await screen.findByLabelText("Nightly review model");
    await user.type(model, "-new");
    await user.click(screen.getByRole("button", { name: "Save change" }));
    expect(api.stageConfig).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{ name: "OPENROUTER_DREAMING_MODEL", value: "deepseek/deepseek-v4-flash-new" }],
    }));

    await user.clear(model);
    await user.type(model, "deepseek/deepseek-v4-flash");
    expect(screen.queryByRole("button", { name: "Save change" })).not.toBeInTheDocument();
  });

  it("makes restoring the server default explicit before saving", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Use server default" }));
    expect(screen.getByLabelText("Nightly review model")).toHaveValue("");
    expect(screen.getByText("This saved override will be cleared.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save change" }));
    expect(api.stageConfig).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{ name: "OPENROUTER_DREAMING_MODEL", value: null }],
    }));
  });

  it("prevents saving a blank model and offers an explicit reset from that draft", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.clear(await screen.findByLabelText("Nightly review model"));
    expect(screen.getByRole("button", { name: "Save change" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Use server default" }));
    expect(screen.getByRole("button", { name: "Save change" })).toBeEnabled();
  });

  it("puts the save action next to a clear unsaved-change summary", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText("OpenRouter API key"), "sk-or-new-key");
    const status = screen.getByRole("status", { name: "1 unsaved change" });
    await user.click(within(status).getByRole("button", { name: "Save change" }));

    expect(api.stageConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 3,
        changes: [{ name: "OPENROUTER_API_KEY", value: "sk-or-new-key" }],
      }),
    );
  });

  it("makes saved changes waiting for application the first action", async () => {
    vi.mocked(api.config).mockResolvedValue(configuration(true));
    const user = userEvent.setup();
    renderPage();

    const status = await screen.findByRole("status", { name: "Saved changes need to be applied" });
    await user.click(within(status).getByRole("button", { name: "Apply settings" }));

    expect(screen.getByRole("dialog", { name: "Apply settings now?" })).toBeVisible();
  });

  it("uses the same plain-language hierarchy in Brazilian Portuguese", async () => {
    window.localStorage.setItem(localeStorageKey, "pt-BR");
    renderPage();

    expect(await screen.findByLabelText("Chave de API do OpenRouter")).toBeVisible();
    expect(screen.getByRole("button", { name: "Ajustes avançados" })).toBeVisible();
    expect(screen.getByText("Chave personalizada salva")).toBeVisible();
    expect(screen.queryByText(/configuração da implantação/i)).not.toBeInTheDocument();
  });
});
