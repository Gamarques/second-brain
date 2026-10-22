import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FileClock, Filter, X } from "lucide-react";
import { useState } from "react";

import { EmptyState, ErrorState, TableLoading } from "../components/async-state";
import { EmptyActivityIllustration } from "../components/illustrations/empty-activity";
import { Page, PageHeader } from "../components/page";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { CodeBlock } from "../components/ui/code-block";
import { CopyableId } from "../components/ui/copy-button";
import { Field, Input, Select } from "../components/ui/field";
import { GlossaryTerm } from "../components/ui/glossary-term";
import { Table, Td, Th, Tr } from "../components/ui/table";
import { api } from "../lib/api";
import type { AuditEvent } from "../lib/api-types";
import { useLocale, useTranslation, type CatalogKey } from "../lib/i18n";
import { cn, formatDate, formatRelativeTime, localDateTimeToIso } from "../lib/utils";

const emptyFilters = { action: "", outcome: "", category: "", from: "", to: "" };
const filterLabelKeys: Record<keyof typeof emptyFilters, CatalogKey> = {
  action: "audit.filters.action",
  outcome: "audit.filters.outcome",
  category: "audit.filters.category",
  from: "audit.filters.from",
  to: "audit.filters.to",
};

function outcomeTone(outcome: AuditEvent["outcome"]): BadgeTone {
  if (outcome === "succeeded") return "success";
  return outcome === "denied" ? "warning" : "danger";
}

export function AuditPage() {
  const t = useTranslation();
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const query = useQuery({
    queryKey: ["audit-events", applied, cursor],
    queryFn: ({ signal }) =>
      api.auditEvents(
        {
          action: applied.action,
          outcome: applied.outcome,
          category: applied.category,
          from: localDateTimeToIso(applied.from),
          to: localDateTimeToIso(applied.to),
          cursor,
          limit: 100,
        },
        signal,
      ),
  });

  const activeFilters = Object.entries(applied).filter(([, value]) => value !== "") as Array<[keyof typeof emptyFilters, string]>;

  function reset() {
    setFilters(emptyFilters);
    setApplied(emptyFilters);
    setCursor(null);
    setSelected(null);
  }

  return (
    <Page>
      <PageHeader
        description={t("audit.description")}
        title={t("nav.audit.label")}
      />
      <Card>
        <CardContent className="pt-5 sm:pt-6">
          <form
            className="grid gap-4 md:grid-cols-2 xl:grid-cols-6"
            onSubmit={(event) => { event.preventDefault(); setApplied(filters); setCursor(null); setSelected(null); }}
          >
            <Field htmlFor="audit-action" label={t("audit.filters.action")}>
              <Input id="audit-action" onChange={(event) => setFilters({ ...filters, action: event.target.value })} placeholder={t("audit.filters.actionPlaceholder")} value={filters.action} />
            </Field>
            <Field htmlFor="audit-outcome" label={t("audit.filters.outcome")}>
              <Select id="audit-outcome" onChange={(event) => setFilters({ ...filters, outcome: event.target.value })} value={filters.outcome}>
                <option value="">{t("audit.filters.allOutcomes")}</option>
                <option value="succeeded">{t("status.auditOutcome.succeeded")}</option>
                <option value="denied">{t("status.auditOutcome.denied")}</option>
                <option value="failed">{t("status.auditOutcome.failed")}</option>
              </Select>
            </Field>
            <Field htmlFor="audit-category" label={t("audit.filters.category")}>
              <Select id="audit-category" onChange={(event) => setFilters({ ...filters, category: event.target.value })} value={filters.category}>
                <option value="">{t("audit.filters.allCategories")}</option>
                <option value="domain">{t("status.auditCategory.domain")}</option>
                <option value="administration">{t("status.auditCategory.administration")}</option>
                <option value="authentication">{t("status.auditCategory.authentication")}</option>
                <option value="automation">{t("status.auditCategory.automation")}</option>
              </Select>
            </Field>
            <Field htmlFor="audit-from" label={t("audit.filters.from")}>
              <Input id="audit-from" onChange={(event) => setFilters({ ...filters, from: event.target.value })} type="datetime-local" value={filters.from} />
            </Field>
            <Field htmlFor="audit-to" label={t("audit.filters.to")}>
              <Input id="audit-to" onChange={(event) => setFilters({ ...filters, to: event.target.value })} type="datetime-local" value={filters.to} />
            </Field>
            <div className="flex items-end gap-2">
              <Button type="submit">
                <Filter aria-hidden="true" />
                {t("common.apply")}
              </Button>
              <Button aria-label={t("audit.clearFiltersAriaLabel")} onClick={reset} size="icon" type="button" variant="ghost">
                <X aria-hidden="true" />
              </Button>
            </div>
          </form>
          {activeFilters.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
              <span className="text-xs font-medium text-muted-foreground">{t("audit.activeFiltersLabel")}</span>
              {activeFilters.map(([key, value]) => (
                <Badge key={key} tone="info">{t("audit.activeFilterBadge", { label: t(filterLabelKeys[key]), value })}</Badge>
              ))}
              <Button className="ml-1" onClick={reset} size="sm" variant="ghost">{t("common.clearAll")}</Button>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <Card>
          <CardHeader>
            <CardTitle>{t("audit.events.title")}</CardTitle>
            <CardDescription>{t("audit.events.description")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0 sm:p-0">
            {query.isPending ? (
              <TableLoading columns={4} label={t("audit.events.loading")} rows={8} />
            ) : query.isError ? (
              <div className="p-4 pt-0 sm:p-5 sm:pt-0"><ErrorState error={query.error} retry={() => query.refetch()} /></div>
            ) : query.data.items.length === 0 ? (
              <EmptyState
                description={activeFilters.length > 0 ? t("audit.events.empty.filtered.description") : t("audit.events.empty.noneAtAll.description")}
                illustration={<EmptyActivityIllustration />}
                title={activeFilters.length > 0 ? t("audit.events.empty.filtered.title") : t("audit.events.empty.noneAtAll.title")}
                variant="plain"
                {...(activeFilters.length > 0 ? { action: <Button onClick={reset} size="sm" variant="outline">{t("common.clearAll")}</Button> } : {})}
              />
            ) : (
              <>
                <AuditTable events={query.data.items} onSelect={setSelected} selectedId={selected?.id ?? null} />
                <div className="flex items-center justify-between gap-2 border-t border-border p-4">
                  <p className="text-sm text-muted-foreground">{t("audit.events.shownCount", { count: query.data.items.length })}</p>
                  <div className="flex items-center gap-2">
                    <Button disabled={!cursor} onClick={() => { setCursor(null); setSelected(null); }} size="sm" variant="outline">{t("common.pagination.firstPage")}</Button>
                    <Button disabled={!query.data.nextCursor} onClick={() => { setCursor(query.data.nextCursor); setSelected(null); }} size="sm" variant="outline">{t("common.pagination.nextPage")}</Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <AuditDetail event={selected} />
      </div>
    </Page>
  );
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function AuditTable({ events, onSelect, selectedId }: { events: AuditEvent[]; onSelect: (event: AuditEvent) => void; selectedId: string | null }) {
  const { locale } = useLocale();
  const t = useTranslation();
  const me = useQuery({ queryKey: ["me"], queryFn: ({ signal }) => api.me(signal), staleTime: 30_000 });
  const actorLabel = (event: AuditEvent) => {
    if (!event.actorAccountId) return <span className="text-xs font-medium text-foreground">{t("audit.systemActor")}</span>;
    if (me.data && event.actorAccountId === me.data.accountId) return <span className="text-xs font-medium text-foreground">{t("audit.you")}</span>;
    if (uuidPattern.test(event.actorAccountId)) return <CopyableId label={t("common.id.identifier")} value={event.actorAccountId} />;
    return <span className="break-all text-xs font-medium text-foreground">{event.actorAccountId}</span>;
  };
  return (
    <Table className="min-w-[560px]" containerClassName="max-h-[65vh]" scrollLabel={t("audit.events.scrollLabel")}>
      <thead>
        <tr>
          <Th>{t("audit.table.time")}</Th>
          <Th>{t("audit.table.action")}</Th>
          <Th>{t("audit.table.actorCategory")}</Th>
          <Th>
            {t("audit.table.outcome")}
            <GlossaryTerm className="ml-1" id="auditOutcome" variant="icon" />
          </Th>
          <Th className="w-12"><span className="sr-only">{t("audit.table.details")}</span></Th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <Tr
            className={cn("cursor-pointer", selectedId === event.id && "bg-muted/60 hover:bg-muted/60")}
            key={event.id}
            onClick={() => onSelect(event)}
          >
            <Td className="whitespace-nowrap px-3 text-xs">
              <span className="font-medium text-foreground">{formatRelativeTime(event.occurredAt, Date.now(), locale)}</span>
              <p className="mt-0.5 text-muted-foreground">{formatDate(event.occurredAt, locale)}</p>
            </Td>
            <Td>
              <code className="font-mono text-xs font-medium text-foreground">{event.action}</code>
              {event.targetType && (
                <span className="mt-0.5 flex max-w-[16rem] items-center gap-1 text-xs text-muted-foreground">
                  <span className="shrink-0">{event.targetType}</span>
                  {event.targetId && <span aria-hidden="true">·</span>}
                  {event.targetId && (uuidPattern.test(event.targetId) ? <CopyableId label={t("common.id.targetId")} value={event.targetId} /> : <span className="truncate">{event.targetId}</span>)}
                </span>
              )}
            </Td>
            <Td className="max-w-[11rem] px-3">
              <div className="max-w-full">{actorLabel(event)}</div>
              {event.actorRole && <p className="text-xs text-muted-foreground">{t(`status.role.${event.actorRole}`)}</p>}
              <Badge className="mt-1" tone="neutral">{t(`status.auditCategory.${event.category}`)}</Badge>
            </Td>
            <Td className="whitespace-nowrap px-3">
              <Badge dot tone={outcomeTone(event.outcome)}>{t(`status.auditOutcome.${event.outcome}`)}</Badge>
            </Td>
            <Td>
              <Button
                aria-controls="audit-event-detail"
                aria-label={t("audit.inspectEventAriaLabel", { action: event.action })}
                aria-pressed={selectedId === event.id}
                onClick={(clickEvent) => { clickEvent.stopPropagation(); onSelect(event); }}
                size="icon-sm"
                variant="ghost"
              >
                <ChevronRight aria-hidden="true" className={cn("transition-transform", selectedId === event.id && "translate-x-0.5 text-foreground")} />
              </Button>
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

function AuditDetail({ event }: { event: AuditEvent | null }) {
  const { locale } = useLocale();
  const t = useTranslation();
  const metadata = event ? JSON.stringify(event.metadata, null, 2) : "";
  return (
    <Card aria-live="polite" className="h-fit xl:sticky xl:top-[4.75rem]" id="audit-event-detail">
      <CardHeader>
        <CardTitle>{t("audit.detail.title")}</CardTitle>
        <CardDescription>{t("audit.detail.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {!event ? (
          <div className="grid place-items-center rounded-lg border border-dashed border-border py-16 text-center">
            <FileClock aria-hidden="true" className="mb-3 size-5 text-muted-foreground/70" />
            <p className="max-w-[16rem] text-sm leading-relaxed text-muted-foreground">
              {t("audit.detail.placeholder")}
            </p>
          </div>
        ) : (
          <div className="grid animate-fade-in gap-4">
            <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 rounded-lg border border-border bg-muted/20 p-4 text-xs">
              <dt className="font-medium text-muted-foreground">{t("audit.detail.eventId")}</dt>
              <dd className="min-w-0"><CopyableId label={t("common.id.eventId")} value={event.id} /></dd>
              <dt className="font-medium text-muted-foreground">{t("audit.detail.requestId")}</dt>
              <dd className="min-w-0"><CopyableId label={t("common.id.requestId")} value={event.requestId} /></dd>
              <dt className="font-medium text-muted-foreground">{t("audit.detail.occurred")}</dt>
              <dd className="text-foreground">{formatDate(event.occurredAt, locale)}</dd>
              <dt className="font-medium text-muted-foreground">{t("audit.detail.category")}</dt>
              <dd className="font-medium text-foreground">{t(`status.auditCategory.${event.category}`)}</dd>
              <dt className="font-medium text-muted-foreground">{t("audit.detail.action")}</dt>
              <dd className="font-medium text-foreground">{event.action}</dd>
              <dt className="font-medium text-muted-foreground">{t("audit.detail.outcome")}</dt>
              <dd><Badge dot tone={outcomeTone(event.outcome)}>{t(`status.auditOutcome.${event.outcome}`)}</Badge></dd>
              <dt className="font-medium text-muted-foreground">{t("audit.detail.errorCode")}</dt>
              <dd><code className="font-mono text-xs text-muted-foreground">{event.errorCode ?? t("common.emptyValue")}</code></dd>
              <dt className="font-medium text-muted-foreground">{t("audit.detail.target")}</dt>
              <dd className="min-w-0 text-foreground">
                {event.targetType ?? t("common.emptyValue")}
                {event.targetId && <span className="mt-0.5 block"><CopyableId label={t("common.id.targetId")} value={event.targetId} /></span>}
              </dd>
            </dl>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  {t("audit.detail.metadataPayload")}
                  <GlossaryTerm id="idempotencyKey" variant="icon" />
                </p>
              </div>
              <CodeBlock copyLabel={t("common.id.metadataPayload")} label={t("audit.detail.metadataPayload")} maxHeightClassName="max-h-[440px]" value={metadata} wrap={false} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
