import { CornerDownLeft, Search, type LucideIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useLocale, useTranslation } from "../lib/i18n";
import { navigationItemsFor } from "../lib/navigation";
import { commandKeyLabel } from "../lib/shortcuts";
import { useBodyScrollLock, useEscapeKey, useFocusTrap } from "../lib/overlay";
import { cn } from "../lib/utils";
import { Kbd } from "./ui/kbd";
import { Portal } from "./ui/portal";

export interface CommandAction {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  keywords?: string[];
  hint?: string;
  run: () => void;
}

interface CommandEntry {
  id: string;
  label: string;
  hint: string;
  group: string;
  icon: LucideIcon;
  haystack: string;
  run: () => void;
}

function rank(entry: CommandEntry, tokens: string[]): number | null {
  if (tokens.length === 0) return 0;
  const label = entry.label.toLowerCase();
  let best = 0;
  for (const token of tokens) {
    if (!entry.haystack.includes(token)) return null;
    best += label.startsWith(token) ? 0 : label.includes(token) ? 1 : 2;
  }
  return best;
}

export function CommandPalette({ open, onClose, actions = [] }: { open: boolean; onClose: () => void; actions?: CommandAction[] }) {
  const navigate = useNavigate();
  const { locale } = useLocale();
  const t = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useBodyScrollLock(open);
  useEscapeKey(open, onClose);
  useFocusTrap(panel, open, input);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const goToLabel = t("commandPalette.groupGoTo");
  const entries = useMemo<CommandEntry[]>(() => {
    const destinations = navigationItemsFor(locale).map((item) => ({
      id: `goto:${item.to}`,
      label: item.label,
      hint: item.description,
      group: goToLabel,
      icon: item.icon,
      haystack: [item.label, item.description, ...item.keywords].join(" ").toLowerCase(),
      run: () => navigate(item.to),
    }));
    const extras = actions.map((action) => ({
      id: `action:${action.id}`,
      label: action.label,
      hint: action.hint ?? "",
      group: action.group,
      icon: action.icon,
      haystack: [action.label, action.hint ?? "", ...(action.keywords ?? [])].join(" ").toLowerCase(),
      run: action.run,
    }));
    return [...destinations, ...extras];
  }, [actions, navigate, locale, goToLabel]);

  const matches = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return entries
      .map((entry) => ({ entry, score: rank(entry, tokens) }))
      .filter((candidate): candidate is { entry: CommandEntry; score: number } => candidate.score !== null)
      .sort((left, right) => left.score - right.score)
      .map((candidate) => candidate.entry);
  }, [entries, query]);

  if (!open) return null;

  const selected = matches[Math.min(active, matches.length - 1)];
  const groups = matches.reduce<Array<{ group: string; entries: CommandEntry[] }>>((accumulator, entry) => {
    const last = accumulator.at(-1);
    if (last && last.group === entry.group) last.entries.push(entry);
    else accumulator.push({ group: entry.group, entries: [entry] });
    return accumulator;
  }, []);

  function activate(entry: CommandEntry | undefined) {
    if (!entry) return;
    onClose();
    entry.run();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (matches.length === 0 ? 0 : (Math.min(current, matches.length - 1) + 1) % matches.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (matches.length === 0 ? 0 : (Math.min(current, matches.length - 1) + matches.length - 1) % matches.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(selected);
    }
  }

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[12vh]">
        <div aria-hidden="true" className="fixed inset-0 animate-fade-in bg-black/50 backdrop-blur-xs" onClick={onClose} />
        <div
          aria-label={t("commandPalette.dialogLabel")}
          aria-modal="true"
          className="relative z-10 w-full max-w-xl animate-dialog-in overflow-hidden rounded-xl border border-border bg-card shadow-elevated"
          ref={panel}
          role="dialog"
        >
          <div className="flex items-center gap-3 border-b border-border/60 px-4">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              aria-activedescendant={selected ? `${listId}-${selected.id}` : undefined}
              aria-autocomplete="list"
              aria-controls={listId}
              aria-expanded
              aria-label={t("commandPalette.searchAriaLabel")}
              className="h-14 w-full border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              placeholder={t("commandPalette.searchPlaceholder")}
              ref={input}
              role="combobox"
              type="text"
              value={query}
            />
            <Kbd className="hidden sm:inline-flex">{t("commandPalette.escKey")}</Kbd>
          </div>
          <div className="max-h-[min(60vh,26rem)] overflow-y-auto p-2">
            {matches.length === 0 ? (
              <p className="px-3 py-10 text-center text-sm text-muted-foreground">{t("commandPalette.noMatches")}</p>
            ) : (
              <ul className="grid gap-0.5" id={listId} role="listbox">
                {groups.map((group) => (
                  <li key={group.group} role="presentation">
                    <p className="px-3 pb-1.5 pt-2.5 text-xs font-medium text-muted-foreground">{group.group}</p>
                    <ul className="grid gap-0.5" role="presentation">
                      {group.entries.map((entry) => {
                        const index = matches.indexOf(entry);
                        const isActive = entry === selected;
                        const Icon = entry.icon;
                        return (
                          <li
                            aria-selected={isActive}
                            className={cn(
                              "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors",
                              isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
                            )}
                            id={`${listId}-${entry.id}`}
                            key={entry.id}
                            onClick={() => activate(entry)}
                            onMouseEnter={() => setActive(index)}
                            role="option"
                          >
                            <Icon aria-hidden="true" className="h-4 w-4 shrink-0 opacity-80" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium text-foreground">{entry.label}</span>
                              {entry.hint && <span className="block truncate text-xs text-muted-foreground">{entry.hint}</span>}
                            </span>
                            {isActive && <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex items-center gap-4 border-t border-border/60 bg-muted/20 px-4 py-2.5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> {t("commandPalette.navigateHint")}</span>
            <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> {t("commandPalette.selectHint")}</span>
            <span className="ml-auto hidden items-center gap-1.5 sm:flex"><Kbd>{commandKeyLabel()}</Kbd><Kbd>K</Kbd> {t("commandPalette.anywhereHint")}</span>
          </div>
        </div>
      </div>
    </Portal>
  );
}
