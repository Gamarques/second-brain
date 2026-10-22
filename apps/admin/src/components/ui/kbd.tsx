import type { HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-card px-1.5 font-sans text-[10px] font-medium text-muted-foreground shadow-[0_1px_0_0_var(--border)]",
        className,
      )}
      {...props}
    />
  );
}
