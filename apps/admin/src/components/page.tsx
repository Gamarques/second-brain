import { ArrowLeft, type LucideIcon } from "lucide-react";
import { Children, Fragment, type ComponentProps, type ComponentType, type HTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { cn } from "../lib/utils";

/**
 * The root of every routed page: the vertical rhythm between its blocks. The
 * container width belongs to the shell's `<main>`, so no page sets one, and
 * no block may widen it — a wide table scrolls inside its own box instead.
 */
export function Page({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid w-full gap-6 *:min-w-0", className)} {...props} />;
}

/**
 * The page's title block. `back` renders a consistent "return to the list"
 * link above the title on detail pages; `eyebrow` is a short label (or an
 * identifier) above it; `actions` sit on the right, wrapping under the
 * text on small screens; `meta` sits under the description for badges.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  back,
  meta,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  back?: { to: string; label: string };
  meta?: ReactNode;
}) {
  return (
    <header className="relative isolate grid gap-3">
      <div aria-hidden="true" className="aurora-glow page-aurora" />
      {back && (
        <Link
          className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
          to={back.to}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <div className={cn("mb-1.5 flex min-w-0 items-center gap-2 text-[11px] font-medium text-muted-foreground", typeof eyebrow === "string" && "uppercase tracking-wider")}>
              {eyebrow}
            </div>
          )}
          <h1 className="text-xl font-medium leading-tight tracking-[-0.02em] text-foreground sm:text-[22px]">{title}</h1>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{description}</p>
          {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

const metricTones = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success-surface text-success",
  warning: "bg-warning-surface text-warning",
  danger: "bg-danger-surface text-danger",
  info: "bg-info-surface text-info",
};

export function Metric({
  label,
  value,
  detail,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  tone?: keyof typeof metricTones;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-card transition-[border-color,box-shadow] duration-200 hover:border-foreground/15">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        {Icon && (
          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", metricTones[tone])}>
            <Icon aria-hidden="true" className="size-3.5" />
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-medium leading-none tabular-nums tracking-[-0.02em] text-foreground">{value}</div>
      {detail && <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{detail}</div>}
    </div>
  );
}

/** A titled group of content on a page, for cards that share one heading. */
export function Section({ title, description, actions, children, className }: { title: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("grid gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium tracking-[-0.01em] text-foreground">{title}</h2>
          {description && <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A bordered list that stacks rows with dividers, the shape used for records on every page. */
export function ListCard({ className, ...props }: React.HTMLAttributes<HTMLUListElement>) {
  return <ul className={cn("divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-card", className)} {...props} />;
}

/** A row inside `ListCard`; also the hover group that reveals its `RowActions`. */
export function ListRow({ className, ...props }: React.LiHTMLAttributes<HTMLLIElement>) {
  return <li className={cn("group/row relative grid gap-2 px-3 py-3 transition-colors hover:bg-muted/25 sm:px-4", className)} {...props} />;
}

/**
 * The quiet line under a row's content: small, muted, items separated by a
 * middot. Falsy children are skipped so callers can render items conditionally.
 */
export function Meta({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const items = Children.toArray(children);
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-5 text-muted-foreground", className)} {...props}>
      {items.map((item, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden="true" className="select-none text-muted-foreground/40">·</span>}
          {item}
        </Fragment>
      ))}
    </div>
  );
}

const metaTones = {
  neutral: "",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
};

/** One item of a `Meta` line; an optional glyph sits before the text at 12px. */
export function MetaItem({
  icon: Icon,
  tone = "neutral",
  truncate = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { icon?: ComponentType<{ className?: string }> | undefined; tone?: keyof typeof metaTones | undefined; truncate?: boolean }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:opacity-70", metaTones[tone], truncate && "max-w-full", className)} {...props}>
      {Icon && <Icon aria-hidden="true" />}
      {truncate ? <span className="truncate">{children}</span> : children}
    </span>
  );
}

/**
 * Secondary actions on a row (edit, delete, configure). Hidden until the row is
 * hovered or focused, so idle lists stay quiet; always shown where there is no
 * hover to speak of. Primary actions never go in here.
 */
export function RowActions({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative z-10 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** A link that stretches over its whole `ListRow`, so the row itself is the destination. */
export function RowLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link className={cn("rounded-sm outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring/20", className)} {...props} />;
}
