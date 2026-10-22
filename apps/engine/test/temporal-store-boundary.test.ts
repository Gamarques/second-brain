import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const storesDirectory = new URL(
  "../src/database/stores/",
  import.meta.url,
);

describe("temporal store immutability boundary", () => {
  it("never mutates or deletes immutable version and revision tables", () => {
    const productionStores = readdirSync(storesDirectory)
      .filter((name) => name.endsWith("-store.ts"))
      .map((name) => ({
        name,
        source: readFileSync(new URL(name, storesDirectory), "utf8"),
      }));
    const immutableTables = [
      "goalVersions",
      "priorityPlanVersions",
      "priorityPlanVersionItems",
      "taskVersions",
      "taskVersionGoalLinks",
      "reminderVersions",
      "knowledgeDocumentRevisions",
    ] as const;

    for (const { name, source } of productionStores) {
      for (const table of immutableTables) {
        expect(source, `${name} must not update ${table}`).not.toMatch(
          new RegExp(`\\.update\\(\\s*${table}\\s*\\)`, "u"),
        );
        expect(source, `${name} must not delete ${table}`).not.toMatch(
          new RegExp(`\\.delete\\(\\s*${table}\\s*\\)`, "u"),
        );
      }
    }
  });
});
