import { describe, expect, it } from "vitest";

import {
  brainSearchGuidance,
  classifyBrainSearchQuery,
  lexicalMatchScore,
} from "../src/domain/search.js";

describe("brain search intent routing", () => {
  it("classifies person lookups in English and Portuguese", () => {
    expect(classifyBrainSearchQuery("quem é Jane Doe")).toEqual({
      intent: "lookup_person",
      subject: "Jane Doe",
    });
    expect(classifyBrainSearchQuery("Who is Jane Doe?")).toEqual({
      intent: "lookup_person",
      subject: "Jane Doe",
    });
    expect(classifyBrainSearchQuery("who's Ada Lovelace")).toEqual({
      intent: "lookup_person",
      subject: "Ada Lovelace",
    });
  });

  it("classifies topic lookups and keeps a general fallback", () => {
    expect(classifyBrainSearchQuery("o que você sabe sobre Example Academy")).toEqual(
      {
        intent: "lookup_topic",
        subject: "Example Academy",
      },
    );
    expect(classifyBrainSearchQuery("what do you know about embeddings")).toEqual({
      intent: "lookup_topic",
      subject: "embeddings",
    });
    expect(classifyBrainSearchQuery("informação sobre o lançamento")).toEqual({
      intent: "lookup_topic",
      subject: "o lançamento",
    });
    expect(classifyBrainSearchQuery("launch checklist")).toEqual({
      intent: "general",
      subject: "launch checklist",
    });
  });

  it("tells agents to consult knowledge bases for who/what questions", () => {
    expect(brainSearchGuidance("lookup_person")).toMatch(/knowledge base/i);
    expect(brainSearchGuidance("lookup_person")).toMatch(/people/i);
    expect(brainSearchGuidance("lookup_topic")).toMatch(/knowledge-base hits/i);
    expect(lexicalMatchScore("Jane Doe", "Jane Doe")).toBe(1);
    expect(lexicalMatchScore("Jane Doe is faculty", "Jane Doe")).toBe(
      0.92,
    );
    expect(lexicalMatchScore("unrelated", "Jane Doe")).toBe(0);
  });
});
