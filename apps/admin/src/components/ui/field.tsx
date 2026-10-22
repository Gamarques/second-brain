import { Check, ChevronDown } from "lucide-react";
import { Children, cloneElement, isValidElement, type InputHTMLAttributes, type LabelHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

import { cn } from "../../lib/utils";

/**
 * Always walks the children, even when there is nothing to describe: `Children.map`
 * re-keys what it returns, so mapping only sometimes would remount the control
 * (and lose its focus) the moment a hint or error appeared.
 */
function describeControl(children: ReactNode, htmlFor: string, descriptionId: string | undefined, invalid: boolean): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const element = child as ReactElement<{ id?: string; children?: ReactNode; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
    if (element.props.id === htmlFor) {
      const describedBy = [element.props["aria-describedby"], descriptionId].filter(Boolean).join(" ");
      return cloneElement(element, {
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(invalid ? { "aria-invalid": true } : {}),
      });
    }
    if (element.props.children === undefined) return child;
    return cloneElement(element, {
      children: describeControl(element.props.children, htmlFor, descriptionId, invalid),
    });
  });
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-[13px] font-medium leading-none text-foreground select-none", className)} {...props} />;
}

export function Field({ label, htmlFor, hint, error, className, children }: { label: string; htmlFor: string; hint?: string; error?: string | null; className?: string; children: ReactNode }) {
  const descriptionId = `${htmlFor}-description`;
  const hasDescription = Boolean(error ?? hint);
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {describeControl(children, htmlFor, hasDescription ? descriptionId : undefined, Boolean(error))}
      {hasDescription && (
        <p className={cn("text-xs leading-relaxed", error ? "font-medium text-destructive" : "text-muted-foreground")} id={descriptionId} role={error ? "alert" : undefined}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

const control =
  "flex h-8 w-full min-w-0 rounded-md border border-input bg-card px-2.5 py-1 text-sm text-foreground transition-[color,box-shadow,border-color] outline-none placeholder:text-muted-foreground/60 hover:border-foreground/20 focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring/10 aria-invalid:border-destructive aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-20 resize-y py-2 leading-relaxed", className)} {...props} />;
}

/**
 * A native `<select>` with a consistent chevron. `className` sizes the
 * wrapper (for example `sm:w-52`); the control always fills it.
 */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cn("relative grid w-full", className)}>
      <select className={cn(control, "cursor-pointer appearance-none pr-9")} {...props} />
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}

/**
 * A labelled checkbox. `variant="card"` (default) draws a bordered row for
 * settings; `variant="inline"` is a bare label for filters and toolbars.
 */
export function Checkbox({
  label,
  description,
  className,
  variant = "card",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string; variant?: "card" | "inline" }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 select-none",
        variant === "card" && "rounded-lg border border-border bg-card p-3 transition-colors hover:bg-muted/40 has-[:checked]:border-foreground/25",
        variant === "inline" && "items-center",
        props.disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <input
          className="peer absolute inset-0 size-4 cursor-pointer appearance-none rounded-[4px] border border-input bg-card transition-colors outline-none checked:border-primary checked:bg-primary focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed"
          type="checkbox"
          {...props}
        />
        <Check aria-hidden="true" className="pointer-events-none relative size-3 text-primary-foreground opacity-0 transition-opacity peer-checked:opacity-100" strokeWidth={3} />
      </span>
      <span className={cn("min-w-0", variant === "card" ? "grid gap-1" : "flex flex-wrap items-baseline gap-x-2 gap-y-0.5")}>
        <span className="text-[13px] font-medium leading-none text-foreground">{label}</span>
        {description && <span className={cn("text-xs leading-relaxed text-muted-foreground", variant === "inline" && "hidden sm:inline")}>{description}</span>}
      </span>
    </label>
  );
}
