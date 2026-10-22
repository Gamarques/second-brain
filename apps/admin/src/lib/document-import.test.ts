import { describe, expect, it, vi } from "vitest";

import { readDocumentImport } from "./document-import";

describe("document import", () => {
  it("reads supported text content and derives a title from the file name", async () => {
    await expect(readDocumentImport({
      name: "Founder playbook.md",
      size: 24,
      text: async () => "# Founder playbook",
    })).resolves.toEqual({
      content: "# Founder playbook",
      suggestedTitle: "Founder playbook",
    });
  });

  it("accepts a file whose bytes exceed 1,000,000 as long as it holds at most 1,000,000 characters", async () => {
    const content = "文".repeat(400_000);

    await expect(readDocumentImport({ name: "wide.txt", size: 1_200_000, text: async () => content })).resolves.toMatchObject({ content });
  });

  it("rejects a file with more than 1,000,000 characters after reading it", async () => {
    await expect(readDocumentImport({ name: "long.txt", size: 1_000_001, text: async () => "x".repeat(1_000_001) })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("rejects a file above the transport limit before reading it", async () => {
    const text = vi.fn(async () => "private content");

    await expect(readDocumentImport({ name: "huge.txt", size: 4_000_001, text })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(text).not.toHaveBeenCalled();
  });
});
