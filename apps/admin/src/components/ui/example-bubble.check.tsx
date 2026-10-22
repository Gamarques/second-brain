import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LocaleProvider } from "../../lib/i18n";
import { ExampleBubble } from "./example-bubble";

describe("ExampleBubble", () => {
  it("shows the sentence to say and a copy control named for it", () => {
    render(
      <LocaleProvider>
        <ExampleBubble copyLabel="example" text="Remember that I prefer weekly summaries." />
      </LocaleProvider>,
    );

    expect(screen.getByText("Remember that I prefer weekly summaries.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy example" })).toBeVisible();
  });
});
