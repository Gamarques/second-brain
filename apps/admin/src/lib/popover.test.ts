import { describe, expect, it } from "vitest";

import { placePopover } from "./popover";

const viewport = { width: 1280, height: 800 };
const panelWidth = 288;

function trigger(overrides: Partial<{ top: number; bottom: number; left: number }> = {}) {
  return { top: 100, bottom: 120, left: 400, ...overrides };
}

describe("popover placement", () => {
  it("sits below the trigger when there is room", () => {
    expect(placePopover(trigger(), { width: panelWidth, height: 140 }, viewport)).toEqual({ top: 128, left: 400 });
  });

  it("flips above the trigger when the definition would fall off the bottom", () => {
    const near = trigger({ top: 720, bottom: 740 });

    const placement = placePopover(near, { width: panelWidth, height: 140 }, viewport);

    expect(placement.top).toBe(572);
    expect(placement.top + 140).toBeLessThanOrEqual(near.top);
  });

  it("keeps a flipped popover on screen when the trigger is near the top as well", () => {
    const cramped = trigger({ top: 40, bottom: 60 });

    const placement = placePopover(cramped, { width: panelWidth, height: 700 }, { width: 1280, height: 720 });

    expect(placement.top).toBe(12);
  });

  it("clamps against the right edge", () => {
    const placement = placePopover(trigger({ left: 1240 }), { width: panelWidth, height: 140 }, viewport);

    expect(placement.left).toBe(980);
  });

  it("clamps against the left edge", () => {
    const placement = placePopover(trigger({ left: -50 }), { width: panelWidth, height: 140 }, viewport);

    expect(placement.left).toBe(12);
  });
});
