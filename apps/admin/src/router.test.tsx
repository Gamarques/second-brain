import { render, screen } from "@testing-library/react";
import { Outlet } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "./lib/i18n";
import { AppRouter } from "./router";

vi.mock("./routes/auth", () => ({
  LoginPage: () => <div>Sign in page</div>,
  OAuthCallbackPage: () => <div>OAuth callback page</div>,
  ProtectedRoute: () => <main id="main-content" tabIndex={-1}><Outlet /></main>,
}));

vi.mock("./routes/brain-map", () => ({
  BrainMapPage: () => <div>Brain map page</div>,
}));

vi.mock("./routes/home", () => ({
  HomePage: () => <div>Home page</div>,
}));

vi.mock("./routes/dashboard", () => ({
  DashboardPage: () => <div>Status page</div>,
}));

vi.mock("./routes/configuration", () => ({
  ConfigurationPage: () => <input aria-label="Review model" autoFocus data-route-focus />,
}));

function renderAt(path: string) {
  window.history.replaceState({}, "", `/admin${path}`);
  return render(
    <LocaleProvider>
      <AppRouter />
    </LocaleProvider>,
  );
}

describe("admin routes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves an explicit field focus when navigating to configuration", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    renderAt("/configuration/environment?focus=dreaming");
    expect(await screen.findByLabelText("Review model")).toHaveFocus();
  });

  it("focuses the main content when a route has no explicit field target", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    renderAt("/status");
    expect(await screen.findByRole("main")).toHaveFocus();
  });
  it("renders the home at the default route", async () => {
    renderAt("/");
    expect(await screen.findByText("Home page")).toBeVisible();
  });

  it("keeps the brain map on its own route", async () => {
    renderAt("/brain-map");
    expect(await screen.findByText("Brain map page")).toBeVisible();
  });

  it("keeps the former landing dashboard available as Status", async () => {
    renderAt("/status");
    expect(await screen.findByText("Status page")).toBeVisible();
  });

  it("redirects former ask links to the home without dropping their query", async () => {
    renderAt("/ask?project=00000000-0000-4000-8000-000000000002");

    expect(await screen.findByText("Home page")).toBeVisible();
    expect(window.location.pathname).toBe("/admin");
    expect(window.location.search).toBe("?project=00000000-0000-4000-8000-000000000002");
  });

  it("redirects the former daily briefing to the home", async () => {
    renderAt("/briefing");

    expect(await screen.findByText("Home page")).toBeVisible();
    expect(window.location.pathname).toBe("/admin");
  });
});
