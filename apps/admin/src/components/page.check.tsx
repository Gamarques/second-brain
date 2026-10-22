import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ListRow, Meta, MetaItem, Page, PageHeader, RowActions } from "./page";

describe("PageHeader eyebrow", () => {
  it("styles a plain-text eyebrow as a label", () => {
    render(<PageHeader description="Description" eyebrow="Automation" title="Dreaming" />);

    expect(screen.getByText("Automation")).toHaveClass("uppercase");
  });

  it("never case-transforms an identifier shown in the eyebrow", () => {
    render(<PageHeader description="Description" eyebrow={<code>637029e6-9529-52d2</code>} title="Example" />);

    const eyebrow = screen.getByText("637029e6-9529-52d2").closest("div");
    expect(eyebrow).not.toHaveClass("uppercase");
    expect(screen.getByText("637029e6-9529-52d2")).toBeVisible();
  });
});

describe("PageHeader sunrise", () => {
  it("carries the Home sunrise behind every page title", () => {
    const { container } = render(<PageHeader description="Description" title="Reminders" />);

    const glow = container.querySelector(".aurora-glow.page-aurora");
    expect(glow).toHaveAttribute("aria-hidden", "true");
    expect(glow?.parentElement).toHaveClass("isolate");
  });
});

describe("Meta", () => {
  it("separates items with hidden middots and skips empty slots", () => {
    const { container } = render(
      <Meta>
        <MetaItem>First</MetaItem>
        {false}
        {null}
        <MetaItem>Second</MetaItem>
        <MetaItem>Third</MetaItem>
      </Meta>,
    );

    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    expect(container.textContent).toBe("First·Second·Third");
  });
});

describe("RowActions", () => {
  it("stays hidden until the row is hovered or focused, except on coarse pointers", () => {
    render(<RowActions data-testid="actions">x</RowActions>);

    expect(screen.getByTestId("actions")).toHaveClass("opacity-0", "group-hover/row:opacity-100", "group-focus-within/row:opacity-100", "pointer-coarse:opacity-100");
  });
});

describe("ListRow", () => {
  it("is the hover group that reveals its actions", () => {
    render(<ul><ListRow data-testid="row">x</ListRow></ul>);

    expect(screen.getByTestId("row")).toHaveClass("group/row", "relative", "py-3");
  });
});

describe("Page", () => {
  it("is the page grid and never a width of its own: the shell owns the container", () => {
    render(<Page data-testid="page">x</Page>);

    const page = screen.getByTestId("page");
    expect(page).toHaveClass("grid", "gap-6", "*:min-w-0");
    expect(page.className).not.toMatch(/max-w-/);
  });
});
