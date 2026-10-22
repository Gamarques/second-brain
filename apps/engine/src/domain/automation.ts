export const automationJobKinds = [
  "daily_dreaming",
  "reminder_delivery",
  "brain_pack_export",
  "brain_pack_import",
] as const;
export type AutomationJobKind = (typeof automationJobKinds)[number];

export const automationJobStatuses = [
  "pending",
  "running",
  "retry_wait",
  "completed",
  "failed",
  "canceled",
] as const;
export type AutomationJobStatus = (typeof automationJobStatuses)[number];

export interface AutomationSettings {
  readonly timeZone: string;
  readonly dreamingEnabled: boolean;
  readonly dreamLocalTime: string;
  readonly nextDreamAt: string | null;
  readonly reminderDeliveryEnabled: boolean;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface AutomationJob {
  readonly id: string;
  readonly kind: AutomationJobKind;
  readonly canonicalKey: string;
  readonly scheduledFor: string;
  readonly status: AutomationJobStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly fencingToken: string | null;
  readonly cancelRequestedAt: string | null;
  readonly sanitizedError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClaimedAutomationJob {
  readonly job: AutomationJob;
  readonly workerId: string;
  readonly fencingToken: string;
}

export interface AutomationWorkerHeartbeat {
  readonly workerId: string;
  readonly version: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
}

export interface AutomationWorker {
  run(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
