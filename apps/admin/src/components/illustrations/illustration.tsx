import { useId, type ReactNode } from "react";

import { cn } from "../../lib/utils";

export interface IllustrationProps {
  className?: string;
  /** Names the drawing for assistive tech; without it the drawing is decorative. */
  title?: string;
}

/**
 * The shared stage for the console's small drawings: 160×120, hairline
 * `currentColor` strokes with rounded joins, and one sunrise gradient handed to
 * the drawing as a paint server — so every illustration carries exactly one
 * accent and reads as part of the same hand.
 */
export function Illustration({ className, title, children }: IllustrationProps & { children: (sunrise: string) => ReactNode }) {
  const gradientId = `sunrise-${useId()}`;
  return (
    <svg
      aria-hidden={title ? undefined : "true"}
      className={cn("h-20 w-auto", className)}
      fill="none"
      role={title ? "img" : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.25}
      viewBox="0 0 160 120"
    >
      {title && <title>{title}</title>}
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id={gradientId} x1="0" x2="160" y1="0" y2="120">
          <stop offset="0%" stopColor="var(--aurora-orange)" />
          <stop offset="52%" stopColor="var(--aurora-pink)" />
          <stop offset="100%" stopColor="var(--aurora-blue)" />
        </linearGradient>
      </defs>
      {children(`url(#${gradientId})`)}
    </svg>
  );
}
