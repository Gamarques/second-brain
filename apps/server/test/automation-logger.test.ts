import { describe, expect, it, vi } from "vitest";

import { createJsonAutomationWorkerLogger } from "../src/services/automation/logger.js";

describe("automation worker JSON logger", () => {
  it("writes one allowlisted JSON object per line to the matching stream", () => {
    const stdout = { write: vi.fn((_chunk: string) => true) };
    const stderr = { write: vi.fn((_chunk: string) => true) };
    const logger = createJsonAutomationWorkerLogger({
      now: () => new Date("2026-08-16T06:00:00.000Z"),
      stdout,
      stderr,
    });

    logger.info({
      event: "job_completed",
      workerId: "worker-1",
      jobId: "job-1",
      kind: "daily_dreaming",
      attemptCount: 2,
    });
    logger.error({
      event: "job_failed",
      workerId: "worker-1",
      jobId: "job-2",
      kind: "daily_dreaming",
      attemptCount: 5,
      code: "DREAMING_JOB_FAILED",
    });

    expect(stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        timestamp: "2026-08-16T06:00:00.000Z",
        level: "info",
        event: "job_completed",
        workerId: "worker-1",
        jobId: "job-1",
        kind: "daily_dreaming",
        attemptCount: 2,
      })}\n`,
    );
    expect(stderr.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        timestamp: "2026-08-16T06:00:00.000Z",
        level: "error",
        event: "job_failed",
        workerId: "worker-1",
        jobId: "job-2",
        kind: "daily_dreaming",
        attemptCount: 5,
        code: "DREAMING_JOB_FAILED",
      })}\n`,
    );
  });

  it("never accepts or serializes an error object or arbitrary context", () => {
    const secret = "private memory text";
    const stderr = { write: vi.fn((_chunk: string) => true) };
    const logger = createJsonAutomationWorkerLogger({
      now: () => new Date("2026-08-16T06:00:00.000Z"),
      stdout: { write: vi.fn((_chunk: string) => true) },
      stderr,
    });

    logger.error({
      event: "worker_poll_failed",
      workerId: "worker-1",
      jobId: "poll",
      kind: "worker_poll",
      attemptCount: 0,
      code: "WORKER_STORE_FAILED",
      error: new Error(secret),
      arbitrary: secret,
    } as never);

    const serialized = String(stderr.write.mock.calls[0]?.[0]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("stack");
    expect(JSON.parse(serialized)).toEqual({
      timestamp: "2026-08-16T06:00:00.000Z",
      level: "error",
      event: "worker_poll_failed",
      workerId: "worker-1",
      jobId: "poll",
      kind: "worker_poll",
      attemptCount: 0,
      code: "WORKER_STORE_FAILED",
    });
  });
});
