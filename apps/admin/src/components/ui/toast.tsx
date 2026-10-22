import { AlertCircle, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useTranslation } from "../../lib/i18n";
import { cn } from "../../lib/utils";

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  duration?: number;
}

interface ToastRecord extends ToastInput {
  id: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
const defaultDuration = 5_000;

const toneIcons = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: AlertCircle };
/** Like `Alert`: a neutral surface, the tone on the icon badge only. */
const toneStyles: Record<ToastTone, string> = {
  info: "bg-info-surface text-info",
  success: "bg-success-surface text-success",
  warning: "bg-warning-surface text-warning",
  danger: "bg-danger-surface text-danger",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTranslation();
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = `toast-${Math.random().toString(36).slice(2)}`;
      const record: ToastRecord = { tone: "info", ...input, id };
      setToasts((current) => [...current.slice(-3), record]);
      const duration = input.duration ?? defaultDuration;
      if (duration > 0) {
        timers.current.set(id, setTimeout(() => dismiss(id), duration));
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext value={value}>
      {children}
      <div aria-label={t("toast.notificationsAriaLabel")} className="pointer-events-none fixed inset-x-0 bottom-0 z-60 flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end" role="region">
        {toasts.map((entry) => {
          const Icon = toneIcons[entry.tone];
          return (
            <div
              aria-live={entry.tone === "danger" ? "assertive" : "polite"}
              className="pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-3 rounded-lg border border-border bg-elevated p-3 text-foreground shadow-elevated backdrop-blur-sm"
              key={entry.id}
              role={entry.tone === "danger" ? "alert" : "status"}
            >
              <span aria-hidden="true" className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", toneStyles[entry.tone])} data-toast-badge>
                <Icon className="size-3.5" data-toast-icon />
              </span>
              <div className="grid min-w-0 flex-1 gap-0.5 pt-0.5">
                <p className="text-[13px] font-medium leading-5">{entry.title}</p>
                {entry.description && <p className="text-xs leading-relaxed text-muted-foreground">{entry.description}</p>}
              </div>
              <button
                aria-label={t("toast.dismissAriaLabel")}
                className="-m-1 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                onClick={() => dismiss(entry.id)}
                type="button"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside a ToastProvider.");
  return value;
}
