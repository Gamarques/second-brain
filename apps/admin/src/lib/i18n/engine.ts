/**
 * Locale-agnostic translation engine: interpolation, CLDR pluralization, and
 * the fallback lookup chain. Kept independent of the concrete app catalogs
 * (see catalog.ts) so the mechanics can be unit tested with small fixtures.
 */

export type PluralForm = "one" | "other";
export type Message = string | Record<PluralForm, string>;
export type TranslateParams = Record<string, string | number> & { count?: number };

/** Replaces `{name}` placeholders with the matching param, left untouched when absent. */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** Every plural category CLDR can produce; English/Portuguese/Spanish cardinals only ever select "one" or "other". */
function pluralForm(locale: string, count: number): PluralForm {
  return new Intl.PluralRules(locale).select(count) === "one" ? "one" : "other";
}

export function renderMessage(locale: string, message: Message, params?: TranslateParams): string {
  const template = typeof message === "string" ? message : message[pluralForm(locale, params?.count ?? 0)];
  return interpolate(template, params);
}

/**
 * Looks a key up in the active locale's catalog, falling back to
 * `fallbackLocale`, then to the raw key with a console warning.
 */
export function translateFrom<K extends string>(
  catalogs: Record<string, Partial<Record<K, Message>> | undefined>,
  locale: string,
  fallbackLocale: string,
  key: K,
  params?: TranslateParams,
): string {
  const message = catalogs[locale]?.[key] ?? catalogs[fallbackLocale]?.[key];
  if (message === undefined) {
    console.warn(`[i18n] Missing translation for key "${key}"`);
    return key;
  }
  return renderMessage(locale, message, params);
}
