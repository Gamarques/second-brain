import type {
  AutomationJob,
  BrainPackArtifactStore,
  BrainPackImportService,
  BrainPackStore,
} from "@second-brain/engine/domain";
import { BrainPackError } from "@second-brain/engine/domain/brain-pack";

import {
  AutomationJobCanceledError,
  AutomationJobExecutionError,
  type JobRunner,
} from "./worker.js";

/** The engine store keys an import job as `brain-pack-import:<run id>`; the claim carries no payload. */
const importJobKeyPattern =
  /^brain-pack-import:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

/** How often, at most, a worker sweeps expired upload and export archives. */
export const defaultHousekeepingIntervalMs = 5 * 60 * 1_000;

export interface BrainPackImportRunnerDependencies {
  readonly service: BrainPackImportService;
  readonly runs: Pick<BrainPackStore, "loadImportWork">;
  readonly artifacts: Pick<BrainPackArtifactStore, "expire">;
  readonly housekeepingIntervalMs?: number;
}

export function brainPackImportRunIdOf(job: Pick<AutomationJob, "kind" | "canonicalKey">): string | null {
  if (job.kind !== "brain_pack_import") return null;
  const match = importJobKeyPattern.exec(job.canonicalKey);
  return match === null ? null : match[1]!.toLowerCase();
}

/**
 * Runs one queued import: index, then publish under the job's fence. The
 * import service records the run's own outcome (failed or canceled), so this
 * runner only decides what the job queue should do next:
 *
 * - a cancellation, from `checkCancelled` or from a publish that found the
 *   request first, ends the job as canceled;
 * - a typed pack error is deterministic and never retried;
 * - anything else is retried unless the service already marked the run
 *   failed (a retry would find nothing to index; the member resumes it with
 *   `knowledge_packs_runs_retry`) or the run no longer exists.
 */
export function createBrainPackImportRunner(
  dependencies: BrainPackImportRunnerDependencies,
): JobRunner {
  const interval = dependencies.housekeepingIntervalMs ?? defaultHousekeepingIntervalMs;
  if (!Number.isFinite(interval) || interval < 0) {
    throw new TypeError("housekeepingIntervalMs must be a non-negative number.");
  }
  let lastSweepAt: number | null = null;

  async function failure(error: unknown, runId: string, signal: AbortSignal): Promise<unknown> {
    if (error instanceof AutomationJobExecutionError) return error;
    if (signal.aborted) return error;
    if (error instanceof BrainPackError) {
      return new AutomationJobExecutionError(error.code, false, { cause: error });
    }
    let work: Awaited<ReturnType<BrainPackStore["loadImportWork"]>> | undefined;
    try {
      work = await dependencies.runs.loadImportWork(runId, signal);
    } catch {
      work = undefined;
    }
    if (work === undefined) {
      return new AutomationJobExecutionError("BRAIN_PACK_IMPORT_FAILED", true, { cause: error });
    }
    if (work === null) {
      return new AutomationJobExecutionError("BRAIN_PACK_RUN_MISSING", false, { cause: error });
    }
    return new AutomationJobExecutionError("BRAIN_PACK_IMPORT_FAILED", work.run.status !== "failed", {
      cause: error,
    });
  }

  return {
    async materialize(now, signal) {
      const at = now.getTime();
      if (lastSweepAt !== null && at - lastSweepAt < interval) return;
      lastSweepAt = at;
      try {
        await dependencies.artifacts.expire(now.toISOString(), signal);
      } catch {
        // A failed sweep must not keep the worker from claiming import work; the next interval tries again.
      }
    },
    async run(claim, context) {
      const runId = brainPackImportRunIdOf(claim.job);
      if (runId === null) {
        throw new AutomationJobExecutionError("BRAIN_PACK_JOB_INVALID", false);
      }
      const { signal, checkCancelled } = context;
      try {
        await dependencies.service.index(runId, { signal, checkCancelled });
        await checkCancelled();
        const receipt = await dependencies.service.publish(runId, {
          signal,
          fence: { jobId: claim.job.id, fencingToken: claim.fencingToken },
        });
        if (receipt === null) throw new AutomationJobCanceledError();
      } catch (error) {
        throw await failure(error, runId, signal);
      }
    },
  };
}
