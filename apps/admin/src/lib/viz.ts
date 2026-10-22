import type { AutomationJob } from "./api-types";

const round = (value: number): string => String(Number(value.toFixed(2)));

/** Points of a series spread across the width, scaled to the value range; a flat series sits at mid height. */
export function linePoints(values: readonly number[], width: number, height: number, pad = 2): Array<{ x: number; y: number }> {
  if (values.length < 2) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values.map((value, index) => ({
    x: pad + (index * (width - 2 * pad)) / (values.length - 1),
    y: span === 0 ? height / 2 : pad + ((max - value) / span) * (height - 2 * pad),
  }));
}

export function linePath(values: readonly number[], width: number, height: number, pad = 2): string {
  const points = linePoints(values, width, height, pad);
  if (points.length === 0) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${round(point.x)} ${round(point.y)}`).join("");
}

/** The line closed down to the bottom edge, for a soft fill under it. */
export function areaPath(values: readonly number[], width: number, height: number, pad = 2): string {
  const line = linePath(values, width, height, pad);
  if (line === "") return "";
  return `${line}L${round(width - pad)} ${height}L${round(pad)} ${height}Z`;
}

/** The tone of one review outcome in a strip of dots. */
export function tickTone(status: AutomationJob["status"]): "success" | "danger" | "info" | "neutral" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "canceled":
      return "neutral";
    default:
      return "info";
  }
}
