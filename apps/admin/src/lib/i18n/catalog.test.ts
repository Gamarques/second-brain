import { describe, expect, it } from "vitest";

import { catalogsForTesting } from "./catalog";
import { en } from "./en";
import { es } from "./es";
import { locales } from "./locale";
import { ptBR } from "./pt-BR";

function keySet(catalog: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(catalog));
}

describe("catalog completeness", () => {
  it("gives pt-BR exactly the same keys as the English reference catalog", () => {
    const missing = [...keySet(en)].filter((key) => !(key in ptBR));
    const extra = Object.keys(ptBR).filter((key) => !(key in en));

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("gives es exactly the same keys as the English reference catalog", () => {
    const missing = [...keySet(en)].filter((key) => !(key in es));
    const extra = Object.keys(es).filter((key) => !(key in en));

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("keeps the same message shape (plain string vs. plural forms) across every locale", () => {
    for (const key of Object.keys(en)) {
      const englishIsPlural = typeof en[key as keyof typeof en] === "object";
      const ptIsPlural = typeof ptBR[key as keyof typeof ptBR] === "object";
      const esIsPlural = typeof es[key as keyof typeof es] === "object";
      expect({ key, ptIsPlural }).toEqual({ key, ptIsPlural: englishIsPlural });
      expect({ key, esIsPlural }).toEqual({ key, esIsPlural: englishIsPlural });
    }
  });

  it("registers every supported locale in the catalog map used by translate()", () => {
    expect(Object.keys(catalogsForTesting).sort()).toEqual([...locales].sort());
  });

  it("never leaves an empty translation for a non-empty English source", () => {
    for (const [key, message] of Object.entries(en)) {
      if (typeof message !== "string") continue;
      for (const [locale, catalog] of Object.entries(catalogsForTesting)) {
        const value = catalog[key as keyof typeof en];
        if (typeof value === "string") {
          expect(value.length, `${locale}.${key} is empty`).toBeGreaterThan(0);
        }
      }
    }
  });
});
