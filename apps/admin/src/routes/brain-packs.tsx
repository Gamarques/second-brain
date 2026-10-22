import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, LoaderCircle, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { EmptyState, ErrorState, PageSkeleton } from "../components/async-state";
import { ManifestCard, PublisherMark } from "../components/brain-pack/manifest-card";
import { EmptyPacksIllustration } from "../components/illustrations/empty-packs";
import { ListCard, ListRow, Meta, MetaItem, Page, PageHeader } from "../components/page";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { ButtonLink } from "../components/ui/button-link";
import { Card, CardContent } from "../components/ui/card";
import { Disclosure } from "../components/ui/disclosure";
import { Field, Input, Select } from "../components/ui/field";
import { Step, StepHint } from "../components/ui/step";
import { useToast } from "../components/ui/toast";
import { api, ApiError } from "../lib/api";
import type { KnowledgeBase } from "../lib/api-types";
import { allowedBrainPackDecisions, brainPackClassificationTone, brainPackDecisionNeedsRevision, brainPackErrorKey, brainPackImportStep, brainPackStatusTone, defaultBrainPackDecision, formatBytes, isBrainPackRunActive, saveBlob } from "../lib/brain-pack";
import {
  brainPackLimits,
  type BrainPackCollectionMapping,
  type BrainPackImportRun,
  type BrainPackItemDecision,
  type BrainPackItemReview,
  type BrainPackRunItem,
  type BrainPackRunSummary,
} from "../lib/brain-pack-types";
import { useLocale, useTranslation } from "../lib/i18n";
import { cn, formatDate, formatNumber, formatRelativeTime, newIdempotencyKey } from "../lib/utils";

/** The engine resumes only imports that failed after their review was frozen; everything else starts over. */
function canRetry(run: { kind: string; status: string; reviewDigest: string | null }): boolean {
  return run.kind === "import" && run.status === "failed" && run.reviewDigest !== null;
}

function isActiveImportLimit(error: unknown): boolean {
  return error instanceof ApiError && (error.problem.error === "PACK_LIMIT_EXCEEDED" || error.problem.code === "PACK_LIMIT_EXCEEDED" || error.message.includes("PACK_LIMIT_EXCEEDED"));
}


const importPagePath = "/knowledge/packs/import";
const historyPath = "/knowledge/packs";
const itemsPerPage = 100;

function StatusItem({ run }: { run: BrainPackRunSummary }) {
  const t = useTranslation();
  return (
    <MetaItem tone={brainPackStatusTone(run.status)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {t(`packs.status.${run.status}`)}
    </MetaItem>
  );
}

function useRunActions() {
  const t = useTranslation();
  const client = useQueryClient();
  const { toast } = useToast();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["brain-pack-runs"] });
    void client.invalidateQueries({ queryKey: ["brain-pack-import"] });
  };
  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelBrainPackRun({ runId, idempotencyKey: newIdempotencyKey("brain-pack-cancel") }),
    onSuccess: (result) => {
      // While the worker holds the run, cancel only flags it; the run turns canceled at its next stage boundary.
      const title = result.canceled ? "packs.toast.canceled" : isBrainPackRunActive(result.status) ? "packs.toast.cancelRequested" : "packs.toast.alreadyDone";
      toast({ title: t(title), tone: result.canceled || isBrainPackRunActive(result.status) ? "info" : "warning" });
      refresh();
    },
    onError: (error: unknown) => toast({ title: t("packs.toast.actionFailed"), ...(error instanceof Error ? { description: error.message } : {}), tone: "danger" }),
  });
  const retry = useMutation({
    mutationFn: (runId: string) => api.retryBrainPackRun({ runId, idempotencyKey: newIdempotencyKey("brain-pack-retry") }),
    onSuccess: () => {
      toast({ title: t("packs.toast.retried"), tone: "info" });
      refresh();
    },
    onError: (error: unknown) => toast({ title: t("packs.toast.actionFailed"), ...(error instanceof Error ? { description: error.message } : {}), tone: "danger" }),
  });
  const download = useMutation({
    mutationFn: async (runId: string) => {
      const { blob, fileName } = await api.downloadBrainPack(runId);
      saveBlob(blob, fileName);
    },
    onError: (error: unknown) => toast({ title: t("packs.toast.actionFailed"), ...(error instanceof Error ? { description: error.message } : {}), tone: "danger" }),
  });
  return { cancel, retry, download, refresh };
}

/** Every import and export, newest first, with the one action each state allows. */
export function BrainPacksPage() {
  const t = useTranslation();
  const { locale } = useLocale();
  const runs = useQuery({
    queryKey: ["brain-pack-runs"],
    queryFn: ({ signal }) => api.brainPackRuns({ kind: null, status: null, cursor: null, limit: 50 }, signal),
    refetchInterval: (query) => (query.state.data?.items.some((run) => isBrainPackRunActive(run.status)) ? 5_000 : false),
  });
  const bases = useQuery({ queryKey: ["knowledge-bases"], queryFn: ({ signal }) => api.knowledgeBases(signal) });
  const { cancel, retry, download } = useRunActions();

  return (
    <Page>
      <PageHeader
        actions={
          <>
            <ButtonLink to={importPagePath} variant="outline">
              <Upload aria-hidden="true" />
              {t("packs.import")}
            </ButtonLink>
            <ButtonLink to="/knowledge/packs/export">
              <Download aria-hidden="true" />
              {t("packs.export")}
            </ButtonLink>
          </>
        }
        back={{ to: "/knowledge", label: t("knowledge.allBasesLink") }}
        description={t("packs.description")}
        title={t("packs.title")}
      />
      {runs.isPending ? (
        <PageSkeleton cards={1} label={t("packs.loading")} />
      ) : runs.isError ? (
        <ErrorState error={runs.error} retry={() => runs.refetch()} />
      ) : runs.data.items.length === 0 ? (
        <EmptyState
          action={
            <ButtonLink size="sm" to={importPagePath} variant="outline">
              <Upload aria-hidden="true" />
              {t("packs.history.empty.action")}
            </ButtonLink>
          }
          description={t("packs.history.empty.description")}
          illustration={<EmptyPacksIllustration />}
          title={t("packs.history.empty.title")}
        />
      ) : (
        <ListCard aria-label={t("packs.history.ariaLabel")}>
          {runs.data.items.map((run) => {
            const active = isBrainPackRunActive(run.status);
            return (
              <ListRow className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={run.id}>
                <div className="flex min-w-0 items-start gap-3">
                  <PublisherMark className="size-8 text-xs" publisher={run.publisher} />
                  <div className="grid min-w-0 gap-1">
                    <p className="text-sm font-medium leading-snug text-foreground">{run.title ?? t("packs.run.untitled")}</p>
                    <Meta>
                      <MetaItem icon={run.kind === "import" ? Upload : Download}>{t(`packs.kind.${run.kind}`)}</MetaItem>
                      {run.publisher && <MetaItem>{run.publisher.displayName}</MetaItem>}
                      {run.packRevision !== null && <MetaItem>{t("packs.run.revision", { revision: run.packRevision })}</MetaItem>}
                      <StatusItem run={run} />
                      {run.progress && <MetaItem>{t("packs.run.progress", { processed: run.progress.processedItems, total: run.progress.totalItems })}</MetaItem>}
                      <MetaItem>{formatRelativeTime(run.completedAt ?? run.updatedAt, Date.now(), locale)}</MetaItem>
                      {run.status === "failed" && <MetaItem tone="danger">{t(brainPackErrorKey(run.sanitizedError))}</MetaItem>}
                    </Meta>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {run.kind === "import" && (
                    <ButtonLink size="sm" to={`/knowledge/packs/imports/${run.id}`} variant="outline">
                      {t("packs.run.open")}
                    </ButtonLink>
                  )}
                  {run.kind === "export" && run.status === "completed" && (
                    <Button loading={download.isPending && download.variables === run.id} onClick={() => download.mutate(run.id)} size="sm" variant="outline">
                      {t("packs.run.download")}
                    </Button>
                  )}
                  {active && (
                    <Button disabled={cancel.isPending} onClick={() => cancel.mutate(run.id)} size="sm" variant="ghost">
                      {t("common.cancel")}
                    </Button>
                  )}
                  {run.kind === "export" && run.status === "completed" && run.packId && run.packRevision !== null && (
                    <ButtonLink size="sm" to={`/knowledge/packs/export?packId=${encodeURIComponent(run.packId)}&revision=${run.packRevision + 1}${run.title ? `&title=${encodeURIComponent(run.title)}` : ""}`} variant="ghost">
                      {t("packs.run.exportAgain")}
                    </ButtonLink>
                  )}
                  {canRetry(run) && (
                    <Button disabled={retry.isPending} onClick={() => retry.mutate(run.id)} size="sm" variant="ghost">
                      {t("packs.run.retry")}
                    </Button>
                  )}
                </div>
              </ListRow>
            );
          })}
        </ListCard>
      )}
    </Page>
  );
}

/** Step one of an import: choose the file. The run page takes over as soon as the upload is accepted. */
export function BrainPackImportStartPage() {
  const t = useTranslation();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const start = useMutation({
    mutationFn: async (file: File) => {
      controller.current?.abort();
      controller.current = new AbortController();
      const upload = await api.uploadBrainPack(file, controller.current.signal);
      return api.importBrainPack({ artifactId: upload.artifactId, idempotencyKey: newIdempotencyKey("brain-pack-import") });
    },
    onSuccess: (run) => navigate(`/knowledge/packs/imports/${run.runId}`),
  });
  useEffect(() => () => controller.current?.abort(), []);

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".brainpack")) {
      setError(t("packs.import.upload.wrongType"));
      return;
    }
    if (file.size > brainPackLimits.compressedBytes) {
      setError(t("packs.import.upload.tooLarge", { size: formatBytes(brainPackLimits.compressedBytes, locale) }));
      return;
    }
    setError(null);
    setFileName(file.name);
    start.mutate(file);
  }

  const stepTitles = ["validate", "preview", "destination", "review", "publish"] as const;

  return (
    <Page>
      <PageHeader back={{ to: historyPath, label: t("packs.history.link") }} description={t("packs.import.description")} title={t("packs.import.title")} />
      <Card>
        <CardContent className="grid divide-y divide-border/60 p-0 sm:p-0">
          <Step number={1} title={t("packs.import.step.upload")}>
            <StepHint>{t("packs.import.upload.hint", { size: formatBytes(brainPackLimits.compressedBytes, locale) })}</StepHint>
            <div className="flex flex-wrap items-center gap-3">
              <label className={cn("inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3 text-[13px] font-medium text-foreground shadow-xs transition-colors hover:bg-muted/50 focus-within:ring-2 focus-within:ring-ring/20", start.isPending && "pointer-events-none opacity-50")}>
                <Upload aria-hidden="true" className="size-3.5" />
                <span>{t("packs.import.upload.choose")}</span>
                <input accept=".brainpack,application/zip" className="sr-only" disabled={start.isPending} onChange={choose} type="file" />
              </label>
              {start.isPending && fileName && (
                <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
                  <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                  {t("packs.import.upload.uploading", { name: fileName })}
                </span>
              )}
            </div>
            {error && <p className="text-xs font-medium text-destructive" role="alert">{error}</p>}
            {start.isError && (isActiveImportLimit(start.error) ? <p className="text-xs font-medium text-destructive" role="alert">{t("packs.import.upload.activeLimit")}</p> : <ErrorState error={start.error} />)}
          </Step>
          {stepTitles.map((key, index) => (
            <Step key={key} muted number={index + 2} title={t(`packs.import.step.${key}`)} />
          ))}
        </CardContent>
      </Card>
    </Page>
  );
}

type DestinationChoice = { mode: "existing"; knowledgeBaseId: string } | { mode: "new"; name: string };

function seedDestinations(data: BrainPackImportRun, bases: readonly KnowledgeBase[]): Record<string, DestinationChoice> {
  const seeded: Record<string, DestinationChoice> = {};
  for (const collection of data.preview?.collections ?? []) {
    const existing = bases.find((base) => base.name.trim().toLocaleLowerCase() === collection.name.trim().toLocaleLowerCase());
    seeded[collection.key] = existing ? { mode: "existing", knowledgeBaseId: existing.id } : { mode: "new", name: collection.name };
  }
  return seeded;
}

function seedDecisions(items: readonly BrainPackRunItem[]): Record<string, BrainPackItemDecision> {
  const seeded: Record<string, BrainPackItemDecision> = {};
  for (const item of items) seeded[item.itemKey] = item.decision ?? defaultBrainPackDecision(item.classification);
  return seeded;
}

/** The guided import: what the pack holds, where it goes, what to do with each document, then publish. */
export function BrainPackImportRunPage() {
  const { runId = "" } = useParams();
  const t = useTranslation();
  const query = useQuery({
    queryKey: ["brain-pack-import", runId],
    queryFn: ({ signal }) => api.brainPackImport({ runId, cursor: null, limit: itemsPerPage }, signal),
    enabled: runId !== "",
    refetchInterval: (state) => {
      const status = state.state.data?.run.status;
      if (!status) return false;
      return isBrainPackRunActive(status) && status !== "awaiting_review" && status !== "reviewed" ? 2_000 : false;
    },
  });
  const bases = useQuery({ queryKey: ["knowledge-bases"], queryFn: ({ signal }) => api.knowledgeBases(signal) });

  if (query.isPending || bases.isPending) return <PageSkeleton cards={1} label={t("packs.loading")} />;
  if (query.isError) return <ErrorState error={query.error} retry={() => query.refetch()} />;
  if (bases.isError) return <ErrorState error={bases.error} retry={() => bases.refetch()} />;

  return (
    <Page>
      <PageHeader back={{ to: historyPath, label: t("packs.history.link") }} description={t("packs.import.description")} title={t("packs.import.title")} />
      <ImportSteps bases={bases.data.knowledgeBases} data={query.data} key={`${runId}:${query.data.run.reviewVersion}`} runId={runId} />
    </Page>
  );
}

function ImportSteps({ runId, data, bases }: { runId: string; data: BrainPackImportRun; bases: readonly KnowledgeBase[] }) {
  const t = useTranslation();
  const { locale } = useLocale();
  const client = useQueryClient();
  const { toast } = useToast();
  const { cancel, retry, refresh } = useRunActions();
  const { run, preview, receipt } = data;
  const [items, setItems] = useState(data.items.items);
  const [nextCursor, setNextCursor] = useState(data.items.nextCursor);
  const [destinations, setDestinations] = useState(() => seedDestinations(data, bases));
  const [decisions, setDecisions] = useState(() => seedDecisions(data.items.items));
  const [tags, setTags] = useState("");
  const [editing, setEditing] = useState(run.status === "awaiting_review");
  const step = brainPackImportStep(run.status);
  const failed = run.status === "failed";
  const canceled = run.status === "canceled";
  const reviewable = run.status === "awaiting_review" || run.status === "reviewed";

  const loadMore = useMutation({
    mutationFn: () => api.brainPackImport({ runId, cursor: nextCursor, limit: itemsPerPage }),
    onSuccess: (page) => {
      setItems((current) => [...current, ...page.items.items]);
      setNextCursor(page.items.nextCursor);
      setDecisions((current) => ({ ...seedDecisions(page.items.items), ...current }));
    },
  });
  const review = useMutation({
    mutationFn: (input: Parameters<typeof api.reviewBrainPackImport>[0]) => api.reviewBrainPackImport(input),
    onSuccess: () => {
      setEditing(false);
      void client.invalidateQueries({ queryKey: ["brain-pack-import", runId] });
    },
  });
  const publish = useMutation({
    mutationFn: (reviewDigest: string) => api.publishBrainPackImport({ runId, reviewDigest, idempotencyKey: newIdempotencyKey("brain-pack-publish") }),
    onSuccess: () => {
      toast({ title: t("packs.import.publish.queued"), tone: "success" });
      refresh();
    },
  });

  function freeze() {
    if (!preview) return;
    const collections: BrainPackCollectionMapping[] = preview.collections.map((collection) => {
      const choice = destinations[collection.key] ?? { mode: "new", name: collection.name };
      return {
        collectionKey: collection.key,
        destination:
          choice.mode === "existing"
            ? { knowledgeBaseId: choice.knowledgeBaseId }
            : { createKnowledgeBase: { name: choice.name.trim() || collection.name, description: collection.description } },
      };
    });
    const reviewed: BrainPackItemReview[] = items.map((item) => {
      const decision = decisions[item.itemKey] ?? defaultBrainPackDecision(item.classification);
      return { itemKey: item.itemKey, decision, expectedLocalRevision: brainPackDecisionNeedsRevision(decision) ? item.localRevision : null };
    });
    review.mutate({
      runId,
      expectedReviewVersion: run.reviewVersion,
      collections,
      items: reviewed,
      projectId: null,
      tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, brainPackLimits.tagsPerDocument),
      idempotencyKey: newIdempotencyKey("brain-pack-review"),
    });
  }

  const destinationsComplete = (preview?.collections ?? []).every((collection) => {
    const choice = destinations[collection.key];
    return choice !== undefined && (choice.mode === "existing" ? choice.knowledgeBaseId !== "" : choice.name.trim() !== "");
  });

  return (
    <Card>
      <CardContent className="grid divide-y divide-border/60 p-0 sm:p-0">
        <Step done number={1} title={t("packs.import.step.upload")}>
          <StepHint>{t("packs.import.upload.done")}</StepHint>
        </Step>

        <Step done={step > 2} number={2} title={t("packs.import.step.validate")}>
          {failed ? (
            <div className="grid gap-3">
              <Alert title={t("packs.import.failed.title")} tone="danger">
                <p>{t(brainPackErrorKey(run.sanitizedError))}</p>
                {run.sanitizedError && <code className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">{run.sanitizedError}</code>}
              </Alert>
              <div className="flex flex-wrap gap-2">
                <ButtonLink size="sm" to={importPagePath} variant="outline">{t("packs.import.failed.startOver")}</ButtonLink>
              </div>
            </div>
          ) : canceled && !preview ? (
            <CanceledNotice />
          ) : step > 2 ? (
            <StepHint>{t("packs.import.checked")}</StepHint>
          ) : (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
              {t("packs.import.validating")}
            </p>
          )}
        </Step>

        {preview && (
          <Step done={step > 3} number={3} title={t("packs.import.step.preview")}>
            <ManifestCard
              counts={{ collections: preview.counts.collections, documents: preview.counts.documents }}
              description={preview.description}
              packId={preview.packId}
              packRevision={preview.packRevision}
              publisher={preview.publisher}
              title={preview.title}
            />
            <Meta>
              {preview.counts.new > 0 && <MetaItem tone="success">{t("packs.import.preview.counts.new", { count: preview.counts.new })}</MetaItem>}
              {preview.counts.updated > 0 && <MetaItem tone="info">{t("packs.import.preview.counts.updated", { count: preview.counts.updated })}</MetaItem>}
              {preview.counts.unchanged > 0 && <MetaItem>{t("packs.import.preview.counts.unchanged", { count: preview.counts.unchanged })}</MetaItem>}
              {preview.counts.conflicting > 0 && <MetaItem tone="warning">{t("packs.import.preview.counts.conflicting", { count: preview.counts.conflicting })}</MetaItem>}
              {preview.counts.invalid > 0 && <MetaItem tone="danger">{t("packs.import.preview.counts.invalid", { count: preview.counts.invalid })}</MetaItem>}
            </Meta>
            <StepHint>
              {t("packs.import.preview.volume", {
                size: formatBytes(preview.volume.expandedBytes, locale),
                characters: formatNumber(preview.volume.documentCharacters, locale),
                chunks: formatNumber(preview.volume.estimatedChunks, locale),
              })}
            </StepHint>
            {preview.samples.length > 0 && (
              <Disclosure size="sm" summary={t("packs.import.preview.samples")}>
                <ul className="grid gap-2">
                  {preview.samples.map((sample) => (
                    <li className="grid gap-0.5" key={sample.itemKey}>
                      <p className="text-[13px] font-medium text-foreground">{sample.title}</p>
                      <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{sample.excerpt}</p>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </Step>
        )}

        {preview && (
          <Step done={!editing && step > 3} number={4} title={t("packs.import.step.destination")}>
            <ul className="grid gap-3">
              {preview.collections.map((collection) => {
                const choice = destinations[collection.key] ?? { mode: "new", name: collection.name };
                const selectId = `destination-${collection.key}`;
                return (
                  <li className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-center" key={collection.key}>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-foreground">{collection.name}</p>
                      <Meta>
                        <MetaItem>{t("knowledge.documentCount", { count: collection.documentCount })}</MetaItem>
                      </Meta>
                    </div>
                    <div className="grid gap-2">
                      <Select
                        aria-label={t("packs.import.destination.label", { name: collection.name })}
                        disabled={!editing || !reviewable}
                        id={selectId}
                        onChange={(event) =>
                          setDestinations((current) => ({
                            ...current,
                            [collection.key]: event.target.value === "__new__" ? { mode: "new", name: collection.name } : { mode: "existing", knowledgeBaseId: event.target.value },
                          }))
                        }
                        value={choice.mode === "existing" ? choice.knowledgeBaseId : "__new__"}
                      >
                        <option value="__new__">{t("packs.import.destination.new")}</option>
                        {bases.map((base) => (
                          <option key={base.id} value={base.id}>{base.name}</option>
                        ))}
                      </Select>
                      {choice.mode === "new" && (
                        <Input
                          aria-label={t("packs.import.destination.newName", { name: collection.name })}
                          disabled={!editing || !reviewable}
                          maxLength={brainPackLimits.nameCharacters}
                          onChange={(event) => setDestinations((current) => ({ ...current, [collection.key]: { mode: "new", name: event.target.value } }))}
                          value={choice.name}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Step>
        )}

        {preview && (
          <Step done={!editing && step > 3} number={5} title={t("packs.import.step.review")}>
            <ul className="divide-y divide-border/60">
              {items.map((item) => {
                const decision = decisions[item.itemKey] ?? defaultBrainPackDecision(item.classification);
                const allowed = allowedBrainPackDecisions(item.classification);
                return (
                  <li className="grid gap-2 py-3 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)] sm:items-center" key={item.itemKey}>
                    <div className="grid min-w-0 gap-1">
                      <p className="text-[13px] font-medium text-foreground">{item.title}</p>
                      <Meta>
                        <MetaItem tone={brainPackClassificationTone[item.classification]}>
                          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                          {t(`packs.import.review.classification.${item.classification}`)}
                        </MetaItem>
                        {item.localRevision !== null && <MetaItem>{t("packs.import.review.localRevision", { revision: item.localRevision })}</MetaItem>}
                        {item.result && <MetaItem>{t(`packs.import.review.result.${item.result}`)}</MetaItem>}
                      </Meta>
                      {item.classification === "conflicting" && editing && <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{t("packs.import.review.conflictHint")}</p>}
                      {item.sanitizedError && <p className="text-xs text-danger">{item.sanitizedError}</p>}
                    </div>
                    <Select
                      aria-label={t("packs.import.review.decisionLabel", { title: item.title })}
                      disabled={!editing || !reviewable || allowed.length <= 1}
                      onChange={(event) => setDecisions((current) => ({ ...current, [item.itemKey]: event.target.value as BrainPackItemDecision }))}
                      value={decision}
                    >
                      {allowed.map((option) => (
                        <option key={option} value={option}>{t(`packs.import.review.decision.${option}`)}</option>
                      ))}
                    </Select>
                  </li>
                );
              })}
            </ul>
            {nextCursor && (
              <Button loading={loadMore.isPending} onClick={() => loadMore.mutate()} size="sm" variant="ghost">
                {t("packs.import.loadMore")}
              </Button>
            )}
            {reviewable && editing && (
              <div className="grid gap-3">
                <Field className="sm:max-w-md" hint={t("packs.import.review.tagsHint")} htmlFor="brain-pack-tags" label={t("packs.import.review.tagsLabel")}>
                  <Input id="brain-pack-tags" onChange={(event) => setTags(event.target.value)} value={tags} />
                </Field>
                {review.isError && <ErrorState error={review.error} />}
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={!destinationsComplete || items.length === 0} loading={review.isPending} onClick={freeze} size="sm">
                    {review.isPending ? t("packs.import.review.freezePending") : t("packs.import.review.freeze")}
                  </Button>
                  {run.status === "reviewed" && (
                    <Button onClick={() => setEditing(false)} size="sm" variant="ghost">{t("common.cancel")}</Button>
                  )}
                </div>
              </div>
            )}
            {run.status === "reviewed" && !editing && (
              <div className="flex flex-wrap items-center gap-3">
                <StepHint>{t("packs.import.review.frozen")}</StepHint>
                <Button onClick={() => setEditing(true)} size="sm" variant="ghost">{t("packs.import.review.change")}</Button>
              </div>
            )}
          </Step>
        )}

        {preview && (
          <Step done={run.status === "completed"} muted={run.status === "awaiting_review" || editing} number={6} title={t("packs.import.step.publish")}>
            {run.status === "reviewed" && !editing && run.reviewDigest && (
              <div className="grid gap-3">
                <StepHint>{t("packs.import.publish.hint")}</StepHint>
                {publish.isError && <ErrorState error={publish.error} />}
                <Button className="w-fit" loading={publish.isPending} onClick={() => publish.mutate(run.reviewDigest!)} size="sm">
                  {t("packs.import.publish.submit")}
                </Button>
              </div>
            )}
            {(run.status === "indexing" || run.status === "publishing") && (
              <div className="grid gap-3">
                <p className="flex items-center gap-2 text-[13px] text-foreground">
                  <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-muted-foreground" />
                  {t(run.status === "indexing" ? "packs.import.progress.indexing" : "packs.import.progress.publishing")}
                </p>
                <Meta>
                  {run.progress && <MetaItem>{t("packs.run.progress", { processed: run.progress.processedItems, total: run.progress.totalItems })}</MetaItem>}
                  <MetaItem>{t("packs.import.progress.leave")}</MetaItem>
                </Meta>
                <Button className="w-fit" disabled={cancel.isPending} onClick={() => cancel.mutate(runId)} size="sm" variant="outline">
                  {t("packs.import.cancel")}
                </Button>
              </div>
            )}
            {run.status === "completed" && receipt && (
              <div className="grid gap-3">
                <p className="text-sm font-medium text-foreground">{t("packs.import.receipt.title")}</p>
                <StepHint>{t("packs.import.receipt.description", { date: formatDate(receipt.publishedAt, locale), publisher: preview.publisher.displayName })}</StepHint>
                <Meta>
                  {receipt.created.length > 0 && <MetaItem tone="success">{t("packs.import.receipt.created", { count: receipt.created.length })}</MetaItem>}
                  {receipt.updated.length > 0 && <MetaItem tone="info">{t("packs.import.receipt.updated", { count: receipt.updated.length })}</MetaItem>}
                  {receipt.skipped.length > 0 && <MetaItem>{t("packs.import.receipt.skipped", { count: receipt.skipped.length })}</MetaItem>}
                  {receipt.excluded.length > 0 && <MetaItem tone="warning">{t("packs.import.receipt.excluded", { count: receipt.excluded.length })}</MetaItem>}
                </Meta>
                <ButtonLink className="w-fit" size="sm" to="/knowledge" variant="outline">{t("packs.import.receipt.openFolders")}</ButtonLink>
                <StepHint>{t("agentResources.afterImport")}</StepHint>
                <ButtonLink className="w-fit" size="sm" to="/agent-resources" variant="outline">{t("agentResources.calibrateLink")}</ButtonLink>
              </div>
            )}
            {canceled && preview && <CanceledNotice />}
            {failed && preview && (
              <div className="grid gap-3">
                <Alert title={t("packs.import.failed.title")} tone="danger">
                  <p>{t(brainPackErrorKey(run.sanitizedError))}</p>
                </Alert>
                {canRetry(run) ? (
                  <Button className="w-fit" disabled={retry.isPending} onClick={() => retry.mutate(runId)} size="sm" variant="outline">{t("packs.run.retry")}</Button>
                ) : (
                  <ButtonLink className="w-fit" size="sm" to={importPagePath} variant="outline">{t("packs.import.failed.startOver")}</ButtonLink>
                )}
              </div>
            )}
          </Step>
        )}
      </CardContent>
    </Card>
  );
}

function CanceledNotice() {
  const t = useTranslation();
  return (
    <div className="grid gap-3">
      <Alert title={t("packs.import.canceled.title")} tone="info">{t("packs.import.canceled.body")}</Alert>
      <ButtonLink className="w-fit" size="sm" to={importPagePath} variant="outline">{t("packs.import.failed.startOver")}</ButtonLink>
    </div>
  );
}
