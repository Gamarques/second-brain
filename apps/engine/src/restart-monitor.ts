import { setTimeout as delay } from "node:timers/promises";

export interface EnvironmentRestartRequestReader {
  readRestartRequestForRuntime(signal?: AbortSignal): Promise<number>;
}

export interface EnvironmentRestartMonitor {
  readonly requested: Promise<number>;
  close(): void;
}

/** Polls the shared durable restart revision without owning a service process. */
export function monitorEnvironmentRestart(
  reader: EnvironmentRestartRequestReader,
  loadedRevision: number,
  intervalMs = 1_000,
): EnvironmentRestartMonitor {
  if (!Number.isInteger(loadedRevision) || loadedRevision < 0) {
    throw new Error("loadedRevision must be a non-negative integer.");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("intervalMs must be a positive integer.");
  }
  const controller = new AbortController();
  const requested = (async () => {
    while (true) {
      controller.signal.throwIfAborted();
      try {
        const revision = await reader.readRestartRequestForRuntime(
          controller.signal,
        );
        if (revision > loadedRevision) return revision;
      } catch (error) {
        if (controller.signal.aborted) controller.signal.throwIfAborted();
        // A transient database failure must not disable later restart checks.
      }
      await delay(intervalMs, undefined, {
        signal: controller.signal,
        ref: false,
      });
    }
  })();
  // Closing a runtime intentionally aborts the monitor; keep that expected
  // rejection from becoming an unhandled process-level error.
  void requested.catch(() => undefined);
  return {
    requested,
    close() {
      controller.abort("runtime-closed");
    },
  };
}
