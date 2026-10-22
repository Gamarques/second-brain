import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import { LocaleProvider } from "../lib/i18n";
import { ConnectPage } from "./connect";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <MemoryRouter><ConnectPage /></MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe("ConnectPage", () => {
  it("links to the skill and prompts after connection setup", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "Skills & prompts" })).toHaveAttribute("href", "/agent-resources");
  });

  it("shows this brain's address derived from the current origin", () => {
    renderPage();

    expect(screen.getByText(`${window.location.origin}/mcp`)).toBeVisible();
  });

  it("copies the address when its copy button is used", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderPage();

    await user.click(screen.getByRole("button", { name: /Copy .*brain address/i }));

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/mcp`);
  });

  it("leads with Claude Code on a computer-only origin", () => {
    renderPage();

    expect(screen.getByText(`claude mcp add --transport http second-brain ${window.location.origin}/mcp`)).toBeVisible();
    expect(screen.queryByText(/turn on Developer mode/)).not.toBeInTheDocument();
  });

  it("switches apps through the tabs", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("tab", { name: "Codex" }));

    expect(screen.getByText(`codex mcp add second-brain --url ${window.location.origin}/mcp`)).toBeVisible();
    expect(screen.getByText("codex mcp login second-brain")).toBeVisible();
    expect(screen.queryByText(/claude mcp add/)).not.toBeInTheDocument();
  });

  it("reveals the Codex config.toml block only once its disclosure is opened", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "Codex" }));

    const toml = `[mcp_servers.second-brain]\nurl = "${window.location.origin}/mcp"`;
    const findToml = () => screen.getByText((_, element) => element?.tagName === "CODE" && element.textContent === toml);
    expect(findToml()).not.toBeVisible();

    await user.click(screen.getByText("Prefer editing the config file directly?"));

    expect(findToml()).toBeVisible();
  });

  it("gives Claude click-by-click remote connector steps without an invalid settings-file fallback", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "Claude" }));

    expect(screen.getByText("Open Claude Settings, then Connectors.")).toBeVisible();
    expect(screen.getByText("Choose Add custom connector.")).toBeVisible();
    expect(screen.queryByText(/settings file/i)).not.toBeInTheDocument();
    expect(screen.queryByText((_, element) => element?.tagName === "CODE" && (element.textContent ?? "").includes("mcpServers"))).not.toBeInTheDocument();
  });

  it("shows step-by-step, config-free instructions for ChatGPT", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "ChatGPT" }));

    expect(screen.getByText(/turn on Developer mode/)).toBeVisible();
    expect(screen.getByText(/Paste the address shown below into the server URL field/)).toBeVisible();
    expect(screen.queryByText(/MCP Server URL/)).not.toBeInTheDocument();
  });

  it("links to Replit's own install flow with only the display name and server URL encoded", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "Replit" }));

    const link = screen.getByRole("link", { name: /Add to Replit/ });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("https://replit.com/integrations?mcp=")).toBe(true);
    const payload = JSON.parse(atob(decodeURIComponent(href.slice("https://replit.com/integrations?mcp=".length))));
    expect(payload).toEqual({ displayName: "second-brain", baseUrl: `${window.location.origin}/mcp` });
  });

  it("warns that this computer-only address cannot reach ChatGPT or Claude on the web", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByText(/local-only address/i)).toBeVisible();
    expect(screen.queryByText(/isn’t reachable from the internet/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "ChatGPT" }));
    expect(screen.getByText(/isn’t reachable from the internet/)).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Claude" }));
    expect(screen.getByText(/isn’t reachable from the internet/)).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(screen.queryByText(/isn’t reachable from the internet/)).not.toBeInTheDocument();
    expect(screen.getByText(/local-only address/i)).toBeVisible();
  });

  it("never renders a token, bearer, or secret value on the page", async () => {
    const user = userEvent.setup();
    renderPage();
    for (const name of ["Claude Code", "Claude", "Codex", "ChatGPT", "Replit"]) {
      await user.click(screen.getByRole("tab", { name }));
    }

    expect(document.body.textContent?.toLowerCase()).not.toMatch(/\bbearer [a-z0-9]|token: |secret: /);
  });

  it("keeps the connection standard behind a how-this-works disclosure", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByText("How this connection works"));
    await user.click(screen.getByRole("button", { name: /How does this work\?/i }));

    expect(screen.getByRole("dialog", { name: "How your AI connects" })).toBeVisible();
  });
});

describe("ConnectPage flow", () => {
  it("marks every app in the picker so it is recognisable at a glance", () => {
    renderPage();

    for (const name of ["Claude Code", "Claude", "Codex", "ChatGPT", "Replit"]) {
      expect(screen.getByRole("tab", { name }).querySelector("svg[data-mark]")).not.toBeNull();
    }
  });

  it("reports connected apps as a quiet line under the title, not an alert", async () => {
    vi.spyOn(api, "me").mockResolvedValue({ accountId: "a", email: "a@example.test", role: "owner", connectedClientCount: 2 });
    renderPage();

    const line = await screen.findByText("2 apps connected");
    expect(line).toBeVisible();
    expect(line.closest("[role='status'], [role='alert']")).toBeNull();
    expect(screen.queryByText("Your AI is connected")).not.toBeInTheDocument();
  });

  it("walks through the steps in order and keeps the sign-in explanation behind how-this-works", () => {
    renderPage();

    const steps = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(steps).toEqual(["Pick your app", "This brain’s address", "Set it up in Claude Code", "Sign in when the browser opens", "Try it"]);
    expect(screen.getByText(/no token to copy/).closest("details")).not.toBeNull();
    expect(screen.getAllByText(/no token to copy/)).toHaveLength(1);
  });

  it("offers the two test messages as chat bubbles with their own copy buttons", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "Copy remember test message" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy recall test message" })).toBeVisible();
    expect(screen.queryByRole("region", { name: /Remember a preference/ })).not.toBeInTheDocument();
  });
});

describe("ConnectPage copyable blocks", () => {
  it("gives each code block an accessible name instead of repeating the card heading", async () => {
    renderPage();

    expect(screen.getByRole("tab", { name: "Claude Code" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Claude Code" })).toBeVisible();
  });

  it("keeps a long code block reachable by keyboard when it scrolls", async () => {
    renderPage();

    expect(screen.getByRole("region", { name: "Claude Code" })).toHaveAttribute("tabindex", "0");
  });
});
