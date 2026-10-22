import { ArrowRight, BookOpen, FolderKanban } from "lucide-react";

import { useTranslation } from "../lib/i18n";
import { cn } from "../lib/utils";
import type { BrainAnswer } from "../lib/workspace-types";
import { Badge } from "./ui/badge";
import { ButtonLink } from "./ui/button-link";

export type BrainCitation = BrainAnswer["citations"][number];
export interface KnowledgeCitation {
  documentTitle: string;
  content: string;
  score: number;
}

export function citationDocumentRoute(citation: BrainCitation): string | null {
  return citation.documentId && citation.knowledgeBaseId ? `/knowledge/${citation.knowledgeBaseId}/documents/${citation.documentId}` : null;
}

export function citationProjectRoute(citation: BrainCitation): string | null {
  if (citation.sourceType === "project") return `/projects/${citation.id}`;
  return citation.projectId ? `/projects/${citation.projectId}` : null;
}

/** The numbered source list under a grounded answer. `compact` fits the side panel. */
export function BrainCitations({ citations, compact = false, className }: { citations: BrainCitation[]; compact?: boolean; className?: string }) {
  const t = useTranslation();
  if (citations.length === 0) return null;
  return (
    <ol className={cn("grid list-none gap-2", className)}>
      {citations.map((citation) => {
        const documentTo = citationDocumentRoute(citation);
        const projectTo = documentTo ? null : citationProjectRoute(citation);
        return (
          <li className={cn("flex gap-3 rounded-lg border border-border bg-muted/20", compact ? "p-3" : "p-4")} key={citation.index}>
            <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-medium tabular-nums text-primary-foreground">
              {citation.index}
            </span>
            <div className="grid min-w-0 flex-1 gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="break-words text-sm font-medium text-foreground">{citation.title}</p>
                {!compact && <Badge tone="neutral">{citation.sourceType.replaceAll("_", " ")}</Badge>}
              </div>
              <p className={cn("whitespace-pre-wrap break-words leading-relaxed text-muted-foreground", compact ? "line-clamp-4 text-xs" : "text-sm")}>{citation.excerpt}</p>
              {(documentTo || projectTo) && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {documentTo && (
                    <ButtonLink size="sm" to={documentTo} variant="outline">
                      <BookOpen aria-hidden="true" />
                      {t("projects.openDocument")}
                      <ArrowRight aria-hidden="true" />
                    </ButtonLink>
                  )}
                  {projectTo && (
                    <ButtonLink size="sm" to={projectTo} variant="outline">
                      <FolderKanban aria-hidden="true" />
                      {t("ask.openProject")}
                      <ArrowRight aria-hidden="true" />
                    </ButtonLink>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Sources for an answer scoped to one document folder. */
export function KnowledgeCitations({ citations, className }: { citations: KnowledgeCitation[]; className?: string }) {
  const t = useTranslation();
  if (citations.length === 0) return null;
  return (
    <div className={cn("grid gap-2", className)}>
      {citations.map((citation, index) => (
        <blockquote className="rounded-md border-l-2 border-primary/40 bg-muted/40 px-3.5 py-2.5 text-xs" key={`${citation.documentTitle}-${index}`}>
          <p className="line-clamp-4 leading-relaxed text-foreground/90">{citation.content}</p>
          <footer className="mt-2 flex items-center justify-between gap-2 text-muted-foreground">
            <span className="truncate font-medium">{citation.documentTitle}</span>
            <Badge tone="info">{t("common.matchPercent", { percent: Math.round(citation.score * 100) })}</Badge>
          </footer>
        </blockquote>
      ))}
    </div>
  );
}
