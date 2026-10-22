import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { engine } from "../src/engine.js";

describe("Invokta engine project", () => {
  it("exports the conventional engine and mirrors its catalog in the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../invokta.mcp.json", import.meta.url), "utf8"),
    ) as {
      readonly id: string;
      readonly version: string;
      readonly capabilityIds: readonly string[];
    };

    expect(engine.name).toBe(manifest.id);
    expect(engine.version).toBe(manifest.version);
    expect(engine.list().map(({ id }) => id)).toEqual(manifest.capabilityIds);
  });

  it("uses real environment-composed dependencies instead of a catalog proxy", () => {
    const source = readFileSync(
      new URL("../src/engine.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("createDefaultSecondBrainEngine");
    expect(source).toContain("createDrizzleEngineDependencies");
    expect(source).not.toContain("catalogDependencies");
    expect(source).not.toContain("unavailableDependency");
  });
});
