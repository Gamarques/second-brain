import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CardFooter, CardHeader, CardHeaderText } from "./card";

describe("CardFooter", () => {
  it("keeps an explicit top padding at every breakpoint so a bordered footer is not flush", () => {
    render(
      <CardFooter className="border-t border-border/60 pt-4" data-testid="footer">
        Next
      </CardFooter>,
    );

    const className = screen.getByTestId("footer").className;
    expect(className).toContain("pt-4");
    expect(className).not.toContain("sm:pt-0");
    expect(className).not.toMatch(/(?:^|\s)sm:p-6(?:\s|$)/);
  });
});

describe("CardHeaderText", () => {
  it("keeps title and description spaced when they share a row with an action", () => {
    render(
      <CardHeader className="sm:flex-row sm:justify-between">
        <CardHeaderText>
          <h2>Title</h2>
          <p>Description</p>
        </CardHeaderText>
        <span>Action</span>
      </CardHeader>,
    );

    expect(screen.getByText("Title").parentElement).toHaveClass("gap-1.5");
  });
});
