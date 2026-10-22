import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sparkles } from "lucide-react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../lib/i18n";
import { CommandPalette, type CommandAction } from "./command-palette";

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="pathname">{location.pathname}</p>;
}

function renderPalette(actions: CommandAction[] = [], onClose = vi.fn()) {
  const user = userEvent.setup();
  render(
    <LocaleProvider>
      <MemoryRouter initialEntries={["/"]}>
        <LocationProbe />
        <CommandPalette actions={actions} onClose={onClose} open />
      </MemoryRouter>
    </LocaleProvider>,
  );
  return { user, onClose };
}

describe("CommandPalette", () => {
  it("offers every destination until the operator narrows the list", async () => {
    const { user } = renderPalette();

    expect(screen.getAllByRole("option").length).toBeGreaterThan(5);

    await user.keyboard("jobs");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Background work");
  });

  it("matches keywords so operators do not have to know the menu label", async () => {
    const { user } = renderPalette();

    await user.keyboard("secrets");

    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Settings");
  });

  it("navigates to the highlighted destination on Enter", async () => {
    const { user, onClose } = renderPalette();

    await user.keyboard("activity");
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("pathname")).toHaveTextContent("/audit");
    expect(onClose).toHaveBeenCalled();
  });

  it("walks the list with the arrow keys", async () => {
    const { user } = renderPalette();

    await user.keyboard("{ArrowDown}");

    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
  });

  it("runs a supplied action", async () => {
    const run = vi.fn();
    const { user } = renderPalette([
      { id: "theme", label: "Toggle theme", group: "Actions", icon: Sparkles, keywords: ["dark", "light"], run },
    ]);

    await user.keyboard("toggle theme");
    await user.keyboard("{Enter}");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("tells the operator when nothing matches", async () => {
    const { user } = renderPalette();

    await user.keyboard("zzzzzz");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching commands")).toBeVisible();
  });
});
