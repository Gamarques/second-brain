import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { translate, type CatalogKey } from "./catalog";
import type { TranslateParams } from "./engine";
import { locales, persistLocale, resolveInitialLocale, type Locale } from "./locale";

export type Translator = (key: CatalogKey, params?: TranslateParams) => string;

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Cycles en → pt-BR → es → en, for a single reachable "change language" command. */
  cycle: () => void;
  t: Translator;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    persistLocale(next);
  }, []);

  const cycle = useCallback(() => {
    setLocaleState((current) => {
      const next = locales[(locales.indexOf(current) + 1) % locales.length]!;
      persistLocale(next);
      return next;
    });
  }, []);

  const t = useCallback<Translator>((key, params) => translate(locale, key, params), [locale]);

  const value = useMemo(() => ({ locale, setLocale, cycle, t }), [locale, setLocale, cycle, t]);
  return <LocaleContext value={value}>{children}</LocaleContext>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale must be used inside a LocaleProvider.");
  return value;
}

/** Returns the `t(key, params?)` translator bound to the active locale. */
export function useTranslation(): Translator {
  return useLocale().t;
}
