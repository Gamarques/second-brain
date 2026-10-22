import { ChevronRight } from "lucide-react";
import type { DetailsHTMLAttributes, ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * A native `<details>` with a consistent chevron summary. `variant="boxed"`
 * wraps it in a muted panel for secondary options inside a form or dialog.
 */
export function Disclosure({
  summary,
  children,
  className,
  contentClassName,
  summaryClassName,
  variant = "plain",
  size = "default",
  ...props
}: DetailsHTMLAttributes<HTMLDetailsElement> & { summary: ReactNode; contentClassName?: string; summaryClassName?: string; variant?: "plain" | "boxed"; size?: "default" | "sm" }) {
  return (
    <details
      className={cn("group/disclosure", variant === "boxed" && "rounded-lg border border-border bg-muted/30 p-3", className)}
      {...props}
    >
      <summary
        className={cn(
          "flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm font-medium text-muted-foreground transition-colors select-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 [&::-webkit-details-marker]:hidden",
          size === "sm" ? "text-xs [&>svg]:size-3.5" : "text-sm [&>svg]:size-4",
          summaryClassName,
        )}
      >
        <ChevronRight aria-hidden="true" className="shrink-0 transition-transform duration-150 group-open/disclosure:rotate-90" />
        <span>{summary}</span>
      </summary>
      <div className={cn("mt-3", contentClassName)}>{children}</div>
    </details>
  );
}
