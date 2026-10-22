import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SwitchRow } from "./switch";

describe("SwitchRow", () => {
  it("can sit in a divided list without its own box", () => {
    const { rerender } = render(<SwitchRow checked label="Automatic delivery" onCheckedChange={() => undefined} variant="plain" />);
    expect(screen.getByRole("switch", { name: "Automatic delivery" }).parentElement).not.toHaveClass("border");

    rerender(<SwitchRow checked label="Automatic delivery" onCheckedChange={() => undefined} />);
    expect(screen.getByRole("switch", { name: "Automatic delivery" }).parentElement).toHaveClass("border");
  });
});
