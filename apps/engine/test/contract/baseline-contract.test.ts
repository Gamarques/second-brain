import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Frozen contract of everything released up to the baseline version.
 *
 * - A baseline capability may never disappear or be renamed (breaking change).
 * - An applied migration may never be edited (README: "never edit or regenerate").
 * New capabilities and new migrations are allowed; they only need their own tests.
 * To accept a deliberate breaking change, update the files in ./baseline.
 */
const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(here, "..", "..");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const baselineCapabilities = readJson<{ capabilityIds: string[] }>(
  join(here, "baseline", "capabilities.json"),
).capabilityIds;
const baselineMigrations = readJson<{ sha256: Record<string, string> }>(
  join(here, "baseline", "migrations.json"),
).sha256;

const sha256 = (path: string): string =>
  createHash("sha256")
    .update(readFileSync(path, "utf8").replace(/\r\n/gu, "\n"))
    .digest("hex");

describe("baseline contract", () => {
  it("keeps every released capability in the MCP catalog", () => {
    const current = readJson<{ capabilityIds: string[] }>(
      join(engineRoot, "invokta.mcp.json"),
    ).capabilityIds;
    expect(baselineCapabilities.filter((id) => !current.includes(id))).toEqual([]);
  });

  it("does not duplicate capability ids", () => {
    const current = readJson<{ capabilityIds: string[] }>(
      join(engineRoot, "invokta.mcp.json"),
    ).capabilityIds;
    expect(new Set(current).size).toBe(current.length);
  });

  it("never edits or removes an already released migration", () => {
    const dir = join(engineRoot, "drizzle");
    const files = new Set(readdirSync(dir).filter((file) => file.endsWith(".sql")));
    for (const [file, hash] of Object.entries(baselineMigrations)) {
      expect(files.has(file), `${file} was removed`).toBe(true);
      expect(sha256(join(dir, file)), `${file} was edited`).toBe(hash);
    }
  });
});
