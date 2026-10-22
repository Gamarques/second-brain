import { Inbox, LoaderCircle, RefreshCw, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ApiError } from "../lib/api";
import { useTranslation } from "../lib/i18n";
import { cn } from "../lib/utils";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { ExampleBubble } from "./ui/example-bubble";
import { TextLink } from "./ui/link";
import { GlossaryTerm } from "./ui/glossary-term";
import { CardSkeleton, MetricsSkeleton, Skeleton, TableSkeleton } from "./ui/skeleton";

export function LoadingState({ label, className }: { label?: string; className?: string }) {
  const t = useTranslation();
  return (
    <div aria-live="polite" className={cn("flex min-h-32 items-center justify-center gap-3 text-sm text-muted-foreground", className)}>
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-muted-foreground/80" />
      <span>{label ?? t("asyncState.loadingDefault")}…</span>
    </div>
  );
}

export function TableLoading({ label, rows = 5, columns = 5 }: { label?: string; rows?: number; columns?: number }) {
  const t = useTranslation();
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{label ?? t("asyncState.loadingRowsDefault")}…</span>
      <TableSkeleton columns={columns} rows={rows} />
    </div>
  );
}

export function PageSkeleton({ label, metrics = 0, cards = 2 }: { label?: string; metrics?: number; cards?: number }) {
  const t = useTranslation();
  return (
    <div aria-busy="true" aria-live="polite" className="grid gap-5">
      <span className="sr-only">{label ?? t("asyncState.loadingDefault")}…</span>
      <div>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-2.5 h-3 w-80 max-w-full" />
      </div>
      {metrics > 0 && <MetricsSkeleton count={metrics} />}
      <div className="grid gap-5">
        {Array.from({ length: cards }, (_, index) => (
          <CardSkeleton key={index} lines={index === 0 ? 4 : 3} />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const t = useTranslation();
  const message = error instanceof Error ? error.message : t("asyncState.error.unexpected");
  const conflict = error instanceof ApiError && error.conflict;
  const title = conflict ? t("asyncState.error.conflictTitle") : t("asyncState.error.title");
  return (
    <Alert title={title} tone="danger">
      <p>{message}</p>
      {conflict && (
        <p className="mt-1">
          <GlossaryTerm id="expectedRevision" variant="text">{t("common.whatIsThis")}</GlossaryTerm>
        </p>
      )}
      {retry && (
        <Button className="mt-3" onClick={retry} size="sm" variant="outline">
          <RefreshCw aria-hidden="true" />
          {t("asyncState.error.retry")}
        </Button>
      )}
    </Alert>
  );
}

/**
 * An empty list. When `example` is given, the state also teaches the one
 * sentence to say to a connected AI so the list fills itself, because that
 * conversation is how most records reach this brain.
 */
export function EmptyState({
  title,
  description,
  action,
  example,
  icon: Icon = Inbox,
  illustration,
  variant = "boxed",
  className,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  example?: string | undefined;
  icon?: LucideIcon;
  /** A drawing from `components/illustrations`; replaces the icon disc. */
  illustration?: ReactNode;
  /** `plain` drops the dashed box, for an empty list that already sits inside a card. */
  variant?: "boxed" | "plain";
  className?: string;
}) {
  const t = useTranslation();
  return (
    <div className={cn("grid min-h-36 place-items-center px-6 py-8 text-center", variant === "boxed" && "rounded-xl border border-dashed border-border bg-card/40", className)}>
      <div className="flex max-w-sm flex-col items-center">
        {illustration ? (
          <div className="mb-4 text-muted-foreground [&>svg]:h-24 [&>svg]:w-auto" data-illustration="">
            {illustration}
          </div>
        ) : (
          <div className="aurora-soft mb-3 flex size-9 items-center justify-center rounded-full text-foreground">
            <Icon aria-hidden="true" className="size-4" />
          </div>
        )}
        <h2 className="text-sm font-medium tracking-tight text-foreground">{title}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        {action && <div className="mt-4">{action}</div>}
        {example && (
          <div className="mt-5 w-full max-w-sm text-left">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t("emptyState.sayToAi")}</p>
            <ExampleBubble copyLabel={t("emptyState.copyExample")} text={example} />
            <p className="mt-2 text-xs text-muted-foreground">
              <TextLink to="/connect">{t("nav.connect.label")}</TextLink>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
