export type Locale = "en" | "pt-BR" | "es";

export const locales: Locale[] = ["en", "pt-BR", "es"];
export const defaultLocale: Locale = "en";
export const localeStorageKey = "second-brain-admin.locale";

function isLocale(value: string): value is Locale {
  return (locales as string[]).includes(value);
}

/**
 * Maps an IETF language tag to a supported locale. Portuguese variants
 * (`pt`, `pt-PT`, `pt-BR`, …) resolve to `pt-BR`; Spanish variants
 * (`es`, `es-419`, `es-MX`, …) resolve to `es`.
 */
export function normalizeLocale(tag: string): Locale | null {
  const lower = tag.trim().toLowerCase();
  if (lower === "pt" || lower.startsWith("pt-")) return "pt-BR";
  if (lower === "es" || lower.startsWith("es-")) return "es";
  if (lower === "en" || lower.startsWith("en-")) return "en";
  return null;
}

export function readStoredLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(localeStorageKey);
    return stored !== null && isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function persistLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(localeStorageKey, locale);
  } catch {
    // A blocked storage partition must never break the console.
  }
}

function readNavigatorLocale(): Locale | null {
  const candidates = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeLocale(candidate);
    if (normalized) return normalized;
  }
  return null;
}

/** Stored preference, then the browser's language, then `en`. */
export function resolveInitialLocale(): Locale {
  return readStoredLocale() ?? readNavigatorLocale() ?? defaultLocale;
}
