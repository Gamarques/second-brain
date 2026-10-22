import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowRight, BellRing, Brain, CalendarClock, CheckCircle2, FileText, FolderKanban, ListChecks, MoonStar, Sparkles, X, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { BrainCitations } from "../components/brain-answer";
import { InsightActionDialog, InsightCard, type InsightActionKind } from "../components/dreaming-insights";
import { Page, Section } from "../components/page";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ButtonLink } from "../components/ui/button-link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Composer, ComposerChip } from "../components/ui/composer";
import { Skeleton } from "../components/ui/skeleton";
import { api } from "../lib/api";
import { useLocale, useTranslation } from "../lib/i18n";
import { pendingSuggestionsQuery } from "../lib/learning-queries";
import { cn, formatDate } from "../lib/utils";
import type { BrainAnswer, BriefingInsight } from "../lib/workspace-types";

const visibleInsights = 3;
const suggestionKeys = ["home.suggestion.1", "home.suggestion.2", "home.suggestion.3"] as const;

export function HomePage() {
  const t = useTranslation();
  const { locale } = useLocale();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const requestedProject = params.get("project");
  const projectId = requestedProject && /^[0-9a-f-]{36}$/i.test(requestedProject) ? requestedProject : null;
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: ({ signal }) => api.project(projectId!, signal),
    enabled: !!projectId,
  });
  const briefing = useQuery({ queryKey: ["briefing"], queryFn: ({ signal }) => api.briefing(signal), refetchInterval: 60_000 });
  const overview = useQuery({ queryKey: ["overview"], queryFn: ({ signal }) => api.overview(signal), refetchInterval: 30_000 });
  const pending = useQuery(pendingSuggestionsQuery());

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<BrainAnswer | null>(null);
  const [asked, setAsked] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [action, setAction] = useState<{ insight: BriefingInsight; kind: InsightActionKind } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const hero = useRef<HTMLElement>(null);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setAnswer(null);
    setError(false);
    setAsked("");
  }, [projectId]);

  async function ask(text = question) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(false);
    setAnswer(null);
    setAsked(trimmed);
    try {
      const result = await api.askBrain({ question: trimmed, locale, projectId }, request.signal);
      if (!request.signal.aborted) setAnswer(result);
    } catch {
      if (!request.signal.aborted) setError(true);
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setBusy(false);
      }
    }
  }
  function stop() {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
  }
  function askAbout(statement: string) {
    setQuestion(statement);
    hero.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    input.current?.focus({ preventScroll: true });
  }

  const canAsk = !busy && question.trim() !== "" && !(projectId && (!project.data?.result || project.isError));
  const dateInZone = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: briefing.data?.timeZone ?? "UTC" }).format(new Date(value));
  const insights = briefing.data?.insights ?? [];
  const shownInsights = showAll ? insights : insights.slice(0, visibleInsights);
  const report = overview.data?.latestReport ?? null;
  const dreamingEnabled = overview.data?.settings.dreamingEnabled ?? true;
  const pendingCount = pending.data?.items.length ?? 0;
  const attention = overview.data ? attentionItems(overview.data, t) : [];
  const now = Date.now();
  const late =
    (briefing.data?.dueReminders.some((item) => new Date(item.remindAt).getTime() < now) ?? false) ||
    (briefing.data?.dueTasks.some((item) => new Date(item.dueAt).getTime() < now) ?? false);
  const suggestions = [
    ...(late ? [t("home.suggestion.late")] : []),
    ...(report ? [t("home.suggestion.review")] : []),
    ...(late ? suggestionKeys.slice(1) : suggestionKeys).map((key) => t(key)),
  ].slice(0, 3);

  return (
    <Page>
      <section className="relative isolate mx-auto grid w-full max-w-3xl gap-4 pt-6 sm:pt-14" ref={hero}>
        <div aria-hidden="true" className="aurora-glow home-aurora" />
        <h1 className="text-center text-2xl font-medium leading-tight tracking-[-0.02em] text-foreground sm:text-[30px]" id="home-question-label">{t("ask.question")}</h1>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <Composer
            aria-labelledby="home-question-label"
            busy={busy}
            disabled={!busy && !canAsk && question.trim() !== ""}
            footnote={t("ask.scope")}
            id="brain-question"
            leading={
              projectId ? (
                <>
                  <ComposerChip icon={FolderKanban}>{t("ask.projectScope", { name: project.data?.result?.project.name ?? t("projects.title") })}</ComposerChip>
                  <ComposerChip icon={X} to="/">{t("ask.allProjects")}</ComposerChip>
                </>
              ) : (
                <ComposerChip icon={Brain}>{overview.data ? t("ask.scopeBrainCount", { count: overview.data.counts.memories }) : t("askPanel.scope.brain")}</ComposerChip>
              )
            }
            maxLength={5000}
            onChange={setQuestion}
            onStop={stop}
            onSubmit={() => void ask()}
            placeholder={t("ask.example")}
            ref={input}
            required
            stopLabel={t("ask.stop")}
            submitLabel={t("ask.submit")}
            value={question}
          />
        </form>
        {!asked && (
          <div className="flex flex-wrap justify-center gap-1.5">
            {suggestions.map((suggestion) => (
              <button
                className="cursor-pointer rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                key={suggestion}
                onClick={() => askAbout(suggestion)}
                type="button"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        <div aria-live="polite" className="grid gap-4">
          {error && <Alert title={t("ask.failure")} tone="danger" />}
          {answer && (
            <Card className="animate-rise text-left">
              <CardHeader>
                <CardTitle className="whitespace-pre-wrap break-words text-lg">{asked}</CardTitle>
                {answer.answerable && <CardDescription>{t("ask.sources")}</CardDescription>}
              </CardHeader>
              <CardContent className="grid gap-5">
                <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground">
                  {answer.answerable ? answer.answer : t("ask.noEvidence")}
                </p>
                <BrainCitations citations={answer.citations} className="border-t border-border/60 pt-5" />
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      <div className="grid overflow-hidden rounded-2xl border border-border/70 bg-card/50 sm:grid-cols-3 sm:divide-x sm:divide-border/60 max-sm:divide-y max-sm:divide-border/60">
        <HomeTile icon={CalendarClock} linkLabel={t("home.today.link")} loading={briefing.isPending} title={t("home.today.title")} to="/reminders">
          {briefing.data && (
            briefing.data.dueTasks.length === 0 && briefing.data.dueReminders.length === 0 ? (
              <TileLine icon={CheckCircle2} tone="success">{t("home.today.empty")}</TileLine>
            ) : (
              <>
                {briefing.data.dueTasks.length > 0 && <TileLine icon={ListChecks} tone="warning">{t("home.today.tasks", { count: briefing.data.dueTasks.length })}</TileLine>}
                {briefing.data.dueReminders.length > 0 && <TileLine icon={BellRing} tone="warning">{t("home.today.reminders", { count: briefing.data.dueReminders.length })}</TileLine>}
              </>
            )
          )}
          {briefing.isError && <TileLine icon={XCircle} tone="danger">{t("asyncState.error.title")}</TileLine>}
        </HomeTile>
        <HomeTile icon={Activity} linkLabel={t("home.attention.link")} loading={overview.isPending} title={t("home.attention.title")} to="/status">
          {overview.data && (attention.length === 0 ? (
            <TileLine icon={CheckCircle2} tone="success">{t("home.attention.ok")}</TileLine>
          ) : (
            attention.map((item) => <TileLine icon={XCircle} key={item} tone="danger">{item}</TileLine>)
          ))}
          {overview.isError && <TileLine icon={XCircle} tone="danger">{t("asyncState.error.title")}</TileLine>}
        </HomeTile>
        <HomeTile icon={Brain} linkLabel={t("home.brain.link")} loading={overview.isPending} title={t("home.brain.title")} to="/brain-map">
          {overview.data && (
            <>
              <TileLine icon={Brain}>{t("home.brain.memories", { count: overview.data.counts.memories })}</TileLine>
              <TileLine icon={FileText}>{t("home.brain.documents", { count: overview.data.counts.knowledgeDocuments })}</TileLine>
            </>
          )}
          {overview.isError && <TileLine icon={XCircle} tone="danger">{t("asyncState.error.title")}</TileLine>}
        </HomeTile>
      </div>

      <Section
        actions={report ? (
          <ButtonLink size="sm" to={`/automation/dreaming/runs/${report.runId}`} variant="outline">
            <FileText aria-hidden="true" />
            {t("home.review.fullRecap")}
          </ButtonLink>
        ) : undefined}
        title={report ? t("home.review.dated", { date: report.localDate }) : t("home.review.title")}
        {...(report ? { description: report.summary } : {})}
      >
        {briefing.isPending || overview.isPending ? (
          <div className="grid gap-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : !dreamingEnabled && insights.length === 0 ? (
          <Card className="border-primary/25 bg-primary/[0.025]">
            <CardHeader className="sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="aurora flex size-10 shrink-0 items-center justify-center rounded-lg shadow-xs">
                  <MoonStar aria-hidden="true" className="size-5" />
                </span>
                <div className="grid gap-1.5">
                  <CardTitle>{t("home.review.disabled.title")}</CardTitle>
                  <CardDescription>{t("home.review.disabled.body")}</CardDescription>
                </div>
              </div>
              <ButtonLink className="shrink-0" to="/automation/dreaming">
                {t("home.review.disabled.link")}
                <ArrowRight aria-hidden="true" />
              </ButtonLink>
            </CardHeader>
          </Card>
        ) : !report && insights.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("home.review.waiting.title")}</CardTitle>
              <CardDescription>
                {overview.data?.settings.nextDreamAt ? t("home.review.waiting.body", { date: formatDate(overview.data.settings.nextDreamAt, locale) }) : t("home.review.waiting.unknown")}
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="grid gap-4">
            {insights.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{t("home.review.noInsights")}</p>
            ) : (
              shownInsights.map((insight) => (
                <InsightCard insight={insight} key={`${insight.reportId}:${insight.index}`} onAction={(kind) => setAction({ insight, kind })} onAsk={askAbout} />
              ))
            )}
            {insights.length > visibleInsights && (
              <div className="flex justify-center">
                <Button onClick={() => setShowAll((current) => !current)} size="sm" variant="ghost">
                  {showAll ? t("home.review.showLess") : t("home.review.showAll", { count: insights.length })}
                </Button>
              </div>
            )}
          </div>
        )}
        {pendingCount > 0 && (
          <div className="aurora-soft flex flex-col gap-3 rounded-xl border border-border/70 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="aurora flex size-9 shrink-0 items-center justify-center rounded-md shadow-xs">
                <Sparkles aria-hidden="true" className="size-4" />
              </span>
              <p className="text-sm font-medium text-foreground">
                {t("home.review.pending", { count: pending.data?.nextCursor ? pendingCount + 1 : pendingCount })}
                {pending.data?.nextCursor && <Badge className="ml-2" tone="info">+</Badge>}
              </p>
            </div>
            <ButtonLink size="sm" to="/learning">
              {t("learning.open")}
              <ArrowRight aria-hidden="true" />
            </ButtonLink>
          </div>
        )}
      </Section>

      {action && (
        <InsightActionDialog
          key={`${action.insight.reportId}:${action.insight.index}:${action.kind}`}
          {...action}
          onClose={() => setAction(null)}
          onSaved={async () => {
            setAction(null);
            await Promise.all([
              briefing.refetch(),
              client.invalidateQueries({ queryKey: ["project-section"] }),
              client.invalidateQueries({ queryKey: ["task-lists"] }),
              client.invalidateQueries({ queryKey: ["reminders"] }),
            ]);
          }}
        />
      )}
      {briefing.data && !briefing.isPending && (
        <div className="grid gap-1 text-center text-xs text-muted-foreground">
          <p>{t("briefing.updated", { date: dateInZone(briefing.data.generatedAt), zone: briefing.data.timeZone })}</p>
          {briefing.data.truncated && <p className="mx-auto max-w-2xl">{t("briefing.limited")}</p>}
        </div>
      )}
    </Page>
  );
}

function attentionItems(overview: NonNullable<ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.overview>>>>["data"]>, t: ReturnType<typeof useTranslation>): string[] {
  const items: string[] = [];
  const workersHealthy = overview.workerSummary.stale === 0 && overview.workerSummary.offline === 0 && overview.workerSummary.healthy > 0;
  if (overview.settings.dreamingEnabled && !workersHealthy) items.push(t("dashboard.checks.workerHeartbeat.label"));
  if (overview.jobSummary.failed > 0) items.push(t("dashboard.checks.failedJobsDetail", { count: overview.jobSummary.failed }));
  if (overview.configuration.restartRequired) items.push(t("dashboard.alerts.restartRequired.title"));
  return items;
}

function HomeTile({ icon: Icon, title, to, linkLabel, loading, children }: { icon: LucideIcon; title: string; to: string; linkLabel: string; loading: boolean; children: ReactNode }) {
  return (
    <Link
      className="group flex flex-col gap-2.5 p-4 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/20"
      to={to}
    >
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      </div>
      <div className="grid min-h-10 content-start gap-1">
        {loading ? (
          <>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-24" />
          </>
        ) : (
          children
        )}
      </div>
      <span className="mt-auto inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
        {linkLabel}
        <ArrowRight aria-hidden="true" className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

const lineTones = { neutral: "text-muted-foreground", success: "text-success", warning: "text-warning", danger: "text-danger" };

function TileLine({ icon: Icon, tone = "neutral", children }: { icon: LucideIcon; tone?: keyof typeof lineTones; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm font-medium text-foreground">
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", lineTones[tone])} />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}
