import type { TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

import { useTranslation } from "../../lib/i18n";
import { cn } from "../../lib/utils";

type TableProps = TableHTMLAttributes<HTMLTableElement> & { scrollLabel?: string; containerClassName?: string };

export function Table({ className, scrollLabel, containerClassName, ...props }: TableProps) {
  const t = useTranslation();
  return (
    <div
      aria-label={scrollLabel ?? t("common.table.defaultScrollLabel")}
      className={cn("relative w-full overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/20", containerClassName)}
      role="region"
      tabIndex={0}
    >
      <table className={cn("w-full min-w-[640px] caption-bottom border-collapse text-sm text-foreground", className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "sticky top-0 z-10 h-9 whitespace-nowrap border-b border-border bg-card/95 px-3 text-left align-middle text-xs font-medium text-muted-foreground/90 backdrop-blur-sm",
        className,
      )}
      scope="col"
      {...props}
    />
  );
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("border-b border-border px-3 py-2.5 align-middle", className)} {...props} />;
}

export function Tr({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("transition-colors hover:bg-muted/40 [&:last-child>td]:border-0", className)} {...props} />;
}
