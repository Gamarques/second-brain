import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../../lib/i18n";
import { ToastProvider, useToast } from "./toast";

function Publisher() {
  const { toast } = useToast();
  return (
    <button onClick={() => toast({ title: "Schedule saved", description: "Next run recalculated.", tone: "success" })} type="button">
      Publish
    </button>
  );
}

function renderPublisher() {
  return render(<LocaleProvider><ToastProvider><Publisher /></ToastProvider></LocaleProvider>);
}

describe("Toast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces a published message politely", () => {
    renderPublisher();

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(screen.getByText("Schedule saved")).toBeVisible();
    expect(screen.getByText("Next run recalculated.")).toBeVisible();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("lets the operator dismiss a message immediately", () => {
    renderPublisher();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    expect(screen.queryByText("Schedule saved")).not.toBeInTheDocument();
  });

  it("retires a message on its own so the surface stays clear", () => {
    vi.useFakeTimers();
    renderPublisher();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    act(() => {
      vi.advanceTimersByTime(6_000);
    });

    expect(screen.queryByText("Schedule saved")).not.toBeInTheDocument();
  });
});
