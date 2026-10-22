import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/utils";

/**
 * Shared button recipe (shadcn "new-york" sizing). Also applied to router
 * links and anchors through `ButtonLink` / `ExternalButtonLink`, so a link
 * that looks like a button never drifts from a real button.
 */
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-[13px] font-medium tracking-[-0.006em] transition-[color,background-color,border-color,box-shadow] duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-[inset_0_1px_0_0_rgb(255_255_255/0.14),0_1px_2px_0_rgb(0_0_0/0.16)] hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-muted",
        outline: "border border-input bg-card text-foreground shadow-xs hover:border-foreground/20 hover:bg-muted/50",
        ghost: "text-foreground hover:bg-muted/70",
        destructive: "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/25",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 gap-1.5 px-2.5 text-xs",
        lg: "h-9 px-4 text-sm [&_svg:not([class*='size-'])]:size-4",
        icon: "size-8 [&_svg:not([class*='size-'])]:size-4",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & ButtonVariantProps & { loading?: boolean }
>(function Button({ className, variant, size, type = "button", loading = false, disabled, children, ...props }, ref) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled ?? loading}
      ref={ref}
      type={type}
      {...props}
    >
      {loading && <LoaderCircle aria-hidden="true" className="animate-spin" />}
      {children}
    </button>
  );
});
