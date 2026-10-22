import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import calibrationPrompt from "../content/agent-resources/knowledge-calibration.md?raw";
import mcpPrompt from "../content/agent-resources/mcp-instructions.md?raw";
import mcpSkill from "../content/agent-resources/second-brain-mcp/SKILL.md?raw";
import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { AgentResourcesPage } from "./agent-resources";

function renderPage() {
  render(<LocaleProvider><MemoryRouter><AgentResourcesPage /></MemoryRouter></LocaleProvider>);
}

const downloads = [
  { title: "MCP skill", filename: "SKILL.md", content: mcpSkill },
  { title: "MCP instructions prompt", filename: "second-brain-mcp-prompt.md", content: mcpPrompt },
  { title: "Knowledge calibration prompt", filename: "second-brain-knowledge-calibration.md", content: calibrationPrompt },
];

describe("agent resources", () => {
  beforeEach(() => window.localStorage.setItem(localeStorageKey, "en"));
  afterEach(() => {
    window.localStorage.removeItem(localeStorageKey);
    vi.restoreAllMocks();
  });

  it.each(downloads)("downloads, copies and previews the complete $title from the same source", async ({ title, filename, content }) => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderPage();

    const link = screen.getByRole("link", { name: `Download ${title}` });
    expect(link).toHaveAttribute("download", filename);
    const href = link.getAttribute("href")!;
    expect(href).toMatch(/^data:text\/markdown;charset=utf-8,/);
    expect(decodeURIComponent(href.slice(href.indexOf(",") + 1))).toBe(content);

    await user.click(screen.getByRole("button", { name: `Copy ${title}` }));
    expect(writeText).toHaveBeenCalledWith(content);

    await user.click(screen.getByText(`Preview ${title}`));
    const preview = screen.getByRole("region", { name: title });
    expect(preview).toBeVisible();
    expect(preview).toHaveAttribute("tabindex", "0");
    expect(preview.textContent).toBe(content);
  });

  it.each([
    { locale: "en", title: "Skills & prompts", download: "Download Knowledge calibration prompt" },
    { locale: "pt-BR", title: "Skills e prompts", download: "Baixar Prompt de nivelamento" },
    { locale: "es", title: "Skills y prompts", download: "Descargar Prompt de nivelación" },
  ])("offers the downloads in $locale while preserving the English files", ({ locale, title, download }) => {
    window.localStorage.setItem(localeStorageKey, locale);
    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const link = screen.getByRole("link", { name: download });
    const href = link.getAttribute("href")!;
    expect(decodeURIComponent(href.slice(href.indexOf(",") + 1))).toBe(calibrationPrompt);
    expect(document.querySelectorAll("a[download]")).toHaveLength(3);
  });

  it("links to connection setup before using the materials", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "Connect your AI" })).toHaveAttribute("href", "/connect");
  });
});
