/** Structured logging adapter owned by the automation worker service. */
import type {
  AutomationLogContext,
  AutomationWorkerLogger,
} from "./worker.js";

export interface AutomationLogWriter {
  write(chunk: string): unknown;
}

export interface JsonAutomationWorkerLoggerOptions {
  readonly now?: () => Date;
  readonly stdout?: AutomationLogWriter;
  readonly stderr?: AutomationLogWriter;
}

/**
 * Writes sanitized worker lifecycle events as one JSON object per line.
 * Only the fixed AutomationLogContext fields are serialized; errors, model
 * payloads, evidence, and arbitrary caller context cannot reach the output.
 */
export function createJsonAutomationWorkerLogger(
  options: JsonAutomationWorkerLoggerOptions = {},
): AutomationWorkerLogger {
  const now = options.now ?? (() => new Date());
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  function write(
    level: "info" | "error",
    context: AutomationLogContext,
  ): void {
    const line = {
      timestamp: now().toISOString(),
      level,
      event: context.event,
      workerId: context.workerId,
      jobId: context.jobId,
      kind: context.kind,
      attemptCount: context.attemptCount,
      ...(context.code === undefined ? {} : { code: context.code }),
    };
    (level === "info" ? stdout : stderr).write(`${JSON.stringify(line)}\n`);
  }

  return {
    info(context) {
      write("info", context);
    },
    error(context) {
      write("error", context);
    },
  };
}
