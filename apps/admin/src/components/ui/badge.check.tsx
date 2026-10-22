import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "./badge";

describe("Badge", () => {
  it("renders status text without relying on color alone", () => {
    render(<Badge tone="danger">failed</Badge>);
    expect(screen.getByText("failed")).toBeVisible();
  });
});
