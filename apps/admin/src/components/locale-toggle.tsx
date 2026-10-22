import { locales, useLocale, useTranslation, type Locale } from "../lib/i18n";
import { cn } from "../lib/utils";

const shortLabels: Record<Locale, string> = { en: "EN", "pt-BR": "PT", es: "ES" };
const nameKeys: Record<Locale, "language.en" | "language.pt-BR" | "language.es"> = {
  en: "language.en",
  "pt-BR": "language.pt-BR",
  es: "language.es",
};

export function LocaleToggle({ className }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  const t = useTranslation();

  return (
    <div aria-label={t("language.groupLabel")} className={cn("inline-flex h-9 items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-xs", className)} role="group">
      {locales.map((value) => (
        <button
          aria-label={t(nameKeys[value])}
          aria-pressed={locale === value}
          className={cn(
            "inline-flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-[5px] px-1.5 text-[11px] font-medium tracking-wide text-muted-foreground transition-all duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20",
            locale === value && "bg-muted text-foreground",
          )}
          key={value}
          onClick={() => setLocale(value)}
          type="button"
        >
          {shortLabels[value]}
        </button>
      ))}
    </div>
  );
}
