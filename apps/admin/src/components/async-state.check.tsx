import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { LocaleProvider } from "../lib/i18n";
import { EmptyState } from "./async-state";

describe("EmptyState", () => {
  it("marks the icon with the sunrise so an empty page still carries the brand", () => {
    render(
      <LocaleProvider>
        <MemoryRouter>
          <EmptyState description="Nothing yet." title="No reminders" />
        </MemoryRouter>
      </LocaleProvider>,
    );

    const icon = screen.getByRole("heading", { name: "No reminders" }).previousElementSibling;
    expect(icon).toHaveClass("aurora-soft");
  });
});

describe("EmptyState illustration", () => {
  it("draws the illustration in place of the icon disc", () => {
    const { container } = render(
      <LocaleProvider>
        <MemoryRouter>
          <EmptyState description="Nothing yet." illustration={<svg data-testid="art" />} title="No folders" />
        </MemoryRouter>
      </LocaleProvider>,
    );

    const art = screen.getByRole("heading", { name: "No folders" }).previousElementSibling;
    expect(art).toHaveAttribute("data-illustration");
    expect(art).toContainElement(screen.getByTestId("art"));
    expect(container.querySelector(".aurora-soft")).toBeNull();
  });
});

describe("EmptyState variants", () => {
  it("drops its dashed box when it sits inside a card", () => {
    const { container, rerender } = render(
      <LocaleProvider>
        <MemoryRouter>
          <EmptyState description="Nothing yet." title="No documents" variant="plain" />
        </MemoryRouter>
      </LocaleProvider>,
    );
    expect(container.firstElementChild).not.toHaveClass("border-dashed");

    rerender(
      <LocaleProvider>
        <MemoryRouter>
          <EmptyState description="Nothing yet." title="No documents" />
        </MemoryRouter>
      </LocaleProvider>,
    );
    expect(container.firstElementChild).toHaveClass("border-dashed");
  });
});
