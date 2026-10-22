import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, MessageCircleQuestion, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { matchPath, useLocation } from "react-router-dom";

import { api } from "../lib/api";
import { useLocale, useTranslation } from "../lib/i18n";
import { useBodyScrollLock, useEscapeKey, useFocusTrap } from "../lib/overlay";
import { commandKeyLabel } from "../lib/shortcuts";
import { cn } from "../lib/utils";
import type { BrainAnswer } from "../lib/workspace-types";
import { BrainCitations, KnowledgeCitations, type KnowledgeCitation } from "./brain-answer";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Composer } from "./ui/composer";
import { Disclosure } from "./ui/disclosure";
import { Kbd } from "./ui/kbd";
import { Tabs } from "./ui/tabs";

export const askPanelStorageKey = "second-brain-admin.ask-panel-open";
export const askPanelWidth = "380px";
const wideQuery = "(min-width: 1024px)";

/** The panel reopens only on wide screens, where it docks beside the page instead of covering it. */
export function readAskPanelOpen(): boolean {
  try {
    return window.localStorage.getItem(askPanelStorageKey) === "true" && (window.matchMedia?.(wideQuery).matches ?? false);
  } catch {
    return false;
  }
}

export function persistAskPanelOpen(open: boolean): void {
  try {
    window.localStorage.setItem(askPanelStorageKey, String(open));
  } catch {
    // A blocked storage partition must never break the console.
  }
}

type AskScope = { kind: "brain" } | { kind: "project"; id: string; label: string } | { kind: "folder"; id: string; label: string };
type PageScope = Extract<AskScope, { kind: "project" | "folder" }>;

interface Entry {
  id: string;
  question: string;
  scope: AskScope;
  status: "pending" | "done" | "error";
  answer?: BrainAnswer;
  knowledge?: { answer: string; citations: KnowledgeCitation[] };
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

/** Derives the page's natural scope: the open project or document folder, if any. */
function usePageScope(pathname: string): PageScope | null {
  const t = useTranslation();
  const projectId = matchPath("/projects/:projectId", pathname)?.params.projectId ?? null;
  const baseId = matchPath("/knowledge/:baseId/*", pathname)?.params.baseId ?? null;
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: ({ signal }) => api.project(projectId!, signal),
    enabled: projectId !== null,
  });
  const bases = useQuery({
    queryKey: ["knowledge-bases"],
    queryFn: ({ signal }) => api.knowledgeBases(signal),
    enabled: baseId !== null,
  });
  if (projectId) return { kind: "project", id: projectId, label: project.data?.result?.project.name ?? t("askPanel.scope.project") };
  if (baseId) return { kind: "folder", id: baseId, label: bases.data?.knowledgeBases.find((base) => base.id === baseId)?.name ?? t("askPanel.scope.folder") };
  return null;
}

/**
 * A docked panel for asking the brain from any page. On wide screens it
 * sits beside the content; below `lg` it slides over it with a backdrop.
 * The conversation lives only for the session.
 */
export function AskPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslation();
  const { locale } = useLocale();
  const location = useLocation();
  const pageScope = usePageScope(location.pathname);
  const [scopeChoice, setScopeChoice] = useState<"page" | "brain">("page");
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery(wideQuery);
  const overlay = open && !wide;

  useBodyScrollLock(overlay);
  useEscapeKey(open, onClose);
  useFocusTrap(panel, overlay, input);
  useEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [entries]);

  if (!open) return null;

  const scope: AskScope = pageScope && scopeChoice === "page" ? pageScope : { kind: "brain" };

  function update(id: string, patch: Partial<Entry>) {
    setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }

  async function ask() {
    const text = question.trim();
    if (!text || busy) return;
    const id = crypto.randomUUID();
    const request = new AbortController();
    controller.current = request;
    setEntries((current) => [...current, { id, question: text, scope, status: "pending" }]);
    setQuestion("");
    setBusy(true);
    try {
      if (scope.kind === "folder") {
        const result = await api.askKnowledge(scope.id, text);
        if (!request.signal.aborted) update(id, { status: "done", knowledge: result });
      } else {
        const result = await api.askBrain({ question: text, locale, projectId: scope.kind === "project" ? scope.id : null }, request.signal);
        if (!request.signal.aborted) update(id, { status: "done", answer: result });
      }
    } catch {
      if (!request.signal.aborted) update(id, { status: "error" });
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  function stop() {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setEntries((current) => {
      const last = current.at(-1);
      if (last?.status !== "pending") return current;
      setQuestion(last.question);
      return current.slice(0, -1);
    });
  }

  const shortcut = `${commandKeyLabel()} J`;

  return (
    <>
      {overlay && <div aria-hidden="true" className="fixed inset-0 z-40 animate-fade-in bg-black/40 backdrop-blur-xs lg:hidden" onClick={onClose} />}
      <aside
        aria-label={t("askPanel.title")}
        className={cn(
          "flex flex-col border-l border-border bg-frame text-foreground",
          wide ? "relative h-full shrink-0" : "fixed inset-y-0 right-0 z-40 w-full max-w-[420px] animate-fade-in shadow-2xl shadow-black/30",
        )}
        ref={panel}
        role={overlay ? "dialog" : undefined}
        style={{ width: wide ? askPanelWidth : undefined }}
        {...(overlay ? { "aria-modal": true } : {})}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
          <MessageCircleQuestion aria-hidden="true" className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">{t("askPanel.title")}</h2>
          <span className="ml-1 hidden items-center gap-0.5 sm:flex"><Kbd>{commandKeyLabel()}</Kbd><Kbd>J</Kbd></span>
          <div className="ml-auto flex items-center gap-1">
            {entries.length > 0 && (
              <Button aria-label={t("askPanel.clear")} className="text-muted-foreground hover:text-foreground" disabled={busy} onClick={() => setEntries([])} size="icon-sm" variant="ghost">
                <Trash2 aria-hidden="true" />
              </Button>
            )}
            <Button aria-label={t("askPanel.close")} className="text-muted-foreground hover:text-foreground" onClick={onClose} size="icon-sm" variant="ghost">
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>
        {pageScope && (
          <div className="grid gap-1.5 border-b border-border px-4 py-3">
            <p className="text-xs font-medium text-muted-foreground">{t("askPanel.scope.label")}</p>
            <Tabs
              className="w-full"
              items={[
                { id: "page", label: pageScope.label },
                { id: "brain", label: t("askPanel.scope.brain") },
              ]}
              label={t("askPanel.scope.label")}
              onChange={(id) => setScopeChoice(id as "page" | "brain")}
              value={scopeChoice}
            />
          </div>
        )}
        <div aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-4 py-4" ref={log}>
          {entries.length === 0 ? (
            <div className="grid h-full place-items-center text-center">
              <div className="max-w-xs">
                <div className="aurora-soft mx-auto mb-4 flex size-11 items-center justify-center rounded-full text-foreground">
                  <MessageCircleQuestion aria-hidden="true" className="size-5" />
                </div>
                <p className="text-sm font-medium text-foreground">{t("askPanel.empty.title")}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t("askPanel.empty.body", { shortcut })}</p>
                <p className="mt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t("askPanel.empty.try")}</p>
                <button
                  className="mt-1.5 cursor-pointer rounded-full border border-border/70 bg-card px-3 py-1.5 text-xs text-foreground shadow-xs transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                  onClick={() => {
                    setQuestion(t(scope.kind === "project" ? "askPanel.example.project" : scope.kind === "folder" ? "askPanel.example.folder" : "home.suggestion.2"));
                    input.current?.focus();
                  }}
                  type="button"
                >
                  {t(scope.kind === "project" ? "askPanel.example.project" : scope.kind === "folder" ? "askPanel.example.folder" : "home.suggestion.2")}
                </button>
              </div>
            </div>
          ) : (
            <ol className="grid gap-5">
              {entries.map((entry) => {
                const entryScope = entry.scope;
                const scopeLabel = entryScope.kind === "brain" ? null : entryScope.label;
                return (
                <li className="grid gap-2.5" key={entry.id}>
                  <div className="ml-6 rounded-lg rounded-tr-sm bg-primary px-3.5 py-2.5 text-sm leading-relaxed text-primary-foreground">
                    <p className="whitespace-pre-wrap break-words">{entry.question}</p>
                    {scopeLabel && <p className="mt-1 text-[11px] text-primary-foreground/70">{scopeLabel}</p>}
                  </div>
                  {entry.status === "pending" && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                      {t("ask.searching")}
                    </p>
                  )}
                  {entry.status === "error" && <Alert title={t("ask.failure")} tone="danger" />}
                  {entry.status === "done" && (
                    <div className="grid gap-2.5">
                      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                        {entry.answer ? (entry.answer.answerable ? entry.answer.answer : t("ask.noEvidence")) : entry.knowledge?.answer}
                      </p>
                      {entry.answer && entry.answer.citations.length > 0 && (
                        <Disclosure summary={t("askPanel.sources", { count: entry.answer.citations.length })}>
                          <BrainCitations citations={entry.answer.citations} compact />
                        </Disclosure>
                      )}
                      {entry.knowledge && entry.knowledge.citations.length > 0 && (
                        <Disclosure summary={t("askPanel.sources", { count: entry.knowledge.citations.length })}>
                          <KnowledgeCitations citations={entry.knowledge.citations} />
                        </Disclosure>
                      )}
                    </div>
                  )}
                </li>
                );
              })}
            </ol>
          )}
        </div>
        <form
          className="shrink-0 border-t border-border bg-frame p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <Composer
            aria-label={t("askPanel.title")}
            busy={busy}
            footnote={t("ask.scope")}
            maxLength={5000}
            onChange={setQuestion}
            onStop={stop}
            onSubmit={() => void ask()}
            placeholder={t("askPanel.placeholder")}
            ref={input}
            stopLabel={t("ask.stop")}
            submitLabel={t("ask.submit")}
            value={question}
            variant="pill"
          />
        </form>
      </aside>
    </>
  );
}
