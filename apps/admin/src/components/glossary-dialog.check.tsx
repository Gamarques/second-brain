import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../lib/i18n";
import { GlossaryDialog } from "./glossary-dialog";

function renderDialog(open = true) {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <LocaleProvider>
      <GlossaryDialog onClose={onClose} open={open} />
    </LocaleProvider>,
  );
  return { user, onClose };
}

describe("GlossaryDialog", () => {
  it("renders nothing while closed", () => {
    renderDialog(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists every glossary term when open", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Glossary" })).toBeVisible();
    expect(screen.getByText("PKCE")).toBeVisible();
    expect(screen.getByText("In progress")).toBeVisible();
  });

  it("filters terms by a search query", async () => {
    const { user } = renderDialog();

    await user.type(screen.getByLabelText("Search terms"), "PKCE");

    expect(screen.getByText("PKCE")).toBeVisible();
    expect(screen.queryByText("In progress")).not.toBeInTheDocument();
  });

  it("shows an empty state when nothing matches", async () => {
    const { user } = renderDialog();

    await user.type(screen.getByLabelText("Search terms"), "nonexistentterm");

    expect(screen.getByText("No terms match your search.")).toBeVisible();
  });
});
