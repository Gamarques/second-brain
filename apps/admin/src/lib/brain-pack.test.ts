import { describe, expect, it } from "vitest";

import { brainPackErrorKey, brainPackFileName, brainPackImportStep, brainPackStatusTone, formatBytes, isBrainPackRunActive, readPublisherPreference, suggestPublisher, writePublisherPreference } from "./brain-pack";

describe("brainPackStatusTone", () => {
  it.each([
    ["completed", "success"],
    ["failed", "danger"],
    ["canceled", "neutral"],
    ["awaiting_review", "warning"],
    ["indexing", "info"],
    ["queued", "info"],
  ] as const)("%s → %s", (status, tone) => {
    expect(brainPackStatusTone(status)).toBe(tone);
  });
});

describe("brainPackImportStep", () => {
  it.each([
    ["uploaded", 2],
    ["validating", 2],
    ["awaiting_review", 3],
    ["reviewed", 6],
    ["indexing", 6],
    ["publishing", 6],
    ["completed", 6],
    ["failed", 2],
  ] as const)("%s is step %i", (status, step) => {
    expect(brainPackImportStep(status)).toBe(step);
  });
});

describe("isBrainPackRunActive", () => {
  it("treats only completed, failed and canceled as finished", () => {
    expect(isBrainPackRunActive("indexing")).toBe(true);
    expect(isBrainPackRunActive("completed")).toBe(false);
    expect(isBrainPackRunActive("canceled")).toBe(false);
  });
});

describe("brainPackErrorKey", () => {
  it("maps a known code and falls back for anything else", () => {
    expect(brainPackErrorKey("PACK_INTEGRITY_FAILED")).toBe("packs.errors.PACK_INTEGRITY_FAILED");
    expect(brainPackErrorKey("PACK_INTEGRITY_FAILED: documents/x.md")).toBe("packs.errors.PACK_INTEGRITY_FAILED");
    expect(brainPackErrorKey("something else")).toBe("packs.errors.unknown");
    expect(brainPackErrorKey(null)).toBe("packs.errors.unknown");
  });
});

describe("formatBytes", () => {
  it("rounds to a sensible unit", () => {
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(64 * 1024 * 1024, "en")).toBe("64 MB");
    expect(formatBytes(1_500_000, "en")).toBe("1.4 MB");
  });
});

describe("suggestPublisher", () => {
  it("turns the account's domain into a namespace and a display name", () => {
    expect(suggestPublisher("jane@example.academy")).toEqual({ namespace: "academy.example", displayName: "Example" });
    expect(suggestPublisher("owner@example.test")).toEqual({ namespace: "test.example", displayName: "Example" });
  });

  it("suggests nothing without a usable domain", () => {
    expect(suggestPublisher(null)).toEqual({ namespace: "", displayName: "" });
    expect(suggestPublisher("local")).toEqual({ namespace: "", displayName: "" });
  });
});

describe("publisher preference", () => {
  it("round-trips through storage and survives a blocked partition", () => {
    window.localStorage.clear();
    expect(readPublisherPreference()).toBeNull();
    writePublisherPreference({ namespace: "academy.example", displayName: "Example", language: "pt-BR" });
    expect(readPublisherPreference()).toEqual({ namespace: "academy.example", displayName: "Example", language: "pt-BR" });
    window.localStorage.setItem("second-brain-admin.brain-pack-publisher", "{not json");
    expect(readPublisherPreference()).toBeNull();
  });
});

describe("brainPackFileName", () => {
  it("matches the name the download route sets", () => {
    expect(brainPackFileName("00000000-0000-4000-8000-000000000100", 3)).toBe("00000000-0000-4000-8000-000000000100-r3.brainpack");
  });
});
