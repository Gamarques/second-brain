// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Field, Input } from "./field";

describe("Field", () => {
  it("associates hints with nested form controls", () => {
    render(<Field hint="Use a stable identifier." htmlFor="identifier" label="Identifier"><div><Input id="identifier" /></div></Field>);

    expect(screen.getByLabelText("Identifier")).toHaveAttribute("aria-describedby", "identifier-description");
  });

  it("marks controls with validation errors as invalid", () => {
    render(<Field error="This value is required." htmlFor="required-value" label="Required value"><Input id="required-value" /></Field>);

    expect(screen.getByLabelText("Required value")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("This value is required.");
  });
});
