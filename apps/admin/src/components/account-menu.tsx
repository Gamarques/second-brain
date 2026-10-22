import { LogOut } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { AdminIdentity } from "../lib/api-types";
import { useTranslation } from "../lib/i18n";
import { signOutOAuth } from "../lib/oauth";
import { useEscapeKey } from "../lib/overlay";
import { cn } from "../lib/utils";
import { LocaleToggle } from "./locale-toggle";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";

/** The first letter of whoever is signed in, for the round avatar. */
export function identityInitial(identity?: AdminIdentity): string {
  const source = identity?.email?.trim() || identity?.role || "";
  return (source.slice(0, 1) || "?").toUpperCase();
}

/**
 * The round avatar in the header. It opens a small non-modal popover with
 * the signed-in identity, the theme and language choices, and sign out, so
 * the header itself stays down to search and the ask panel.
 */
export function AccountMenu({ identity, className }: { identity?: AdminIdentity | undefined; className?: string }) {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }, []);
  useEscapeKey(open, close);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const roleLabel = identity ? t(`status.role.${identity.role}`) : t("shell.roleFallback");

  return (
    <div className={cn("relative", className)} ref={root}>
      <button
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("shell.accountMenu")}
        className={cn(
          "aurora flex size-8 cursor-pointer items-center justify-center rounded-full text-xs font-semibold ring-offset-frame transition-shadow hover:ring-2 hover:ring-ring/20 hover:ring-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-2",
          open && "ring-2 ring-ring/20 ring-offset-2",
        )}
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
        type="button"
      >
        {identityInitial(identity)}
      </button>
      {open && (
        <div
          aria-label={t("shell.accountMenu")}
          className="absolute right-0 top-full z-50 mt-2 w-72 animate-dialog-in rounded-xl border border-border bg-elevated p-1.5 text-foreground shadow-elevated"
          id={id}
          role="dialog"
        >
          <div className="flex items-center gap-3 rounded-lg px-2.5 py-2">
            <div className="aurora flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold">{identityInitial(identity)}</div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium leading-tight text-foreground">{identity?.email ?? t("shell.activeSessionFallback")}</p>
              <p className="truncate text-xs capitalize text-muted-foreground">{roleLabel}</p>
            </div>
          </div>
          <div className="my-1 h-px bg-border" />
          <div className="grid gap-2 px-2.5 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{t("themeToggle.groupLabel")}</span>
              <ThemeToggle className="h-8" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{t("language.groupLabel")}</span>
              <LocaleToggle className="h-8" />
            </div>
          </div>
          <div className="my-1 h-px bg-border" />
          <Button className="w-full justify-start px-2.5 text-foreground/85 hover:text-foreground" onClick={() => void signOutOAuth()} size="sm" variant="ghost">
            <LogOut aria-hidden="true" className="text-muted-foreground" />
            {t("shell.signOut")}
          </Button>
        </div>
      )}
    </div>
  );
}
