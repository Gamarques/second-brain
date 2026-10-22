import type { HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const tones: Record<BadgeTone, string> = {
  neutral: "border-border bg-muted/50 text-muted-foreground",
  success: "border-transparent bg-success-surface text-success",
  warning: "border-transparent bg-warning-surface text-warning",
  danger: "border-transparent bg-danger-surface text-danger",
  info: "border-transparent bg-info-surface text-info",
};

export function Badge({ className, tone = "neutral", dot = false, children, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; dot?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap transition-colors",
        tones[tone],
        className,
      )}
      {...props}
    >
      {dot && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}
