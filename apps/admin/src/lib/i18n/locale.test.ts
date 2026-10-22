import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultLocale, localeStorageKey, normalizeLocale, persistLocale, readStoredLocale, resolveInitialLocale } from "./locale";

function stubLanguages(languages: string[]) {
  vi.spyOn(window.navigator, "language", "get").mockReturnValue(languages[0] ?? "");
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);
}

describe("normalizeLocale", () => {
  it("maps Portuguese variants to pt-BR", () => {
    expect(normalizeLocale("pt")).toBe("pt-BR");
    expect(normalizeLocale("pt-BR")).toBe("pt-BR");
    expect(normalizeLocale("pt-PT")).toBe("pt-BR");
  });

  it("maps Spanish variants to es", () => {
    expect(normalizeLocale("es")).toBe("es");
    expect(normalizeLocale("es-419")).toBe("es");
    expect(normalizeLocale("es-MX")).toBe("es");
  });

  it("maps English variants to en", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en-GB")).toBe("en");
  });

  it("returns null for an unsupported language", () => {
    expect(normalizeLocale("fr")).toBeNull();
    expect(normalizeLocale("de-DE")).toBeNull();
  });
});

describe("locale resolution", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("prefers a stored preference over the browser language", () => {
    persistLocale("es");
    stubLanguages(["pt-BR"]);

    expect(resolveInitialLocale()).toBe("es");
  });

  it("falls back to the browser language when nothing is stored", () => {
    stubLanguages(["pt-BR", "en"]);

    expect(resolveInitialLocale()).toBe("pt-BR");
  });

  it("falls back to en when the browser language is unsupported", () => {
    stubLanguages(["fr-FR"]);

    expect(resolveInitialLocale()).toBe(defaultLocale);
  });

  it("ignores a corrupted stored value", () => {
    window.localStorage.setItem(localeStorageKey, "klingon");
    stubLanguages(["en"]);

    expect(readStoredLocale()).toBeNull();
    expect(resolveInitialLocale()).toBe("en");
  });

  it("survives a blocked storage partition", () => {
    const blocked = vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(readStoredLocale()).toBeNull();

    blocked.mockRestore();
  });
});
