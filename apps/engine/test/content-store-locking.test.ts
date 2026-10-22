import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function functionBody(
  contents: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = contents.indexOf(startMarker);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return contents.slice(start, end);
}

describe("content store concurrency boundaries", () => {
  it("holds the active embedding-space row through memory and decision writes", async () => {
    const [memoryStore, decisionStore, embeddingSpaceStore] = await Promise.all(
      [
        source("../src/database/stores/memory-store.ts"),
        source("../src/database/stores/decision-store.ts"),
        source("../src/database/stores/embedding-space-store.ts"),
      ],
    );

    const memorySpaceValidation = functionBody(
      memoryStore,
      "async function requireActiveSpace(",
      "async function requireLinkedContext(",
    );
    const decisionSpaceValidation = functionBody(
      decisionStore,
      "async function requireActiveSpace(",
      "async function linkedContextExists(",
    );
    const promotion = functionBody(
      embeddingSpaceStore,
      "  async promoteSpace(",
      "export async function assertActiveEmbeddingSpacesMatchProvider(",
    );

    expect(memorySpaceValidation).toContain('.for("share")');
    expect(decisionSpaceValidation).toContain('.for("share")');
    expect(promotion).toContain(".update(embeddingSpaces)");
    expect(promotion).toContain('eq(embeddingSpaces.status, "active")');
  });

  it("accepts only current mutation channels in stored provenance", async () => {
    const [memoryStore, decisionStore] = await Promise.all([
      source("../src/database/stores/memory-store.ts"),
      source("../src/database/stores/decision-store.ts"),
    ]);

    for (const contents of [memoryStore, decisionStore]) {
      const actorDecoder = functionBody(
        contents,
        "function decodeActor(",
        "const successor =",
      );
      expect(actorDecoder).toMatch(
        /!\[\s*"direct",\s*"mcp_http",\s*"automation",\s*"import",?\s*\]\.includes/gu,
      );
    }
  });
});
