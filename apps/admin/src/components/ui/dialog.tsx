import { X } from "lucide-react";
import { useCallback, useId, useRef, type ReactNode } from "react";

import { useTranslation } from "../../lib/i18n";
import { useBodyScrollLock, useEscapeKey, useFocusTrap } from "../../lib/overlay";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Portal } from "./portal";

const sizes = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof sizes;
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  const t = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useBodyScrollLock(open);
  useEscapeKey(open, onClose);
  useFocusTrap(panel, open, initialFocus);
  if (!open) return null;

  return (
    <Portal>
      <div className="fixed inset-0 z-50 grid place-items-center p-4">
        <div aria-hidden="true" className="fixed inset-0 animate-fade-in bg-black/50 backdrop-blur-xs" onClick={onClose} />
        <div
          aria-describedby={description ? descriptionId : undefined}
          aria-labelledby={titleId}
          aria-modal="true"
          className={cn("relative z-10 flex max-h-[calc(100dvh-2rem)] w-full animate-dialog-in flex-col rounded-xl border border-border bg-card text-card-foreground shadow-elevated outline-none", sizes[size])}
          ref={panel}
          role="dialog"
          tabIndex={-1}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border/60 p-4 sm:p-5">
            <div className="grid gap-1">
              <h2 className="text-sm font-medium leading-snug tracking-tight text-foreground" id={titleId}>{title}</h2>
              {description && <p className="text-[13px] leading-relaxed text-muted-foreground" id={descriptionId}>{description}</p>}
            </div>
            <Button aria-label={t("common.closeDialogAriaLabel")} className="-mr-1.5 -mt-1.5 shrink-0 text-muted-foreground hover:text-foreground" onClick={onClose} size="icon-sm" variant="ghost">
              <X aria-hidden="true" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5" data-dialog-body>{children}</div>
          {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/60 bg-muted/30 p-3 sm:px-5 sm:py-3">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "default",
  pending = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const t = useTranslation();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    if (!pending) onCancel();
  }, [onCancel, pending]);

  return (
    <Dialog
      initialFocus={cancelButton}
      onClose={close}
      open={open}
      size="sm"
      title={title}
      {...(description === undefined ? {} : { description })}
      footer={
        <>
          <Button disabled={pending} onClick={close} ref={cancelButton} variant="ghost">
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button disabled={pending} onClick={onConfirm} variant={tone === "danger" ? "destructive" : "default"}>
            {pending ? t("common.working") : (confirmLabel ?? t("common.confirm"))}
          </Button>
        </>
      }
    >
      {children ?? <p className="text-sm leading-relaxed text-muted-foreground">{t("common.confirmDialogDefaultDescription")}</p>}
    </Dialog>
  );
}
