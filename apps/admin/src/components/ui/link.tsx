import type { AnchorHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router-dom";

import { cn } from "../../lib/utils";

const textLinkClass =
  "inline-flex w-fit max-w-full cursor-pointer items-center gap-1 rounded-sm text-sm font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 [&_svg]:size-3.5 [&_svg]:shrink-0";

/** Inline text link inside copy or a card. Use `ButtonLink` when the link is the row's action. */
export function TextLink({ className, ...props }: LinkProps) {
  return <Link className={cn(textLinkClass, className)} {...props} />;
}

/** Inline text link to another site. Always opens in a new tab. */
export function ExternalTextLink({ className, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={cn(textLinkClass, className)} rel="noopener noreferrer" target="_blank" {...props} />;
}
