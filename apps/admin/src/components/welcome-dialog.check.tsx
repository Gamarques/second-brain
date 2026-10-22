import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../lib/i18n";
import { WelcomeDialog } from "./welcome-dialog";

function renderDialog(open = true) {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onStart = vi.fn();
  render(
    <LocaleProvider>
      <WelcomeDialog onClose={onClose} onStart={onStart} open={open} />
    </LocaleProvider>,
  );
  return { user, onClose, onStart };
}

describe("WelcomeDialog", () => {
  it("renders nothing while closed", () => {
    renderDialog(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("orients a first-time visitor to the product, setup, and connecting an AI app", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: "Welcome to Second Brain" })).toBeVisible();
    expect(screen.getByText("This is your private brain")).toBeVisible();
    expect(screen.getByText("A short setup")).toBeVisible();
    expect(screen.getByText("Connect your AI")).toBeVisible();
    expect(screen.queryByText("Command palette")).not.toBeInTheDocument();
  });

  it("lets a visitor skip without starting the checklist", async () => {
    const { user, onClose, onStart } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Skip, I’ll look around" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("starts the setup checklist from the primary action", async () => {
    const { user, onStart } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Start setup" }));

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("shows the live next action when setup progress is available", () => {
    render(
      <LocaleProvider>
        <WelcomeDialog
          nextStep={{
            id: "connect",
            title: "Connect your AI",
            description: "Authorize one app.",
            to: "/connect",
            linkLabel: "Connect now",
            complete: false,
          }}
          onClose={vi.fn()}
          onStart={vi.fn()}
          open
        />
      </LocaleProvider>,
    );

    expect(screen.getByText("Your next step is Connect your AI.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect now" })).toBeVisible();
  });
});
