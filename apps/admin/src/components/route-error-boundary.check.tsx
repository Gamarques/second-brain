import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../lib/i18n";
import { isChunkLoadError, RouteErrorBoundary, shouldReloadForChunk } from "./route-error-boundary";

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

function renderBoundary(child: React.ReactNode, reload = vi.fn()) {
  render(
    <LocaleProvider>
      <MemoryRouter>
        <RouteErrorBoundary reload={reload}>{child}</RouteErrorBoundary>
      </MemoryRouter>
    </LocaleProvider>,
  );
  return reload;
}

describe("RouteErrorBoundary", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders its children when nothing fails", () => {
    renderBoundary(<p>Routed content</p>);
    expect(screen.getByText("Routed content")).toBeVisible();
  });

  it("shows a recovery card instead of a blank screen when a page throws", async () => {
    const user = userEvent.setup();
    const reload = renderBoundary(<Boom message="render exploded" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.getByRole("link", { name: /Go to Home/ })).toHaveAttribute("href", "/");
    await user.click(screen.getByRole("button", { name: /Reload page/ }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once when a route chunk from an old deploy can no longer be fetched", () => {
    const reload = renderBoundary(<Boom message="Failed to fetch dynamically imported module: https://x/admin/assets/reminders-abc.js" />);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("recognises the chunk-load failures browsers report and rate-limits the automatic reload", () => {
    expect(isChunkLoadError(new Error("Failed to fetch dynamically imported module: x"))).toBe(true);
    expect(isChunkLoadError(new Error("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);

    expect(shouldReloadForChunk(1_000_000)).toBe(true);
    expect(shouldReloadForChunk(1_000_000 + 10_000)).toBe(false);
    expect(shouldReloadForChunk(1_000_000 + 61_000)).toBe(true);
  });
});
