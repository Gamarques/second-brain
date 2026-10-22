import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

export function Tooltip({ label, children, hidden = false, className }: { label: string; children: ReactNode; hidden?: boolean; className?: string }) {
  if (hidden) return <>{children}</>;
  return (
    <span className={cn("group/tooltip relative flex", className)}>
      {children}
      <span
        className="pointer-events-none absolute left-full top-1/2 z-50 ml-2.5 -translate-y-1/2 -translate-x-1 whitespace-nowrap rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground opacity-0 shadow-md transition-all duration-150 group-focus-within/tooltip:translate-x-0 group-focus-within/tooltip:opacity-100 group-hover/tooltip:translate-x-0 group-hover/tooltip:opacity-100"
        aria-hidden="true"
        role="tooltip"
      >
        {label}
      </span>
    </span>
  );
}
