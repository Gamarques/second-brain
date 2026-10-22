import { ArrowUp, LoaderCircle, Square, type LucideIcon } from "lucide-react";
import { forwardRef, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Link } from "react-router-dom";

import { cn } from "../../lib/utils";

type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "onSubmit" | "className">;

export interface ComposerProps extends TextareaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Shown while a question is in flight; the send button becomes a stop button. */
  busy?: boolean;
  onStop?: () => void;
  submitLabel: string;
  stopLabel?: string;
  /** `card` is the tall composer for a page; `pill` is the single-row field for a panel. */
  variant?: "card" | "pill";
  /** Context chips shown at the bottom-left of a card or the left of a pill. */
  leading?: ReactNode;
  /** A short muted line under the composer, for cost notes. */
  footnote?: ReactNode;
  className?: string;
}

/**
 * A floating message box: a soft, borderless surface with the question on
 * top and a round send button. Enter sends; Shift+Enter breaks the line.
 * Used by Home, the ask panel, and the folder question, so every place that
 * asks the brain looks and behaves the same.
 */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { value, onChange, onSubmit, busy = false, onStop, submitLabel, stopLabel, variant = "card", leading, footnote, className, disabled, ...props },
  ref,
) {
  const canSend = !busy && !disabled && value.trim() !== "";

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    props.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  }

  const pill = variant === "pill";
  const button = busy ? (
    <button
      aria-label={stopLabel ?? submitLabel}
      className="composer-button bg-primary text-primary-foreground hover:bg-primary/90"
      onClick={onStop}
      type="button"
    >
      {onStop ? <Square aria-hidden="true" className="size-3" strokeWidth={2.5} /> : <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />}
    </button>
  ) : (
    <button
      aria-label={submitLabel}
      className="composer-button aurora hover:brightness-110 disabled:bg-none disabled:bg-muted-foreground/25 disabled:text-background"
      disabled={!canSend}
      type="submit"
    >
      <ArrowUp aria-hidden="true" className="size-4" strokeWidth={2.25} />
    </button>
  );

  return (
    <div className={cn("grid gap-2", className)}>
      <div
        className={cn(
          "composer flex bg-card text-foreground shadow-float ring-1 ring-border/70 transition-[box-shadow,ring-color] duration-200 focus-within:ring-foreground/20",
          pill ? "items-end gap-2 rounded-[1.5rem] py-1.5 pl-4 pr-1.5" : "flex-col rounded-[1.625rem] p-2",
        )}
      >
        {pill && leading}
        <textarea
          className={cn(
            "composer-input w-full resize-none bg-transparent leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60",
            pill ? "max-h-40 min-h-9 py-2 text-sm" : "max-h-64 min-h-[3.25rem] px-3 pb-1 pt-2.5 text-base",
          )}
          disabled={disabled}
          ref={ref}
          rows={1}
          {...props}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          value={value}
        />
        {pill ? (
          <span className="shrink-0 self-end pb-px">{button}</span>
        ) : (
          <div className="flex items-center gap-1.5 pl-1">
            {leading}
            <span className="ml-auto">{button}</span>
          </div>
        )}
      </div>
      {footnote && <p className={cn("text-[11px] leading-relaxed text-muted-foreground", !pill && "text-center")}>{footnote}</p>}
    </div>
  );
});

const chipClass = "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0";

/** A small context marker in the composer footer, optionally a link or a button. */
export function ComposerChip({
  icon: Icon,
  children,
  to,
  onClick,
  className,
  ...props
}: {
  icon?: LucideIcon;
  children: ReactNode;
  to?: string;
  onClick?: () => void;
  className?: string;
  "aria-label"?: string;
  title?: string;
}) {
  const content = (
    <>
      {Icon && <Icon aria-hidden="true" />}
      <span className="truncate">{children}</span>
    </>
  );
  const interactive = "cursor-pointer transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20";
  if (to) {
    return (
      <Link className={cn(chipClass, interactive, className)} to={to} {...props}>
        {content}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button className={cn(chipClass, interactive, className)} onClick={onClick} type="button" {...props}>
        {content}
      </button>
    );
  }
  return (
    <span className={cn(chipClass, className)} {...props}>
      {content}
    </span>
  );
}
