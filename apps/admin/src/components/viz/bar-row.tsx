import { cn } from "../../lib/utils";

/** One labelled bar of a small comparison: label, a meter filled to its share of the maximum, the value. */
export function BarRow({ label, value, max, valueLabel, className }: { label: string; value: number; max: number; valueLabel: string; className?: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className={cn("grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-xs", className)}>
      <span className="truncate text-muted-foreground">{label}</span>
      <div aria-label={label} aria-valuemax={max} aria-valuemin={0} aria-valuenow={value} className="h-1.5 overflow-hidden rounded-full bg-muted" role="meter">
        <div className="aurora h-full rounded-full opacity-80 transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <span className="tabular-nums text-foreground">{valueLabel}</span>
    </div>
  );
}
