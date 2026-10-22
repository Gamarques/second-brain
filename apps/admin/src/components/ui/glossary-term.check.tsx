import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { LocaleProvider } from "../../lib/i18n";
import { GlossaryTerm } from "./glossary-term";

function renderWithLocale(ui: React.ReactElement) {
  const user = userEvent.setup();
  render(<LocaleProvider>{ui}</LocaleProvider>);
  return { user };
}

describe("GlossaryTerm", () => {
  it("stays closed until activated", () => {
    renderWithLocale(<GlossaryTerm id="retryWait" />);

    expect(screen.getByRole("button", { name: "Trying again" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows its definition on click and closes with Escape, returning focus to the trigger", async () => {
    const { user } = renderWithLocale(<GlossaryTerm id="retryWait" />);
    const trigger = screen.getByRole("button", { name: "Trying again" });

    await user.click(trigger);
    const popover = screen.getByRole("dialog", { name: "Trying again" });
    expect(popover).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes when clicking outside the popover", async () => {
    const { user } = renderWithLocale(
      <div>
        <GlossaryTerm id="lease" />
        <button type="button">Elsewhere</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "In progress" }));
    expect(screen.getByRole("dialog")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders an icon-only trigger next to an existing label, without repeating the term as visible text", async () => {
    const { user } = renderWithLocale(
      <p>
        Lease owner
        <GlossaryTerm id="lease" variant="icon" />
      </p>,
    );

    const trigger = screen.getByRole("button", { name: "Explain: In progress" });
    expect(trigger).not.toHaveTextContent("In progress");

    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "In progress" })).toBeVisible();
  });

  it("lets custom children be the clickable label", () => {
    renderWithLocale(<GlossaryTerm id="superseded">What does this mean?</GlossaryTerm>);

    expect(screen.getByRole("button", { name: "What does this mean?" })).toBeVisible();
  });
});
