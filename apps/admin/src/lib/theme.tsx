import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export const themeStorageKey = "second-brain-admin.theme";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  cycle: () => void;
}

const darkQuery = "(prefers-color-scheme: dark)";
const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Dark is the console's native look; following the operating system is an explicit choice. */
const defaultPreference: ThemePreference = "dark";

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : defaultPreference;
  } catch {
    return defaultPreference;
  }
}

function persistPreference(next: ThemePreference): void {
  try {
    window.localStorage.setItem(themeStorageKey, next);
  } catch {
    // A blocked storage partition must never break the console.
  }
}

function readSystemTheme(): ResolvedTheme {
  return window.matchMedia?.(darkQuery).matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(readSystemTheme);
  const resolved: ResolvedTheme = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    const media = window.matchMedia?.(darkQuery);
    if (!media) return;
    const sync = () => setSystemTheme(media.matches ? "dark" : "light");
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    persistPreference(next);
  }, []);

  const cycle = useCallback(() => {
    setPreferenceState((current) => {
      const next: ThemePreference = current === "dark" ? "light" : current === "light" ? "system" : "dark";
      persistPreference(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, cycle }),
    [preference, resolved, setPreference, cycle],
  );
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside a ThemeProvider.");
  return value;
}
