import { Monitor, Moon, Sun } from "lucide-react";

import { useTranslation } from "../lib/i18n";
import { useTheme, type ThemePreference } from "../lib/theme";
import { cn } from "../lib/utils";

const options: Array<{ value: ThemePreference; labelKey: "themeToggle.light" | "themeToggle.dark" | "themeToggle.system"; icon: typeof Sun }> = [
  { value: "light", labelKey: "themeToggle.light", icon: Sun },
  { value: "dark", labelKey: "themeToggle.dark", icon: Moon },
  { value: "system", labelKey: "themeToggle.system", icon: Monitor },
];

export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  const t = useTranslation();

  return (
    <div aria-label={t("themeToggle.groupLabel")} className={cn("inline-flex h-9 items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-xs", className)} role="group">
      {options.map(({ value, labelKey, icon: Icon }) => (
        <button
          aria-label={t(labelKey)}
          aria-pressed={preference === value}
          className={cn(
            "inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-[5px] text-muted-foreground transition-all duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20",
            preference === value && "bg-muted text-foreground",
          )}
          key={value}
          onClick={() => setPreference(value)}
          type="button"
        >
          <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
