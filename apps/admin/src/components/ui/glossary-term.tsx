import { HelpCircle, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { glossaryDefinitionKey, glossaryTermKey, type GlossaryId } from "../../lib/glossary";
import { useTranslation } from "../../lib/i18n";
import { useEscapeKey } from "../../lib/overlay";
import { placePopover } from "../../lib/popover";
import { cn } from "../../lib/utils";

const popoverWidth = 288;
/** Keeps the panel out of sight for the single frame before it is measured and placed. */
const offscreen: CSSProperties = { position: "fixed", top: -9999, left: -9999, width: popoverWidth };

/**
 * Inline, accessible "what does this mean?" affordance for one piece of
 * jargon. `variant="text"` (the default) makes the label itself — or
 * `children`, when given — the clickable trigger, styled with a dotted
 * underline. `variant="icon"` renders a bare (?) button meant to sit right
 * after a label that is already visible elsewhere (a table header, a
 * `<dt>`, a status badge), so nothing is duplicated.
 *
 * The definition popover is portaled to `document.body` and positioned
 * from the trigger's live bounding box (not CSS-anchored to an ancestor),
 * so it is never clipped by a scrolling table container — several call
 * sites live inside `overflow-x-auto` tables.
 */
export function GlossaryTerm({
  id,
  variant = "text",
  className,
  children,
}: {
  id: GlossaryId;
  variant?: "text" | "icon";
  className?: string;
  children?: ReactNode;
}) {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>(offscreen);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const term = t(glossaryTermKey(id));
  const definition = t(glossaryDefinitionKey(id));
  const isPlainLabel = variant === "text" && (children === undefined || typeof children === "string");

  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  useEscapeKey(open, close);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const height = panel.current?.getBoundingClientRect().height ?? 0;
      const { top, left } = placePopover(rect, { width: popoverWidth, height }, { width: window.innerWidth, height: window.innerHeight });
      setStyle({ position: "fixed", top, left, width: popoverWidth });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      setStyle(offscreen);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus({ preventScroll: true });
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <span className={cn("inline", className)}>
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-label={variant === "icon" ? t("glossary.trigger.ariaLabel", { term }) : undefined}
        className={cn(
          "cursor-help rounded-sm text-inherit outline-none focus-visible:ring-2 focus-visible:ring-ring/20",
          variant === "icon"
            ? "inline-flex h-4 w-4 shrink-0 translate-y-px items-center justify-center text-muted-foreground/70 transition-colors hover:text-foreground"
            : cn(isPlainLabel && "underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 transition-colors hover:decoration-foreground"),
        )}
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
        type="button"
      >
        {variant === "icon" ? <HelpCircle aria-hidden="true" className="h-3.5 w-3.5" /> : (children ?? term)}
      </button>
      {open &&
        createPortal(
          <div
            aria-label={term}
            className="z-70 grid w-72 animate-fade-in gap-1.5 rounded-lg border border-border bg-elevated p-4 text-left shadow-elevated"
            id={panelId}
            ref={panel}
            role="dialog"
            style={style}
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium leading-none text-foreground">{term}</p>
              <button
                aria-label={t("common.closeDialogAriaLabel")}
                className="-m-1 shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                onClick={close}
                ref={closeButton}
                type="button"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{definition}</p>
          </div>,
          document.body,
        )}
    </span>
  );
}
