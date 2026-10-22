/**
 * Viewport-aware placement for a popover anchored to a trigger. Kept as a
 * pure function so the edge cases — flipping above the trigger, and clamping
 * against every viewport edge — are testable without a real browser.
 */

export const popoverMargin = 12;
export const popoverGap = 8;

export interface TriggerBox {
  top: number;
  bottom: number;
  left: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
}

export function placePopover(trigger: TriggerBox, panel: PanelSize, viewport: Viewport): Placement {
  const below = trigger.bottom + popoverGap;
  const fitsBelow = below + panel.height <= viewport.height - popoverMargin;
  const top = fitsBelow
    ? below
    : Math.max(popoverMargin, trigger.top - popoverGap - panel.height);
  const left = Math.min(Math.max(popoverMargin, trigger.left), viewport.width - panel.width - popoverMargin);
  return { top, left };
}
