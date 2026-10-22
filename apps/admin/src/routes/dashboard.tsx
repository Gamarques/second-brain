import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Layers,
  MoonStar,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Link } from "react-router-dom";

import { ErrorState, PageSkeleton } from "../components/async-state";
import { OnboardingBanner } from "../components/onboarding-banner";
import { Metric, Page, PageHeader } from "../components/page";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ButtonLink } from "../components/ui/button-link";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardHeaderText, CardTitle } from "../components/ui/card";
import { api } from "../lib/api";
import { useLocale, useTranslation } from "../lib/i18n";
import { cn, formatDate, formatNumber, formatRelativeTime } from "../lib/utils";

export function DashboardPage() {
  const { locale } = useLocale();
  const t = useTranslation();
  const query = useQuery({ queryKey: ["overview"], queryFn: ({ signal }) => api.overview(signal), refetchInterval: 30_000 });
  if (query.isPending) return <PageSkeleton cards={2} label={t("dashboard.loading")} metrics={4} />;
  if (query.isError) return <ErrorState error={query.error} retry={() => query.refetch()} />;
  const overview = query.data;
  const workersHealthy = overview.workerSummary.stale === 0 && overview.workerSummary.offline === 0 && overview.workerSummary.healthy > 0;
  const queueHealthy = overview.jobSummary.failed === 0;

  return (
    <Page>
      <PageHeader
        actions={
          <Button loading={query.isFetching} onClick={() => query.refetch()} size="sm" variant="outline">
            {!query.isFetching && <RefreshCw aria-hidden="true" />}
            {t("common.refresh")}
          </Button>
        }
        description={t("dashboard.description")}
        eyebrow={
          <>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
            {t("dashboard.updated", { time: formatRelativeTime(new Date(query.dataUpdatedAt).toISOString(), Date.now(), locale) })}
          </>
        }
        title={t("nav.dashboard.label")}
      />
      <OnboardingBanner />
      {overview.settings.dreamingEnabled && !workersHealthy && (
        <Alert title={t("dashboard.alerts.workerAttention.title")} tone="danger">
          {t("dashboard.alerts.workerAttention.body")}
        </Alert>
      )}
      {overview.configuration.restartRequired && (
        <Alert title={t("dashboard.alerts.restartRequired.title")} tone="warning">
          {t("dashboard.alerts.restartRequired.body")}
        </Alert>
      )}
      <section aria-label={t("dashboard.metrics.ariaLabel")} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          detail={overview.settings.dreamingEnabled ? t("dashboard.metrics.dreaming.nextRun", { date: formatDate(overview.settings.nextDreamAt, locale) }) : t("dashboard.metrics.dreaming.enableHint")}
          icon={MoonStar}
          label={t("dashboard.metrics.dreaming.label")}
          tone={overview.settings.dreamingEnabled ? "success" : "neutral"}
          value={overview.settings.dreamingEnabled ? t("common.enabled") : t("common.disabled")}
        />
        <Metric
          detail={t("dashboard.metrics.workers.detail", { stale: overview.workerSummary.stale, offline: overview.workerSummary.offline })}
          icon={Activity}
          label={t("dashboard.metrics.workers.label")}
          tone={!overview.settings.dreamingEnabled ? "neutral" : workersHealthy ? "success" : "danger"}
          value={!overview.settings.dreamingEnabled ? t("dashboard.metrics.helper.notNeeded") : workersHealthy ? t("dashboard.metrics.helper.running") : t("dashboard.metrics.helper.attention")}
        />
        <Metric
          detail={t("dashboard.metrics.jobs.detail", { running: overview.jobSummary.running, failed: overview.jobSummary.failed })}
          icon={Layers}
          label={t("dashboard.metrics.jobs.label")}
          tone={queueHealthy ? "neutral" : "danger"}
          value={overview.jobSummary.pending}
        />
        <Metric
          detail={t("dashboard.metrics.memories.detail", { count: overview.counts.knowledgeDocuments, formatted: formatNumber(overview.counts.knowledgeDocuments, locale) })}
          icon={BrainCircuit}
          label={t("dashboard.metrics.memories.label")}
          tone="info"
          value={formatNumber(overview.counts.memories, locale)}
        />
      </section>
      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <CardHeaderText>
              <CardTitle>{t("dashboard.latestReport.title")}</CardTitle>
              <CardDescription>{t("dashboard.latestReport.description")}</CardDescription>
            </CardHeaderText>
            {overview.latestReport && (
              <Badge dot tone={overview.latestReport.status === "completed" ? "success" : "warning"}>
                {t(`status.dreamingReportStatus.${overview.latestReport.status}`)}
              </Badge>
            )}
          </CardHeader>
          <CardContent>
            {overview.latestReport ? (
              <div className="grid gap-5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge tone="neutral">{overview.latestReport.localDate}</Badge>
                  <Badge tone="neutral">{t("dashboard.latestReport.modeBadge", { mode: t(`status.dreamingMode.${overview.latestReport.mode}`) })}</Badge>
                  <span>{t("common.generatedAt", { time: formatRelativeTime(overview.latestReport.generatedAt, Date.now(), locale) })}</span>
                </div>
                <p className="text-sm leading-relaxed text-foreground/90">{overview.latestReport.summary}</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <ReportStat label={t("dashboard.latestReport.stats.insights")} value={overview.latestReport.insights.length} />
                  <ReportStat className="text-success" label={t("dashboard.latestReport.stats.created")} value={overview.latestReport.memoriesCreated.length} />
                  <ReportStat className="text-info" label={t("dashboard.latestReport.stats.updated")} value={overview.latestReport.memoriesUpdated.length} />
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                {t("dashboard.latestReport.empty")}
              </div>
            )}
          </CardContent>
          {overview.latestReport && (
            <CardFooter className="justify-end border-t border-border/60 pt-4 sm:pt-4">
              <ButtonLink size="sm" to={`/automation/dreaming/runs/${overview.latestReport.runId}`} variant="outline">
                {t("dashboard.latestReport.openFullReport")} <ArrowRight aria-hidden="true" />
              </ButtonLink>
            </CardFooter>
          )}
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("dashboard.checks.title")}</CardTitle>
            <CardDescription>{t("dashboard.checks.description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {overview.settings.dreamingEnabled && (
              <>
                <Check
                  detail={workersHealthy ? t("dashboard.checks.workerHeartbeat.ok") : t("dashboard.checks.workerHeartbeat.notOk")}
                  label={t("dashboard.checks.workerHeartbeat.label")}
                  ok={workersHealthy}
                  to="/automation/jobs"
                />
                <Check
                  detail={overview.settings.nextDreamAt ? formatDate(overview.settings.nextDreamAt, locale) : t("dashboard.checks.noNextRunScheduled")}
                  label={t("dashboard.checks.dreamingSchedule.label")}
                  ok={overview.settings.nextDreamAt !== null}
                  to="/automation/dreaming"
                />
              </>
            )}
            <Check
              detail={t("dashboard.checks.failedJobsDetail", { count: overview.jobSummary.failed })}
              label={t("dashboard.checks.failedJobQueue.label")}
              ok={queueHealthy}
              to="/automation/jobs"
            />
            <Check
              detail={overview.configuration.restartRequired ? t("dashboard.checks.pendingChangesDetail", { count: overview.configuration.pendingChanges }) : t("dashboard.checks.noRestartPending")}
              label={t("dashboard.checks.configuration.label")}
              ok={!overview.configuration.restartRequired}
              to="/configuration/environment"
            />
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

function ReportStat({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-xl font-medium tabular-nums tracking-tight", className)}>{value}</p>
    </div>
  );
}

function Check({ label, detail, ok, to }: { label: string; detail: string; ok: boolean; to: string }) {
  return (
    <Link
      className="group flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3.5 transition-colors hover:border-foreground/20 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
      to={to}
    >
      {ok ? (
        <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
      ) : (
        <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      )}
      <div className="grid min-w-0 gap-0.5">
        <p className="text-sm font-medium leading-snug text-foreground">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <ArrowRight aria-hidden="true" className="ml-auto mt-0.5 size-4 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
    </Link>
  );
}
