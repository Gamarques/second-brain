import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../../lib/i18n";
import { CopyButton } from "./copy-button";

function renderCopyButton(props: React.ComponentProps<typeof CopyButton>) {
  return render(<LocaleProvider><CopyButton {...props} /></LocaleProvider>);
}

describe("CopyButton", () => {
  it("copies the value and confirms the result", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderCopyButton({ label: "run ID", value: "run-42" });

    await user.click(screen.getByRole("button", { name: "Copy run ID" }));

    expect(writeText).toHaveBeenCalledWith("run-42");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied run ID" })).toBeVisible());
  });

  it("stays usable when the clipboard is unavailable", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    renderCopyButton({ label: "run ID", value: "run-42" });

    await user.click(screen.getByRole("button", { name: "Copy run ID" }));

    expect(screen.getByRole("button", { name: "Copy run ID" })).toBeVisible();
  });
});
