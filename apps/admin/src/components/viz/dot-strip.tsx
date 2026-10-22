import { cn } from "../../lib/utils";

const tones = {
  success: "bg-success",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-muted-foreground/30",
};

export interface DotStripItem {
  key: string;
  tone: keyof typeof tones;
  label: string;
}

/** A row of small dots, one per outcome, oldest first; each dot is named for assistive tech. */
export function DotStrip({ items, label, className }: { items: readonly DotStripItem[]; label: string; className?: string }) {
  return (
    <ol aria-label={label} className={cn("flex items-center gap-1", className)}>
      {items.map((item) => (
        <li className={cn("size-1.5 rounded-full", tones[item.tone])} key={item.key} title={item.label}>
          <span className="sr-only">{item.label}</span>
        </li>
      ))}
    </ol>
  );
}
