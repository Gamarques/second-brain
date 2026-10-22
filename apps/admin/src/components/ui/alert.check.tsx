import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Alert } from "./alert";

describe("Alert", () => {
  it("keeps the surface neutral and carries the tone on the icon", () => {
    render(<Alert title="Heads up" tone="warning">Body copy</Alert>);

    const alert = screen.getByRole("status");
    expect(alert).not.toHaveClass("bg-warning-surface");
    expect(alert).not.toHaveClass("border-warning-border");
    expect(alert.querySelector("[data-alert-badge]")).toHaveClass("bg-warning-surface", "text-warning");
    expect(screen.getByText("Heads up")).toBeVisible();
    expect(screen.getByText("Body copy")).toBeVisible();
  });

  it("announces danger assertively", () => {
    render(<Alert title="Something failed" tone="danger" />);

    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("alert").querySelector("[data-alert-badge]")).toHaveClass("text-danger");
  });
});
