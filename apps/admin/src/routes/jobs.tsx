import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { EmptyState, ErrorState, TableLoading } from "../components/async-state";
import { EmptyJobsIllustration } from "../components/illustrations/empty-jobs";
import { DreamingProviderError } from "../components/dreaming-provider";
import { Page, PageHeader } from "../components/page";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardHeaderText, CardTitle } from "../components/ui/card";
import { CopyableId } from "../components/ui/copy-button";
import { Select } from "../components/ui/field";
import { Table, Td, Th, Tr } from "../components/ui/table";
import { api } from "../lib/api";
import type { JobStatus, WorkerHealth } from "../lib/api-types";
import { useLocale, useTranslation, type Locale, type Translator } from "../lib/i18n";
import { formatDate, formatRelativeTime } from "../lib/utils";

const statuses: JobStatus[] = ["pending", "running", "retry_wait", "completed", "failed", "canceled"];

function jobTone(status: JobStatus): BadgeTone {
  if (status === "completed") return "success";
  if (status === "failed" || status === "canceled") return "danger";
  if (status === "retry_wait") return "warning";
  if (status === "running") return "info";
  return "neutral";
}

export function JobsPage() {
  const { locale } = useLocale();
  const t = useTranslation();
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const jobs = useQuery({
    queryKey: ["jobs", status, cursor],
    queryFn: ({ signal }) =>
      api.jobs({ ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit: 50 }, signal),
    refetchInterval: 10_000,
  });
  const workers = useQuery({
    queryKey: ["workers"],
    queryFn: ({ signal }) => api.workers(signal),
    refetchInterval: 15_000,
  });

  const isRefreshing = jobs.isFetching || workers.isFetching;

  return (
    <Page>
      <PageHeader
        actions={
          <Button loading={isRefreshing} onClick={() => { jobs.refetch(); workers.refetch(); }} size="sm" variant="outline">
            {!isRefreshing && <RefreshCw aria-hidden="true" />}
            {t("common.refresh")}
          </Button>
        }
        description={t("jobs.description")}
        title={t("nav.jobs.label")}
      />
      <Card>
        <CardHeader>
          <CardTitle>{t("jobs.workers.title")}</CardTitle>
          <CardDescription>{t("jobs.workers.description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0 sm:p-0">
          {workers.isPending ? (
            <TableLoading columns={5} label={t("jobs.workers.loading")} rows={2} />
          ) : workers.isError ? (
            <div className="p-4 pt-0 sm:p-5 sm:pt-0">
              <ErrorState error={workers.error} retry={() => workers.refetch()} />
            </div>
          ) : workers.data.workers.length === 0 ? (
            <EmptyState description={t("jobs.workers.empty.description")} illustration={<EmptyJobsIllustration />} title={t("jobs.workers.empty.title")} variant="plain" />
          ) : (
            <WorkerTable locale={locale} t={t} workers={workers.data.workers} />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <CardHeaderText>
            <CardTitle>{t("jobs.queue.title")}</CardTitle>
            <CardDescription>{t("jobs.queue.description")}</CardDescription>
          </CardHeaderText>
          <Select
            aria-label={t("jobs.queue.filterAriaLabel")}
            className="w-full sm:w-52"
            onChange={(event) => { setStatus(event.target.value); setCursor(null); }}
            value={status}
          >
            <option value="">{t("jobs.queue.allStatuses")}</option>
            {statuses.map((value) => (
              <option key={value} value={value}>{t(`status.jobStatus.${value}`)}</option>
            ))}
          </Select>
        </CardHeader>
        <CardContent className="p-0 sm:p-0">
          {jobs.isPending ? (
            <TableLoading columns={5} label={t("jobs.queue.loading")} />
          ) : jobs.isError ? (
            <div className="p-4 pt-0 sm:p-5 sm:pt-0">
              <ErrorState error={jobs.error} retry={() => jobs.refetch()} />
            </div>
          ) : jobs.data.items.length === 0 ? (
            <EmptyState
              description={status ? t("jobs.queue.empty.filtered.description") : t("jobs.queue.empty.noneAtAll.description")}
              illustration={<EmptyJobsIllustration />}
              title={status ? t("jobs.queue.empty.filtered.title") : t("jobs.queue.empty.noneAtAll.title")}
              variant="plain"
              {...(status ? { action: <Button onClick={() => { setStatus(""); setCursor(null); }} size="sm" variant="outline">{t("jobs.queue.allStatuses")}</Button> } : {})}
            />
          ) : (
            <>
              <Table containerClassName="max-h-[65vh]" scrollLabel={t("jobs.queue.scrollLabel")}>
                <thead>
                  <tr>
                    <Th>{t("jobs.table.job")}</Th>
                    <Th>{t("jobs.table.status")}</Th>
                    <Th>{t("jobs.table.schedule")}</Th>
                    <Th>{t("jobs.table.leaseRetry")}</Th>
                    <Th>{t("jobs.table.error")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.items.map((job) => (
                    <Tr key={job.id}>
                      <Td>
                        <p className="font-medium text-foreground">{t(`status.jobKind.${job.kind}`)}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{t("jobs.table.attempt", { count: job.attemptCount })}</p>
                      </Td>
                      <Td>
                        {job.status === "retry_wait" ? (
                          <Badge dot tone="warning">{t("status.jobStatus.retry_wait")}</Badge>
                        ) : (
                          <Badge dot tone={jobTone(job.status)}>{t(`status.jobStatus.${job.status}`)}</Badge>
                        )}
                        {job.cancelRequestedAt && <p className="mt-1 text-xs text-warning">{t("jobs.table.cancellationRequested")}</p>}
                      </Td>
                      <Td>
                        <span className="text-xs font-medium text-foreground">{formatDate(job.scheduledFor, locale)}</span>
                        <p className="mt-0.5 text-xs text-muted-foreground">{t("common.createdAt", { time: formatRelativeTime(job.createdAt, Date.now(), locale) })}</p>
                      </Td>
                      <Td>
                        {job.leaseOwner ? (
                          <p className="text-xs text-muted-foreground">{t("jobs.table.leaseUntil", { date: formatDate(job.leaseExpiresAt, locale) })}</p>
                        ) : job.status === "retry_wait" && job.nextAttemptAt ? (
                          <p className="text-xs font-medium">{t("common.job.retryIn", { time: formatRelativeTime(job.nextAttemptAt, Date.now(), locale) })}</p>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("common.emptyValue")}</span>
                        )}
                      </Td>
                      <Td className="max-w-xs">
                        {job.sanitizedError ? (
                          job.kind === "daily_dreaming" ? <DreamingProviderError code={job.sanitizedError} compact />
                            : <code className="line-clamp-2 font-mono text-xs text-danger" title={job.sanitizedError}>{job.sanitizedError}</code>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("common.emptyValue")}</span>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <div className="flex items-center justify-between gap-2 border-t border-border p-4">
                <p className="text-sm text-muted-foreground">{t("jobs.queue.shownCount", { count: jobs.data.items.length })}</p>
                <div className="flex items-center gap-2">
                  <Button disabled={!cursor} onClick={() => setCursor(null)} size="sm" variant="outline">{t("common.pagination.firstPage")}</Button>
                  <Button disabled={!jobs.data.nextCursor} onClick={() => setCursor(jobs.data.nextCursor)} size="sm" variant="outline">{t("common.pagination.nextPage")}</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}

function WorkerTable({ workers, locale, t }: { workers: WorkerHealth[]; locale: Locale; t: Translator }) {
  return (
    <Table scrollLabel={t("jobs.workers.scrollLabel")}>
      <thead>
        <tr>
          <Th>{t("jobs.workerTable.worker")}</Th>
          <Th>{t("jobs.workerTable.state")}</Th>
          <Th>{t("jobs.workerTable.started")}</Th>
          <Th>{t("jobs.workerTable.lastHeartbeat")}</Th>
          <Th>{t("jobs.workerTable.activeJob")}</Th>
        </tr>
      </thead>
      <tbody>
        {workers.map((worker) => (
          <Tr key={worker.workerId}>
            <Td>
              <CopyableId label={t("common.id.workerId")} value={worker.workerId} />
              <p className="mt-0.5 text-xs text-muted-foreground">{t("jobs.workerTable.version", { version: worker.version })}</p>
            </Td>
            <Td>
              <Badge dot tone={worker.state === "healthy" ? "success" : worker.state === "stale" ? "warning" : "danger"}>
                {t(`status.workerState.${worker.state}`)}
              </Badge>
            </Td>
            <Td className="text-xs text-muted-foreground">{formatDate(worker.startedAt, locale)}</Td>
            <Td>
              <span className="text-xs font-medium text-foreground">{formatRelativeTime(worker.lastSeenAt, Date.now(), locale)}</span>
              <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(worker.lastSeenAt, locale)}</p>
            </Td>
            <Td>
              {worker.activeJobId ? <CopyableId label={t("common.id.jobId")} value={worker.activeJobId} /> : <span className="text-xs text-muted-foreground">{t("jobs.workerTable.idle")}</span>}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
