import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Clock, Play, Save, Search, Settings2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { EmptyState, ErrorState, PageSkeleton, TableLoading } from "../components/async-state";
import { DreamingCalendar } from "../components/dreaming-calendar";
import { DreamingModelRow, DreamingProviderError } from "../components/dreaming-provider";
import { EmptyReviewsIllustration } from "../components/illustrations/empty-reviews";
import { Meta, MetaItem, Metric, Page, PageHeader } from "../components/page";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ButtonLink } from "../components/ui/button-link";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { CopyableId } from "../components/ui/copy-button";
import { Disclosure } from "../components/ui/disclosure";
import { Checkbox, Field, Input, Select } from "../components/ui/field";
import { useToast } from "../components/ui/toast";
import { DotStrip } from "../components/viz/dot-strip";
import { api } from "../lib/api";
import type { AutomationJob, AutomationSettings, DreamingRun } from "../lib/api-types";
import { useLocale, useTranslation, type Locale, type Translator } from "../lib/i18n";
import { cn, formatDate, formatRelativeTime, newIdempotencyKey } from "../lib/utils";
import { tickTone } from "../lib/viz";

const recentOutcomes = 20;

export function DreamingPage() {
  const navigate = useNavigate();
  const { locale } = useLocale();
  const t = useTranslation();
  const [reportRunId, setReportRunId] = useState("");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const settings = useQuery({ queryKey: ["automation-settings"], queryFn: ({ signal }) => api.automationSettings(signal) });
  const jobs = useQuery({ queryKey: ["dreaming-jobs"], queryFn: ({ signal }) => api.jobs({ kind: "daily_dreaming", limit: 20 }, signal), refetchInterval: 15_000 });

  if (settings.isPending) return <PageSkeleton cards={2} label={t("dreaming.loadingSettings")} />;
  if (settings.isError) return <ErrorState error={settings.error} retry={() => settings.refetch()} />;
  const items = jobs.data?.items ?? [];
  const outcomes = items
    .slice(0, recentOutcomes)
    .reverse()
    .map((job) => ({ key: job.id, tone: tickTone(job.status), label: `${formatDate(job.scheduledFor, locale)}: ${t(`status.jobStatus.${job.status}`)}` }));

  return (
    <Page>
      <PageHeader description={t("dreaming.description")} title={t("nav.dreaming.label")} />
      <Card>
        <CardContent className="grid divide-y divide-border/60 p-0 sm:p-0">
          <ScheduleRow initial={settings.data} onDirtyChange={setSettingsDirty} />
          <DreamingModelRow />
          <RunRow settings={settings.data} settingsDirty={settingsDirty} />
        </CardContent>
      </Card>
      <DreamingCalendar enabled={settings.data.dreamingEnabled} timeZone={settings.data.timeZone} />
      <section aria-label={t("dreaming.recentJobs.title")} className="grid" role="region">
        {jobs.isPending ? (
          <Card>
            <CardContent className="pt-4 sm:pt-5">
              <TableLoading columns={3} label={t("dreaming.recentJobs.loading")} rows={3} />
            </CardContent>
          </Card>
        ) : jobs.isError ? (
          <ErrorState error={jobs.error} retry={() => jobs.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState description={t("dreaming.recentJobs.empty.description")} illustration={<EmptyReviewsIllustration />} title={t("dreaming.recentJobs.empty.title")} />
        ) : (
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3">
              <CardTitle>{t("dreaming.recentJobs.title")}</CardTitle>
              <DotStrip items={outcomes} label={t("dreaming.recentJobs.outcomes", { count: outcomes.length })} />
            </CardHeader>
            <CardContent className="p-0 sm:p-0">
              <DreamingJobTable jobs={items} locale={locale} t={t} />
            </CardContent>
            <CardFooter className="border-t border-border/60 pt-3 sm:pt-3">
              <Disclosure className="w-full" contentClassName="mt-2" size="sm" summary={t("dreaming.openReport.title")}>
                <p className="text-xs text-muted-foreground">{t("dreaming.openReport.description")}</p>
                <form
                  className="mt-2 flex flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => { event.preventDefault(); if (reportRunId) navigate(`/automation/dreaming/runs/${reportRunId}`); }}
                >
                  <Input
                    aria-label={t("dreaming.openReport.inputAriaLabel")}
                    className="font-mono text-xs sm:max-w-md"
                    onChange={(event) => setReportRunId(event.target.value)}
                    pattern="[0-9a-fA-F-]{36}"
                    placeholder="00000000-0000-4000-8000-000000000000"
                    required
                    value={reportRunId}
                  />
                  <Button size="sm" type="submit" variant="outline">
                    <Search aria-hidden="true" />
                    {t("dreaming.openReport.submit")}
                  </Button>
                </form>
              </Disclosure>
            </CardFooter>
          </Card>
        )}
      </section>
    </Page>
  );
}

/** The schedule at a glance, with the form underneath only while it is being changed. */
function ScheduleRow({ initial, onDirtyChange }: { initial: AutomationSettings; onDirtyChange: (dirty: boolean) => void }) {
  const client = useQueryClient();
  const { toast } = useToast();
  const { locale } = useLocale();
  const t = useTranslation();
  const [form, setForm] = useState(initial);
  const [editing, setEditing] = useState(!initial.dreamingEnabled);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const dirtyAgainst = (next: AutomationSettings) =>
    next.dreamingEnabled !== initial.dreamingEnabled ||
    next.timeZone !== initial.timeZone ||
    next.dreamLocalTime !== initial.dreamLocalTime ||
    next.dreamingMode !== initial.dreamingMode ||
    next.dailyInputTokenLimit !== initial.dailyInputTokenLimit ||
    next.dailyOutputTokenLimit !== initial.dailyOutputTokenLimit;
  const isDirty = dirtyAgainst(form);
  const updateForm = (next: AutomationSettings) => {
    setForm(next);
    onDirtyChange(dirtyAgainst(next));
  };
  const save = useMutation({
    mutationFn: () =>
      api.updateAutomationSettings({
        dreamingEnabled: form.dreamingEnabled,
        timeZone: form.timeZone,
        dreamLocalTime: form.dreamLocalTime,
        dreamingMode: form.dreamingMode,
        dailyInputTokenLimit: form.dailyInputTokenLimit,
        dailyOutputTokenLimit: form.dailyOutputTokenLimit,
        expectedRevision: initial.revision,
        idempotencyKey: newIdempotencyKey("dreaming-settings"),
      }),
    onSuccess: (data) => {
      client.setQueryData(["automation-settings"], data);
      setForm(data);
      setEditing(false);
      onDirtyChange(false);
      toast({
        title: t("dreaming.schedule.toast.saved.title"),
        description: data.nextDreamAt ? t("dreaming.schedule.toast.saved.nextRun", { date: formatDate(data.nextDreamAt, locale) }) : t("dreaming.schedule.toast.saved.noNextRun"),
        tone: "success",
      });
    },
    onError: (error: unknown) => {
      toast({ title: t("dreaming.schedule.toast.failed.title"), description: error instanceof Error ? error.message : t("dreaming.schedule.toast.failed.fallback"), tone: "danger" });
    },
  });

  return (
    <div className="grid gap-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="text-sm font-medium text-foreground">
            {initial.dreamingEnabled ? t("dreaming.schedule.status.enabled") : t("dreaming.schedule.status.disabled")}
          </p>
          <Meta>
            <MetaItem icon={Clock}>{t("dreaming.schedule.summary", { time: initial.dreamLocalTime, timeZone: initial.timeZone })}</MetaItem>
            <MetaItem>{t(`status.dreamingMode.${initial.dreamingMode}`)}</MetaItem>
            {initial.dreamingEnabled && initial.nextDreamAt && <MetaItem>{t("dreaming.schedule.status.next", { date: formatDate(initial.nextDreamAt, locale) })}</MetaItem>}
          </Meta>
        </div>
        {!editing && (
          <Button onClick={() => setEditing(true)} size="sm" variant="outline">
            {initial.dreamingEnabled ? t("dreaming.schedule.change") : t("dreaming.schedule.setUp")}
          </Button>
        )}
      </div>
      {editing && (
        <form className="grid gap-4" id="dreaming-settings" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
          {save.isError && <ErrorState error={save.error} />}
          <Checkbox
            checked={form.dreamingEnabled}
            description={t("dreaming.schedule.enableDescription")}
            label={t("dreaming.schedule.enableLabel")}
            onChange={(event) => updateForm({ ...form, dreamingEnabled: event.target.checked })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="local-time" label={t("dreaming.schedule.localTimeLabel")}>
              <Input id="local-time" onChange={(event) => updateForm({ ...form, dreamLocalTime: event.target.value })} required type="time" value={form.dreamLocalTime} />
            </Field>
            <Field hint={t("dreaming.schedule.timezoneHint")} htmlFor="timezone" label={t("dreaming.schedule.timezoneLabel")}>
              <Input id="timezone" onChange={(event) => updateForm({ ...form, timeZone: event.target.value })} required value={form.timeZone} />
            </Field>
          </div>
          <Field className="sm:max-w-xs" htmlFor="dream-mode" label={t("dreaming.schedule.modeLabel")}>
            <div>
              <Select id="dream-mode" onChange={(event) => updateForm({ ...form, dreamingMode: event.target.value as "preview" | "apply" })} value={form.dreamingMode}>
                <option value="preview">{t("dreaming.schedule.mode.previewOption")}</option>
                <option value="apply">{t("dreaming.schedule.mode.applyOption")}</option>
              </Select>
            </div>
          </Field>
          {form.dreamingMode === "apply" && (
            <Alert title={t("dreaming.schedule.applyWarning.title")} tone="warning">
              {t("dreaming.schedule.applyWarning.body")}
            </Alert>
          )}
          <Button aria-expanded={showAdvanced} className="-ml-2 w-fit" onClick={() => setShowAdvanced((current) => !current)} size="sm" variant="ghost">
            <Settings2 aria-hidden="true" />
            {t("dreaming.schedule.advancedSettings")}
          </Button>
          {showAdvanced && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field htmlFor="input-limit" label={t("dreaming.schedule.inputLimitLabel")}>
                <Input id="input-limit" min={1} onChange={(event) => updateForm({ ...form, dailyInputTokenLimit: Number(event.target.value) })} required type="number" value={form.dailyInputTokenLimit} />
              </Field>
              <Field htmlFor="output-limit" label={t("dreaming.schedule.outputLimitLabel")}>
                <Input id="output-limit" min={1} onChange={(event) => updateForm({ ...form, dailyOutputTokenLimit: Number(event.target.value) })} required type="number" value={form.dailyOutputTokenLimit} />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!isDirty || save.isPending} form="dreaming-settings" loading={save.isPending} size="sm" type="submit">
              {!save.isPending && <Save aria-hidden="true" />}
              {save.isPending ? t("common.saving") : t("dreaming.schedule.save")}
            </Button>
            {initial.dreamingEnabled && (
              <Button onClick={() => { setForm(initial); setEditing(false); onDirtyChange(false); }} size="sm" variant="ghost">{t("common.cancel")}</Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

/** One line on what a run does, and the button that starts it. */
function RunRow({ settings, settingsDirty }: { settings: AutomationSettings; settingsDirty: boolean }) {
  const client = useQueryClient();
  const { toast } = useToast();
  const t = useTranslation();
  const [localDate, setLocalDate] = useState("");
  const [showDate, setShowDate] = useState(false);
  const enqueue = useMutation({
    mutationFn: () => api.enqueueDreaming({ ...(localDate ? { localDate } : {}), idempotencyKey: newIdempotencyKey("dreaming-run") }),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["dreaming-jobs"] });
      toast({
        title: result.created ? t("dreaming.runNow.toast.enqueued") : t("dreaming.runNow.toast.existing"),
        description: result.created
          ? t("dreaming.runNow.toast.description")
          : t(["failed", "completed", "canceled"].includes(result.job.status)
            ? "dreaming.runNow.toast.existingTerminal" : "dreaming.runNow.toast.existingActive", {
              status: t(`status.jobStatus.${result.job.status}`),
            }),
        tone: result.created ? "success" : result.job.status === "failed" ? "warning" : "info",
      });
    },
    onError: (error: unknown) => {
      toast({ title: t("dreaming.runNow.toast.failed"), description: error instanceof Error ? error.message : t("dreaming.runNow.toast.fallback"), tone: "danger" });
    },
  });

  return (
    <form className="grid gap-3 p-4 sm:p-5" id="run-now" onSubmit={(event) => { event.preventDefault(); enqueue.mutate(); }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-foreground">
          {settings.dreamingMode === "preview" ? t("dreaming.runNow.previewSafety") : t("dreaming.runNow.applySafety")}
        </p>
        <Button disabled={!settings.dreamingEnabled || settingsDirty || enqueue.isPending} form="run-now" loading={enqueue.isPending} size="sm" type="submit">
          {!enqueue.isPending && <Play aria-hidden="true" />}
          {enqueue.isPending ? t("common.enqueuing") : localDate ? t("dreaming.runNow.submitDate", { date: localDate }) : t("dreaming.runNow.submit")}
        </Button>
      </div>
      {enqueue.isError && <ErrorState error={enqueue.error} />}
      {!settings.dreamingEnabled && (
        <Alert title={t("dreaming.runNow.disabled.title")} tone="warning">{t("dreaming.runNow.disabled.body")}</Alert>
      )}
      {settingsDirty && (
        <Alert title={t("dreaming.runNow.unsaved.title")} tone="info">{t("dreaming.runNow.unsaved.body")}</Alert>
      )}
      <Button aria-expanded={showDate} className="-ml-2 w-fit" onClick={() => setShowDate((current) => !current)} size="sm" variant="ghost">
        <ChevronDown aria-hidden="true" className={cn("transition-transform", showDate && "rotate-180")} />
        {t("dreaming.runNow.chooseDate")}
      </Button>
      {showDate && (
        <Field className="sm:max-w-xs" hint={t("dreaming.runNow.dateHint")} htmlFor="run-date" label={t("dreaming.runNow.dateLabel")}>
          <Input id="run-date" onChange={(event) => setLocalDate(event.target.value)} type="date" value={localDate} />
        </Field>
      )}
    </form>
  );
}

const visibleJobs = 5;

function DreamingJobTable({ jobs, locale, t }: { jobs: AutomationJob[]; locale: Locale; t: Translator }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? jobs : jobs.slice(0, visibleJobs);
  return (
    <>
      <ul className="divide-y divide-border/60">
        {shown.map((job) => <DreamingJobRow job={job} key={job.id} locale={locale} t={t} />)}
      </ul>
      {jobs.length > visibleJobs && (
        <div className="flex justify-center border-t border-border/60 p-3">
          <Button onClick={() => setShowAll((current) => !current)} size="sm" variant="ghost">
            {showAll ? t("home.review.showLess") : t("home.review.showAll", { count: jobs.length })}
          </Button>
        </div>
      )}
    </>
  );
}

function DreamingJobRow({ job, locale, t }: { job: AutomationJob; locale: Locale; t: Translator }) {
  const [showDetails, setShowDetails] = useState(false);
  return (
    <li className="grid gap-2 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{formatDate(job.scheduledFor, locale)}</p>
        <div className="flex items-center gap-2">
          <MetaItem tone={tickTone(job.status)}>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            {t(`status.jobStatus.${job.status}`)}
          </MetaItem>
          <Button aria-expanded={showDetails} onClick={() => setShowDetails((current) => !current)} size="sm" variant="ghost">
            {showDetails ? t("dreaming.jobsTable.hideDetails") : t("dreaming.jobsTable.showDetails")}
          </Button>
        </div>
      </div>
      {job.sanitizedError && <DreamingProviderError code={job.sanitizedError} compact />}
      {showDetails && (
        <div className="grid gap-1.5">
          {job.status === "failed" && <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{t("dreaming.jobsTable.failedHelp")}</p>}
          <Meta>
            <MetaItem><CopyableId label={t("common.id.canonicalKey")} value={job.canonicalKey} /></MetaItem>
            <MetaItem>{t("dreaming.jobsTable.attemptCount", { count: job.attemptCount })}</MetaItem>
            {(job.leaseOwner || (job.status === "retry_wait" && job.nextAttemptAt)) && (
              <MetaItem>{job.leaseOwner ?? t("common.job.retryIn", { time: formatRelativeTime(job.nextAttemptAt!, Date.now(), locale) })}</MetaItem>
            )}
          </Meta>
        </div>
      )}
    </li>
  );
}

export function DreamingRunPage() {
  const { runId = "" } = useParams();
  const { locale } = useLocale();
  const t = useTranslation();
  const query = useQuery({ queryKey: ["dreaming-run", runId], queryFn: ({ signal }) => api.dreamingRun(runId, signal), enabled: runId !== "" });

  if (query.isPending) return <PageSkeleton cards={2} label={t("dreaming.run.loading")} />;
  if (query.isError) return <ErrorState error={query.error} retry={() => query.refetch()} />;
  const report = query.data.report;

  return (
    <Page>
      <PageHeader
        actions={report?.mode === "preview" ? <ButtonLink to="/learning">{t("learning.open")}</ButtonLink> : undefined}
        back={{ to: "/automation/dreaming", label: t("dreaming.run.backLink") }}
        description={report ? t("dreaming.run.generatedDescription", { date: formatDate(report.generatedAt, locale), mode: t(`status.dreamingMode.${report.mode}`) }) : t("dreaming.run.noReportDescription")}
        eyebrow={<CopyableId label={t("common.id.runId")} value={runId} />}
        title={report ? t("dreaming.run.titleWithDate", { date: report.localDate }) : t("route.dreamingReport")}
      />
      {report ? (
        <ReportView report={report} />
      ) : (
        <EmptyState description={t("dreaming.run.empty.description")} illustration={<EmptyReviewsIllustration />} title={t("dreaming.run.empty.title")} />
      )}
    </Page>
  );
}

function ReportView({ report }: { report: NonNullable<DreamingRun["report"]> }) {
  const { locale } = useLocale();
  const t = useTranslation();
  return (
    <div className="grid gap-5">
      <section aria-label={t("dreaming.report.totalsAriaLabel")} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label={t("dreaming.report.metrics.insights")} value={report.insights.length} />
        <Metric label={t("dreaming.report.metrics.created")} tone="success" value={report.memoriesCreated.length} />
        <Metric label={t("dreaming.report.metrics.updated")} tone="info" value={report.memoriesUpdated.length} />
        <Metric label={t("dreaming.report.metrics.skipped")} tone={report.skipped.length > 0 ? "warning" : "neutral"} value={report.skipped.length} />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>{t("dreaming.report.summary.title")}</CardTitle>
          <CardDescription>{t("common.generatedAt", { time: formatRelativeTime(report.generatedAt, Date.now(), locale) })}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{report.summary}</p>
          {report.coverageWarnings.length > 0 && (
            <div className="mt-4 grid gap-2.5">
              {report.coverageWarnings.map((warning) => (
                <Alert key={warning} title={t("dreaming.report.coverageWarningTitle")} tone="warning">{warning}</Alert>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("dreaming.report.insights.title")}</CardTitle>
          <CardDescription>{t("dreaming.report.insights.description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {report.insights.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dreaming.report.insights.empty")}</p>
          ) : (
            report.insights.map((insight, index) => (
              <article className="rounded-lg border border-border bg-muted/20 p-4" key={`${insight.kind}-${index}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info">{t(`status.insightKind.${insight.kind}`)}</Badge>
                  <Badge tone={insight.confidence === "high" ? "success" : insight.confidence === "medium" ? "neutral" : "warning"}>
                    {t("dreaming.report.confidenceBadge", { confidence: t(`status.confidence.${insight.confidence}`) })}
                  </Badge>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-foreground/90">{insight.statement}</p>
                <Disclosure className="mt-3" summary={t("dreaming.report.evidenceSummary", { count: insight.evidence.length })}>
                  <div className="grid gap-2">
                    {insight.evidence.map((citation) => (
                      <blockquote className="rounded-md border-l-2 border-primary/40 bg-muted/50 px-3.5 py-2.5 text-sm" key={`${citation.type}-${citation.id}`}>
                        <p className="leading-relaxed">{citation.excerpt}</p>
                        <footer className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="font-medium">{citation.type}</span>
                          <CopyableId label={t("common.id.citationId")} value={citation.id} />
                        </footer>
                      </blockquote>
                    ))}
                  </div>
                </Disclosure>
              </article>
            ))
          )}
        </CardContent>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <ChangeCard items={report.memoriesCreated} title={t("dreaming.report.metrics.created")} />
        <ChangeCard items={report.memoriesUpdated} title={t("dreaming.report.metrics.updated")} />
      </div>
      {report.skipped.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("dreaming.report.skipped.title")}</CardTitle>
            <CardDescription>{t("dreaming.report.skipped.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {report.skipped.map((item, index) => (
                <li className="rounded-lg border border-border bg-muted/20 p-3.5 text-sm text-muted-foreground" key={`${item.reason}-${index}`}>
                  {item.reason}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ChangeCard({ title, items }: { title: string; items: Array<{ id: string; content: string }> }) {
  const t = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{t("dreaming.report.changesCount", { count: items.length })}</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("common.none")}</p>
        ) : (
          <ul className="grid gap-2.5">
            {items.map((item) => (
              <li className="rounded-lg border border-border bg-muted/20 p-4 text-sm" key={item.id}>
                <p className="leading-relaxed text-foreground">{item.content}</p>
                <div className="mt-2"><CopyableId label={t("common.id.memoryId")} value={item.id} /></div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
