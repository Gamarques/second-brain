import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, Plus, Upload } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { EmptyState, ErrorState, PageSkeleton } from "../components/async-state";
import { EmptyDocumentsIllustration } from "../components/illustrations/empty-documents";
import { EmptyFoldersIllustration } from "../components/illustrations/empty-folders";
import { FolderMark } from "../components/illustrations/folder-mark";
import { ListCard, ListRow, Meta, MetaItem, Page, PageHeader, RowLink } from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ButtonLink } from "../components/ui/button-link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { CopyableId } from "../components/ui/copy-button";
import { Dialog } from "../components/ui/dialog";
import { Disclosure } from "../components/ui/disclosure";
import { Composer } from "../components/ui/composer";
import { Field, Input, Textarea } from "../components/ui/field";
import { ExternalTextLink, TextLink } from "../components/ui/link";
import { GlossaryTerm } from "../components/ui/glossary-term";
import { Table, Td, Th, Tr } from "../components/ui/table";
import { useToast } from "../components/ui/toast";
import { api } from "../lib/api";
import type { KnowledgeDocument } from "../lib/api-types";
import { DocumentImportError, readDocumentImport } from "../lib/document-import";
import { useLocale, useTranslation, type Locale, type Translator } from "../lib/i18n";
import { formatDate, formatRelativeTime, newIdempotencyKey } from "../lib/utils";

export function KnowledgePage() {
  const client = useQueryClient();
  const { toast } = useToast();
  const { locale } = useLocale();
  const t = useTranslation();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const query = useQuery({ queryKey: ["knowledge-bases"], queryFn: ({ signal }) => api.knowledgeBases(signal) });
  // Packs move whole folders in and out, so only owners and admins see the doors.
  const identity = useQuery({ queryKey: ["me"], queryFn: ({ signal }) => api.me(signal), staleTime: 60_000 });
  const canPack = identity.data?.role === "owner" || identity.data?.role === "admin";
  const create = useMutation({
    mutationFn: () => api.createKnowledgeBase({ name, description: description.trim() || null, idempotencyKey: newIdempotencyKey("knowledge-base") }),
    onSuccess: (base) => {
      setCreating(false);
      setName("");
      setDescription("");
      client.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast({ title: t("knowledge.toast.baseCreated.title"), description: t("knowledge.toast.baseCreated.description", { name: base.name }), tone: "success" });
    },
    onError: (error: unknown) => {
      toast({ title: t("knowledge.toast.baseCreateFailed.title"), description: error instanceof Error ? error.message : t("knowledge.toast.baseCreateFailed.fallback"), tone: "danger" });
    },
  });

  return (
    <Page>
      <PageHeader
        actions={
          <>
            {canPack && (
              <ButtonLink to="/knowledge/packs/import" variant="outline">
                <Upload aria-hidden="true" />
                {t("packs.import")}
              </ButtonLink>
            )}
            {canPack && (
              <ButtonLink to="/knowledge/packs/export" variant="outline">
                <Download aria-hidden="true" />
                {t("packs.export")}
              </ButtonLink>
            )}
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t("knowledge.newBase")}
            </Button>
          </>
        }
        description={t("knowledge.description")}
        {...(canPack ? { meta: <TextLink to="/knowledge/packs">{t("packs.history.fromDocuments")}</TextLink> } : {})}
        title={t("knowledge.pageTitle")}
      />
      {query.isPending ? (
        <PageSkeleton cards={2} label={t("knowledge.loading")} />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : query.data.knowledgeBases.length === 0 ? (
        <EmptyState
          action={<Button onClick={() => setCreating(true)} size="sm"><Plus aria-hidden="true" />{t("knowledge.newBase")}</Button>}
          description={t("knowledge.empty.description")}
          illustration={<EmptyFoldersIllustration />}
          title={t("knowledge.empty.title")}
        />
      ) : (
        <ListCard aria-label={t("knowledge.sectionAriaLabel")}>
          {query.data.knowledgeBases.map((base) => (
            <ListRow className="grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3" key={base.id}>
              <FolderMark className="text-muted-foreground" count={base.documentCount ?? 0} />
              <div className="min-w-0">
                <h2 className="text-sm font-medium leading-snug text-foreground">
                  <RowLink to={`/knowledge/${base.id}`}>{base.name}</RowLink>
                </h2>
                <p className="mt-0.5 line-clamp-1 text-[13px] leading-relaxed text-muted-foreground">
                  {base.description ?? t("knowledge.noCoverageDescription")}
                </p>
                <Meta className="mt-1">
                  <MetaItem>{t("knowledge.documentCount", { count: base.documentCount ?? 0 })}</MetaItem>
                  <MetaItem>{t("common.updatedAt", { time: formatRelativeTime(base.updatedAt, Date.now(), locale) })}</MetaItem>
                </Meta>
              </div>
              <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground/60 transition-colors group-hover/row:text-foreground" />
            </ListRow>
          ))}
        </ListCard>
      )}
      <Dialog
        description={t("knowledge.createDialog.description")}
        footer={
          <>
            <Button onClick={() => setCreating(false)} variant="ghost">{t("common.cancel")}</Button>
            <Button form="knowledge-base-form" loading={create.isPending} type="submit">
              {create.isPending ? t("knowledge.createDialog.submitPending") : t("knowledge.createDialog.submit")}
            </Button>
          </>
        }
        onClose={() => setCreating(false)}
        open={creating}
        title={t("knowledge.createDialog.title")}
      >
        <form className="grid gap-4" id="knowledge-base-form" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
          {create.isError && <ErrorState error={create.error} />}
          <Field htmlFor="base-name" label={t("common.field.name")}>
            <Input id="base-name" maxLength={200} onChange={(event) => setName(event.target.value)} required value={name} />
          </Field>
          <Field htmlFor="base-description" label={t("knowledge.createDialog.descriptionLabel")}>
            <Textarea id="base-description" maxLength={10_000} onChange={(event) => setDescription(event.target.value)} value={description} />
          </Field>
        </form>
      </Dialog>
    </Page>
  );
}

export function KnowledgeBasePage() {
  const { baseId = "" } = useParams();
  const client = useQueryClient();
  const { toast } = useToast();
  const { locale } = useLocale();
  const t = useTranslation();
  const [editor, setEditor] = useState(false);
  const [question, setQuestion] = useState("");
  const bases = useQuery({ queryKey: ["knowledge-bases"], queryFn: ({ signal }) => api.knowledgeBases(signal) });
  const documents = useQuery({ queryKey: ["knowledge-documents", baseId], queryFn: ({ signal }) => api.knowledgeDocuments(baseId, { limit: 50 }, signal), enabled: baseId !== "" });
  const ask = useMutation({ mutationFn: () => api.askKnowledge(baseId, question) });

  if (bases.isPending || documents.isPending) return <PageSkeleton cards={2} label={t("knowledge.loadingCollection")} />;
  if (bases.isError || documents.isError) return <ErrorState error={bases.error ?? documents.error} />;
  const base = bases.data.knowledgeBases.find((candidate) => candidate.id === baseId);
  if (!base) return <EmptyState description={t("knowledge.notFound.description")} illustration={<EmptyFoldersIllustration />} title={t("knowledge.notFound.title")} />;

  return (
    <Page>
      <PageHeader
        actions={
          <Button onClick={() => setEditor(true)}>
            <Plus aria-hidden="true" />
            {t("knowledge.addDocument")}
          </Button>
        }
        back={{ to: "/knowledge", label: t("knowledge.allBasesLink") }}
        description={base.description ?? t("knowledge.noCoverageDescription")}
        title={base.name}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <Card>
          <CardHeader>
            <CardTitle>{t("knowledge.documents.title")}</CardTitle>
            <CardDescription>{t("knowledge.documents.description")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0 sm:p-0">
            {documents.data.items.length === 0 ? (
              <EmptyState
                action={<Button onClick={() => setEditor(true)} size="sm"><Plus aria-hidden="true" />{t("knowledge.addDocument")}</Button>}
                description={t("knowledge.documents.empty.description")}
                illustration={<EmptyDocumentsIllustration />}
                title={t("knowledge.documents.empty.title")}
                variant="plain"
              />
            ) : (
              <DocumentTable baseId={baseId} documents={documents.data.items} locale={locale} t={t} />
            )}
          </CardContent>
        </Card>
        <Card className="h-fit xl:sticky xl:top-[4.75rem]">
          <CardHeader>
            <CardTitle>{t("knowledge.ask.title")}</CardTitle>
            <CardDescription>{t("knowledge.ask.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" id="knowledge-ask" onSubmit={(event) => { event.preventDefault(); ask.mutate(); }}>
              <Composer
                aria-label={t("knowledge.ask.questionLabel")}
                busy={ask.isPending}
                id="knowledge-question"
                maxLength={5_000}
                onChange={setQuestion}
                onSubmit={() => ask.mutate()}
                placeholder={t("knowledge.ask.placeholder")}
                required
                submitLabel={t("knowledge.ask.submit")}
                value={question}
                variant="pill"
              />
              {ask.isError && <ErrorState error={ask.error} />}
              {ask.data && (
                <div aria-live="polite" className="grid animate-fade-in gap-3 rounded-lg border border-border bg-muted/20 p-4">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{ask.data.answer}</p>
                  <Disclosure summary={t("knowledge.ask.citationsSummary", { count: ask.data.citations.length })}>
                    <div className="grid gap-2">
                      {ask.data.citations.map((citation, index) => (
                        <blockquote className="rounded-md border-l-2 border-primary/40 bg-muted/50 px-3.5 py-2.5 text-sm" key={`${citation.documentTitle}-${index}`}>
                          <p className="leading-relaxed">{citation.content}</p>
                          <footer className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <span className="truncate font-medium">{citation.documentTitle}</span>
                            <Badge tone="info">{t("common.matchPercent", { percent: Math.round(citation.score * 100) })}</Badge>
                          </footer>
                        </blockquote>
                      ))}
                    </div>
                  </Disclosure>
                </div>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
      {editor && (
        <DocumentEditor
          baseId={baseId}
          onClose={() => setEditor(false)}
          onSaved={() => {
            setEditor(false);
            client.invalidateQueries({ queryKey: ["knowledge-documents", baseId] });
            toast({ title: t("knowledge.toast.documentAdded.title"), description: t("knowledge.toast.documentAdded.description"), tone: "success" });
          }}
        />
      )}
    </Page>
  );
}

function DocumentTable({ baseId, documents, locale, t }: { baseId: string; documents: KnowledgeDocument[]; locale: Locale; t: Translator }) {
  return (
    <Table scrollLabel={t("knowledge.documentsTable.scrollLabel")}>
      <thead>
        <tr>
          <Th>{t("knowledge.documentsTable.title")}</Th>
          <Th>
            {t("knowledge.documentsTable.revision")}
            <GlossaryTerm className="ml-1" id="revision" variant="icon" />
          </Th>
          <Th>{t("knowledge.documentsTable.tags")}</Th>
          <Th>{t("knowledge.documentsTable.updated")}</Th>
        </tr>
      </thead>
      <tbody>
        {documents.map((document) => (
          <Tr key={document.id}>
            <Td>
              <Link className="font-medium tracking-tight text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/20" to={`/knowledge/${baseId}/documents/${document.id}`}>
                {document.title}
              </Link>
              {document.sourceUri && (
                <ExternalTextLink className="mt-0.5 block w-fit text-xs font-normal text-muted-foreground" href={document.sourceUri}>{t("knowledge.documentsTable.sourceLink")}</ExternalTextLink>
              )}
            </Td>
            <Td className="text-xs tabular-nums text-muted-foreground">{t("common.versionBadge", { version: document.currentRevision })}</Td>
            <Td className="text-xs text-muted-foreground">{document.tags.map((tag) => `#${tag}`).join(" ")}</Td>
            <Td className="text-xs text-muted-foreground">{formatRelativeTime(document.updatedAt, Date.now(), locale)}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

function DocumentEditor({ baseId, document, initialContent = "", onClose, onSaved }: { baseId: string; document?: KnowledgeDocument; initialContent?: string; onClose: () => void; onSaved: () => void }) {
  const t = useTranslation();
  const [title, setTitle] = useState(document?.title ?? "");
  const [sourceUri, setSourceUri] = useState(document?.sourceUri ?? "");
  const [tags, setTags] = useState(document?.tags.join(", ") ?? "");
  const [content, setContent] = useState(initialContent);
  const [fileError, setFileError] = useState<string | null>(null);

  async function importFile(file: File): Promise<void> {
    setFileError(null);
    try {
      const imported = await readDocumentImport(file);
      setContent(imported.content);
      if (title.trim() === "") setTitle(imported.suggestedTitle);
    } catch (error) {
      setFileError(error instanceof DocumentImportError && error.code === "FILE_TOO_LARGE"
        ? t("knowledge.editorDialog.fileTooLarge")
        : t("knowledge.editorDialog.fileReadFailed"));
    }
  }
  const save = useMutation({
    mutationFn: () =>
      api.createKnowledgeRevision(baseId, {
        documentId: document?.id ?? null,
        expectedRevision: document?.currentRevision ?? null,
        title,
        content,
        sourceUri: sourceUri.trim() || null,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        idempotencyKey: newIdempotencyKey("knowledge-revision"),
      }),
    onSuccess: onSaved,
  });

  return (
    <Dialog
      description={t("knowledge.editorDialog.description")}
      footer={
        <>
          <Button onClick={onClose} variant="ghost">{t("common.cancel")}</Button>
          <Button form="document-editor" loading={save.isPending} type="submit">
            {save.isPending ? t("knowledge.editorDialog.savingPending") : document ? t("knowledge.editorDialog.submitCreateRevision") : t("knowledge.editorDialog.submitAddDocument")}
          </Button>
        </>
      }
      onClose={onClose}
      open
      size="xl"
      title={document ? t("knowledge.editorDialog.titleRevision", { version: document.currentRevision + 1 }) : t("knowledge.editorDialog.titleAdd")}
    >
      <form className="grid gap-4" id="document-editor" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        {save.isError && <ErrorState error={save.error} />}
        {!document && (
          <div className="grid gap-2 rounded-lg border border-dashed border-border bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t("knowledge.editorDialog.importTitle")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("knowledge.editorDialog.importDescription")}</p>
              </div>
              <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground shadow-xs transition-colors hover:bg-muted focus-within:ring-2 focus-within:ring-ring/20">
                <Upload aria-hidden="true" className="size-4" />
                {t("knowledge.editorDialog.chooseFile")}
                <input
                  accept=".txt,.md,.markdown,.json,.csv,.html,.xml,.yaml,.yml,text/*,application/json"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importFile(file);
                  }}
                  type="file"
                />
              </label>
            </div>
            {fileError && <p className="text-xs text-danger" role="alert">{fileError}</p>}
          </div>
        )}
        <Field htmlFor="document-title" label={t("knowledge.editorDialog.titleLabel")}>
          <Input id="document-title" maxLength={500} onChange={(event) => setTitle(event.target.value)} required value={title} />
        </Field>
        <Field htmlFor="document-content" label={t("knowledge.editorDialog.contentLabel")}>
          <Textarea className="font-mono text-xs" id="document-content" maxLength={1_000_000} onChange={(event) => setContent(event.target.value)} required rows={14} value={content} />
        </Field>
        <Disclosure contentClassName="mt-4" summary={t("common.moreOptions")} variant="boxed">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="document-source" label={t("knowledge.editorDialog.sourceLabel")}>
              <Input id="document-source" onChange={(event) => setSourceUri(event.target.value)} type="url" value={sourceUri} />
            </Field>
            <Field hint={t("knowledge.editorDialog.tagsHint")} htmlFor="document-tags" label={t("knowledge.editorDialog.tagsLabel")}>
              <Input id="document-tags" onChange={(event) => setTags(event.target.value)} value={tags} />
            </Field>
          </div>
        </Disclosure>
      </form>
    </Dialog>
  );
}

export function KnowledgeDocumentPage() {
  const { baseId = "", documentId = "" } = useParams();
  const client = useQueryClient();
  const { toast } = useToast();
  const { locale } = useLocale();
  const t = useTranslation();
  const [editing, setEditing] = useState(false);
  const [revisionCursor, setRevisionCursor] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["knowledge-document", baseId, documentId], queryFn: ({ signal }) => api.knowledgeDocument(baseId, documentId, signal), enabled: baseId !== "" && documentId !== "" });
  const revisionQuery = useQuery({ queryKey: ["knowledge-revisions", baseId, documentId, revisionCursor], queryFn: ({ signal }) => api.knowledgeRevisions(baseId, documentId, { ...(revisionCursor ? { cursor: revisionCursor } : {}), limit: 50 }, signal), enabled: baseId !== "" && documentId !== "" });

  if (query.isPending || revisionQuery.isPending) return <PageSkeleton cards={2} label={t("knowledge.document.loading")} />;
  if (query.isError || revisionQuery.isError) return <ErrorState error={query.error ?? revisionQuery.error} retry={() => { query.refetch(); revisionQuery.refetch(); }} />;
  const { document, content } = query.data;
  const revisions = revisionQuery.data.revisions;

  return (
    <Page>
      <PageHeader
        actions={
          <Button onClick={() => setEditing(true)}>
            <Plus aria-hidden="true" />
            {t("knowledge.createRevisionAction")}
          </Button>
        }
        back={{ to: `/knowledge/${baseId}`, label: t("knowledge.backToCollection") }}
        description={t("knowledge.document.headerDescription", { revision: document.currentRevision, date: formatDate(document.updatedAt, locale) })}
        eyebrow={<CopyableId label={t("common.id.documentId")} value={document.id} />}
        title={document.title}
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            {t("knowledge.revisions.title")}
            <GlossaryTerm id="revision" variant="icon" />
          </CardTitle>
          <CardDescription>{t("knowledge.revisions.description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0 sm:p-0">
          {revisions.length === 0 ? (
            <EmptyState description={t("knowledge.revisions.empty.description")} illustration={<EmptyDocumentsIllustration />} title={t("knowledge.revisions.empty.title")} variant="plain" />
          ) : (
            <>
              <Table scrollLabel={t("knowledge.revisionsTable.scrollLabel")}>
                <thead>
                  <tr>
                    <Th>{t("knowledge.revisionsTable.version")}</Th>
                    <Th>
                      {t("knowledge.revisionsTable.contentHash")}
                      <GlossaryTerm className="ml-1" id="contentHash" variant="icon" />
                    </Th>
                    <Th>
                      {t("knowledge.revisionsTable.chunks")}
                      <GlossaryTerm className="ml-1" id="chunk" variant="icon" />
                    </Th>
                    <Th>
                      {t("knowledge.revisionsTable.provenance")}
                      <GlossaryTerm className="ml-1" id="provenance" variant="icon" />
                    </Th>
                    <Th>{t("knowledge.revisionsTable.created")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {revisions.map((revision) => (
                    <Tr key={revision.id}>
                      <Td>
                        <Badge dot={revision.version === document.currentRevision} tone={revision.version === document.currentRevision ? "success" : "neutral"}>
                          {t("common.versionBadge", { version: revision.version })}
                        </Badge>
                      </Td>
                      <Td><CopyableId label={t("common.id.contentHash")} value={revision.contentHash} /></Td>
                      <Td className="text-xs tabular-nums">{revision.chunkCount}</Td>
                      <Td className="text-xs text-muted-foreground">{t("knowledge.revisionsTable.provenanceCell", { kind: t(`status.provenanceKind.${revision.provenance.kind}`), source: revision.provenance.source })}</Td>
                      <Td className="text-xs text-muted-foreground">{formatRelativeTime(revision.createdAt, Date.now(), locale)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              {(revisionCursor !== null || revisionQuery.data.nextCursor) && (
                <div className="flex items-center justify-end gap-2 border-t border-border p-4">
                  <Button disabled={revisionCursor === null} onClick={() => setRevisionCursor(null)} size="sm" variant="outline">{t("common.pagination.firstPage")}</Button>
                  <Button disabled={!revisionQuery.data.nextCursor} onClick={() => setRevisionCursor(revisionQuery.data.nextCursor)} size="sm" variant="outline">{t("common.pagination.nextPage")}</Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
      {editing && (
        <DocumentEditor
          baseId={baseId}
          document={document}
          initialContent={content}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            client.invalidateQueries({ queryKey: ["knowledge-document", baseId, documentId] });
            client.invalidateQueries({ queryKey: ["knowledge-revisions", baseId, documentId] });
            toast({ title: t("knowledge.toast.revisionCreated.title"), description: t("knowledge.toast.revisionCreated.description"), tone: "success" });
          }}
        />
      )}
    </Page>
  );
}
