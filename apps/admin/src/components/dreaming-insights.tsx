import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { BellRing, CheckCheck, ClipboardList, FileText, MessageCircleQuestion } from "lucide-react";
import { useRef, useState } from "react";

import { api } from "../lib/api";
import { useTranslation } from "../lib/i18n";
import type { BriefingInsight } from "../lib/workspace-types";
import { ErrorState } from "./async-state";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ButtonLink } from "./ui/button-link";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { Disclosure } from "./ui/disclosure";
import { Field, Input, Select } from "./ui/field";

export type InsightActionKind = "task" | "reminder" | "resolve";

/**
 * One open question or contradiction from a nightly review, with the
 * actions that turn it into work: create a task, create a reminder, mark it
 * reviewed, or ask the brain about it.
 */
export function InsightCard({
  insight,
  onAction,
  onAsk,
}: {
  insight: BriefingInsight;
  onAction: (kind: InsightActionKind) => void;
  onAsk?: (statement: string) => void;
}) {
  const t = useTranslation();
  const taskCreated = insight.actions.some((item) => item.kind === "task");
  const reminderCreated = insight.actions.some((item) => item.kind === "reminder");
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={insight.kind === "contradiction" ? "warning" : "info"}>{t(insight.kind === "contradiction" ? "briefing.contradiction" : "briefing.openLoop")}</Badge>
          <span className="text-xs text-muted-foreground">{insight.localDate}</span>
        </div>
        <CardTitle className="whitespace-pre-wrap break-words">{insight.statement}</CardTitle>
      </CardHeader>
      <CardContent>
        <Disclosure summary={t("learning.evidence")}>
          <div className="grid gap-2">
            {insight.evidence.map((evidence, index) => (
              <blockquote className="whitespace-pre-wrap break-words rounded-md border-l-2 border-primary/40 bg-muted/40 px-3.5 py-2.5 text-sm leading-relaxed text-foreground/90" key={index}>
                {evidence.excerpt}
              </blockquote>
            ))}
          </div>
        </Disclosure>
      </CardContent>
      <CardFooter className="justify-between border-t border-border/60 pt-4 sm:pt-4">
        <div className="flex flex-wrap gap-2">
          <Button disabled={taskCreated} onClick={() => onAction("task")} size="sm" variant="outline">
            {taskCreated ? <CheckCheck aria-hidden="true" /> : <ClipboardList aria-hidden="true" />}
            {t(taskCreated ? "briefing.taskCreated" : "briefing.createTask")}
          </Button>
          <Button disabled={reminderCreated} onClick={() => onAction("reminder")} size="sm" variant="outline">
            {reminderCreated ? <CheckCheck aria-hidden="true" /> : <BellRing aria-hidden="true" />}
            {t(reminderCreated ? "briefing.reminderCreated" : "briefing.createReminder")}
          </Button>
          <Button onClick={() => onAction("resolve")} size="sm" variant="ghost">
            {t("briefing.resolve")}
          </Button>
          {onAsk && (
            <Button onClick={() => onAsk(insight.statement)} size="sm" variant="ghost">
              <MessageCircleQuestion aria-hidden="true" />
              {t("home.review.askAbout")}
            </Button>
          )}
        </div>
        <ButtonLink size="sm" to={`/automation/dreaming/runs/${insight.runId}`} variant="ghost">
          <FileText aria-hidden="true" />
          {t("learning.report")}
        </ButtonLink>
      </CardFooter>
    </Card>
  );
}

export function InsightActionDialog({
  insight,
  kind,
  onClose,
  onSaved,
}: {
  insight: BriefingInsight;
  kind: InsightActionKind;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslation();
  const [text, setText] = useState(insight.statement.slice(0, kind === "task" ? 500 : 2000));
  const [dueAt, setDueAt] = useState("");
  const [listId, setListId] = useState("");
  const [newListName, setNewListName] = useState("");
  const [projectId, setProjectId] = useState("");
  const listKey = useRef(crypto.randomUUID());
  const createdList = useRef<string | null>(null);
  const lists = useQuery({
    queryKey: ["task-lists"],
    queryFn: ({ signal }) => api.taskLists(signal),
    enabled: kind === "task",
  });
  const projects = useInfiniteQuery({
    queryKey: ["projects"],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api.projects(pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    enabled: kind === "task",
  });
  const selectedList = listId || lists.data?.taskLists[0]?.id || "new";
  const mutation = useMutation({
    mutationFn: async () => {
      let destination = selectedList;
      if (kind === "task" && destination === "new") {
        destination =
          createdList.current ??
          (
            await api.createTaskList({
              name: newListName.trim(),
              idempotencyKey: listKey.current,
            })
          ).id;
        createdList.current = destination;
      }
      return api.actOnBriefing({
        reportId: insight.reportId,
        insightIndex: insight.index,
        expectedDigest: insight.digest,
        kind,
        ...(kind === "resolve" ? {} : { text: text.trim(), dueAt: dueAt ? new Date(dueAt).toISOString() : null }),
        ...(kind === "task" ? { listId: destination, projectId: projectId || null } : {}),
        idempotencyKey: `briefing:${insight.reportId}:${insight.index}:${kind}`,
      });
    },
    onSuccess: onSaved,
  });
  const title = t(kind === "task" ? "briefing.createTask" : kind === "reminder" ? "briefing.createReminder" : "briefing.resolve");
  const disabled =
    mutation.isPending ||
    (kind === "task" && (lists.isPending || lists.isError || (selectedList === "new" && !newListName.trim()))) ||
    (kind !== "resolve" && !text.trim());
  return (
    <Dialog
      description={t(kind === "resolve" ? "briefing.resolveHint" : "briefing.actionHint")}
      footer={
        <>
          <Button disabled={mutation.isPending} onClick={onClose} variant="ghost">{t("common.cancel")}</Button>
          <Button disabled={disabled} form="briefing-action" loading={mutation.isPending} type="submit">
            {t(mutation.isPending ? "common.working" : "common.confirm")}
          </Button>
        </>
      }
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      open
      title={title}
    >
      <form
        className="grid gap-4"
        id="briefing-action"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        {kind === "resolve" && (
          <blockquote className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 px-3.5 py-3 text-sm leading-relaxed text-foreground">{insight.statement}</blockquote>
        )}
        {kind !== "resolve" && (
          <>
            <Field htmlFor="briefing-text" label={t(kind === "task" ? "briefing.taskTitle" : "briefing.reminderMessage")}>
              <Input disabled={mutation.isPending} id="briefing-text" maxLength={kind === "task" ? 500 : 2000} onChange={(event) => setText(event.target.value)} required value={text} />
            </Field>
            <Field hint={t("briefing.browserTimeZone")} htmlFor="briefing-due" label={t(kind === "task" ? "briefing.dueOptional" : "briefing.remindAt")}>
              <Input disabled={mutation.isPending} id="briefing-due" onChange={(event) => setDueAt(event.target.value)} required={kind === "reminder"} type="datetime-local" value={dueAt} />
            </Field>
          </>
        )}
        {kind === "task" && (
          <>
            {lists.isError ? (
              <ErrorState error={lists.error} retry={() => lists.refetch()} />
            ) : (
              <Field htmlFor="briefing-list" label={t("briefing.list")}>
                <Select disabled={lists.isPending || mutation.isPending} id="briefing-list" onChange={(event) => setListId(event.target.value)} value={selectedList}>
                  {lists.data?.taskLists.map((list) => (
                    <option key={list.id} value={list.id}>{list.name}</option>
                  ))}
                  <option value="new">{t("briefing.newList")}</option>
                </Select>
              </Field>
            )}
            {selectedList === "new" && (
              <Field htmlFor="briefing-list-name" label={t("briefing.listName")}>
                <Input
                  disabled={mutation.isPending || !!createdList.current}
                  id="briefing-list-name"
                  maxLength={200}
                  onChange={(event) => {
                    setNewListName(event.target.value);
                    listKey.current = crypto.randomUUID();
                  }}
                  required
                  value={newListName}
                />
              </Field>
            )}
            <Field htmlFor="briefing-project" label={t("briefing.projectOptional")}>
              <Select disabled={mutation.isPending} id="briefing-project" onChange={(event) => setProjectId(event.target.value)} value={projectId}>
                <option value="">{t("briefing.general")}</option>
                {projects.data?.pages.flatMap((page) => page.projects).map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </Select>
            </Field>
            {projects.isError && <ErrorState error={projects.error} retry={() => projects.refetch()} />}
            {projects.hasNextPage && (
              <Button className="w-fit" disabled={projects.isFetchingNextPage} onClick={() => projects.fetchNextPage()} size="sm" type="button" variant="ghost">
                {t("learning.more")}
              </Button>
            )}
          </>
        )}
        {mutation.isError && <Alert title={t("briefing.failure")} tone="danger" />}
      </form>
    </Dialog>
  );
}
