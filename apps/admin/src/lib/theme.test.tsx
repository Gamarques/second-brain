import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider, themeStorageKey, useTheme } from "./theme";

function ThemeProbe() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <div>
      <p data-testid="preference">{preference}</p>
      <p data-testid="resolved">{resolved}</p>
      <button onClick={() => setPreference("dark")} type="button">Dark</button>
      <button onClick={() => setPreference("system")} type="button">System</button>
    </div>
  );
}

describe("theme preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("starts dark until a preference is chosen", () => {
    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    expect(screen.getByTestId("preference")).toHaveTextContent("dark");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("follows the operating system once that is chosen, and remembers the choice", () => {
    window.localStorage.setItem(themeStorageKey, "system");

    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    expect(screen.getByTestId("preference")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });

  it("persists an explicit preference and paints it on the document", async () => {
    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    await userEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(themeStorageKey)).toBe("dark");
  });

  it("restores a stored preference on the next visit", () => {
    window.localStorage.setItem(themeStorageKey, "dark");

    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });

  it("returns to the operating system preference when asked", async () => {
    window.localStorage.setItem(themeStorageKey, "dark");
    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    await userEvent.click(screen.getByRole("button", { name: "System" }));

    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(window.localStorage.getItem(themeStorageKey)).toBe("system");
  });
});
