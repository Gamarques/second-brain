import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowRight, BookOpen, Check, FolderKanban, MessageCircleQuestion, RefreshCw, RotateCcw, Search } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useParams } from "react-router-dom";

import {
  EmptyState,
  ErrorState,
  PageSkeleton,
} from "../components/async-state";
import { EmptyProjectsIllustration } from "../components/illustrations/empty-projects";
import { ListCard, ListRow, Page, PageHeader } from "../components/page";
import { Alert } from "../components/ui/alert";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ButtonLink } from "../components/ui/button-link";
import { Disclosure } from "../components/ui/disclosure";
import { Input } from "../components/ui/field";
import { TabPanel, Tabs } from "../components/ui/tabs";
import { api } from "../lib/api";
import { useLocale, useTranslation } from "../lib/i18n";
import type { CatalogKey } from "../lib/i18n/catalog";
import { cn, formatDate } from "../lib/utils";
import { projectSections, type ProjectSection } from "../lib/workspace-types";

const statusKeys: Record<string, CatalogKey> = {
  active: "projects.status.active",
  paused: "projects.status.paused",
  completed: "projects.status.completed",
  archived: "projects.status.archived",
  achieved: "projects.status.achieved",
  abandoned: "projects.status.abandoned",
  todo: "projects.status.todo",
  in_progress: "projects.status.in_progress",
  done: "projects.status.completed",
  canceled: "projects.status.canceled",
};

function statusTone(status: string | null): BadgeTone {
  switch (status) {
    case "active":
    case "in_progress":
      return "info";
    case "completed":
    case "done":
    case "achieved":
      return "success";
    case "paused":
      return "warning";
    case "abandoned":
    case "canceled":
      return "danger";
    default:
      return "neutral";
  }
}

const priorityTone: Record<string, BadgeTone> = { low: "neutral", normal: "neutral", high: "warning", urgent: "danger" };

export function ProjectsPage() {
  const t = useTranslation();
  const [search, setSearch] = useState("");
  const query = useInfiniteQuery({
    queryKey: ["projects"],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api.projects(pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
  });
  const projects = query.data?.pages.flatMap((page) => page.projects) ?? [];
  const visible = projects.filter((project) => project.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return (
    <Page>
      <PageHeader description={t("projects.description")} title={t("projects.title")} />
      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : projects.length === 0 ? (
        <EmptyState description={t("projects.emptyHint")} example={t("projects.example")} illustration={<EmptyProjectsIllustration />} title={t("projects.empty")} />
      ) : (
        <>
          <label className="relative block max-w-sm">
            <span className="sr-only">{t("projects.filter")}</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" onChange={(event) => setSearch(event.target.value)} placeholder={t("projects.filter")} type="search" value={search} />
          </label>
          {visible.length === 0 ? (
            <EmptyState description={t("projects.noMatch.description")} illustration={<EmptyProjectsIllustration />} title={t("projects.noMatch.title")} />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {visible.map((project) => (
                <li key={project.id}>
                  <Link
                    className="group flex h-full flex-col gap-2.5 rounded-xl border border-border bg-card p-4 shadow-card transition-[border-color,box-shadow] hover:border-foreground/15 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                    to={`/projects/${project.id}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/60 text-foreground">
                        <FolderKanban aria-hidden="true" className="size-4" />
                      </span>
                      <Badge dot tone={statusTone(project.status)}>{t(statusKeys[project.status] ?? "projects.status.active")}</Badge>
                    </div>
                    <div className="grid gap-1">
                      <h2 className="break-words text-sm font-medium leading-snug text-foreground">{project.name}</h2>
                      {project.description && (
                        <p className="line-clamp-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted-foreground">{project.description}</p>
                      )}
                    </div>
                    <span className="mt-auto inline-flex items-center gap-1 pt-0.5 text-[13px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                      {t("ask.openProject")}
                      <ArrowRight aria-hidden="true" className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button disabled={query.isFetchingNextPage} loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()} variant="outline">
            {t("learning.more")}
          </Button>
        </div>
      )}
    </Page>
  );
}

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const t = useTranslation();
  const [section, setSection] = useState<ProjectSection>("tasks");
  const query = useQuery({
    queryKey: ["project", projectId],
    queryFn: ({ signal }) => api.project(projectId, signal),
  });
  if (query.isPending) return <PageSkeleton />;
  if (query.isError) return <ErrorState error={query.error} retry={() => query.refetch()} />;
  if (!query.data.result) {
    return <EmptyState description={t("projects.missingHint")} illustration={<EmptyProjectsIllustration />} title={t("projects.missing")} />;
  }
  const { project, counts } = query.data.result;
  return (
    <Page>
      <PageHeader
        actions={
          <ButtonLink to={`/?project=${project.id}`} variant="outline">
            <MessageCircleQuestion aria-hidden="true" />
            {t("projects.ask")}
          </ButtonLink>
        }
        back={{ to: "/projects", label: t("projects.back") }}
        description={project.description ?? t("projects.description")}
        meta={<Badge dot tone={statusTone(project.status)}>{t(statusKeys[project.status] ?? "projects.status.active")}</Badge>}
        title={project.name}
      />
      <Tabs
        items={projectSections.map((value) => ({ id: value, label: t(`projects.section.${value}`), count: counts[value] }))}
        label={t("projects.sections")}
        onChange={(id) => setSection(id as ProjectSection)}
        value={section}
      />
      <TabPanel active id={section}>
        <ProjectSectionView key={`${projectId}:${section}`} projectId={projectId} section={section} />
      </TabPanel>
    </Page>
  );
}

function ProjectSectionView({ projectId, section }: { projectId: string; section: ProjectSection }) {
  const t = useTranslation();
  const { locale } = useLocale();
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: ["project-section", projectId, section],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.projectSection({ projectId, section, cursor: pageParam }, signal),
    getNextPageParam: (page) => page.nextCursor,
  });
  const mutation = useMutation({
    mutationFn: (input: { id: string; expectedVersion: number; status: "done" | "todo" }) =>
      api.updateTask({
        ...input,
        idempotencyKey: `project-task:${input.id}:${input.expectedVersion}:${input.status}`,
      }),
    onSuccess: async () => {
      await Promise.all([query.refetch(), client.invalidateQueries({ queryKey: ["project", projectId] })]);
    },
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <h2 className="sr-only">{t(`projects.section.${section}`)}</h2>
      {mutation.isError && <Alert title={t("projects.conflict")} tone="danger" />}
      {query.isPending ? (
        <PageSkeleton cards={1} />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : !items.length ? (
        <EmptyState description={t("projects.linkHint")} illustration={<EmptyProjectsIllustration />} title={t("projects.sectionEmpty")} />
      ) : (
        <ListCard>
          {items.map((item) => {
            const done = item.status === "done";
            const canToggle = section === "tasks" && item.version && item.status !== "canceled";
            return (
              <ListRow className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start" key={item.id}>
                <div className="grid min-w-0 gap-2">
                  <div className="flex items-start gap-3">
                    {section === "tasks" && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                          done ? "border-success bg-success text-white" : "border-border bg-card",
                        )}
                      >
                        {done && <Check className="size-3" strokeWidth={3} />}
                      </span>
                    )}
                    <h3 className={cn("whitespace-pre-wrap break-words text-sm font-medium leading-snug text-foreground", done && "text-muted-foreground line-through decoration-muted-foreground/50")}>
                      {item.title}
                    </h3>
                  </div>
                  <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground", section === "tasks" && "pl-8")}>
                    {item.status && section !== "tasks" && <Badge tone={statusTone(item.status)}>{t(statusKeys[item.status] ?? "projects.status.active")}</Badge>}
                    {item.status && section === "tasks" && !done && <Badge tone={statusTone(item.status)}>{t(statusKeys[item.status] ?? "projects.status.active")}</Badge>}
                    {item.priority && (
                      <Badge tone={priorityTone[item.priority] ?? "neutral"}>
                        {t(`learning.priority.${item.priority as "low" | "normal" | "high" | "urgent"}`)}
                      </Badge>
                    )}
                    {item.date && <span>{formatDate(item.date, locale)}</span>}
                    {item.tags.map((tag) => <Badge key={tag} tone="neutral">#{tag}</Badge>)}
                  </div>
                  {item.body && (
                    <Disclosure className={cn(section === "tasks" && "pl-8")} summary={t("projects.details")}>
                      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">{item.body}</p>
                    </Disclosure>
                  )}
                </div>
                <div className={cn("flex flex-wrap items-center gap-2", section === "tasks" && "pl-8 sm:pl-0")}>
                  {section === "documents" && item.knowledgeBaseId && (
                    <ButtonLink size="sm" to={`/knowledge/${item.knowledgeBaseId}/documents/${item.id}`} variant="outline">
                      <BookOpen aria-hidden="true" />
                      {t("projects.openDocument")}
                    </ButtonLink>
                  )}
                  {canToggle && (
                    <Button
                      disabled={mutation.isPending}
                      onClick={() =>
                        mutation.mutate({
                          id: item.id,
                          expectedVersion: item.version!,
                          status: done ? "todo" : "done",
                        })
                      }
                      size="sm"
                      variant={done ? "ghost" : "outline"}
                    >
                      {done ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}
                      {t(done ? "projects.reopen" : "projects.complete")}
                    </Button>
                  )}
                </div>
              </ListRow>
            );
          })}
        </ListCard>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {query.hasNextPage && (
          <Button disabled={query.isFetchingNextPage} loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()} variant="outline">
            {t("learning.more")}
          </Button>
        )}
        <Button disabled={mutation.isPending} loading={query.isFetching && !query.isPending} onClick={() => query.refetch()} size="sm" variant="ghost">
          {!(query.isFetching && !query.isPending) && <RefreshCw aria-hidden="true" />}
          {t("common.refresh")}
        </Button>
      </div>
    </>
  );
}
