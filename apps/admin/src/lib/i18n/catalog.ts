import { translateFrom, type Message, type TranslateParams } from "./engine";
import { en } from "./en";
import { es } from "./es";
import { defaultLocale, type Locale } from "./locale";
import { ptBR } from "./pt-BR";

/** Every translation key, derived from the English reference catalog. */
export type CatalogKey = keyof typeof en;

/**
 * The shape every locale catalog must satisfy. Because `pt-BR.ts` and
 * `es.ts` assign an object literal directly to a `Catalog`-typed constant,
 * TypeScript's excess-property checking makes both a missing key and a
 * stray/misspelled one a compile error. Those two files only need a
 * type-only import of `Catalog` from this module, so there is no runtime
 * circular dependency even though this module imports their values back.
 */
export type Catalog = Record<CatalogKey, Message>;

const catalogs: Record<Locale, Catalog> = {
  en,
  "pt-BR": ptBR,
  es,
};

export function translate(locale: Locale, key: CatalogKey, params?: TranslateParams): string {
  return translateFrom(catalogs, locale, defaultLocale, key, params);
}

/** Exposed for the catalog-completeness test; not part of the public API. */
export const catalogsForTesting = catalogs;
