import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createDefaultSecondBrainEngine,
  engine,
} from "../src/engine.js";

interface PackageManifest {
  readonly scripts: Readonly<Record<string, string>>;
  readonly version: string;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

describe("conventional composition root", () => {
  it("serves the devtools scripts from the conventional engine module", () => {
    for (const name of ["devtools", "devtools:doctor"] as const) {
      expect(manifest.scripts[name], name).toMatch(
        /invokta-devtools (?:serve|doctor) dist\/engine\.js\b/u,
      );
    }
  });

  it("exports an engine value satisfying the devtools loader contract", () => {
    expect(engine.name).toBe("second-brain");
    expect(engine.version).toBe(manifest.version);
    expect(typeof engine.invoke).toBe("function");
    expect(typeof engine.list).toBe("function");
    expect(typeof engine.describe).toBe("function");
    expect(engine.list().length).toBeGreaterThan(0);
  });

  it("composes without configuration and performs no IO at construction", () => {
    const unconfigured = createDefaultSecondBrainEngine({});
    expect(unconfigured.name).toBe("second-brain");
    expect(unconfigured.list().map(({ id }) => id)).toEqual(
      engine.list().map(({ id }) => id),
    );
  });

  it("keeps the composed engine fail-closed for unauthenticated calls", async () => {
    await expect(
      engine.invoke("task_lists_list", {}, { principal: null }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
