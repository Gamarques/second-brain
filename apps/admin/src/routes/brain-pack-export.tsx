import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Download, FileText, X } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { ErrorState, PageSkeleton } from "../components/async-state";
import { ManifestCard } from "../components/brain-pack/manifest-card";
import { Meta, MetaItem, Page, PageHeader } from "../components/page";
import { Button } from "../components/ui/button";
import { ButtonLink } from "../components/ui/button-link";
import { Card, CardContent, CardHeader, CardHeaderText, CardTitle } from "../components/ui/card";
import { CopyableId } from "../components/ui/copy-button";
import { DescriptionItem, DescriptionList } from "../components/ui/description-list";
import { Disclosure } from "../components/ui/disclosure";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Step, StepHint } from "../components/ui/step";
import { api, ApiError } from "../lib/api";
import type { KnowledgeBase } from "../lib/api-types";
import { brainPackFileName, formatBytes, readPublisherPreference, saveBlob, suggestPublisher, writePublisherPreference } from "../lib/brain-pack";
import { brainPackLimits, brainPackPublisherNamespacePattern, type BrainPackExportResult } from "../lib/brain-pack-types";
import { locales, useLocale, useTranslation } from "../lib/i18n";
import { formatRelativeTime, newIdempotencyKey } from "../lib/utils";

const exportRetentionDays = 7;

function DocumentPicker({ baseId, selected, onToggle }: { baseId: string; selected: ReadonlyMap<string, string>; onToggle: (documentId: string, baseId: string) => void }) {
  const t = useTranslation();
  const documents = useQuery({ queryKey: ["knowledge-documents", baseId], queryFn: ({ signal }) => api.knowledgeDocuments(baseId, { limit: 50 }, signal) });
  if (documents.isPending) return <p className="pl-7 text-xs text-muted-foreground">{t("knowledge.document.loading")}…</p>;
  if (documents.isError) return <ErrorState error={documents.error} />;
  if (documents.data.items.length === 0) return <p className="pl-7 text-xs text-muted-foreground">{t("knowledge.documents.empty.title")}</p>;
  return (
    <ul className="grid gap-1.5 pl-7">
      {documents.data.items.map((document) => (
        <li key={document.id}>
          <Checkbox checked={selected.has(document.id)} label={document.title} onChange={() => onToggle(document.id, baseId)} variant="inline" />
        </li>
      ))}
    </ul>
  );
}

function isExportLimit(error: unknown): boolean {
  return error instanceof ApiError && (error.problem.code === "PACK_LIMIT_EXCEEDED" || error.message.includes("PACK_LIMIT_EXCEEDED"));
}

/**
 * Export as three steps on one card: choose folders or documents, describe the
 * pack (title suggested from the folder, publisher remembered from last time),
 * and export. A sticky aside shows the pack as the recipient will see it, and
 * the third step turns into the receipt with file name, size, hash and download.
 */
export function BrainPackExportPage() {
  const t = useTranslation();
  const { locale } = useLocale();
  const [searchParams] = useSearchParams();
  const repack = (() => {
    const packId = searchParams.get("packId");
    const revision = Number(searchParams.get("revision"));
    return packId && Number.isInteger(revision) && revision > 1 ? { packId, nextRevision: revision, title: searchParams.get("title") } : null;
  })();
  const identity = useQuery({ queryKey: ["me"], queryFn: ({ signal }) => api.me(signal), staleTime: 30_000 });
  const bases = useQuery({ queryKey: ["knowledge-bases"], queryFn: ({ signal }) => api.knowledgeBases(signal) });

  const [selectedBases, setSelectedBases] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedDocuments, setSelectedDocuments] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [pickers, setPickers] = useState<ReadonlySet<string>>(() => new Set());
  const [title, setTitle] = useState<string | null>(repack?.title ?? null);
  const [description, setDescription] = useState("");
  const [publisher, setPublisher] = useState<{ namespace: string; displayName: string; language: string } | null>(null);
  const [result, setResult] = useState<BrainPackExportResult | null>(null);
  const exportRun = useMutation({
    mutationFn: (input: Parameters<typeof api.exportBrainPack>[0]) => api.exportBrainPack(input),
    onSuccess: (data, input) => {
      writePublisherPreference({ namespace: input.metadata.publisherNamespace, displayName: input.metadata.publisherDisplayName, language: input.metadata.language });
      setResult(data);
    },
  });
  const download = useMutation({
    mutationFn: async (run: BrainPackExportResult) => {
      const { blob, fileName } = await api.downloadBrainPack(run.runId);
      saveBlob(blob, fileName || brainPackFileName(run.packId, run.packRevision));
    },
  });

  if (bases.isPending) return <PageSkeleton cards={1} label={t("knowledge.loading")} />;
  if (bases.isError) return <ErrorState error={bases.error} retry={() => bases.refetch()} />;

  const allBases = bases.data.knowledgeBases;
  const chosenBases = allBases.filter((base) => selectedBases.has(base.id));
  const folderCount = chosenBases.length;
  const documentCount = chosenBases.reduce((sum, base) => sum + (base.documentCount ?? 0), 0) + [...selectedDocuments.values()].filter((baseId) => !selectedBases.has(baseId)).length;
  const hasSelection = folderCount > 0 || selectedDocuments.size > 0;
  const overLimit = documentCount > brainPackLimits.synchronousExportDocuments;

  // The title follows the single chosen folder until the person types their own.
  const suggestedTitle = folderCount === 1 && selectedDocuments.size === 0 ? chosenBases[0]!.name : "";
  const effectiveTitle = title ?? suggestedTitle;
  const remembered = readPublisherPreference();
  const suggested = suggestPublisher(identity.data?.email);
  const effectivePublisher = publisher ?? {
    namespace: remembered?.namespace ?? suggested.namespace,
    displayName: remembered?.displayName ?? suggested.displayName,
    language: remembered?.language ?? locale,
  };
  const namespaceValid = brainPackPublisherNamespacePattern.test(effectivePublisher.namespace);
  const canSubmit = hasSelection && effectiveTitle.trim() !== "" && namespaceValid && effectivePublisher.displayName.trim() !== "" && !overLimit && !exportRun.isPending;
  const previewPublisher = effectivePublisher.displayName.trim() ? { namespace: effectivePublisher.namespace, displayName: effectivePublisher.displayName.trim() } : null;
  const receipt = result?.receipt ?? null;

  function toggle<K>(setter: (update: (current: ReadonlySet<K>) => ReadonlySet<K>) => void, key: K) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleDocument(documentId: string, baseId: string) {
    setSelectedDocuments((current) => {
      const next = new Map(current);
      if (next.has(documentId)) next.delete(documentId);
      else next.set(documentId, baseId);
      return next;
    });
  }
  function updatePublisher(changes: Partial<{ namespace: string; displayName: string; language: string }>) {
    setPublisher({ ...effectivePublisher, ...changes });
  }
  function submit() {
    if (!canSubmit) return;
    exportRun.mutate({
      selection: {
        knowledgeBaseIds: [...selectedBases],
        documentIds: [...selectedDocuments.entries()].filter(([, baseId]) => !selectedBases.has(baseId)).map(([documentId]) => documentId),
      },
      metadata: {
        title: effectiveTitle.trim(),
        description: description.trim() === "" ? null : description.trim(),
        publisherNamespace: effectivePublisher.namespace.trim(),
        publisherDisplayName: effectivePublisher.displayName.trim(),
        language: effectivePublisher.language === "" ? null : effectivePublisher.language,
      },
      packId: repack?.packId ?? null,
      expectedPackRevision: repack ? repack.nextRevision - 1 : null,
      idempotencyKey: newIdempotencyKey("brain-pack-export"),
    });
  }
  function startOver() {
    setResult(null);
    exportRun.reset();
    setSelectedBases(new Set());
    setSelectedDocuments(new Map());
    setTitle(null);
    setDescription("");
  }

  const languageLabel = effectivePublisher.language === "" ? t("packs.export.languageNone") : (locales as readonly string[]).includes(effectivePublisher.language) ? t(`language.${effectivePublisher.language as (typeof locales)[number]}`) : effectivePublisher.language;

  return (
    <Page>
      <PageHeader back={{ to: "/knowledge/packs", label: t("route.packs") }} description={t("packs.export.description")} title={t("route.packExport")} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
        <Card>
          <CardContent className="grid divide-y divide-border/60 p-0 sm:p-0">
            <Step done={hasSelection} number={1} title={t("packs.export.step.choose")}>
              {allBases.length === 0 ? (
                <StepHint>{t("knowledge.empty.title")}</StepHint>
              ) : (
                <ul aria-label={t("packs.export.step.choose")} className="-mx-1 divide-y divide-border/60">
                  {allBases.map((base) => (
                    <li className="grid gap-2 px-1 py-2.5" key={base.id}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="grid min-w-0 gap-0.5">
                          <Checkbox checked={selectedBases.has(base.id)} label={base.name} onChange={() => toggle(setSelectedBases, base.id)} variant="inline" />
                          <Meta className="pl-7">
                            <MetaItem icon={FileText}>{t("knowledge.documentCount", { count: base.documentCount ?? 0 })}</MetaItem>
                            <MetaItem>{t("common.updatedAt", { time: formatRelativeTime(base.updatedAt, Date.now(), locale) })}</MetaItem>
                          </Meta>
                        </div>
                        {!selectedBases.has(base.id) && (base.documentCount ?? 0) > 0 && (
                          <Button aria-expanded={pickers.has(base.id)} onClick={() => toggle(setPickers, base.id)} size="sm" variant="ghost">
                            {t("packs.export.pickDocuments")}
                          </Button>
                        )}
                      </div>
                      {pickers.has(base.id) && !selectedBases.has(base.id) && <DocumentPicker baseId={base.id} onToggle={toggleDocument} selected={selectedDocuments} />}
                    </li>
                  ))}
                </ul>
              )}
              <Meta>
                <MetaItem>{t("packs.count.folders", { count: folderCount })}</MetaItem>
                <MetaItem tone={overLimit ? "warning" : "neutral"}>{t("knowledge.documentCount", { count: documentCount })}</MetaItem>
                <MetaItem>{t("packs.export.limit", { count: brainPackLimits.synchronousExportDocuments })}</MetaItem>
              </Meta>
            </Step>

            <Step done={hasSelection && effectiveTitle.trim() !== ""} muted={!hasSelection} number={2} title={t("packs.export.step.describe")}>
              {repack && <StepHint>{t("packs.export.repack", { revision: repack.nextRevision })}</StepHint>}
              <div className="grid gap-4 sm:max-w-xl">
                <Field htmlFor="brain-pack-title" label={t("packs.export.titleLabel")}>
                  <Input id="brain-pack-title" maxLength={brainPackLimits.titleCharacters} onChange={(event) => setTitle(event.target.value)} placeholder={t("packs.export.titlePlaceholder")} required value={effectiveTitle} />
                </Field>
                <Field htmlFor="brain-pack-description" label={t("packs.export.descriptionLabel")}>
                  <Textarea id="brain-pack-description" maxLength={brainPackLimits.descriptionCharacters} onChange={(event) => setDescription(event.target.value)} rows={2} value={description} />
                </Field>
              </div>
              <Disclosure className="sm:max-w-xl" contentClassName="mt-3" size="sm" summary={t("packs.export.publisherSection")}>
                <fieldset aria-label={t("packs.export.publisherSection")} className="grid gap-4 sm:grid-cols-2">
                  <Field htmlFor="brain-pack-publisher" label={t("packs.export.publisherNameLabel")}>
                    <Input id="brain-pack-publisher" maxLength={brainPackLimits.nameCharacters} onChange={(event) => updatePublisher({ displayName: event.target.value })} required value={effectivePublisher.displayName} />
                  </Field>
                  <Field
                    {...(effectivePublisher.namespace === "" || namespaceValid ? {} : { error: t("packs.export.publisherNamespaceHint") })}
                    hint={t("packs.export.publisherNamespaceHint")}
                    htmlFor="brain-pack-namespace"
                    label={t("packs.export.publisherNamespaceLabel")}
                  >
                    <Input className="font-mono" id="brain-pack-namespace" maxLength={brainPackLimits.namespaceCharacters} onChange={(event) => updatePublisher({ namespace: event.target.value.toLowerCase() })} placeholder="academy.example" required value={effectivePublisher.namespace} />
                  </Field>
                  <Field htmlFor="brain-pack-language" label={t("packs.export.languageLabel")}>
                    <Select id="brain-pack-language" onChange={(event) => updatePublisher({ language: event.target.value })} value={effectivePublisher.language}>
                      {locales.map((code) => (
                        <option key={code} value={code}>{t(`language.${code}`)}</option>
                      ))}
                      <option value="">{t("packs.export.languageNone")}</option>
                    </Select>
                  </Field>
                </fieldset>
              </Disclosure>
              <Meta data-testid="brain-pack-publisher">
                <MetaItem>{effectivePublisher.displayName.trim() || t("packs.export.publisherMissing")}</MetaItem>
                {effectivePublisher.namespace && <MetaItem className="font-mono">{effectivePublisher.namespace}</MetaItem>}
                <MetaItem>{languageLabel}</MetaItem>
              </Meta>
            </Step>

            <Step done={result !== null} muted={!canSubmit && result === null} number={3} title={t("packs.export.step.export")}>
              {result ? (
                <div className="grid gap-4">
                  <p className="text-sm font-medium text-foreground">{t("packs.export.receipt.title")}</p>
                  <DescriptionList className="text-xs">
                    <DescriptionItem className="font-mono" label={t("packs.export.receipt.file")}>{brainPackFileName(result.packId, result.packRevision)}</DescriptionItem>
                    {receipt && <DescriptionItem label={t("packs.export.receipt.size")}>{formatBytes(receipt.byteSize, locale)}</DescriptionItem>}
                    {receipt && (
                      <DescriptionItem label={t("packs.export.receipt.fingerprint")}>
                        <CopyableId className="max-w-[28ch]" label={t("common.id.contentHash")} value={receipt.sha256} />
                      </DescriptionItem>
                    )}
                  </DescriptionList>
                  <StepHint>{t("packs.export.receipt.expires", { count: exportRetentionDays })}. {t("packs.export.receipt.description")}</StepHint>
                  {download.isError && <ErrorState error={download.error} />}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button loading={download.isPending} onClick={() => download.mutate(result)} size="sm">
                      {!download.isPending && <Download aria-hidden="true" />}
                      {t("packs.export.download")}
                    </Button>
                    <Button onClick={startOver} size="sm" variant="ghost">{t("packs.export.again")}</Button>
                    <ButtonLink size="sm" to="/knowledge/packs" variant="ghost">{t("packs.export.history")}</ButtonLink>
                  </div>
                </div>
              ) : (
                <div className="grid gap-4">
                  {exportRun.isError && (isExportLimit(exportRun.error) ? <p className="max-w-prose text-[13px] leading-relaxed text-warning" role="alert">{t("packs.export.overLimit", { count: brainPackLimits.synchronousExportDocuments })}</p> : <ErrorState error={exportRun.error} />)}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button disabled={!canSubmit} loading={exportRun.isPending} onClick={submit} size="sm">
                      {!exportRun.isPending && <Download aria-hidden="true" />}
                      {exportRun.isPending ? t("packs.export.submitPending") : t("packs.export.submit")}
                    </Button>
                    {overLimit && <span className="text-xs text-warning">{t("packs.export.overLimit", { count: brainPackLimits.synchronousExportDocuments })}</span>}
                  </div>
                </div>
              )}
            </Step>
          </CardContent>
        </Card>

        <Card className="xl:sticky xl:top-4">
          <CardHeader>
            <CardHeaderText>
              <CardTitle>{t("packs.export.preview.title")}</CardTitle>
            </CardHeaderText>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div data-testid="brain-pack-preview">
              <ManifestCard
                counts={receipt ? { collections: receipt.collectionCount, documents: receipt.documentCount } : hasSelection ? { collections: folderCount, documents: documentCount } : null}
                description={description.trim() || null}
                packId={result?.packId ?? repack?.packId ?? null}
                packRevision={result?.packRevision ?? repack?.nextRevision ?? 1}
                publisher={previewPublisher}
                title={effectiveTitle.trim() || null}
              />
            </div>
            <ul aria-label={t("packs.export.travels.label")} className="grid gap-1.5 border-t border-border/60 pt-4 text-xs leading-5 text-muted-foreground">
              <li className="flex items-center gap-2"><Check aria-hidden="true" className="size-3.5 shrink-0 text-success" />{t("packs.export.travels.documents")}</li>
              <li className="flex items-center gap-2"><X aria-hidden="true" className="size-3.5 shrink-0 opacity-50" />{t("packs.export.travels.memories")}</li>
              <li className="flex items-center gap-2"><X aria-hidden="true" className="size-3.5 shrink-0 opacity-50" />{t("packs.export.travels.conversations")}</li>
            </ul>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("packs.export.representationNote")}</p>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
