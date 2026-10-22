import { cn } from "../../lib/utils";
import { CopyButton } from "./copy-button";

/** A sentence to say to a connected AI, drawn as a chat bubble with its own copy control. */
export function ExampleBubble({ text, copyLabel, className }: { text: string; copyLabel: string; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-2xl rounded-bl-md border border-border/70 bg-card px-3.5 py-2.5 text-left shadow-xs", className)}>
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">{text}</p>
      <span className="group/copy -mr-1 inline-flex shrink-0">
        <CopyButton className="opacity-100" label={copyLabel} value={text} />
      </span>
    </div>
  );
}
