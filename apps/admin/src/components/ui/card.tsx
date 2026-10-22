import type { HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card text-card-foreground shadow-card transition-[border-color,box-shadow] duration-200",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 p-4 sm:p-5", className)} {...props} />;
}

/**
 * Restores the header's title/description gap when those two have to sit
 * inside a wrapper so a badge or action can share the row.
 */
export function CardHeaderText({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid min-w-0 gap-1.5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-sm font-medium leading-snug tracking-[-0.01em] text-foreground", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-[13px] leading-relaxed text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 pt-0 sm:p-5 sm:pt-0", className)} {...props} />;
}

/**
 * Horizontal and bottom padding only, so a following `pt-*` (used with a
 * top border) is not wiped out by `sm:p-6` / `sm:pt-0`. A footer that
 * carries `border-t` gets its own top padding automatically.
 */
export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-wrap items-center gap-3 px-4 pb-4 pt-0 sm:px-5 sm:pb-5 [.border-t]:pt-4 sm:[.border-t]:pt-5", className)} {...props} />;
}

export function CardToolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5", className)} {...props} />;
}
