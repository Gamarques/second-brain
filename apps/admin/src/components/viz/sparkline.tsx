import { useId } from "react";

import { cn } from "../../lib/utils";
import { areaPath, linePath, linePoints } from "../../lib/viz";

/**
 * A small line for a series that only needs to show its shape: no axes, a
 * hairline stroke, and the latest point marked in the sunrise. `area` adds a
 * soft fill under the line. Draws nothing for fewer than two points.
 */
export function Sparkline({
  values,
  label,
  width = 120,
  height = 32,
  area = false,
  className,
}: {
  values: readonly number[];
  label: string;
  width?: number;
  height?: number;
  area?: boolean;
  className?: string;
}) {
  const gradientId = `sparkline-${useId()}`;
  const points = linePoints(values, width, height);
  const last = points.at(-1);
  if (!last) return null;
  return (
    <svg aria-label={label} className={cn("h-8 w-30 overflow-visible text-foreground", className)} role="img" viewBox={`0 0 ${width} ${height}`}>
      {area && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--aurora-pink)" stopOpacity="0.35" />
              <stop offset="1" stopColor="var(--aurora-blue)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath(values, width, height)} fill={`url(#${gradientId})`} />
        </>
      )}
      <path d={linePath(values, width, height)} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
      <circle cx={last.x} cy={last.y} fill="var(--aurora-pink)" r="2.25" />
    </svg>
  );
}

export function AreaSeries(props: Omit<Parameters<typeof Sparkline>[0], "area">) {
  return <Sparkline {...props} area />;
}
