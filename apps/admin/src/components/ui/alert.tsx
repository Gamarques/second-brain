import { AlertCircle, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

const icons = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: AlertCircle };

/** The surface stays neutral; only the icon badge carries the tone. */
const badges = {
  info: "bg-info-surface text-info",
  success: "bg-success-surface text-success",
  warning: "bg-warning-surface text-warning",
  danger: "bg-danger-surface text-danger",
};

export function Alert({ title, tone = "info", children, className, ...props }: HTMLAttributes<HTMLDivElement> & { title: string; tone?: "info" | "success" | "warning" | "danger" }) {
  const Icon = icons[tone];
  return (
    <div
      className={cn("flex animate-fade-in items-start gap-3 rounded-lg border border-border bg-card p-3 text-sm text-foreground shadow-xs", className)}
      role={tone === "danger" ? "alert" : "status"}
      {...props}
    >
      <span aria-hidden="true" className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", badges[tone])} data-alert-badge>
        <Icon className="size-3.5" data-alert-icon />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5 pt-0.5">
        <p className="text-[13px] font-medium leading-5">{title}</p>
        {children && <div className="text-[13px] leading-relaxed text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}
