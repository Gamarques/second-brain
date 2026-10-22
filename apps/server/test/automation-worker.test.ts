import { createReminderDispatcher } from "../src/services/automation/reminder-runner.js";
import { NotificationError } from "@second-brain/engine/domain/notifications";
import { describe, expect, it, vi } from "vitest";

import {
  AutomationJobExecutionError,
  createAutomationWorker,
  type AutomationRunnerRegistry,
  type AutomationWorkerLogger,
} from "../src/services/automation/worker.js";
import type {
  AutomationJob,
  AutomationStore,
  ClaimedAutomationJob,
  ClaimedDreamingRun,
  DreamingReport,
  DreamingRunner,
  DreamingStore,
} from "@second-brain/engine/domain";

const jobId = "00000000-0000-4000-8000-000000000102";
const runId = "00000000-0000-4000-8000-000000000103";

function job(attemptCount = 1): AutomationJob {
  return {
    id: jobId,
    kind: "daily_dreaming",
    canonicalKey: "daily-dreaming:2026-08-15",
    scheduledFor: "2026-08-16T06:00:00.000Z",
    status: "running",
    attemptCount,
    nextAttemptAt: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-08-16T06:05:00.000Z",
    fencingToken: "00000000-0000-4000-8000-000000000104",
    cancelRequestedAt: null,
    sanitizedError: null,
    createdAt: "2026-08-16T06:00:00.000Z",
    updatedAt: "2026-08-16T06:00:00.000Z",
  };
}

function claimedJob(attemptCount = 1): ClaimedAutomationJob {
  const value = job(attemptCount);
  return {
    job: value,
    workerId: "worker-1",
    fencingToken: value.fencingToken!,
  };
}

function dreamingClaim(): ClaimedDreamingRun {
  return {
    run: {
      id: runId,
      localDate: "2026-08-15",
      timeZone: "America/Sao_Paulo",
      windowStart: "2026-08-15T03:00:00.000Z",
      windowEnd: "2026-08-16T03:00:00.000Z",
      mode: "apply",
      status: "collecting",
      pipelineVersion: "dreaming-v1",
      promptVersion: "dreaming-plan-v1",
      schemaVersion: "dreaming-plan-v1",
      policyVersion: "dreaming-policy-v1",
      snapshotHash: null,
      snapshotTruncated: false,
      provider: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      attemptCount: 1,
      createdAt: "2026-08-16T06:00:00.000Z",
      startedAt: "2026-08-16T06:00:00.000Z",
      completedAt: null,
    },
    fencingToken: "00000000-0000-4000-8000-000000000105",
    leaseExpiresAt: "2026-08-16T06:05:00.000Z",
    provenance: {
      kind: "dreaming",
      accountId: null,
      clientId: null,
      source: "automation",
      requestId: "dreaming:2026-08-15",
      correlationId: runId,
      causationId: jobId,
      dreamingRunId: runId,
    },
  };
}

function dreamingReport(): DreamingReport {
  return {
    id: "00000000-0000-4000-8000-000000000107",
    runId,
    localDate: "2026-08-15",
    generatedAt: "2026-08-16T06:01:00.000Z",
    mode: "apply",
    status: "completed",
    summary: "One memory was consolidated.",
    insights: [],
    memoriesCreated: [],
    memoriesUpdated: [],
    skipped: [],
    coverageWarnings: [],
  };
}

function createSubject(options: {
  reminders?: ReturnType<typeof createReminderDispatcher>;
  attemptCount?: number;
  runDaily?: DreamingRunner["runDaily"];
  renewLease?: AutomationStore["renewLease"];
  cancelRequested?: AutomationStore["cancelRequested"];
  cancelRequestedAt?: string | null;
  runners?: AutomationRunnerRegistry;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
} = {}) {
  const original = claimedJob(options.attemptCount);
  const flagged = options.cancelRequestedAt === undefined ? original : { ...original, job: { ...original.job, cancelRequestedAt: options.cancelRequestedAt } };
  const claimed = options.reminders ? { ...flagged, job: { ...flagged.job, kind: "reminder_delivery" as const } } : flagged;
  const automationStore: AutomationStore = {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    materializeDueDreamingRuns: vi.fn(async () => [claimed.job]),
    claimNextJob: vi.fn(async () => claimed),
    renewLease: vi.fn(options.renewLease ?? (async (current) => current)),
    completeJob: vi.fn(async () => true),
    retryJob: vi.fn(async () => true),
    failJob: vi.fn(async () => true),
    cancelJob: vi.fn(async () => true),
    cancelRequested: vi.fn(options.cancelRequested ?? (async () => false)),
    requestCancel: vi.fn(async () => null),
    recordHeartbeat: vi.fn(async (workerId, input) => ({ workerId, ...input })),
  };
  const claim = dreamingClaim();
  const dreamingStore = {
    claimRun: vi.fn(async () => claim),
  } as unknown as DreamingStore;
  const dreamingRunner: DreamingRunner = {
    runDaily: vi.fn(options.runDaily ?? (async () => dreamingReport())),
  };
  const logger: AutomationWorkerLogger = {
    info: vi.fn(),
    error: vi.fn(),
  };
  const worker = createAutomationWorker({
    workerId: "worker-1",
    ...(options.reminders ? { reminders: options.reminders } : {}),
    ...(options.runners ? { runners: options.runners } : {}),
    automationStore,
    dreamingStore,
    dreamingRunner,
    now: () => new Date("2026-08-16T06:00:00.000Z"),
    wait:
      options.wait ??
      (async (_milliseconds, signal) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }),
    logger,
  });
  return { automationStore, dreamingRunner, dreamingStore, logger, worker };
}

describe("automation worker", () => {
  it("materializes, claims, runs, and completes one daily dreaming job", async () => {
    const subject = createSubject();

    await expect(subject.worker.runOnce(new AbortController().signal)).resolves.toBe(true);

    expect(subject.automationStore.materializeDueDreamingRuns).toHaveBeenCalledWith(
      "worker-1",
      { now: "2026-08-16T06:00:00.000Z", catchUpLimit: 3 },
      expect.any(AbortSignal),
    );
    expect(subject.dreamingStore.claimRun).toHaveBeenCalledTimes(1);
    expect(subject.dreamingStore.claimRun).toHaveBeenCalledWith(
      "worker-1",
      {
        automationJobId: jobId,
        now: "2026-08-16T06:00:00.000Z",
        leaseSeconds: 300,
      },
      expect.any(AbortSignal),
    );
    expect(subject.dreamingRunner.runDaily).toHaveBeenCalledTimes(1);
    expect(subject.automationStore.completeJob).toHaveBeenCalledTimes(1);
    expect(subject.automationStore.claimNextJob).toHaveBeenCalledWith(
      "worker-1",
      {
        now: "2026-08-16T06:00:00.000Z",
        leaseSeconds: 300,
        kinds: ["daily_dreaming"],
      },
      expect.any(AbortSignal),
    );
  });

  it("uses exponential retry with a stable error code and never persists raw content", async () => {
    const secret = "private memory text";
    const subject = createSubject({
      attemptCount: 2,
      runDaily: async () => {
        throw new Error(secret);
      },
    });

    await expect(subject.worker.runOnce(new AbortController().signal)).resolves.toBe(true);

    expect(subject.automationStore.retryJob).toHaveBeenCalledWith(
      expect.anything(),
      {
        nextAttemptAt: "2026-08-16T06:01:00.000Z",
        sanitizedError: "DREAMING_JOB_FAILED",
      },
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(vi.mocked(subject.logger.error).mock.calls)).not.toContain(secret);
  });

  it("permanently fails a job after the bounded attempt limit", async () => {
    const subject = createSubject({
      attemptCount: 5,
      runDaily: async () => {
        throw new AutomationJobExecutionError("DREAMING_JOB_FAILED", true);
      },
    });

    await subject.worker.runOnce(new AbortController().signal);

    expect(subject.automationStore.retryJob).not.toHaveBeenCalled();
    expect(subject.automationStore.failJob).toHaveBeenCalledWith(
      expect.anything(),
      { sanitizedError: "DREAMING_JOB_FAILED" },
      expect.any(AbortSignal),
    );
  });

  it("logs a sanitized contextual event when retry state cannot be persisted", async () => {
    const secret = "database response with private memory text";
    const subject = createSubject({
      runDaily: async () => {
        throw new AutomationJobExecutionError("DREAMING_PROVIDER_FAILED", true);
      },
    });
    vi.mocked(subject.automationStore.retryJob).mockRejectedValueOnce(
      new Error(secret),
    );

    await expect(subject.worker.runOnce(new AbortController().signal)).resolves.toBe(true);

    expect(subject.logger.error).toHaveBeenCalledWith({
      event: "job_state_update_failed",
      workerId: "worker-1",
      jobId,
      kind: "daily_dreaming",
      attemptCount: 1,
      code: "WORKER_STORE_FAILED",
    });
    expect(JSON.stringify(vi.mocked(subject.logger.error).mock.calls)).not.toContain(secret);
  });

  it("does not complete or retry after losing the job lease", async () => {
    let releaseRun!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let waitCount = 0;
    const subject = createSubject({
      runDaily: async (_claim, signal) => {
        releaseRun();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new AutomationJobExecutionError("DREAMING_JOB_ABORTED", true);
      },
      renewLease: async () => null,
      wait: async () => {
        waitCount += 1;
        if (waitCount === 1) await runStarted;
      },
    });

    await subject.worker.runOnce(new AbortController().signal);

    expect(subject.automationStore.renewLease).toHaveBeenCalledTimes(1);
    expect(subject.automationStore.completeJob).not.toHaveBeenCalled();
    expect(subject.automationStore.retryJob).not.toHaveBeenCalled();
    expect(subject.automationStore.failJob).not.toHaveBeenCalled();
  });

  it("does no work when shutdown was already requested", async () => {
    const subject = createSubject();
    const controller = new AbortController();
    controller.abort();

    await expect(subject.worker.runOnce(controller.signal)).resolves.toBe(false);

    expect(subject.automationStore.materializeDueDreamingRuns).not.toHaveBeenCalled();
  });

  it("records liveness immediately and periodically until the run loop stops", async () => {
    const heartbeatWaits: (() => void)[] = [];
    const automationStore: AutomationStore = {
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      materializeDueDreamingRuns: vi.fn(async () => []),
      claimNextJob: vi.fn(async () => null),
      renewLease: vi.fn(),
      completeJob: vi.fn(),
      retryJob: vi.fn(),
      failJob: vi.fn(),
      cancelJob: vi.fn(),
      cancelRequested: vi.fn(async () => false),
      requestCancel: vi.fn(async () => null),
      recordHeartbeat: vi.fn(async (workerId, input) => ({ workerId, ...input })),
    };
    const logger: AutomationWorkerLogger = { info: vi.fn(), error: vi.fn() };
    const controller = new AbortController();
    const worker = createAutomationWorker({
      workerId: "worker-1",
      workerVersion: "1.2.0",
      automationStore,
      dreamingStore: {} as DreamingStore,
      dreamingRunner: {} as DreamingRunner,
      now: () => new Date("2026-08-16T06:00:00.000Z"),
      wait: async (milliseconds, signal) => {
        if (milliseconds === 30_000) {
          await new Promise<void>((resolve) => {
            heartbeatWaits.push(resolve);
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      logger,
      options: { heartbeatIntervalMs: 30_000 },
    });

    const running = worker.run(controller.signal);
    await vi.waitFor(() => {
      expect(automationStore.recordHeartbeat).toHaveBeenCalledTimes(1);
      expect(heartbeatWaits).toHaveLength(1);
    });
    heartbeatWaits.shift()?.();
    await vi.waitFor(() => {
      expect(automationStore.recordHeartbeat).toHaveBeenCalledTimes(2);
    });
    controller.abort();
    await running;

    expect(automationStore.recordHeartbeat).toHaveBeenNthCalledWith(
      1,
      "worker-1",
      {
        version: "1.2.0",
        startedAt: "2026-08-16T06:00:00.000Z",
        lastSeenAt: "2026-08-16T06:00:00.000Z",
      },
      expect.any(AbortSignal),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "worker_started", workerId: "worker-1" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "worker_stopped", workerId: "worker-1" }),
    );
  });

  it("keeps polling after a heartbeat write fails and logs only a stable code", async () => {
    const secret = "database response with private memory text";
    const controller = new AbortController();
    const subject = createSubject();
    vi.mocked(subject.automationStore.recordHeartbeat).mockRejectedValueOnce(
      new Error(secret),
    );
    vi.mocked(subject.automationStore.claimNextJob).mockResolvedValue(null);

    const running = subject.worker.run(controller.signal);
    await vi.waitFor(() => {
      expect(subject.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "heartbeat_failed",
          code: "WORKER_HEARTBEAT_FAILED",
        }),
      );
      expect(subject.automationStore.materializeDueDreamingRuns).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    await running;

    expect(JSON.stringify(vi.mocked(subject.logger.error).mock.calls)).not.toContain(secret);
  });
});

it("dispatches reminders through the worker and honors the provider retry delay", async () => {
 const store = {materialize: vi.fn(async()=>undefined),prepare:vi.fn(async()=>({deliveryId:jobId,config:{kind:"telegram" as const,token:"123:synthetic",destination:"42"},message:"Review proposal"})),finish:vi.fn(async()=>true)};
 const provider={verify:vi.fn(),send:vi.fn(async()=>{throw new NotificationError("retry","NOTIFICATION_RATE_LIMITED",67);})};
 const subject=createSubject({reminders:createReminderDispatcher(store,provider)});
 await subject.worker.runOnce(new AbortController().signal);
 expect(subject.automationStore.claimNextJob).toHaveBeenCalledWith("worker-1",expect.objectContaining({kinds:["daily_dreaming","reminder_delivery"]}),expect.any(AbortSignal));
 expect(subject.dreamingRunner.runDaily).not.toHaveBeenCalled();
 expect(store.finish).toHaveBeenCalledWith(expect.anything(),{status:"retry_wait",errorCode:"NOTIFICATION_RATE_LIMITED"},expect.any(AbortSignal));
 expect(subject.automationStore.retryJob).toHaveBeenCalledWith(expect.anything(),{nextAttemptAt:"2026-08-16T06:01:07.000Z",sanitizedError:"NOTIFICATION_RATE_LIMITED"},expect.any(AbortSignal));
});
it("records ambiguous reminder outcomes as terminal and never sends suppressed work",async()=>{
 const store={materialize:vi.fn(async()=>undefined),prepare:vi.fn(async()=>({deliveryId:jobId,config:{kind:"telegram" as const,token:"123:synthetic",destination:"42"},message:"Review proposal"})),finish:vi.fn(async()=>true)};
 const provider={verify:vi.fn(),send:vi.fn(async()=>{throw new NotificationError("uncertain","NOTIFICATION_DELIVERY_UNCERTAIN");})};
 const subject=createSubject({reminders:createReminderDispatcher(store,provider)});
 await subject.worker.runOnce(new AbortController().signal);
 expect(subject.automationStore.retryJob).not.toHaveBeenCalled();expect(subject.automationStore.failJob).toHaveBeenCalled();
 expect(store.finish).toHaveBeenCalledWith(expect.anything(),{status:"uncertain",errorCode:"NOTIFICATION_DELIVERY_UNCERTAIN"},expect.any(AbortSignal));
 const suppressed=createSubject({reminders:createReminderDispatcher({...store,prepare:vi.fn(async()=>null)},provider)});
 await suppressed.worker.runOnce(new AbortController().signal);expect(provider.send).toHaveBeenCalledTimes(1);expect(suppressed.automationStore.completeJob).toHaveBeenCalled();
});

describe("automation worker runner registry and cancellation", () => {
  it("claims only registered kinds and dispatches a registered runner with a cancellation check", async () => {
    const run = vi.fn(async (_claim: unknown, context: { checkCancelled(): Promise<void> }) => {
      await context.checkCancelled();
    });
    const subject = createSubject({ runners: { reminder_delivery: { run } } });
    // The fake store hands out a daily_dreaming claim; the registry must still ask for both kinds.
    await subject.worker.runOnce(new AbortController().signal);

    expect(subject.automationStore.claimNextJob).toHaveBeenCalledWith(
      "worker-1",
      expect.objectContaining({ kinds: ["daily_dreaming", "reminder_delivery"] }),
      expect.any(AbortSignal),
    );
    expect(subject.dreamingRunner.runDaily).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("finishes a job as canceled, without a retry, when a runner sees the cancellation request", async () => {
    const subject = createSubject({
      cancelRequested: async () => true,
      runDaily: async () => {
        throw new Error("the runner must not be reached once the claim is flagged");
      },
      cancelRequestedAt: "2026-08-16T06:00:30.000Z",
    });

    await expect(subject.worker.runOnce(new AbortController().signal)).resolves.toBe(true);

    expect(subject.automationStore.cancelJob).toHaveBeenCalledTimes(1);
    expect(subject.automationStore.retryJob).not.toHaveBeenCalled();
    expect(subject.automationStore.failJob).not.toHaveBeenCalled();
    expect(subject.dreamingRunner.runDaily).not.toHaveBeenCalled();
    expect(subject.logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "job_canceled", code: "JOB_CANCELED" }));
  });

  it("lets a runner stop at a stage boundary through checkCancelled", async () => {
    let asked = 0;
    const subject = createSubject({
      cancelRequested: async () => {
        asked += 1;
        return asked >= 2;
      },
      runners: {
        daily_dreaming: {
          async run(_claim, context) {
            await context.checkCancelled();
            await context.checkCancelled();
            throw new Error("unreachable: the second check must throw");
          },
        },
      },
    });

    await expect(subject.worker.runOnce(new AbortController().signal)).resolves.toBe(true);

    expect(asked).toBe(2);
    expect(subject.automationStore.cancelJob).toHaveBeenCalledTimes(1);
    expect(subject.automationStore.completeJob).not.toHaveBeenCalled();
    expect(subject.automationStore.failJob).not.toHaveBeenCalled();
  });
});
