import { ArrowRight, Check, Plug } from "lucide-react";

import { ErrorState, PageSkeleton } from "../components/async-state";
import { Page, PageHeader } from "../components/page";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { ButtonLink } from "../components/ui/button-link";
import { Card, CardContent, CardDescription, CardHeader, CardHeaderText, CardTitle } from "../components/ui/card";
import { useTranslation } from "../lib/i18n";
import { useOnboardingProgress, type OnboardingStep } from "../lib/onboarding";
import { cn } from "../lib/utils";

export function GettingStartedPage() {
  const t = useTranslation();
  const progress = useOnboardingProgress();

  if (progress.isLoading) return <PageSkeleton cards={1} label={t("onboarding.loading")} />;
  if (progress.isError) return <ErrorState error={progress.error} retry={progress.refetch} />;

  return (
    <Page>
      <PageHeader description={t("onboarding.pageDescription")} title={t("nav.gettingStarted.label")} />
      {progress.warnings.map((warning) => (
        <Alert key={warning.id} title={warning.title} tone="warning">
          <p>{warning.description}</p>
          <ButtonLink className="mt-3" size="sm" to={warning.to} variant="outline">
            {warning.linkLabel} <ArrowRight aria-hidden="true" />
          </ButtonLink>
        </Alert>
      ))}
      {progress.allComplete && (
        <Alert title={t("onboarding.progress.allComplete.title")} tone="success">
          {t("onboarding.progress.allComplete.body")}
        </Alert>
      )}
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <CardHeaderText>
            <CardTitle>{t("onboarding.required.title")}</CardTitle>
            <CardDescription>{t("onboarding.required.description")}</CardDescription>
          </CardHeaderText>
          <Badge className="sm:mt-0.5" dot tone={progress.required.every((step) => step.complete) ? "success" : "neutral"}>
            {t("onboarding.progress.summary", { count: progress.totalCount, completed: progress.completedCount, total: progress.totalCount })}
          </Badge>
        </CardHeader>
        <CardContent className="grid gap-3">
          {progress.required.map((step, index) => (
            <StepRow index={index} key={step.id} step={step} />
          ))}
        </CardContent>
      </Card>
      <Card className={progress.connect.complete ? undefined : "border-primary/40 shadow-sm"}>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border",
                progress.connect.complete ? "border-transparent bg-success-surface text-success" : "border-primary/30 bg-primary/10 text-primary",
              )}
            >
              {progress.connect.complete ? <Check className="size-4" /> : <Plug className="size-4" />}
            </span>
            <CardHeaderText>
              <CardTitle>{t("onboarding.connect.sectionTitle")}</CardTitle>
              <CardDescription>{t("onboarding.connect.description")}</CardDescription>
            </CardHeaderText>
          </div>
          <div className="flex shrink-0 items-center gap-2 pl-12 sm:pl-0">
            <Badge tone={progress.connect.complete ? "success" : "neutral"}>
              {progress.connect.complete ? t("onboarding.step.completeBadge") : t("onboarding.step.incompleteBadge")}
            </Badge>
            <ButtonLink size="sm" to="/connect" variant={progress.connect.complete ? "outline" : "default"}>
              {t("onboarding.connect.linkLabel")} <ArrowRight aria-hidden="true" />
            </ButtonLink>
          </div>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("onboarding.optional.title")}</CardTitle>
          <CardDescription>{t("onboarding.optional.description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {progress.optional.map((step, index) => (
            <StepRow index={index} key={step.id} step={step} />
          ))}
        </CardContent>
      </Card>
    </Page>
  );
}

function StepRow({ step, index }: { step: OnboardingStep; index: number }) {
  const t = useTranslation();
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4 transition-colors sm:flex-row sm:items-center sm:justify-between",
        "border-border bg-card",
      )}
    >
      <div className="flex gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
            step.complete ? "border-transparent bg-success-surface text-success" : "border-border bg-muted/60 text-muted-foreground",
          )}
        >
          {step.complete ? <Check className="size-3.5" /> : index + 1}
        </span>
        <div className="grid gap-1">
          <p className="text-sm font-medium text-foreground">{step.title}</p>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">{step.description}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-9 sm:pl-4">
        <Badge tone={step.complete ? "success" : "neutral"}>{step.complete ? t("onboarding.step.completeBadge") : t("onboarding.step.incompleteBadge")}</Badge>
        <ButtonLink size="sm" to={step.to} variant="outline">
          {step.linkLabel} <ArrowRight aria-hidden="true" />
        </ButtonLink>
      </div>
    </div>
  );
}
