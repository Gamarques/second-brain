import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function ingestionStoreSource(): Promise<string> {
  return readFile(
    new URL("../src/database/stores/ingestion-store.ts", import.meta.url),
    "utf8",
  );
}

describe("Drizzle ingestion persistence invariants", () => {
  it("links every committed entity effect to its exact activity event", async () => {
    const source = await ingestionStoreSource();
    const helperEventAssignments = source.match(
      /activityEventId = result\.activityEventId;/gu,
    );

    expect(helperEventAssignments).toHaveLength(5);
    expect(source).toMatch(
      /status: "committed",[\s\S]{0,200}activityEventId,/u,
    );
    expect(source).not.toMatch(
      /status: "committed",[\s\S]{0,200}activityEventId:\s*null/u,
    );
    expect(source).toContain("validateCommittedReceiptLinks(transaction, snapshot)");
  });
});
