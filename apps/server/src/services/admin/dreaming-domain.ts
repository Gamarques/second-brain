import type { BrainAccessContext } from "@second-brain/engine/domain";
import type { AutomationJobStatus } from "@second-brain/engine/domain/automation";

export interface DreamingCalendarItem {
  readonly jobId: string;
  readonly localDate: string;
  readonly status: AutomationJobStatus;
  readonly attemptCount: number;
  readonly runId: string | null;
  readonly reportRunId: string | null;
  readonly replayOfRunId: string | null;
  readonly sourceJobId: string | null;
  readonly mode: "preview" | "apply" | null;
  readonly timeZone: string;
  readonly model: string | null;
  readonly sanitizedError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly canRetry: boolean;
}
export interface AdminDreamingStore {
  calendar(access: BrainAccessContext, input: { month: string }, signal: AbortSignal): Promise<{ month: string; timeZone: string; today: string; items: readonly DreamingCalendarItem[]; truncated: boolean }>;
  retry(access: BrainAccessContext, input: { jobId: string; idempotencyKey: string }, signal: AbortSignal): Promise<{ jobId: string; sourceJobId: string; created: boolean; mode: "preview" }>;
}
