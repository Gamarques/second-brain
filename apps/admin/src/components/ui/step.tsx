import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/** One numbered step of a guided flow; the disc becomes a check once the step is done. Stack steps inside a divided card. */
export function Step({ number, title, done = false, muted = false, children }: { number: number; title: string; done?: boolean; muted?: boolean; children?: ReactNode }) {
  return (
    <div className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-3 p-4 sm:gap-4 sm:p-5", muted && "opacity-60")}>
      <span
        aria-hidden="true"
        className={cn(
          "mt-px flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums",
          done ? "border-transparent bg-success-surface text-success" : "border-border text-muted-foreground",
        )}
      >
        {done ? <Check className="size-3.5" /> : number}
      </span>
      <div className="grid min-w-0 gap-3">
        <h2 className="text-sm font-medium leading-6 text-foreground">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function StepHint({ children }: { children: ReactNode }) {
  return <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">{children}</p>;
}
