import { describe, expect, it, vi } from "vitest";

import { interpolate, renderMessage, translateFrom } from "./engine";

describe("interpolate", () => {
  it("substitutes named placeholders", () => {
    expect(interpolate("Hello {name}, you have {count} items", { name: "Ana", count: 3 })).toBe(
      "Hello Ana, you have 3 items",
    );
  });

  it("leaves an unmatched placeholder untouched", () => {
    expect(interpolate("Hello {name}", {})).toBe("Hello {name}");
  });

  it("passes plain templates through untouched", () => {
    expect(interpolate("No placeholders here")).toBe("No placeholders here");
  });
});

describe("renderMessage", () => {
  it("selects the singular English form for a count of one", () => {
    expect(renderMessage("en", { one: "{count} change", other: "{count} changes" }, { count: 1 })).toBe("1 change");
  });

  it("selects the plural English form for any other count", () => {
    expect(renderMessage("en", { one: "{count} change", other: "{count} changes" }, { count: 0 })).toBe("0 changes");
    expect(renderMessage("en", { one: "{count} change", other: "{count} changes" }, { count: 5 })).toBe("5 changes");
  });

  it("applies Portuguese cardinal plural rules", () => {
    const message = { one: "{count} alteração", other: "{count} alterações" };
    expect(renderMessage("pt-BR", message, { count: 1 })).toBe("1 alteração");
    expect(renderMessage("pt-BR", message, { count: 2 })).toBe("2 alterações");
  });

  it("applies Spanish cardinal plural rules", () => {
    const message = { one: "{count} cambio", other: "{count} cambios" };
    expect(renderMessage("es", message, { count: 1 })).toBe("1 cambio");
    expect(renderMessage("es", message, { count: 2 })).toBe("2 cambios");
  });

  it("interpolates a plain string message", () => {
    expect(renderMessage("en", "Hello {name}", { name: "Ana" })).toBe("Hello Ana");
  });
});

describe("translateFrom", () => {
  it("prefers the active locale's message", () => {
    const catalogs = { en: { greeting: "Hello" }, es: { greeting: "Hola" } };
    expect(translateFrom(catalogs, "es", "en", "greeting")).toBe("Hola");
  });

  it("falls back to the reference locale when a key is missing", () => {
    const catalogs = { en: { greeting: "Hello {name}" }, es: {} };
    expect(translateFrom(catalogs, "es", "en", "greeting", { name: "Ana" })).toBe("Hello Ana");
  });

  it("returns the raw key and warns when no locale has the message", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const catalogs = { en: {}, es: {} };

    expect(translateFrom(catalogs, "es", "en", "missing.key")).toBe("missing.key");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing.key"));

    warn.mockRestore();
  });
});
