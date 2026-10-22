import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { LocaleProvider, localeStorageKey } from "../lib/i18n";
import { LocaleToggle } from "./locale-toggle";

function renderToggle() {
  return render(<LocaleProvider><LocaleToggle /></LocaleProvider>);
}

describe("LocaleToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("offers every supported language", () => {
    renderToggle();

    expect(screen.getByRole("group", { name: "Language" })).toBeVisible();
    expect(screen.getByRole("button", { name: "English" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Português (Brasil)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Español" })).toBeVisible();
  });

  it("marks the active locale as pressed", () => {
    renderToggle();

    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches and persists the chosen locale", async () => {
    const user = userEvent.setup();
    renderToggle();

    await user.click(screen.getByRole("button", { name: "Español" }));

    expect(screen.getByRole("button", { name: "Español" })).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem(localeStorageKey)).toBe("es");
  });
});
