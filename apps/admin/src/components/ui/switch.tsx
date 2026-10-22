import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "../../lib/utils";

type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type" | "role"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

/** An on/off control. Prefer it over a checkbox when the change takes effect right away. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch({ checked, onCheckedChange, className, disabled, ...props }, ref) {
  const state = checked ? "checked" : "unchecked";
  return (
    <button
      aria-checked={checked}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        className,
      )}
      data-state={state}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      ref={ref}
      role="switch"
      type="button"
      {...props}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-0"
        data-state={state}
      />
    </button>
  );
});

/** A labelled switch row: title and explanation on the left, the switch on the right. */
export function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  variant = "boxed",
  className,
  children,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** `plain` drops the box so the row can sit in a divided list. */
  variant?: "boxed" | "plain";
  className?: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start justify-between gap-4", variant === "boxed" ? "rounded-lg border border-border bg-card p-3" : "py-3", className)}>
      <div className="grid min-w-0 gap-1">
        <label className="cursor-pointer text-[13px] font-medium leading-none text-foreground" htmlFor={id}>{label}</label>
        {description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
        {children}
      </div>
      <Switch checked={checked} className="mt-0.5" disabled={disabled} id={id} onCheckedChange={onCheckedChange} />
    </div>
  );
}
