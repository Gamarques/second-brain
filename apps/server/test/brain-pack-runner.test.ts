import { describe, expect, it, vi } from "vitest";

import type {
  BrainPackImportReceipt,
  BrainPackImportWork,
  BrainPackRunRecord,
  ClaimedAutomationJob,
} from "@second-brain/engine/domain";
import { BrainPackError } from "@second-brain/engine/domain/brain-pack";
import {
  brainPackImportRunIdOf,
  createBrainPackImportRunner,
} from "../src/services/automation/brain-pack-runner.js";
import {
  AutomationJobCanceledError,
  AutomationJobExecutionError,
  type JobRunContext,
} from "../src/services/automation/worker.js";

const runId = "00000000-0000-4000-8000-000000000201";
const jobId = "00000000-0000-4000-8000-000000000202";
const fencingToken = "00000000-0000-4000-8000-000000000203";
const now = new Date("2026-09-07T12:00:00.000Z");

function claim(canonicalKey = `brain-pack-import:${runId}`): ClaimedAutomationJob {
  return {
    workerId: "worker-1",
    fencingToken,
    job: {
      id: jobId,
      kind: "brain_pack_import",
      canonicalKey,
      scheduledFor: now.toISOString(),
      status: "running",
      attemptCount: 1,
      nextAttemptAt: null,
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date(now.getTime() + 300_000).toISOString(),
      fencingToken,
      cancelRequestedAt: null,
      sanitizedError: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  };
}

function context(overrides: Partial<JobRunContext> = {}): JobRunContext {
  return {
    signal: new AbortController().signal,
    workerId: "worker-1",
    now: now.toISOString(),
    leaseSeconds: 300,
    logger: { info() {}, error() {} },
    checkCancelled: async () => {},
    ...overrides,
  };
}

function work(status: BrainPackRunRecord["status"]): BrainPackImportWork {
  return { run: { status } as BrainPackRunRecord, items: [] };
}

const receipt = {
  runId,
  packId: "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60",
  packRevision: 1,
  publishedAt: now.toISOString(),
  created: [],
  updated: [],
  skipped: [],
  excluded: [],
} satisfies BrainPackImportReceipt;

function setup(
  overrides: {
    status?: BrainPackRunRecord["status"] | null;
    index?: () => Promise<void>;
    publish?: () => Promise<BrainPackImportReceipt | null>;
  } = {},
) {
  const index = vi.fn(overrides.index ?? (async () => {}));
  const publish = vi.fn(overrides.publish ?? (async () => receipt));
  const expire = vi.fn(async () => 0);
  const loadImportWork = vi.fn(async () => (overrides.status === null ? null : work(overrides.status ?? "indexing")));
  const runner = createBrainPackImportRunner({
    service: { index, publish },
    runs: { loadImportWork },
    artifacts: { expire },
    housekeepingIntervalMs: 60_000,
  });
  return { runner, index, publish, expire, loadImportWork };
}

describe("brainPackImportRunIdOf", () => {
  it("reads the run from the job's canonical key and rejects anything else", () => {
    expect(brainPackImportRunIdOf(claim().job)).toBe(runId);
    expect(brainPackImportRunIdOf(claim("brain-pack-import:not-a-uuid").job)).toBeNull();
    expect(brainPackImportRunIdOf(claim(`daily-dreaming:${runId}`).job)).toBeNull();
  });
});

describe("brain_pack_import runner", () => {
  it("indexes, then publishes under the job's fence", async () => {
    const { runner, index, publish } = setup();
    const ctx = context();

    await runner.run(claim(), ctx);

    expect(index).toHaveBeenCalledWith(runId, { signal: ctx.signal, checkCancelled: ctx.checkCancelled });
    expect(publish).toHaveBeenCalledWith(runId, { signal: ctx.signal, fence: { jobId, fencingToken } });
    expect(index.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0]!);
  });

  it("fails a job whose key names no run, without retrying", async () => {
    const { runner, index } = setup();

    await expect(runner.run(claim("brain-pack-import:nope"), context())).rejects.toMatchObject({
      code: "BRAIN_PACK_JOB_INVALID",
      retryable: false,
    });
    expect(index).not.toHaveBeenCalled();
  });

  it("lets a cancellation through untouched so the worker records it as canceled", async () => {
    const canceled = new AutomationJobCanceledError();
    const { runner, publish } = setup({
      index: async () => {
        throw canceled;
      },
    });

    await expect(runner.run(claim(), context())).rejects.toBe(canceled);
    expect(publish).not.toHaveBeenCalled();
  });

  it("checks for cancellation between the two stages", async () => {
    const { runner, index, publish } = setup();
    const checkCancelled = vi.fn<() => Promise<void>>().mockRejectedValue(new AutomationJobCanceledError());

    await expect(runner.run(claim(), context({ checkCancelled }))).rejects.toBeInstanceOf(AutomationJobCanceledError);
    expect(index).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("ends the job as canceled when publication reports that cancellation arrived first", async () => {
    const { runner } = setup({ publish: async () => null });

    await expect(runner.run(claim(), context())).rejects.toBeInstanceOf(AutomationJobCanceledError);
  });

  it("turns a typed pack error into a non-retryable failure carrying its code", async () => {
    const { runner } = setup({
      status: "failed",
      index: async () => {
        throw new BrainPackError("PACK_LIMIT_EXCEEDED", "Too big.");
      },
    });

    await expect(runner.run(claim(), context())).rejects.toMatchObject({ code: "PACK_LIMIT_EXCEEDED", retryable: false });
  });

  it("does not retry once the service has marked the run failed", async () => {
    const { runner, loadImportWork } = setup({
      status: "failed",
      publish: async () => {
        throw new Error("provider exploded");
      },
    });

    await expect(runner.run(claim(), context())).rejects.toMatchObject({ code: "BRAIN_PACK_IMPORT_FAILED", retryable: false });
    expect(loadImportWork).toHaveBeenCalledWith(runId, expect.any(AbortSignal));
  });

  it("retries an error that struck before the service touched the run", async () => {
    const { runner } = setup({
      status: "indexing",
      index: async () => {
        throw new Error("connection reset");
      },
    });

    await expect(runner.run(claim(), context())).rejects.toMatchObject({ code: "BRAIN_PACK_IMPORT_FAILED", retryable: true });
  });

  it("fails without retry when the run no longer exists", async () => {
    const { runner } = setup({
      status: null,
      index: async () => {
        throw new Error("gone");
      },
    });

    await expect(runner.run(claim(), context())).rejects.toMatchObject({ code: "BRAIN_PACK_RUN_MISSING", retryable: false });
  });

  it("passes worker errors through unchanged", async () => {
    const original = new AutomationJobExecutionError("SOMETHING_ELSE", true);
    const { runner } = setup({
      index: async () => {
        throw original;
      },
    });

    await expect(runner.run(claim(), context())).rejects.toBe(original);
  });

  it("expires artifacts on a bounded housekeeping interval and survives a failing sweep", async () => {
    const expire = vi
      .fn<(now: string, signal?: AbortSignal) => Promise<number>>()
      .mockRejectedValueOnce(new Error("db away"))
      .mockResolvedValue(2);
    const runner = createBrainPackImportRunner({
      service: { index: async () => {}, publish: async () => receipt },
      runs: { loadImportWork: async () => null },
      artifacts: { expire },
      housekeepingIntervalMs: 60_000,
    });
    const signal = new AbortController().signal;

    await runner.materialize!(now, signal);
    await runner.materialize!(new Date(now.getTime() + 30_000), signal);
    await runner.materialize!(new Date(now.getTime() + 61_000), signal);
    await runner.materialize!(new Date(now.getTime() + 90_000), signal);

    expect(expire.mock.calls.map(([at]) => at)).toEqual([now.toISOString(), new Date(now.getTime() + 61_000).toISOString()]);
  });
});
