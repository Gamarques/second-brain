import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Brain } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../../lib/i18n";
import { Composer, ComposerChip } from "./composer";

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSubmit = vi.fn();
  const onChange = vi.fn();
  const onStop = vi.fn();
  render(
    <LocaleProvider>
      <Composer aria-label="Question" onChange={onChange} onSubmit={onSubmit} onStop={onStop} submitLabel="Ask" value="" {...props} />
    </LocaleProvider>,
  );
  return { onSubmit, onChange, onStop };
}

describe("Composer", () => {
  it("submits on Enter, keeps Shift+Enter for a new line, and names the round button", async () => {
    const user = userEvent.setup();
    const { onSubmit, onChange } = renderComposer({ value: "Who leads design?" });

    expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled();
    await user.type(screen.getByRole("textbox", { name: "Question" }), "{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "Question" }), "{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("cannot send an empty question", () => {
    renderComposer({ value: "   " });
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
  });

  it("swaps the send button for Stop while a question is in flight", async () => {
    const user = userEvent.setup();
    const { onStop, onSubmit } = renderComposer({ busy: true, stopLabel: "Stop", value: "Anything" });

    expect(screen.queryByRole("button", { name: "Ask" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    await user.type(screen.getByRole("textbox", { name: "Question" }), "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows context chips beside the send button", () => {
    renderComposer({ leading: <ComposerChip icon={Brain}>Whole brain</ComposerChip>, footnote: "May use AI credits." });

    expect(screen.getByText("Whole brain")).toBeVisible();
    expect(screen.getByText("May use AI credits.")).toBeVisible();
  });
});
