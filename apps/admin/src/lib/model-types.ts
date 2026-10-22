export const modelOperations = ["embedding", "knowledge_ask", "brain_ask", "ingestion", "dreaming", "verification", "diagnostic"] as const;
export type ModelOperation = typeof modelOperations[number];
export type ModelFailureReason = "authentication" | "credits" | "privacy" | "unavailable" | "rate_limit" | "timeout" | "network" | "malformed" | "canceled" | "unknown";
export interface ModelConfiguration {
  saved: { revision: number; hasApiKey: boolean; models: Record<string, string> };
  runtimes: Array<{ id: string; service: string; configurationRevision: number; models: Record<string, string>; healthy: boolean; startedAt: string; lastSeenAt: string }>;
}
export interface ModelProbe { ok: boolean; reason: ModelFailureReason | null; model: string; checkedAt: string; durationMs: number }
export interface ModelUsage {
  since: string; observedAt: string; truncated: boolean;
  groups: Array<{ operation: ModelOperation; model: string; requests: number; failures: number; inputTokens: number; outputTokens: number; reportedCost: number; costCoverage: number; tokenCoverage: number; averageDurationMs: number }>;
  failures: Array<{ reason: ModelFailureReason | null; count: number }>;
}
