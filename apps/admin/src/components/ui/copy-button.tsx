import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../../lib/i18n";
import { cn } from "../../lib/utils";

export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
  const t = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const resolvedLabel = label ?? t("common.id.value");

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    try {
      await clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_800);
    } catch {
      // Clipboard access can be denied; the value stays selectable on the page.
    }
  }

  return (
    <button
      aria-label={copied ? t("common.copiedAriaLabel", { label: resolvedLabel }) : t("common.copyAriaLabel", { label: resolvedLabel })}
      className={cn(
        "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 transition-all hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 group-hover/copy:opacity-100",
        copied && "text-success opacity-100",
        className,
      )}
      onClick={() => void copy()}
      type="button"
    >
      {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
    </button>
  );
}

export function CopyableId({ value, label, className }: { value: string; label?: string; className?: string }) {
  const t = useTranslation();
  return (
    <span className={cn("group/copy inline-flex max-w-full items-center gap-1", className)}>
      <code className="truncate font-mono text-xs text-muted-foreground">{value}</code>
      <CopyButton label={label ?? t("common.id.identifier")} value={value} />
    </span>
  );
}
