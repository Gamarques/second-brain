import type { AnchorHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router-dom";

import { cn } from "../../lib/utils";
import { buttonVariants, type ButtonVariantProps } from "./button";

/** A router link dressed as a button, for navigation that reads as an action. */
export function ButtonLink({ className, variant, size, ...props }: LinkProps & ButtonVariantProps) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

/** An external anchor dressed as a button. Always opens in a new tab. */
export function ExternalButtonLink({ className, variant, size, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & ButtonVariantProps) {
  return <a className={cn(buttonVariants({ variant, size }), className)} rel="noopener noreferrer" target="_blank" {...props} />;
}
