import type { BrainAccessContext } from "./core.js";
export const projectSections = [
  "tasks",
  "goals",
  "decisions",
  "people",
  "documents",
  "memories",
] as const;
export type ProjectSection = (typeof projectSections)[number];
export interface ProjectContextItem {
  id: string;
  title: string;
  body: string | null;
  status: string | null;
  version: number | null;
  date: string | null;
  priority: string | null;
  knowledgeBaseId: string | null;
  tags: string[];
}
export interface ProjectOverviewStore {
  overview(
    access: BrainAccessContext,
    projectId: string,
    signal: AbortSignal,
  ): Promise<{
    project: {
      id: string;
      name: string;
      description: string | null;
      status: string;
      version: number;
    };
    counts: Record<ProjectSection, number>;
  } | null>;
  section(
    access: BrainAccessContext,
    input: {
      projectId: string;
      section: ProjectSection;
      limit?: number | undefined;
      cursor?: string | null | undefined;
    },
    signal: AbortSignal,
  ): Promise<{ items: ProjectContextItem[]; nextCursor: string | null }>;
}
