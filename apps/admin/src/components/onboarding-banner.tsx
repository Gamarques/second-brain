import { ArrowRight, Sparkles } from "lucide-react";

import { useTranslation } from "../lib/i18n";
import { useOnboardingProgress } from "../lib/onboarding";
import { ButtonLink } from "./ui/button-link";

/**
 * Status's single next action, derived from live setup data. It is not
 * dismissible: a founder who is not done still needs one obvious step.
 */
export function OnboardingBanner() {
  const t = useTranslation();
  const progress = useOnboardingProgress();
  const next = progress.next;

  if (progress.isLoading || progress.isError || progress.allComplete || !next) return null;

  return (
    <div className="aurora-soft flex animate-fade-in flex-col gap-4 rounded-xl border border-border/70 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden="true" className="aurora flex size-9 shrink-0 items-center justify-center rounded-md shadow-xs">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="aurora-text w-fit text-xs font-semibold">{t("dashboard.nextStep.title")}</p>
          <p className="mt-1 text-sm font-medium text-foreground">{next.title}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{next.description}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-12 sm:pl-0">
        <ButtonLink size="sm" to={next.to}>
          {next.linkLabel} <ArrowRight aria-hidden="true" />
        </ButtonLink>
        <ButtonLink size="sm" to="/getting-started" variant="ghost">
          {t("dashboard.nextStep.seeAll")}
        </ButtonLink>
      </div>
    </div>
  );
}
