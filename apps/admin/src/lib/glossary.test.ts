import { describe, expect, it } from "vitest";

import { catalogsForTesting } from "./i18n/catalog";
import { glossaryDefinitionKey, glossaryIds, glossaryTermKey } from "./glossary";

describe("glossary registry", () => {
  it("has no duplicate ids", () => {
    expect(new Set(glossaryIds).size).toBe(glossaryIds.length);
  });

  it("gives every id a non-empty term and definition in every locale", () => {
    for (const id of glossaryIds) {
      for (const [locale, catalog] of Object.entries(catalogsForTesting)) {
        const term = catalog[glossaryTermKey(id)];
        const definition = catalog[glossaryDefinitionKey(id)];
        expect(typeof term, `${locale} is missing glossary.${id}.term`).toBe("string");
        expect(typeof definition, `${locale} is missing glossary.${id}.definition`).toBe("string");
        expect((term as string).length).toBeGreaterThan(0);
        expect((definition as string).length).toBeGreaterThan(0);
      }
    }
  });
});
