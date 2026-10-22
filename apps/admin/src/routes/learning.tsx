import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowRight, Check, FileText, FolderKanban, RefreshCw, X } from "lucide-react";
import { useState, type ButtonHTMLAttributes } from "react";
import { useParams } from "react-router-dom";

import { EmptyState, ErrorState, PageSkeleton } from "../components/async-state";
import { EmptyLearningIllustration } from "../components/illustrations/empty-learning";
import { ListRow, Meta, MetaItem, Page, PageHeader, RowLink, Section } from "../components/page";
import { Alert } from "../components/ui/alert";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ButtonLink } from "../components/ui/button-link";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardHeaderText, CardTitle } from "../components/ui/card";
import { DescriptionItem, DescriptionList } from "../components/ui/description-list";
import { ConfirmDialog } from "../components/ui/dialog";
import { Disclosure } from "../components/ui/disclosure";
import { Field, Select } from "../components/ui/field";
import { Tabs } from "../components/ui/tabs";
import { api } from "../lib/api";
import { useLocale, useTranslation } from "../lib/i18n";
import type { CatalogKey } from "../lib/i18n/catalog";
import { groupByPeriod } from "../lib/learning-groups";
import { pendingSuggestionsQuery } from "../lib/learning-queries";
import type { IngestPayload, IngestionStatus, LearningItem, ReviewDecision } from "../lib/learning-types";
import { cn, formatDate, formatNumber, formatShortDateTime } from "../lib/utils";

const statusKeys: Record<string, CatalogKey> = {
  accept: "learning.accepted",
  reject: "learning.rejected",
  awaiting_review: "learning.pending",
  policy_denied: "learning.pending",
  reviewed: "learning.reviewed",
  committing: "learning.committing",
  completed: "learning.completed",
  completed_with_skips: "learning.completed_with_skips",
  failed: "learning.failed",
  committed: "learning.completed",
  skipped: "learning.skipped",
};

function statusTone(status: string): BadgeTone {
  switch (status) {
    case "accept":
    case "completed":
    case "committed":
      return "success";
    case "reject":
    case "failed":
      return "danger";
    case "completed_with_skips":
    case "skipped":
    case "committing":
      return "warning";
    case "reviewed":
      return "info";
    default:
      return "neutral";
  }
}

function Quote({ children }: { children: React.ReactNode }) {
  return (
    <blockquote className="whitespace-pre-wrap break-words rounded-md border-l-2 border-primary/40 bg-muted/40 px-3.5 py-2.5 text-sm leading-relaxed text-foreground/90">
      {children}
    </blockquote>
  );
}

type LearningKind = LearningItem["kind"];
type LearningView = "pending" | "history";

/** A second-level filter under the source tabs: a quiet toggle with an optional count. */
function FilterChip({ active, count, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean; count?: string | undefined }) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-frame",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        className,
      )}
      type="button"
      {...props}
    >
      {children}
      {count !== undefined && " "}
      {count !== undefined && (
        <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", active ? "bg-muted-foreground/15 text-foreground/80" : "bg-muted-foreground/12 text-muted-foreground")}>{count}</span>
      )}
    </button>
  );
}

/**
 * One inbox row: the title is the link and covers the whole row, the date and
 * anything unusual sit under it, and the action reads "Review" with an arrow
 * that only appears on hover or focus. `quiet` hides the status every pending
 * row would otherwise repeat.
 */
function LearningRow({ item, quiet }: { item: LearningItem; quiet: boolean }) {
  const t = useTranslation();
  const { locale } = useLocale();
  const statusKey = statusKeys[item.status] ?? "learning.pending";
  return (
    <ListRow className="gap-1 has-[:focus-visible]:bg-muted/25 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring/30">
      <RowLink className="block text-sm font-medium leading-snug text-foreground focus-visible:ring-0" to={`/learning/${item.kind}/${item.id}`}>
        <span className="line-clamp-2 break-words">{item.title || t("learning.redacted")}</span>
      </RowLink>
      <div className="flex items-center justify-between gap-4">
        <Meta>
          <MetaItem>{formatShortDateTime(item.createdAt, locale)}</MetaItem>
          {item.count > 1 && <MetaItem>{t("learning.count", { count: item.count })}</MetaItem>}
          {!(quiet && statusKey === "learning.pending") && <MetaItem tone={statusTone(item.status)}>{t(statusKey)}</MetaItem>}
        </Meta>
        <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover/row:text-foreground group-focus-within/row:text-foreground">
          {t("learning.review")}
          <ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100" />
        </span>
      </div>
    </ListRow>
  );
}

export function LearningPage() {
  const t = useTranslation();
  const { locale } = useLocale();
  const [kind, setKind] = useState<LearningKind>("dreaming");
  const [view, setView] = useState<LearningView>("pending");
  const query = useInfiniteQuery({
    queryKey: ["learning", kind, view],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api.learningList({ kind, status: view, cursor: pageParam }, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
  // What is waiting from each source, independent of the view, for the header total and the Pending count.
  const pendingDreaming = useQuery(pendingSuggestionsQuery("dreaming"));
  const pendingIngestion = useQuery(pendingSuggestionsQuery("ingestion"));
  const summaries = { dreaming: pendingDreaming.data, ingestion: pendingIngestion.data };
  const pendingTotal = Object.values(summaries).reduce((sum, page) => sum + (page?.items.length ?? 0), 0);
  const pendingBeyondPage = Object.values(summaries).some((page) => page?.nextCursor);
  const current = summaries[kind];
  const pendingCount = current ? (current.nextCursor ? t("learning.countMore", { count: current.items.length }) : formatNumber(current.items.length, locale)) : undefined;
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const groups = groupByPeriod(items);
  return (
    <Page>
      <PageHeader
        description={t("learning.description")}
        meta={pendingTotal > 0 && <span className="text-xs tabular-nums text-muted-foreground">{t(pendingBeyondPage ? "learning.pendingTotalMore" : "learning.pendingTotal", { count: pendingTotal })}</span>}
        title={t("learning.title")}
      />
      <div className="grid max-w-[66rem] gap-6">
        <div className="grid gap-3">
          <Tabs
            items={[
              { id: "dreaming", label: t("learning.dreaming") },
              { id: "ingestion", label: t("learning.ingestion") },
            ]}
            label={t("learning.kind")}
            onChange={(id) => setKind(id as LearningKind)}
            value={kind}
            variant="underline"
          />
          <div aria-label={t("learning.filter")} className="flex flex-wrap items-center gap-1" role="group">
            <FilterChip active={view === "pending"} count={pendingCount} onClick={() => setView("pending")}>
              {t("learning.filterPending")}
            </FilterChip>
            <FilterChip active={view === "history"} onClick={() => setView("history")}>
              {t("learning.filterHistory")}
            </FilterChip>
          </div>
        </div>
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => query.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState description={t("learning.emptyHint")} illustration={<EmptyLearningIllustration />} title={t("learning.empty")} />
        ) : (
          <div className="grid gap-6" key={`${kind}:${view}`}>
            {groups.map((group, index) => (
              <Disclosure
                contentClassName="mt-2 grid gap-3"
                key={group.period}
                open={!group.folded}
                size="sm"
                summary={
                  <>
                    <span>{t(`learning.period.${group.period}`)}</span> <span className="tabular-nums text-muted-foreground/70">{formatNumber(group.items.length, locale)}</span>
                  </>
                }
                summaryClassName="-ml-2 uppercase tracking-[0.06em] sm:-ml-1"
              >
                <ul className="divide-y divide-border border-y border-border">
                  {group.items.map((item) => (
                    <LearningRow item={item} key={item.id} quiet={view === "pending"} />
                  ))}
                </ul>
                {index === groups.length - 1 && query.hasNextPage && (
                  <div className="flex justify-center">
                    <Button disabled={query.isFetchingNextPage} loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()} size="sm" variant="ghost">
                      {t("learning.more")}
                    </Button>
                  </div>
                )}
              </Disclosure>
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}

export function LearningDreamingPage() {
  const { changeId = "" } = useParams();
  const t = useTranslation();
  const client = useQueryClient();
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const query = useQuery({
    queryKey: ["learning-dreaming", changeId],
    queryFn: ({ signal }) => api.learningDreaming(changeId, signal),
  });
  const mutation = useMutation({
    mutationFn: (choice: ReviewDecision) =>
      api.reviewDreaming({
        changeId,
        fingerprint: query.data!.result!.fingerprint,
        decision: choice,
        idempotencyKey: `review:${changeId}:${choice}`,
      }),
    onSuccess: async () => {
      setDecision(null);
      await Promise.all([
        query.refetch(),
        client.invalidateQueries({ queryKey: ["learning"] }),
        client.invalidateQueries({ queryKey: ["memories"] }),
      ]);
    },
  });
  const item = query.data?.result;
  return (
    <Page>
      <PageHeader
        actions={
          item && !item.receipt ? (
            <Button loading={query.isFetching && !query.isPending} onClick={() => query.refetch()} size="sm" variant="ghost">
              {!(query.isFetching && !query.isPending) && <RefreshCw aria-hidden="true" />}
              {t("common.refresh")}
            </Button>
          ) : undefined
        }
        back={{ to: "/learning", label: t("learning.back") }}
        description={t("learning.description")}
        title={t("learning.dreaming")}
      />
      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : !item ? (
        <EmptyState description={t("learning.missingHint")} illustration={<EmptyLearningIllustration />} title={t("learning.missing")} />
      ) : (
        <>
          {item.receipt ? (
            <Alert title={t(item.receipt.decision === "accept" ? "learning.accepted" : "learning.rejected")} tone={item.receipt.decision === "accept" ? "success" : "info"}>
              {item.receipt.resultMemoryId && (
                <ButtonLink className="mt-2" size="sm" to="/memories" variant="outline">
                  {t("learning.result")}
                  <ArrowRight aria-hidden="true" />
                </ButtonLink>
              )}
            </Alert>
          ) : (
            item.blockedReason && <Alert title={t("learning.blocked")} tone="warning" />
          )}
          {mutation.isError && <Alert title={t("learning.failure")} tone="danger" />}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t("learning.before")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{item.target?.content ?? t("learning.new")}</p>
              </CardContent>
            </Card>
            <Card className="border-primary/30 bg-primary/[0.02]">
              <CardHeader>
                <CardTitle>{t("learning.after")}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{item.proposal.content || t("learning.redacted")}</p>
                {(item.proposal.category || item.proposal.tags.length > 0) && (
                  <DescriptionList className="border-t border-border/60 pt-4">
                    {item.proposal.category && <DescriptionItem label={t("learning.field.category")}>{item.proposal.category}</DescriptionItem>}
                    {item.proposal.tags.length > 0 && (
                      <DescriptionItem label={t("learning.field.tags")}>
                        <span className="flex flex-wrap gap-1">{item.proposal.tags.map((tag) => <Badge key={tag} tone="neutral">#{tag}</Badge>)}</span>
                      </DescriptionItem>
                    )}
                  </DescriptionList>
                )}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader className="sm:flex-row sm:items-start sm:justify-between">
              <CardHeaderText>
                <CardTitle>{t("learning.evidence")}</CardTitle>
              </CardHeaderText>
              <ButtonLink className="shrink-0" size="sm" to={`/automation/dreaming/runs/${item.runId}`} variant="ghost">
                <FileText aria-hidden="true" />
                {t("learning.report")}
              </ButtonLink>
            </CardHeader>
            <CardContent className="grid gap-2">
              {item.evidence.map((evidence) => (
                <Quote key={evidence.id}>{evidence.redacted ? t("learning.redacted") : evidence.excerpt}</Quote>
              ))}
            </CardContent>
            {!item.receipt && (
              <CardFooter className="border-t border-border/60 pt-4 sm:pt-4">
                <Button disabled={!!item.blockedReason || mutation.isPending} onClick={() => setDecision("accept")}>
                  <Check aria-hidden="true" />
                  {t("learning.accept")}
                </Button>
                <Button disabled={mutation.isPending} onClick={() => setDecision("reject")} variant="outline">
                  <X aria-hidden="true" />
                  {t("learning.reject")}
                </Button>
              </CardFooter>
            )}
          </Card>
          <ConfirmDialog
            confirmLabel={t(decision === "accept" ? "learning.accept" : "learning.reject")}
            description={t(decision === "accept" ? "learning.acceptHint" : "learning.rejectHint")}
            onCancel={() => {
              if (!mutation.isPending) setDecision(null);
            }}
            onConfirm={() => {
              if (decision) mutation.mutate(decision);
            }}
            open={decision !== null}
            pending={mutation.isPending}
            title={t(decision === "accept" ? "learning.confirmAccept" : "learning.confirmReject")}
            tone={decision === "reject" ? "danger" : "default"}
          />
        </>
      )}
    </Page>
  );
}

function ProposalFields({ payload }: { payload: IngestPayload }) {
  const t = useTranslation();
  const { locale } = useLocale();
  const date = (value: string | null) => (value ? formatDate(value, locale) : null);
  const fields: [CatalogKey, string | null][] = [];
  let title: string;
  switch (payload.kind) {
    case "memory":
      title = payload.content;
      fields.push(["learning.field.category", payload.category], ["learning.field.tags", payload.tags.join(", ")]);
      break;
    case "decision":
      title = payload.statement;
      fields.push(
        ["learning.field.rationale", payload.rationale],
        ["learning.field.alternatives", payload.rejectedAlternatives.map((item) => [item.option, item.reason].filter(Boolean).join(": ")).join("\n")],
        ["learning.field.date", date(payload.decidedAt)],
      );
      break;
    case "task":
      title = payload.title;
      fields.push(
        ["learning.field.description", payload.description],
        ["learning.field.priority", t(`learning.priority.${payload.priority as "low" | "normal" | "high" | "urgent"}`)],
        ["learning.field.date", date(payload.dueAt)],
      );
      break;
    case "reminder":
      title = payload.message;
      fields.push(["learning.field.date", date(payload.remindAt)]);
      break;
    case "person":
      title = payload.name;
      fields.push(["learning.field.aliases", payload.aliases.join(", ")], ["learning.field.notes", payload.notes]);
      break;
  }
  const visible = fields.filter(([, value]) => !!value);
  return (
    <>
      <h3 className="whitespace-pre-wrap break-words text-base font-medium leading-snug text-foreground">{title}</h3>
      {visible.length > 0 && (
        <DescriptionList>
          {visible.map(([key, value]) => (
            <DescriptionItem className="whitespace-pre-wrap" key={key} label={t(key)}>{value}</DescriptionItem>
          ))}
        </DescriptionList>
      )}
      {"projectId" in payload && payload.projectId && (
        <ButtonLink className="w-fit" size="sm" to={`/projects/${payload.projectId}`} variant="outline">
          <FolderKanban aria-hidden="true" />
          {t("learning.field.project")}
        </ButtonLink>
      )}
    </>
  );
}

export function LearningIngestionPage() {
  const { runId = "" } = useParams();
  const t = useTranslation();
  const query = useQuery({
    queryKey: ["learning-ingestion", runId],
    queryFn: ({ signal }) => api.ingestionStatus(runId, signal),
  });
  return (
    <Page>
      <PageHeader
        actions={
          <Button loading={query.isFetching && !query.isPending} onClick={() => query.refetch()} size="sm" variant="ghost">
            {!(query.isFetching && !query.isPending) && <RefreshCw aria-hidden="true" />}
            {t("common.refresh")}
          </Button>
        }
        back={{ to: "/learning", label: t("learning.back") }}
        description={t("learning.description")}
        title={t("learning.ingestion")}
      />
      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : !query.data.result ? (
        <EmptyState description={t("learning.missingHint")} illustration={<EmptyLearningIllustration />} title={t("learning.missing")} />
      ) : (
        <IngestionReview
          data={query.data.result}
          key={`${runId}:${query.data.result.review?.reviewDigest ?? query.data.result.run.proposalDigest}`}
          refresh={() => query.refetch()}
        />
      )}
    </Page>
  );
}

function IngestionReview({ data, refresh }: { data: IngestionStatus; refresh: () => Promise<unknown> }) {
  const t = useTranslation();
  const client = useQueryClient();
  const [choices, setChoices] = useState<Record<string, ReviewDecision>>({});
  const [confirm, setConfirm] = useState(false);
  const refreshAll = async () => {
    await Promise.all([
      refresh(),
      client.invalidateQueries({ queryKey: ["learning"] }),
      client.invalidateQueries({ queryKey: ["memories"] }),
    ]);
  };
  const save = useMutation({
    mutationFn: () =>
      api.reviewIngestion({
        runId: data.run.id,
        proposalDigest: data.run.proposalDigest!,
        items: data.proposals.map((item) => ({ proposalId: item.id, decision: choices[item.id]! })),
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: refreshAll,
  });
  const commit = useMutation({
    mutationFn: () =>
      api.commitIngestion({
        runId: data.run.id,
        reviewedDigest: data.review!.reviewDigest,
        idempotencyKey: `review-commit:${data.run.id}:${data.review!.reviewDigest}`,
      }),
    onSuccess: async () => {
      setConfirm(false);
      await refreshAll();
    },
  });
  const canChoose = data.run.status === "awaiting_review" && data.review === null;
  const canApply = !!data.review && ["reviewed", "committing"].includes(data.run.status);
  const complete = data.run.status === "completed" || data.run.status === "completed_with_skips";
  const decided = data.proposals.filter((item) => choices[item.id]).length;
  return (
    <>
      {complete && <Alert title={t(statusKeys[data.run.status]!)} tone="success" />}
      {(save.isError || commit.isError) && <Alert title={t("learning.failure")} tone="danger" />}
      <Section
        actions={canChoose ? <Badge tone={decided === data.proposals.length ? "success" : "neutral"}>{decided} / {data.proposals.length}</Badge> : undefined}
        description={t(data.review ? "learning.applyHint" : "learning.saveHint")}
        title={t(data.review ? "learning.stepApply" : "learning.stepReview")}
      >
        <div className="grid gap-4">
          {data.proposals.map((item) => {
            const choice = data.review?.items.find((review) => review.proposalId === item.id)?.decision;
            const receipt = data.receipts.find((value) => value.proposalId === item.id);
            const missingList = item.payload.kind === "task" && !item.payload.listId;
            const current = choices[item.id];
            return (
              <Card key={item.id}>
                <CardHeader className="flex-row items-start justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{t(`learning.kind.${item.payload.kind}`)}</Badge>
                    <span className="text-xs text-muted-foreground">{t("common.matchPercent", { percent: Math.round(item.confidence * 100) })}</span>
                  </div>
                  {!canChoose && choice && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge dot tone={statusTone(choice)}>{t(choice === "accept" ? "learning.accepted" : "learning.rejected")}</Badge>
                      {receipt && <Badge tone={statusTone(receipt.status)}>{t(statusKeys[receipt.status]!)}</Badge>}
                    </div>
                  )}
                </CardHeader>
                <CardContent className="grid gap-4">
                  <ProposalFields payload={item.payload} />
                  <div className="grid gap-2">
                    <p className="text-xs font-medium text-muted-foreground">{t("learning.evidence")}</p>
                    <Quote>{item.sourceQuote}</Quote>
                  </div>
                  {missingList && <Alert title={t("learning.taskListMissing")} tone="warning" />}
                </CardContent>
                {canChoose && (
                  <CardFooter className="border-t border-border/60 pt-4 sm:pt-4">
                    <Field className="w-full sm:max-w-xs" htmlFor={`review-${item.id}`} label={t("learning.choose")}>
                      <Select
                        disabled={save.isPending}
                        id={`review-${item.id}`}
                        onChange={(event) => setChoices((previous) => ({ ...previous, [item.id]: event.target.value as ReviewDecision }))}
                        value={current ?? ""}
                      >
                        <option disabled value="">{t("learning.choose")}</option>
                        <option disabled={missingList} value="accept">{t("learning.accept")}</option>
                        <option value="reject">{t("learning.reject")}</option>
                      </Select>
                    </Field>
                    {current && (
                      <Badge className="sm:mt-6" dot tone={statusTone(current)}>{t(current === "accept" ? "learning.accepted" : "learning.rejected")}</Badge>
                    )}
                  </CardFooter>
                )}
              </Card>
            );
          })}
        </div>
      </Section>
      {(canChoose || canApply) && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/95 p-4 shadow-elevated backdrop-blur-md">
          <CardDescription className="max-w-xl">{t(data.review ? "learning.applyHint" : "learning.saveHint")}</CardDescription>
          {canChoose && (
            <Button disabled={save.isPending || !data.run.proposalDigest || data.proposals.some((item) => !choices[item.id])} loading={save.isPending} onClick={() => save.mutate()}>
              {t("learning.save")}
            </Button>
          )}
          {canApply && (
            <Button disabled={commit.isPending} loading={commit.isPending} onClick={() => setConfirm(true)}>
              {t("learning.apply")}
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        confirmLabel={t("learning.apply")}
        description={t("learning.applyHint")}
        onCancel={() => {
          if (!commit.isPending) setConfirm(false);
        }}
        onConfirm={() => commit.mutate()}
        open={confirm}
        pending={commit.isPending}
        title={t("learning.apply")}
      />
    </>
  );
}
