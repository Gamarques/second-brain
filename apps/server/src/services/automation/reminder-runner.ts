import {
  NotificationError,
  type NotificationProvider,
  type ReminderDispatchStore,
} from "@second-brain/engine/domain/notifications";
import type { ClaimedAutomationJob } from "@second-brain/engine/domain";
import { AutomationJobExecutionError } from "./worker.js";
export function createReminderDispatcher(
  store: ReminderDispatchStore,
  provider: NotificationProvider,
) {
  return {
    materialize: (now: Date, signal: AbortSignal) =>
      store.materialize(now, signal),
    async run(claim: ClaimedAutomationJob, signal: AbortSignal) {
      const prepared = await store.prepare(claim, signal);
      if (!prepared) return;
      // A durable running marker precedes the external send. Recovery never blindly
      // sends again after a process crash or a response whose outcome is unknown.
      try {
        const result = await provider.send(
          prepared.config,
          prepared.message,
          signal,
        );
        await store.finish(
          claim,
          { status: "delivered", messageId: result.messageId },
          new AbortController().signal,
        );
      } catch (error) {
        const failure =
          error instanceof NotificationError
            ? error
            : new NotificationError(
                "uncertain",
                "NOTIFICATION_DELIVERY_UNCERTAIN",
              );
        const retry = failure.outcome === "retry" && claim.job.attemptCount < 5;
        await store.finish(
          claim,
          {
            status: retry
              ? "retry_wait"
              : failure.outcome === "uncertain"
                ? "uncertain"
                : "failed",
            errorCode: failure.code,
          },
          new AbortController().signal,
        );
        throw new AutomationJobExecutionError(
          failure.code,
          retry,
          undefined,
          failure.retryAfterSeconds * 1000,
        );
      }
    },
  };
}
