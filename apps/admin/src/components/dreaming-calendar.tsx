import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, FileText, RotateCcw } from "lucide-react";
import { useState } from "react";

import { api } from "../lib/api";
import { useLocale, useTranslation } from "../lib/i18n";
import { cn, newIdempotencyKey } from "../lib/utils";
import { ErrorState, LoadingState } from "./async-state";
import { ModelMark } from "./brand-marks";
import { DreamingProviderError } from "./dreaming-provider";
import { Meta, MetaItem } from "./page";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { ButtonLink } from "./ui/button-link";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ConfirmDialog } from "./ui/dialog";
import { Input, Label } from "./ui/field";

const dayTone = { completed: "bg-success", failed: "bg-danger", pending: "bg-info", running: "bg-info", retry_wait: "bg-info", canceled: "bg-muted-foreground/40" } as const;

function previousLocalDate(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => Number(parts.find((item) => item.type === type)!.value);
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day") - 1)).toISOString().slice(0, 10);
}

export function DreamingCalendar({ timeZone, enabled }: { timeZone: string; enabled: boolean }) {
  const t = useTranslation();
  const { locale } = useLocale();
  const client = useQueryClient();
  const [selected, setSelected] = useState(() => previousLocalDate(timeZone));
  const [month, setMonth] = useState(() => selected.slice(0, 7));
  const [confirmJob, setConfirmJob] = useState<string | null>(null);
  const validMonth = /^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(month);
  const query = useQuery({ queryKey: ["dreaming-calendar", month], queryFn: ({ signal }) => api.dreamingCalendar(month, signal), enabled: validMonth, refetchInterval: 15_000 });
  const retry = useMutation({
    mutationFn: (jobId: string) => api.retryDreaming({ jobId, idempotencyKey: newIdempotencyKey("dreaming-retry") }),
    onSuccess: () => {
      setConfirmJob(null);
      void client.invalidateQueries({ queryKey: ["dreaming-calendar"] });
      void client.invalidateQueries({ queryKey: ["dreaming-jobs"] });
      void client.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
  const [year, monthNumber] = month.split("-").map(Number);
  const start = validMonth ? new Date(Date.UTC(year!, monthNumber! - 1, 1)) : null;
  const dayCount = start ? new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate() : 0;
  const weekStart = locale === "es" ? 1 : 0;
  const offset = start ? (start.getUTCDay() - weekStart + 7) % 7 : 0;
  const dayLabel = (date: string) => new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  const items = query.data?.items ?? [];
  const selectedItems = items.filter((item) => item.localDate === selected);

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid min-w-0 gap-1">
          <CardTitle>{t("dreaming.calendar.title")}</CardTitle>
          <Meta>
            <MetaItem>{t("dreaming.calendar.timeZone", { timeZone })}</MetaItem>
          </Meta>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Label className="sr-only" htmlFor="dreaming-calendar-month">{t("dreaming.calendar.month")}</Label>
          <Input
            className="w-full sm:w-44"
            id="dreaming-calendar-month"
            max="2199-12"
            min="1900-01"
            onChange={(event) => {
              setMonth(event.target.value);
              setSelected("");
              retry.reset();
            }}
            type="month"
            value={month}
          />
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        {validMonth &&
          (query.isPending ? (
            <LoadingState />
          ) : query.isError ? (
            <ErrorState error={query.error} retry={() => query.refetch()} />
          ) : (
            <>
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="grid content-start gap-4">
                  <div aria-label={t("dreaming.calendar.title")} className="grid grid-cols-7 justify-items-center gap-1 text-center" role="group">
                    {Array.from({ length: 7 }, (_, day) => (
                      <span className="py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground" key={`weekday-${day}`}>
                        {new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 7, 2 + weekStart + day)))}
                      </span>
                    ))}
                    {Array.from({ length: offset }, (_, day) => <span key={`blank-${day}`} />)}
                    {Array.from({ length: dayCount }, (_, day) => {
                      const date = `${month}-${String(day + 1).padStart(2, "0")}`;
                      const latest = items.find((item) => item.localDate === date);
                      const status = latest ? t(`status.jobStatus.${latest.status}`) : t("dreaming.calendar.noJob");
                      const isSelected = selected === date;
                      const future = date >= query.data.today;
                      return (
                        <button
                          aria-label={t("dreaming.calendar.day", { date: dayLabel(date), status })}
                          aria-pressed={isSelected}
                          className={cn(
                            "flex size-9 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md text-sm tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-default",
                            isSelected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                            !isSelected && latest?.status === "failed" && "text-danger",
                            !isSelected && !latest && !future && "text-muted-foreground",
                            !isSelected && future && "text-muted-foreground/40 hover:bg-transparent",
                          )}
                          disabled={future}
                          key={date}
                          onClick={() => {
                            setSelected(date);
                            retry.reset();
                          }}
                          type="button"
                        >
                          {day + 1}
                          <span
                            aria-hidden="true"
                            className={cn("size-1 rounded-full", isSelected ? "bg-primary-foreground/80" : latest ? dayTone[latest.status] : "bg-transparent")}
                            data-status={latest?.status ?? "none"}
                          />
                        </button>
                      );
                    })}
                  </div>
                  <Meta className="px-1">
                    <MetaItem><span aria-hidden="true" className="size-1.5 rounded-full bg-success" />{t("status.jobStatus.completed")}</MetaItem>
                    <MetaItem><span aria-hidden="true" className="size-1.5 rounded-full bg-danger" />{t("status.jobStatus.failed")}</MetaItem>
                    <MetaItem><span aria-hidden="true" className="size-1.5 rounded-full bg-info" />{t("dreaming.calendar.queued")}</MetaItem>
                  </Meta>
                </div>
                <section aria-label={t("dreaming.calendar.history")} className="grid content-start gap-3 lg:border-l lg:border-border/60 lg:pl-6">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <CalendarDays aria-hidden="true" className="size-4 text-muted-foreground" />
                    {selected ? dayLabel(selected) : t("dreaming.calendar.selectDay")}
                  </h3>
                  {selected && selectedItems.length === 0 && (
                    <p className="text-sm text-muted-foreground">{t("dreaming.calendar.emptyDay")}</p>
                  )}
                  {selectedItems.map((item) => (
                    <article className="grid gap-2 border-t border-border/60 pt-3 first:border-t-0 first:pt-0" key={item.jobId}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-foreground">{t(item.sourceJobId ? "dreaming.calendar.replay" : "dreaming.calendar.original")}</p>
                        <MetaItem tone={item.status === "failed" ? "danger" : item.status === "completed" ? "success" : "info"}>
                          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                          {t(`status.jobStatus.${item.status}`)}
                        </MetaItem>
                      </div>
                      <Meta>
                        <MetaItem>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: item.timeZone }).format(new Date(item.createdAt))}</MetaItem>
                        <MetaItem>{t("dreaming.jobsTable.attemptCount", { count: item.attemptCount })}</MetaItem>
                        {item.mode && <MetaItem>{t(`status.dreamingMode.${item.mode}`)}</MetaItem>}
                        {item.model && (
                          <MetaItem>
                            <ModelMark model={item.model} />
                            <code className="font-mono">{item.model}</code>
                          </MetaItem>
                        )}
                      </Meta>
                      {item.sanitizedError && <DreamingProviderError code={item.sanitizedError} compact />}
                      {(item.reportRunId || item.canRetry) && (
                        <div className="flex flex-wrap gap-2">
                          {item.reportRunId && (
                            <ButtonLink size="sm" to={`/automation/dreaming/runs/${item.reportRunId}`} variant="outline">
                              <FileText aria-hidden="true" />
                              {t("dreaming.calendar.report")}
                            </ButtonLink>
                          )}
                          {item.canRetry && (
                            <Button disabled={!enabled} onClick={() => setConfirmJob(item.jobId)} size="sm" variant="secondary">
                              <RotateCcw aria-hidden="true" />
                              {t("dreaming.calendar.retry")}
                            </Button>
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </section>
              </div>
              {query.data.truncated && <Alert title={t("dreaming.calendar.truncated")} tone="warning" />}
            </>
          ))}
        {retry.isSuccess && <Alert title={t(retry.data.created ? "dreaming.calendar.queuedSuccess" : "dreaming.calendar.alreadyQueued")} tone="success" />}
        {retry.isError && <ErrorState error={retry.error} />}
        <ConfirmDialog
          confirmLabel={t("dreaming.calendar.confirm")}
          description={t("dreaming.calendar.confirmDescription")}
          onCancel={() => setConfirmJob(null)}
          onConfirm={() => {
            if (confirmJob) retry.mutate(confirmJob);
          }}
          open={confirmJob !== null}
          pending={retry.isPending}
          title={t("dreaming.calendar.confirmTitle")}
        />
      </CardContent>
    </Card>
  );
}
