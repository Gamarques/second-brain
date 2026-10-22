export const modelOperations = ["embedding", "knowledge_ask", "brain_ask", "ingestion", "dreaming", "verification", "diagnostic"] as const;
export type ModelOperation = (typeof modelOperations)[number];
export const modelFailureReasons = ["authentication", "credits", "privacy", "unavailable", "rate_limit", "timeout", "network", "malformed", "canceled", "unknown"] as const;
export type ModelFailureReason = (typeof modelFailureReasons)[number];

/** Request metadata only: never store prompts, responses, credentials or raw errors. */
export interface ModelRequestObservation {
  readonly operation: ModelOperation;
  readonly model: string;
  readonly occurredAt: string;
  readonly durationMs: number;
  readonly outcome: "succeeded" | "failed";
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Credits charged by OpenRouter, not an estimate or an invoice total. */
  readonly cost: number | null;
  readonly errorReason: ModelFailureReason | null;
}
export type ModelRequestObserver = (observation: ModelRequestObservation) => Promise<void>;
