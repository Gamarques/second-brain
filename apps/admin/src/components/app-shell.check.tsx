import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import { LocaleProvider } from "../lib/i18n";
import { ThemeProvider } from "../lib/theme";
import { AppShell } from "./app-shell";

function renderShell({ welcomeDismissed = true }: { welcomeDismissed?: boolean } = {}) {
  if (welcomeDismissed) window.localStorage.setItem("second-brain-admin.welcome-dismissed", "true");
  const user = userEvent.setup();
  render(
    <LocaleProvider>
      <ThemeProvider>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route element={<AppShell identity={{ accountId: "account-1", email: "admin@example.test", role: "admin", connectedClientCount: 0 }} />} path="/">
                <Route element={<p>Routed content</p>} index />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </LocaleProvider>,
  );
  return { user };
}

describe("AppShell", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the primary navigation and the routed page", () => {
    renderShell();

    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Home" })[0]).toHaveAttribute("href", "/");
    expect(screen.getAllByRole("link", { name: "Brain map" })[0]).toHaveAttribute("href", "/brain-map");
    expect(screen.getAllByRole("link", { name: "Status" })[0]).toHaveAttribute("href", "/status");
    expect(screen.queryByText("One private brain")).not.toBeInTheDocument();
    expect(screen.getByText("Routed content")).toBeVisible();
  });

  it("gives every page the same container: one width on main, and no grid of its own", () => {
    renderShell();

    const main = screen.getByRole("main");
    expect(main).toHaveClass("max-w-6xl", "mx-auto", "w-full", "overflow-x-clip");
    expect(main.className).not.toMatch(/\bgap-|\bgrid\b/);
  });

  it("marks the current destination with the sunrise", () => {
    renderShell();

    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    const home = within(nav).getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("aria-current", "page");
    expect(home.querySelector("[data-nav-marker]")).toHaveClass("aurora");
    expect(within(nav).getByRole("link", { name: "Status" }).querySelector("[data-nav-marker]")).toBeNull();
  });

  it("keeps one search control: the header opens the palette and the sidebar carries no second one", async () => {
    const { user } = renderShell();

    expect(within(screen.getByRole("navigation", { name: "Primary navigation" })).queryByRole("button", { name: /Search/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Find a page/ }));

    expect(screen.getByRole("dialog", { name: "Find a page" })).toBeVisible();
  });

  it("keeps Advanced folded until it is opened, and remembers the choice", async () => {
    const { user } = renderShell();
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });

    expect(within(nav).queryByRole("link", { name: "Activity" })).not.toBeInTheDocument();
    await user.click(within(nav).getByRole("button", { name: "Advanced" }));

    expect(within(nav).getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/audit");
    expect(within(nav).getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
    expect(JSON.parse(window.localStorage.getItem("second-brain-admin.sidebar-sections") ?? "{}")).toEqual({ advanced: true });
  });

  it("counts what is waiting next to the destination that handles it", async () => {
    vi.spyOn(api, "learningList").mockResolvedValue({
      items: [
        { id: "c1", kind: "dreaming", status: "awaiting_review", title: "One", summary: "", createdAt: "2026-09-05T00:00:00Z" },
        { id: "c2", kind: "dreaming", status: "awaiting_review", title: "Two", summary: "", createdAt: "2026-09-05T00:00:00Z" },
      ] as never,
      nextCursor: null,
    });
    renderShell();

    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(await within(nav).findByRole("link", { name: "Review learning 2 suggestions to review" })).toHaveAttribute("href", "/learning");
  });

  it("keeps theme, language, and sign out behind the account button in the header", async () => {
    const { user } = renderShell();

    expect(screen.queryByRole("group", { name: "Color theme" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Account" }));

    const menu = screen.getByRole("dialog", { name: "Account" });
    expect(within(menu).getByText("admin@example.test")).toBeVisible();
    expect(within(menu).getByRole("group", { name: "Color theme" })).toBeVisible();
    expect(within(menu).getByRole("group", { name: "Language" })).toBeVisible();
    expect(within(menu).getByRole("button", { name: "Sign out" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Account" })).not.toBeInTheDocument();
  });

  it("opens the command palette from the keyboard", async () => {
    const { user } = renderShell();

    expect(screen.queryByRole("dialog", { name: "Find a page" })).not.toBeInTheDocument();
    await user.keyboard("{Meta>}k{/Meta}");

    expect(screen.getByRole("dialog", { name: "Find a page" })).toBeVisible();
  });

  it("remembers a collapsed sidebar across visits", async () => {
    const { user } = renderShell();

    await user.click(screen.getByRole("button", { name: "Collapse navigation" }));

    expect(window.localStorage.getItem("second-brain-admin.sidebar-collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Expand navigation" })).toBeVisible();
  });

  it("keeps the signed-in identity and sign out off the sidebar, behind the account button", async () => {
    const { user } = renderShell();
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });

    expect(screen.queryByText("admin@example.test")).not.toBeInTheDocument();
    expect(within(nav.closest("aside")!).queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Account" }));
    const menu = screen.getByRole("dialog", { name: "Account" });
    expect(within(menu).getByText("admin@example.test")).toBeVisible();
    expect(within(menu).getByText("Admin")).toBeVisible();
    expect(within(menu).getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  it("opens the browsable glossary from the header", async () => {
    const { user } = renderShell();

    await user.click(screen.getByRole("button", { name: "Help" }));

    expect(screen.getByRole("dialog", { name: "Glossary" })).toBeVisible();
  });

  it("shows the first-run welcome guide once, and never again after it is dismissed", async () => {
    const { user } = renderShell({ welcomeDismissed: false });

    expect(screen.getByRole("dialog", { name: "Welcome to Second Brain" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Skip, I’ll look around" }));

    expect(screen.queryByRole("dialog", { name: "Welcome to Second Brain" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("second-brain-admin.welcome-dismissed")).toBe("true");
  });

  it("does not show the welcome guide again for a returning visitor", () => {
    renderShell({ welcomeDismissed: true });

    expect(screen.queryByRole("dialog", { name: "Welcome to Second Brain" })).not.toBeInTheDocument();
  });

  it("opens the ask panel from the header, answers in place, and toggles it from the keyboard", async () => {
    vi.spyOn(api, "askBrain").mockResolvedValue({ answer: "Fridays.", answerable: true, retrievedAt: "2026-09-05T00:00:00Z", evidenceCount: 0, citations: [] });
    const { user } = renderShell();

    expect(screen.queryByRole("dialog", { name: "Ask your brain" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ask your brain" }));
    const panel = screen.getByRole("dialog", { name: "Ask your brain" });
    await user.type(within(panel).getByRole("textbox"), "When is the review?{Enter}");
    expect(await within(panel).findByText("Fridays.")).toBeVisible();

    await user.keyboard("{Control>}j{/Control}");
    expect(screen.queryByRole("dialog", { name: "Ask your brain" })).not.toBeInTheDocument();
    await user.keyboard("{Control>}j{/Control}");
    expect(screen.getByRole("dialog", { name: "Ask your brain" })).toBeVisible();
  });

  it("reopens the welcome guide from the command palette", async () => {
    const { user } = renderShell({ welcomeDismissed: true });

    await user.keyboard("{Meta>}k{/Meta}");
    await user.click(screen.getByRole("option", { name: /Show the welcome guide/ }));

    expect(screen.getByRole("dialog", { name: "Welcome to Second Brain" })).toBeVisible();
  });
});
