import { cn } from "../../lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-shimmer rounded-md bg-muted", className)} />;
}

export function MetricsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <div className="rounded-xl border border-border bg-card p-4 shadow-card" key={index}>
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="mt-3 h-7 w-20" />
          <Skeleton className="mt-3 h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-border bg-card p-4 shadow-card sm:p-5", className)}>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-2.5 h-3 w-64 max-w-full" />
      <div className="mt-5 grid gap-3">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton className="h-3" key={index} />
        ))}
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div aria-hidden="true" className="grid gap-px bg-border/60">
      <div className="grid h-10 items-center gap-4 bg-muted/30 px-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton className="h-3 w-20" key={index} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div className="grid gap-4 bg-card px-4 py-4" key={rowIndex} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {Array.from({ length: columns }, (_, index) => (
            <Skeleton className={cn("h-3", index === 0 ? "w-full" : "w-2/3")} key={index} />
          ))}
        </div>
      ))}
    </div>
  );
}
