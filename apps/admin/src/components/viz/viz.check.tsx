import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BarRow } from "./bar-row";
import { DotStrip } from "./dot-strip";
import { Sparkline } from "./sparkline";

describe("BarRow", () => {
  it("is a meter whose fill follows the share of the maximum", () => {
    render(<BarRow label="Brain answers" max={400} value={100} valueLabel="100 requests" />);

    const meter = screen.getByRole("meter", { name: "Brain answers" });
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(meter).toHaveAttribute("aria-valuemax", "400");
    expect(meter.firstElementChild).toHaveStyle({ width: "25%" });
    expect(screen.getByText("100 requests")).toBeVisible();
  });

  it("never divides by zero", () => {
    render(<BarRow label="Nothing" max={0} value={0} valueLabel="0 requests" />);

    expect(screen.getByRole("meter").firstElementChild).toHaveStyle({ width: "0%" });
  });
});

describe("Sparkline", () => {
  it("is an image named for assistive tech", () => {
    render(<Sparkline label="Growth" values={[1, 2, 3]} />);

    expect(screen.getByRole("img", { name: "Growth" })).toBeInTheDocument();
  });

  it("draws nothing for a single point", () => {
    const { container } = render(<Sparkline label="Growth" values={[1]} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("DotStrip", () => {
  it("is a list with one named dot per outcome", () => {
    render(
      <DotStrip
        items={[
          { key: "a", tone: "success", label: "Sep 1: Completed" },
          { key: "b", tone: "danger", label: "Sep 2: Failed" },
        ]}
        label="Outcomes"
      />,
    );

    const list = screen.getByRole("list", { name: "Outcomes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Sep 2: Failed")).toBeInTheDocument();
  });
});
