import type { AutomationJob } from "./api-types";
export interface DreamingCalendarItem {
  jobId: string; localDate: string; status: AutomationJob["status"]; attemptCount: number;
  runId: string | null; reportRunId: string | null; replayOfRunId: string | null; sourceJobId: string | null;
  mode: "preview" | "apply" | null; timeZone: string; model: string | null; sanitizedError: string | null;
  createdAt: string; updatedAt: string; canRetry: boolean;
}
export interface DreamingCalendar { month: string; timeZone: string; today: string; items: DreamingCalendarItem[]; truncated: boolean }
