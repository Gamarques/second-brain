import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import { useState } from "react";

import { EmptyState, ErrorState, LoadingState } from "../components/async-state";
import { resolveSource, sourceLabelKey, SourceMark } from "../components/brand-marks";
import { EmptyMemoriesIllustration } from "../components/illustrations/empty-memories";
import { ListCard, ListRow, Meta, MetaItem, Page, PageHeader, RowActions } from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { CopyableId } from "../components/ui/copy-button";
import { DescriptionItem, DescriptionList } from "../components/ui/description-list";
import { ConfirmDialog, Dialog } from "../components/ui/dialog";
import { Disclosure } from "../components/ui/disclosure";
import { Checkbox, Field, Input, Textarea } from "../components/ui/field";
import { GlossaryTerm } from "../components/ui/glossary-term";
import { useToast } from "../components/ui/toast";
import { api } from "../lib/api";
import type { MemoryRecord } from "../lib/api-types";
import { useLocale, useTranslation } from "../lib/i18n";
import { cn, formatDate, formatRelativeTime, newIdempotencyKey, toLocalDateTimeInput } from "../lib/utils";

export function MemoriesPage() {
  const client = useQueryClient();
  const { toast } = useToast();
  const t = useTranslation();
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [category, setCategory] = useState("");
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [editing, setEditing] = useState<MemoryRecord | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MemoryRecord | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["memories", category, includeSuperseded, cursor],
    queryFn: ({ signal }) => api.memories({ category: category || undefined, includeSuperseded, cursor, limit: 50 }, signal),
    enabled: submittedSearch === "",
  });
  const semantic = useQuery({
    queryKey: ["memory-search", submittedSearch],
    queryFn: ({ signal }) => api.searchMemories(submittedSearch, signal),
    enabled: submittedSearch !== "",
  });

  function invalidate() {
    client.invalidateQueries({ queryKey: ["memories"] });
    client.invalidateQueries({ queryKey: ["memory-search"] });
  }

  const remove = useMutation({
    mutationFn: (memory: MemoryRecord) => api.deleteMemory(memory.id, newIdempotencyKey("memory-delete")),
    onSuccess: () => {
      setPendingDelete(null);
      invalidate();
      toast({ title: t("memories.toast.deleted.title"), description: t("memories.toast.deleted.description"), tone: "success" });
    },
    onError: (error: unknown) => {
      toast({ title: t("memories.toast.deleteFailed.title"), description: error instanceof Error ? error.message : t("memories.toast.deleteFailed.fallback"), tone: "danger" });
    },
  });

  const memories = submittedSearch ? semantic.data?.matches ?? [] : list.data?.memories ?? [];
  const pending = submittedSearch ? semantic.isPending : list.isPending;
  const error = submittedSearch ? semantic.error : list.error;

  const paged = !submittedSearch && (cursor !== null || Boolean(list.data?.nextCursor));

  return (
    <Page>
      <PageHeader
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus aria-hidden="true" />
            {t("memories.newMemory")}
          </Button>
        }
        description={t("memories.description")}
        title={t("nav.memories.label")}
      />
      <div className="grid gap-2">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => { event.preventDefault(); setSubmittedSearch(search.trim()); }}
          role="search"
        >
          <label className="relative min-w-[14rem] flex-1">
            <span className="sr-only">{t("memories.search.label")}</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" id="memory-search" onChange={(event) => setSearch(event.target.value)} placeholder={t("memories.search.placeholder")} type="search" value={search} />
          </label>
          <Input aria-label={t("memories.categoryFilter.label")} className="w-40" id="memory-category" onChange={(event) => setCategory(event.target.value)} placeholder={t("memories.categoryFilter.placeholder")} value={category} />
          <Button type="submit" variant="secondary">
            {t("common.search")}
          </Button>
          {submittedSearch && (
            <Button aria-label={t("memories.clearSearchAriaLabel")} onClick={() => { setSubmittedSearch(""); setSearch(""); }} size="icon" variant="ghost">
              <X aria-hidden="true" />
            </Button>
          )}
          <Checkbox checked={includeSuperseded} className="sm:ml-auto" label={t("memories.includeSuperseded.label")} onChange={(event) => setIncludeSuperseded(event.target.checked)} title={t("memories.includeSuperseded.description")} variant="inline" />
        </form>
        {submittedSearch && (
          <Meta className="px-1">
            <MetaItem icon={Sparkles}>{t("memories.rankedBySimilarity", { query: submittedSearch })}</MetaItem>
          </Meta>
        )}
      </div>
      {pending ? (
        <LoadingState label={t("memories.loading")} />
      ) : error ? (
        <ErrorState error={error} />
      ) : memories.length === 0 ? (
        <EmptyState
          action={<Button onClick={() => setEditing("new")} size="sm"><Plus aria-hidden="true" />{t("memories.newMemory")}</Button>}
          description={submittedSearch ? t("memories.empty.searchDescription") : t("memories.empty.listDescription")}
          example={submittedSearch ? undefined : t("connect.test.rememberPrompt")}
          illustration={<EmptyMemoriesIllustration />}
          title={t("memories.empty.title")}
        />
      ) : (
        <>
          <ListCard aria-label={t("memories.resultsAriaLabel")}>
            {memories.map((memory) => (
              <MemoryRow key={memory.id} memory={memory} onDelete={() => setPendingDelete(memory)} onEdit={() => setEditing(memory)} />
            ))}
          </ListCard>
          {paged && (
            <div className="flex justify-end gap-2">
              <Button disabled={cursor === null} onClick={() => setCursor(null)} size="sm" variant="outline">{t("common.pagination.firstPage")}</Button>
              <Button disabled={!list.data?.nextCursor} onClick={() => setCursor(list.data?.nextCursor ?? null)} size="sm" variant="outline">{t("common.pagination.nextPage")}</Button>
            </div>
          )}
        </>
      )}
      {editing && (
        <MemoryEditor
          memory={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null);
            invalidate();
            toast({
              title: created ? t("memories.toast.created.title") : t("memories.toast.versioned.title"),
              description: created ? t("memories.toast.created.description") : t("memories.toast.versioned.description"),
              tone: "success",
            });
          }}
        />
      )}
      <ConfirmDialog
        confirmLabel={t("memories.deleteDialog.confirmLabel")}
        description={t("memories.deleteDialog.description")}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => { if (pendingDelete) remove.mutate(pendingDelete); }}
        open={pendingDelete !== null}
        pending={remove.isPending}
        title={t("memories.deleteDialog.title")}
        tone="danger"
      >
        <div className="grid gap-3">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("memories.deleteDialog.explain")}
          </p>
          <blockquote className="line-clamp-4 rounded-md border-l-2 border-primary/40 bg-muted/40 px-3.5 py-2.5 text-sm leading-relaxed text-foreground">
            {pendingDelete?.content}
          </blockquote>
        </div>
      </ConfirmDialog>
    </Page>
  );
}

/**
 * One memory: the content first, then one quiet line saying who saved it and
 * when. Only an older version earns a pill; the current state is the default
 * and says nothing.
 */
function MemoryRow({ memory, onEdit, onDelete }: { memory: MemoryRecord & { score?: number }; onEdit: () => void; onDelete: () => void }) {
  const { locale } = useLocale();
  const t = useTranslation();
  const superseded = memory.supersededBy !== null;
  return (
    <ListRow className={cn("sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start", superseded && "text-muted-foreground")}>
      <div className="grid min-w-0 gap-1.5">
        <p className="max-w-prose whitespace-pre-wrap text-sm leading-relaxed">{memory.content}</p>
        <Meta>
          {superseded && (
            <GlossaryTerm id="superseded" variant="text">
              <Badge tone="neutral">{t("memories.card.superseded")}</Badge>
            </GlossaryTerm>
          )}
          {memory.score !== undefined && <MetaItem tone="info">{t("common.matchPercent", { percent: Math.round(memory.score * 100) })}</MetaItem>}
          <MetaItem>
            <SourceMark provenance={memory.provenance} />
            {t(sourceLabelKey(resolveSource(memory.provenance)))}
          </MetaItem>
          <MetaItem>{formatRelativeTime(memory.createdAt, Date.now(), locale)}</MetaItem>
          {memory.category && <MetaItem>{memory.category}</MetaItem>}
          {memory.tags.length > 0 && <MetaItem truncate>{memory.tags.map((tag) => `#${tag}`).join(" ")}</MetaItem>}
          {memory.version > 1 && <MetaItem>{t("common.versionBadge", { version: memory.version })}</MetaItem>}
        </Meta>
        <Disclosure contentClassName="mt-1.5" size="sm" summary={t("common.showDetails")}>
          <DescriptionList className="text-xs">
            <DescriptionItem label={t("memories.card.effective")}>{formatDate(memory.effectiveAt, locale)}</DescriptionItem>
            <DescriptionItem label={t("memories.card.provenance")}>{t("memories.card.provenanceCell", { kind: t(`status.provenanceKind.${memory.provenance.kind}`), source: memory.provenance.source })}</DescriptionItem>
            <DescriptionItem label={t("memories.card.lineage")}><CopyableId label={t("common.id.lineageId")} value={memory.lineageId} /></DescriptionItem>
          </DescriptionList>
        </Disclosure>
      </div>
      <RowActions>
        <Button aria-label={t("memories.card.createVersion")} disabled={superseded} onClick={onEdit} size="icon-sm" title={t("memories.card.createVersion")} variant="ghost">
          <Pencil aria-hidden="true" />
        </Button>
        <Button aria-label={t("memories.deleteDialog.confirmLabel")} className="text-muted-foreground hover:bg-danger-surface hover:text-danger" onClick={onDelete} size="icon-sm" title={t("memories.deleteDialog.confirmLabel")} variant="ghost">
          <Trash2 aria-hidden="true" />
        </Button>
      </RowActions>
    </ListRow>
  );
}

function MemoryEditor({ memory, onClose, onSaved }: { memory: MemoryRecord | null; onClose: () => void; onSaved: (created: boolean) => void }) {
  const t = useTranslation();
  const [content, setContent] = useState(memory?.content ?? "");
  const [category, setCategory] = useState(memory?.category ?? "");
  const [tags, setTags] = useState(memory?.tags.join(", ") ?? "");
  const [effectiveAt, setEffectiveAt] = useState(toLocalDateTimeInput(memory?.effectiveAt ?? new Date().toISOString()));
  const save = useMutation({
    mutationFn: () => {
      const common = {
        content,
        category: category.trim() || null,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        effectiveAt: new Date(effectiveAt).toISOString(),
        idempotencyKey: newIdempotencyKey(memory ? "memory-update" : "memory-create"),
      };
      return memory
        ? api.updateMemory(memory.id, { ...common, expectedVersion: memory.version, expectedContentHash: memory.contentHash })
        : api.createMemory(common);
    },
    onSuccess: () => onSaved(memory === null),
  });

  return (
    <Dialog
      description={memory ? t("memories.editorDialog.descriptionEdit") : t("memories.editorDialog.descriptionCreate")}
      footer={
        <>
          <Button onClick={onClose} variant="ghost">{t("common.cancel")}</Button>
          <Button form="memory-editor" loading={save.isPending} type="submit">
            {save.isPending ? t("common.saving") : memory ? t("memories.card.createVersion") : t("memories.editorDialog.createMemory")}
          </Button>
        </>
      }
      onClose={onClose}
      open
      size="lg"
      title={memory ? t("memories.editorDialog.titleVersion", { version: memory.version + 1 }) : t("memories.editorDialog.titleCreate")}
    >
      <form className="grid gap-4" id="memory-editor" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        {save.isError && <ErrorState error={save.error} />}
        <Field htmlFor="memory-content" label={t("memories.editorDialog.contentLabel")}>
          <Textarea id="memory-content" maxLength={10_000} onChange={(event) => setContent(event.target.value)} required rows={6} value={content} />
        </Field>
        <Disclosure contentClassName="mt-4" summary={t("common.moreOptions")} variant="boxed">
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field htmlFor="memory-editor-category" label={t("memories.editorDialog.categoryLabel")}>
                <Input id="memory-editor-category" maxLength={100} onChange={(event) => setCategory(event.target.value)} value={category} />
              </Field>
              <Field hint={t("memories.editorDialog.tagsHint")} htmlFor="memory-tags" label={t("memories.editorDialog.tagsLabel")}>
                <Input id="memory-tags" onChange={(event) => setTags(event.target.value)} value={tags} />
              </Field>
            </div>
            <Field htmlFor="memory-effective" label={t("memories.editorDialog.effectiveAtLabel")}>
              <Input id="memory-effective" onChange={(event) => setEffectiveAt(event.target.value)} required type="datetime-local" value={effectiveAt} />
            </Field>
          </div>
        </Disclosure>
      </form>
    </Dialog>
  );
}
