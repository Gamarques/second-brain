import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { composeSecondBrainRuntime } from "../src/runtime.js";
import { SECOND_BRAIN_VERSION } from "../src/version.js";
import { boundaryDependencies } from "./support/engine-dependencies.js";

describe("second-brain runtime lifecycle", () => {
  it("owns one engine and closes its pool exactly once", async () => {
    const pool = new Pool();
    const end = vi.spyOn(pool, "end").mockResolvedValue();
    const runtime = composeSecondBrainRuntime(pool, boundaryDependencies());

    expect(runtime.engine.version).toBe(SECOND_BRAIN_VERSION);
    expect(runtime.pool).toBe(pool);

    await Promise.all([runtime.close(), runtime.close(), runtime.close()]);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
