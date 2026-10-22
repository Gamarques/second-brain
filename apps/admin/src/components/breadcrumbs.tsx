import { Link } from "react-router-dom";

import { useLocale, useTranslation } from "../lib/i18n";
import { breadcrumbsFor } from "../lib/navigation";
import { cn } from "../lib/utils";

/** The header trail: the brain itself, then the route. Home is the brain, so it never links to itself. */
export function Breadcrumbs({ pathname, className }: { pathname: string; className?: string }) {
  const { locale } = useLocale();
  const t = useTranslation();
  const route = breadcrumbsFor(pathname, locale);
  const home = pathname === "/" || pathname === "/ask" || pathname === "/briefing";
  const trail = home ? route : [{ label: t("shell.appName"), to: "/" }, ...route];

  return (
    <nav aria-label={t("breadcrumbs.ariaLabel")} className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {trail.map((crumb, index) => (
          <li className="flex min-w-0 items-center gap-1.5" key={`${crumb.label}-${index}`}>
            {index > 0 && <span aria-hidden="true" className="select-none text-muted-foreground/40">/</span>}
            {crumb.to ? (
              <Link className="truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20" to={crumb.to}>
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="truncate font-medium text-foreground">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
