import { useRef, type ComponentType, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";

export interface TabItemDefinition {
  id: string;
  label: string;
  /** Optional count shown after the label, for example how many records a section holds. */
  count?: number;
  /** Optional mark drawn before the label, so a tab is recognisable at a glance. */
  icon?: ComponentType<{ className?: string }>;
}

export type TabsVariant = "segmented" | "underline";

/**
 * WAI-ARIA tabs: a roving-tabindex tab list plus panels that unmount when
 * inactive. Scrolls horizontally instead of wrapping when the list is wider
 * than its container. `segmented` is the boxed control; `underline` is a bar
 * with a hairline under it, for the top level of a page whose sections then
 * carry their own smaller filters.
 */
export function Tabs({
  items,
  value,
  onChange,
  label,
  className,
  variant = "segmented",
}: {
  items: TabItemDefinition[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  className?: string;
  variant?: TabsVariant;
}) {
  const underline = variant === "underline";
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});

  function select(index: number) {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    onChange(item.id);
    buttons.current[item.id]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = items.findIndex((item) => item.id === value);
    if (event.key === "ArrowRight") {
      event.preventDefault();
      select(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      select(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      select(0);
    } else if (event.key === "End") {
      event.preventDefault();
      select(items.length - 1);
    }
  }

  return (
    <div
      aria-label={label}
      className={cn(
        "max-w-full overflow-x-auto text-muted-foreground",
        underline ? "flex w-full items-stretch gap-5 border-b border-border" : "inline-flex h-8 w-fit items-center gap-0.5 rounded-md bg-muted/80 p-0.5",
        className,
      )}
      data-variant={variant}
      onKeyDown={onKeyDown}
      role="tablist"
    >
      {items.map((item) => {
        const active = item.id === value;
        const Icon = item.icon;
        return (
          <button
            aria-controls={`tabpanel-${item.id}`}
            aria-selected={active}
            className={cn(
              "shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap text-[13px] font-medium outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/20",
              underline
                ? "relative inline-flex h-9 rounded-sm px-0.5 transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground after:opacity-0 after:transition-opacity after:content-['']"
                : "inline-flex h-7 rounded-[5px] px-2.5 transition-[color,background-color,box-shadow]",
              active && (underline ? "text-foreground after:opacity-100" : "bg-card text-foreground shadow-xs"),
            )}
            data-state={active ? "active" : "inactive"}
            id={`tab-${item.id}`}
            key={item.id}
            onClick={() => onChange(item.id)}
            ref={(element) => {
              buttons.current[item.id] = element;
            }}
            role="tab"
            tabIndex={active ? 0 : -1}
            type="button"
          >
            {Icon && <Icon className="size-3.5 shrink-0 opacity-80" />}
            {item.label}
            {item.count !== undefined && " "}
            {item.count !== undefined && (
              <span className={cn("rounded-full px-1.5 text-[11px] font-medium tabular-nums", active ? "bg-muted text-muted-foreground" : "bg-muted-foreground/12 text-muted-foreground")}>
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, active, children, className }: { id: string; active: boolean; children: ReactNode; className?: string }) {
  if (!active) return null;
  return (
    <div aria-labelledby={`tab-${id}`} className={cn("grid gap-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/20 rounded-md", className)} id={`tabpanel-${id}`} role="tabpanel" tabIndex={0}>
      {children}
    </div>
  );
}
