import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../../lib/i18n";
import { ConfirmDialog, Dialog } from "./dialog";

function renderWithLocale(ui: React.ReactElement) {
  return render(<LocaleProvider>{ui}</LocaleProvider>);
}

describe("Dialog", () => {
  it("names itself for assistive technology", () => {
    renderWithLocale(<Dialog description="Review the change." onClose={() => undefined} open title="Stage changes"><p>Body</p></Dialog>);

    expect(screen.getByRole("dialog", { name: "Stage changes" })).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("renders nothing while closed", () => {
    renderWithLocale(<Dialog onClose={() => undefined} open={false} title="Stage changes"><p>Body</p></Dialog>);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderWithLocale(<Dialog onClose={onClose} open title="Stage changes"><p>Body</p></Dialog>);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog so the keyboard is not stranded behind it", () => {
    renderWithLocale(<Dialog onClose={() => undefined} open title="Stage changes"><button type="button">Inside</button></Dialog>);

    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("keeps the page behind it from scrolling", () => {
    const view = renderWithLocale(<Dialog onClose={() => undefined} open title="Stage changes"><p>Body</p></Dialog>);

    expect(document.body.style.overflow).toBe("hidden");

    view.unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});

describe("ConfirmDialog", () => {
  it("requires an explicit confirmation before a destructive action", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderWithLocale(
      <ConfirmDialog
        confirmLabel="Delete lineage"
        description="This cannot be undone."
        onCancel={onCancel}
        onConfirm={onConfirm}
        open
        title="Delete this memory lineage?"
        tone="danger"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete lineage" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("Dialog overlay containment", () => {
  it("escapes its parent so an animated ancestor cannot clip the overlay", () => {
    const { container } = renderWithLocale(
      <div className="animate-rise">
        <Dialog onClose={() => undefined} open title="Stage changes"><p>Body</p></Dialog>
      </div>,
    );

    const dialog = screen.getByRole("dialog");
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it("caps its own height so a tall form never pushes the footer off screen", () => {
    renderWithLocale(
      <Dialog footer={<button type="button">Save</button>} onClose={() => undefined} open title="Add document">
        <p>Body</p>
      </Dialog>,
    );

    const panel = screen.getByRole("dialog");
    const body = panel.querySelector("[data-dialog-body]");
    expect(panel.className).toContain("max-h-");
    expect(body).toHaveClass("overflow-y-auto");
    expect(screen.getByRole("button", { name: "Save" })).toBeVisible();
  });
});
