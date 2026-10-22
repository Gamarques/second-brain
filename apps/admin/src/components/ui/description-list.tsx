import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../../lib/utils";

/** Label/value pairs in two aligned columns, for record details and metadata. */
export function DescriptionList({ className, ...props }: HTMLAttributes<HTMLDListElement>) {
  return <dl className={cn("grid grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm", className)} {...props} />;
}

export function DescriptionItem({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words text-foreground", className)}>{children}</dd>
    </>
  );
}
