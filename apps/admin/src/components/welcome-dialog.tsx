import { Brain, Plug, Sparkles, type LucideIcon } from "lucide-react";

import { useTranslation } from "../lib/i18n";
import type { OnboardingStep } from "../lib/onboarding";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

/**
 * A single, short, skippable orientation shown once on first login.
 * It teaches the job — what this is, finish setup, connect an AI app —
 * not the chrome of the console.
 */
export function WelcomeDialog({ open, onClose, onStart, nextStep }: { open: boolean; onClose: () => void; onStart: () => void; nextStep?: OnboardingStep | null }) {
  const t = useTranslation();
  const points: Array<{ icon: LucideIcon; title: string; body: string }> = [
    { icon: Brain, title: t("welcome.point.sidebar.title"), body: t("welcome.point.sidebar.body") },
    { icon: Sparkles, title: t("welcome.point.search.title"), body: t("welcome.point.search.body") },
    { icon: Plug, title: t("welcome.point.appearance.title"), body: t("welcome.point.appearance.body") },
  ];

  return (
    <Dialog
      description={nextStep ? t("welcome.description.next", { step: nextStep.title }) : t("welcome.description")}
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            {t("welcome.secondaryCta")}
          </Button>
          <Button onClick={onStart}>{nextStep?.linkLabel ?? t("welcome.primaryCta")}</Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={t("welcome.title")}
    >
      <ul className="grid gap-4">
        {points.map((point) => (
          <li className="flex gap-3" key={point.title}>
            <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/60 text-foreground">
              <point.icon className="size-4 opacity-85" />
            </span>
            <div className="grid gap-1">
              <p className="text-sm font-medium text-foreground">{point.title}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{point.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
