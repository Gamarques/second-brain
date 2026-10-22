import { describe, expect, it, vi } from "vitest";

import { monitorEnvironmentRestart } from "../src/restart-monitor.js";

describe("environment restart monitor", () => {
  it("resolves only when a durable request is newer than the loaded revision", async () => {
    const readRestartRequestForRuntime = vi
      .fn()
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4);
    const monitor = monitorEnvironmentRestart(
      { readRestartRequestForRuntime },
      3,
      1,
    );

    await expect(monitor.requested).resolves.toBe(4);
    expect(readRestartRequestForRuntime).toHaveBeenCalledTimes(2);
  });

  it("retries transient read failures and can be closed", async () => {
    const readRestartRequestForRuntime = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(2);
    const monitor = monitorEnvironmentRestart(
      { readRestartRequestForRuntime },
      1,
      1,
    );
    await expect(monitor.requested).resolves.toBe(2);

    const pending = monitorEnvironmentRestart(
      { readRestartRequestForRuntime: vi.fn(async () => 2) },
      2,
      10,
    );
    pending.close();
    await expect(pending.requested).rejects.toMatchObject({ name: "AbortError" });
  });
});
