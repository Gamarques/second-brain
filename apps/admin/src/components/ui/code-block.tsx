import { cn } from "../../lib/utils";
import { CopyButton } from "./copy-button";

/** The quiet mono surface shared by code blocks and single-line addresses. */
export const codeSurfaceClass = "rounded-lg border border-border bg-code text-code-foreground";

/**
 * A code block with its copy control inside, top-right. The block carries the
 * accessible name so a caption above it is never read twice, and it stays
 * keyboard reachable because it can scroll.
 */
export function CodeBlock({
  value,
  label,
  copyLabel,
  wrap = true,
  maxHeightClassName = "max-h-80",
  className,
}: {
  value: string;
  label: string;
  copyLabel: string;
  /** Wrap long lines (commands, prompts) instead of scrolling sideways. */
  wrap?: boolean;
  maxHeightClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn("group/copy relative min-w-0", className)}>
      <pre
        aria-label={label}
        className={cn(
          "overflow-auto py-3 pl-3.5 pr-11 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/20",
          codeSurfaceClass,
          maxHeightClassName,
          wrap && "whitespace-pre-wrap break-words",
        )}
        role="region"
        tabIndex={0}
      >
        <code>{value}</code>
      </pre>
      <CopyButton
        className="absolute right-1.5 top-1.5 size-7 rounded-md border border-border bg-card text-muted-foreground opacity-100 shadow-xs hover:bg-muted hover:text-foreground"
        label={copyLabel}
        value={value}
      />
    </div>
  );
}
