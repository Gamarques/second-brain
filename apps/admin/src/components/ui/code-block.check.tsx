import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LocaleProvider } from "../../lib/i18n";
import { CodeBlock } from "./code-block";

describe("CodeBlock", () => {
  it("names the block for assistive tech and keeps the copy control inside it", () => {
    render(
      <LocaleProvider>
        <CodeBlock copyLabel="the Claude Code command" label="Claude Code" value="claude mcp add second-brain" />
      </LocaleProvider>,
    );

    const region = screen.getByRole("region", { name: "Claude Code" });
    expect(region).toHaveTextContent("claude mcp add second-brain");
    expect(region).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Copy the Claude Code command" })).toBeVisible();
  });

  it("wraps long lines by default and keeps them on one line when asked", () => {
    const { rerender } = render(
      <LocaleProvider>
        <CodeBlock copyLabel="Copy" label="Wrapped" value="one two" />
      </LocaleProvider>,
    );
    expect(screen.getByRole("region", { name: "Wrapped" })).toHaveClass("whitespace-pre-wrap");

    rerender(
      <LocaleProvider>
        <CodeBlock copyLabel="Copy" label="Wrapped" value="one two" wrap={false} />
      </LocaleProvider>,
    );
    expect(screen.getByRole("region", { name: "Wrapped" })).not.toHaveClass("whitespace-pre-wrap");
  });
});
