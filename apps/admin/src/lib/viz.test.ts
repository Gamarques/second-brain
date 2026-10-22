import { describe, expect, it } from "vitest";

import { areaPath, linePath, tickTone } from "./viz";

describe("linePath", () => {
  it("runs left to right across the width and scales to the value range", () => {
    expect(linePath([0, 10], 100, 20)).toBe("M2 18L98 2");
  });

  it("draws a flat series as a horizontal line at mid height", () => {
    expect(linePath([5, 5, 5], 100, 20)).toBe("M2 10L50 10L98 10");
  });

  it("is empty for fewer than two points", () => {
    expect(linePath([4], 100, 20)).toBe("");
  });
});

describe("areaPath", () => {
  it("closes the line down to the baseline", () => {
    expect(areaPath([0, 10], 100, 20)).toBe("M2 18L98 2L98 20L2 20Z");
  });
});

describe("tickTone", () => {
  it.each([
    ["completed", "success"],
    ["failed", "danger"],
    ["canceled", "neutral"],
    ["running", "info"],
    ["pending", "info"],
    ["retry_wait", "info"],
  ] as const)("%s → %s", (status, tone) => {
    expect(tickTone(status)).toBe(tone);
  });
});
