import type {
  AutomationJobKind,
  AutomationStore,
  AutomationWorker,
  ClaimedAutomationJob,
  DreamingRunner,
  DreamingStore,
} from "@second-brain/engine/domain";
import { automationJobKinds } from "@second-brain/engine/domain/automation";
import { DreamingExecutionError } from "./dreaming-runner.js";

/** Codes the worker itself produces; runners may add their own uppercase codes. */
export type AutomationJobFailureCode =
  | "DREAMING_JOB_ABORTED"
  | "DREAMING_JOB_FAILED"
  | "DREAMING_RUN_UNAVAILABLE"
  | "JOB_CANCELED"
  | "JOB_KIND_UNSUPPORTED"
  | "JOB_REPORT_INTEGRITY_FAILED"
  | (string & {});

export class AutomationJobExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    retryable: boolean,
    options?: ErrorOptions,
    readonly retryAfterMs = 0,
  ) {
    super(code, options);
    this.name = "AutomationJobExecutionError";
    this.code = /^[A-Z][A-Z0-9_]{1,99}$/u.test(code)
      ? code
      : "DREAMING_JOB_FAILED";
    this.retryable = retryable;
  }
}

/** Thrown by `checkCancelled` (or a runner) once a job was asked to stop; never retried. */
export class AutomationJobCanceledError extends AutomationJobExecutionError {
  constructor(options?: ErrorOptions) {
    super("JOB_CANCELED", false, options);
    this.name = "AutomationJobCanceledError";
  }
}

export interface AutomationLogContext {
  readonly event:
    | "heartbeat_failed"
    | "job_canceled"
    | "job_completed"
    | "job_failed"
    | "job_lease_lost"
    | "job_retry_scheduled"
    | "job_started"
    | "job_state_update_failed"
    | "worker_poll_failed"
    | "worker_started"
    | "worker_stopped";
  readonly workerId: string;
  readonly jobId: string;
  readonly kind: string;
  readonly attemptCount: number;
  readonly code?: string;
}

export interface AutomationWorkerLogger {
  info(context: AutomationLogContext): void;
  error(context: AutomationLogContext): void;
}

export type AutomationWait = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export interface AutomationWorkerService extends AutomationWorker {
  runOnce(signal: AbortSignal): Promise<boolean>;
}

/** What a runner receives for one claimed job. */
export interface JobRunContext {
  /** Aborts when the lease is lost or the worker shuts down. */
  readonly signal: AbortSignal;
  readonly workerId: string;
  readonly now: string;
  readonly leaseSeconds: number;
  readonly logger: AutomationWorkerLogger;
  /** Throws `AutomationJobCanceledError` when the job was asked to stop; call it at every stage boundary. */
  checkCancelled(): Promise<void>;
}

/** One kind of job. Registering a new kind is one entry in the registry. */
export interface JobRunner {
  /** Enqueues due work of this kind before the poll claims anything. */
  materialize?(now: Date, signal: AbortSignal): Promise<void>;
  run(claim: ClaimedAutomationJob, context: JobRunContext): Promise<void>;
}

export type AutomationRunnerRegistry = Partial<Record<AutomationJobKind, JobRunner>>;

export interface AutomationWorkerDependencies {
  readonly workerId: string;
  readonly workerVersion?: string;
  readonly automationStore: AutomationStore;
  readonly dreamingStore: DreamingStore;
  readonly dreamingRunner: DreamingRunner;
  readonly reminders?: {
    materialize(now: Date, signal: AbortSignal): Promise<void>;
    run(claim: ClaimedAutomationJob, signal: AbortSignal): Promise<void>;
  };
  /** Extra or replacement runners by kind; the built-in dreaming and reminder runners are registered first. */
  readonly runners?: AutomationRunnerRegistry;
  readonly now?: () => Date;
  readonly wait?: AutomationWait;
  readonly logger?: AutomationWorkerLogger;
  readonly options?: {
    readonly catchUpLimit?: number;
    readonly heartbeatIntervalMs?: number;
    readonly leaseSeconds?: number;
    readonly leaseRenewalIntervalMs?: number;
    readonly maximumAttempts?: number;
    readonly pollIntervalMs?: number;
    readonly retryBaseDelayMs?: number;
    readonly retryMaximumDelayMs?: number;
  };
}

const silentLogger: AutomationWorkerLogger = {
  info() {},
  error() {},
};

function workerContext(
  event: AutomationLogContext["event"],
  workerId: string,
  code?: string,
): AutomationLogContext {
  return {
    event,
    workerId,
    jobId: "worker",
    kind: "automation_worker",
    attemptCount: 0,
    ...(code === undefined ? {} : { code }),
  };
}

async function defaultWait(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function safeError(
  error: unknown,
  signal: AbortSignal,
): AutomationJobExecutionError {
  if (error instanceof AutomationJobExecutionError) return error;
  if (signal.aborted) {
    return new AutomationJobExecutionError("DREAMING_JOB_ABORTED", true, {
      cause: error,
    });
  }
  if (error instanceof DreamingExecutionError) {
    return new AutomationJobExecutionError(error.code, error.retryable, {
      cause: error,
    });
  }
  return new AutomationJobExecutionError("DREAMING_JOB_FAILED", true, {
    cause: error,
  });
}

function retryDelayMs(
  attemptCount: number,
  baseDelayMs: number,
  maximumDelayMs: number,
): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(maximumDelayMs, baseDelayMs * 2 ** exponent);
}

interface LeaseMonitor {
  readonly stop: () => Promise<void>;
  readonly state: {
    currentClaim: ClaimedAutomationJob;
    lost: boolean;
  };
}

interface HeartbeatMonitor {
  readonly stop: () => Promise<void>;
}

function startHeartbeatMonitor(
  dependencies: Pick<
    AutomationWorkerDependencies,
    "automationStore" | "logger" | "now" | "wait" | "workerId" | "workerVersion"
  >,
  input: {
    readonly intervalMs: number;
    readonly parentSignal: AbortSignal;
    readonly startedAt: string;
  },
): HeartbeatMonitor {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.parentSignal, controller.signal]);
  const logger = dependencies.logger ?? silentLogger;
  const now = dependencies.now ?? (() => new Date());
  const wait = dependencies.wait ?? defaultWait;
  const version = dependencies.workerVersion ?? "unknown";

  async function record(): Promise<void> {
    try {
      await dependencies.automationStore.recordHeartbeat(
        dependencies.workerId,
        {
          version,
          startedAt: input.startedAt,
          lastSeenAt: now().toISOString(),
        },
        signal,
      );
    } catch {
      if (!signal.aborted) {
        logger.error(
          workerContext(
            "heartbeat_failed",
            dependencies.workerId,
            "WORKER_HEARTBEAT_FAILED",
          ),
        );
      }
    }
  }

  const task = (async () => {
    await record();
    while (!signal.aborted) {
      try {
        await wait(input.intervalMs, signal);
      } catch {
        if (!signal.aborted) {
          logger.error(
            workerContext(
              "heartbeat_failed",
              dependencies.workerId,
              "WORKER_HEARTBEAT_WAIT_FAILED",
            ),
          );
        }
        return;
      }
      if (!signal.aborted) await record();
    }
  })();

  return {
    async stop() {
      controller.abort("heartbeat-monitor-stopped");
      await task;
    },
  };
}

function startLeaseMonitor(
  initialClaim: ClaimedAutomationJob,
  dependencies: Pick<
    AutomationWorkerDependencies,
    "automationStore" | "now" | "wait"
  >,
  input: {
    readonly leaseSeconds: number;
    readonly renewalIntervalMs: number;
    readonly jobController: AbortController;
    readonly parentSignal: AbortSignal;
  },
): LeaseMonitor {
  const controller = new AbortController();
  const state = { currentClaim: initialClaim, lost: false };
  const signal = AbortSignal.any([input.parentSignal, controller.signal]);
  const wait = dependencies.wait ?? defaultWait;
  const now = dependencies.now ?? (() => new Date());

  const task = (async () => {
    while (!signal.aborted) {
      try {
        await wait(input.renewalIntervalMs, signal);
      } catch {
        if (!signal.aborted) {
          state.lost = true;
          input.jobController.abort("lease-monitor-failed");
        }
        return;
      }
      if (signal.aborted) return;
      try {
        const renewed = await dependencies.automationStore.renewLease(
          state.currentClaim,
          { now: now().toISOString(), leaseSeconds: input.leaseSeconds },
          signal,
        );
        if (!renewed) {
          state.lost = true;
          input.jobController.abort("lease-lost");
          return;
        }
        state.currentClaim = renewed;
      } catch {
        state.lost = true;
        input.jobController.abort("lease-renewal-failed");
        return;
      }
    }
  })();

  return {
    state,
    async stop() {
      controller.abort("lease-monitor-stopped");
      await task;
    },
  };
}

/** The nightly review: claim its run, produce the report, check the report is the run's own. */
function createDreamingJobRunner(
  dependencies: Pick<AutomationWorkerDependencies, "automationStore" | "dreamingRunner" | "dreamingStore" | "workerId">,
  catchUpLimit: number,
): JobRunner {
  return {
    async materialize(now, signal) {
      await dependencies.automationStore.materializeDueDreamingRuns(
        dependencies.workerId,
        { now: now.toISOString(), catchUpLimit },
        signal,
      );
    },
    async run(claim, context) {
      const dreamingClaim = await dependencies.dreamingStore.claimRun(
        context.workerId,
        {
          automationJobId: claim.job.id,
          now: context.now,
          leaseSeconds: context.leaseSeconds,
        },
        context.signal,
      );
      if (!dreamingClaim) {
        throw new AutomationJobExecutionError("DREAMING_RUN_UNAVAILABLE", true);
      }
      const report = await dependencies.dreamingRunner.runDaily(dreamingClaim, context.signal);
      if (
        report.runId !== dreamingClaim.run.id ||
        report.localDate !== dreamingClaim.run.localDate
      ) {
        throw new AutomationJobExecutionError("JOB_REPORT_INTEGRITY_FAILED", false);
      }
    },
  };
}

function adaptReminderDispatcher(
  reminders: NonNullable<AutomationWorkerDependencies["reminders"]>,
): JobRunner {
  return {
    materialize: (now, signal) => reminders.materialize(now, signal),
    run: (claim, context) => reminders.run(claim, context.signal),
  };
}

export function createAutomationWorker(
  dependencies: AutomationWorkerDependencies,
): AutomationWorkerService {
  const now = dependencies.now ?? (() => new Date());
  const wait = dependencies.wait ?? defaultWait;
  const logger = dependencies.logger ?? silentLogger;
  const options = {
    catchUpLimit: dependencies.options?.catchUpLimit ?? 3,
    heartbeatIntervalMs: dependencies.options?.heartbeatIntervalMs ?? 30_000,
    leaseSeconds: dependencies.options?.leaseSeconds ?? 300,
    leaseRenewalIntervalMs:
      dependencies.options?.leaseRenewalIntervalMs ?? 60_000,
    maximumAttempts: dependencies.options?.maximumAttempts ?? 5,
    pollIntervalMs: dependencies.options?.pollIntervalMs ?? 10_000,
    retryBaseDelayMs: dependencies.options?.retryBaseDelayMs ?? 30_000,
    retryMaximumDelayMs: dependencies.options?.retryMaximumDelayMs ?? 3_600_000,
  };
  if (
    dependencies.workerId.trim() === "" ||
    dependencies.workerId.length > 500 ||
    !Number.isInteger(options.catchUpLimit) ||
    options.catchUpLimit <= 0 ||
    !Number.isInteger(options.heartbeatIntervalMs) ||
    options.heartbeatIntervalMs <= 0 ||
    !Number.isInteger(options.leaseSeconds) ||
    options.leaseSeconds <= 0 ||
    !Number.isInteger(options.leaseRenewalIntervalMs) ||
    options.leaseRenewalIntervalMs <= 0 ||
    options.leaseRenewalIntervalMs >= options.leaseSeconds * 1_000 ||
    !Number.isInteger(options.maximumAttempts) ||
    options.maximumAttempts <= 0 ||
    !Number.isInteger(options.pollIntervalMs) ||
    options.pollIntervalMs <= 0 ||
    !Number.isInteger(options.retryBaseDelayMs) ||
    options.retryBaseDelayMs <= 0 ||
    !Number.isInteger(options.retryMaximumDelayMs) ||
    options.retryMaximumDelayMs < options.retryBaseDelayMs
  ) {
    throw new TypeError("Automation worker configuration is invalid.");
  }
  if (
    dependencies.workerVersion !== undefined &&
    (dependencies.workerVersion.trim() === "" ||
      dependencies.workerVersion.length > 100)
  ) {
    throw new TypeError("Automation worker configuration is invalid.");
  }
  const registry: AutomationRunnerRegistry = {
    daily_dreaming: createDreamingJobRunner(dependencies, options.catchUpLimit),
    ...(dependencies.reminders === undefined
      ? {}
      : { reminder_delivery: adaptReminderDispatcher(dependencies.reminders) }),
    ...dependencies.runners,
  };
  const registeredKinds = automationJobKinds.filter((kind) => registry[kind] !== undefined);
  const claimableKinds = registeredKinds as unknown as readonly [AutomationJobKind, ...AutomationJobKind[]];
  if (registeredKinds.length === 0) {
    throw new TypeError("Automation worker configuration is invalid.");
  }
  const closeController = new AbortController();

  function jobContext(claim: ClaimedAutomationJob, code?: string) {
    return {
      workerId: dependencies.workerId,
      jobId: claim.job.id,
      kind: claim.job.kind,
      attemptCount: claim.job.attemptCount,
      ...(code === undefined ? {} : { code }),
    } as const;
  }

  async function finishFailure(
    claim: ClaimedAutomationJob,
    error: AutomationJobExecutionError,
  ): Promise<void> {
    const cleanupSignal = new AbortController().signal;
    const context = jobContext(claim, error.code);
    try {
      if (error.retryable && claim.job.attemptCount < options.maximumAttempts) {
        const delay = retryDelayMs(
          claim.job.attemptCount,
          options.retryBaseDelayMs,
          options.retryMaximumDelayMs,
        );
        const nextAttemptAt = new Date(
          now().getTime() + Math.max(delay, error.retryAfterMs),
        ).toISOString();
        const retried = await dependencies.automationStore.retryJob(
          claim,
          { nextAttemptAt, sanitizedError: error.code },
          cleanupSignal,
        );
        if (retried) logger.info({ ...context, event: "job_retry_scheduled" });
        else logger.error({ ...context, event: "job_lease_lost" });
        return;
      }
      const failed = await dependencies.automationStore.failJob(
        claim,
        { sanitizedError: error.code },
        cleanupSignal,
      );
      logger.error({
        ...context,
        event: failed ? "job_failed" : "job_lease_lost",
      });
    } catch {
      logger.error({
        ...context,
        event: "job_state_update_failed",
        code: "WORKER_STORE_FAILED",
      });
    }
  }

  /** A cancellation is an outcome, not a failure: no retry, one durable state change. */
  async function finishCancellation(claim: ClaimedAutomationJob): Promise<void> {
    const cleanupSignal = new AbortController().signal;
    const context = jobContext(claim, "JOB_CANCELED");
    try {
      const canceled = await dependencies.automationStore.cancelJob(claim, cleanupSignal);
      if (canceled) logger.info({ ...context, event: "job_canceled" });
      else logger.error({ ...context, event: "job_lease_lost" });
    } catch {
      logger.error({
        ...context,
        event: "job_state_update_failed",
        code: "WORKER_STORE_FAILED",
      });
    }
  }

  async function runOnce(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || closeController.signal.aborted) return false;
    const lifecycleSignal = AbortSignal.any([signal, closeController.signal]);
    const currentTime = now().toISOString();
    for (const kind of registeredKinds) {
      await registry[kind]?.materialize?.(new Date(currentTime), lifecycleSignal);
      if (lifecycleSignal.aborted) return false;
    }

    const claimed = await dependencies.automationStore.claimNextJob(
      dependencies.workerId,
      {
        now: currentTime,
        leaseSeconds: options.leaseSeconds,
        kinds: claimableKinds,
      },
      lifecycleSignal,
    );
    if (!claimed) return false;

    logger.info({ ...jobContext(claimed), event: "job_started" });

    const jobController = new AbortController();
    const jobSignal = AbortSignal.any([lifecycleSignal, jobController.signal]);
    const monitor = startLeaseMonitor(
      claimed,
      {
        automationStore: dependencies.automationStore,
        now,
        wait,
      },
      {
        leaseSeconds: options.leaseSeconds,
        renewalIntervalMs: options.leaseRenewalIntervalMs,
        jobController,
        parentSignal: lifecycleSignal,
      },
    );

    try {
      const runner = registry[claimed.job.kind];
      if (runner === undefined) {
        throw new AutomationJobExecutionError("JOB_KIND_UNSUPPORTED", false);
      }
      if (claimed.job.cancelRequestedAt !== null) {
        throw new AutomationJobCanceledError();
      }
      await runner.run(claimed, {
        signal: jobSignal,
        workerId: dependencies.workerId,
        now: currentTime,
        leaseSeconds: options.leaseSeconds,
        logger,
        async checkCancelled() {
          if (
            await dependencies.automationStore.cancelRequested(
              monitor.state.currentClaim,
              jobSignal,
            )
          ) {
            throw new AutomationJobCanceledError();
          }
        },
      });
      await monitor.stop();
      if (monitor.state.lost) {
        logger.error({ ...jobContext(claimed), event: "job_lease_lost" });
        return true;
      }
      const completed = await dependencies.automationStore.completeJob(
        monitor.state.currentClaim,
        lifecycleSignal,
      );
      if (!completed) {
        logger.error({ ...jobContext(claimed), event: "job_lease_lost" });
        return true;
      }
      logger.info({ ...jobContext(claimed), event: "job_completed" });
      return true;
    } catch (error) {
      await monitor.stop();
      if (monitor.state.lost) {
        logger.error({ ...jobContext(claimed), event: "job_lease_lost" });
        return true;
      }
      const failure = safeError(error, lifecycleSignal);
      if (failure instanceof AutomationJobCanceledError) {
        await finishCancellation(monitor.state.currentClaim);
        return true;
      }
      await finishFailure(monitor.state.currentClaim, failure);
      return true;
    }
  }

  return {
    runOnce,
    async run(signal) {
      const lifecycleSignal = AbortSignal.any([signal, closeController.signal]);
      const startedAt = now().toISOString();
      const heartbeat = startHeartbeatMonitor(dependencies, {
        intervalMs: options.heartbeatIntervalMs,
        parentSignal: lifecycleSignal,
        startedAt,
      });
      logger.info(workerContext("worker_started", dependencies.workerId));
      try {
        while (!lifecycleSignal.aborted) {
          let worked = false;
          try {
            worked = await runOnce(lifecycleSignal);
          } catch {
            if (lifecycleSignal.aborted) break;
            logger.error(
              workerContext(
                "worker_poll_failed",
                dependencies.workerId,
                "WORKER_STORE_FAILED",
              ),
            );
          }
          if (!worked && !lifecycleSignal.aborted) {
            try {
              await wait(options.pollIntervalMs, lifecycleSignal);
            } catch {
              if (!lifecycleSignal.aborted)
                throw new Error("automation-wait-failed");
            }
          }
        }
      } finally {
        await heartbeat.stop();
        logger.info(workerContext("worker_stopped", dependencies.workerId));
      }
    },
    async close() {
      closeController.abort("worker-closed");
    },
  };
}
