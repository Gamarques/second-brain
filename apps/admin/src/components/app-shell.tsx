import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BrainCircuit,
  ChevronDown,
  HelpCircle,
  Languages,
  LogOut,
  Menu,
  MessageCircleQuestion,
  Monitor,
  Moon,
  PanelLeft,
  RefreshCw,
  Search,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { api } from "../lib/api";
import type { AdminIdentity } from "../lib/api-types";
import { useLocale, useTranslation } from "../lib/i18n";
import { pendingSuggestionsQuery } from "../lib/learning-queries";
import { navigationSectionsFor, type NavigationItem, type NavigationSection } from "../lib/navigation";
import { useOnboardingProgress } from "../lib/onboarding";
import { signOutOAuth } from "../lib/oauth";
import { useBodyScrollLock, useEscapeKey, useFocusTrap } from "../lib/overlay";
import { commandKeyLabel, useAskPanelShortcut, useCommandPaletteShortcut } from "../lib/shortcuts";
import { useTheme } from "../lib/theme";
import { cn } from "../lib/utils";
import { AccountMenu } from "./account-menu";
import { AskPanel, persistAskPanelOpen, readAskPanelOpen } from "./ask-panel";
import { PageSkeleton } from "./async-state";
import { Breadcrumbs } from "./breadcrumbs";
import { RouteErrorBoundary } from "./route-error-boundary";
import { CommandPalette, type CommandAction } from "./command-palette";
import { GlossaryDialog } from "./glossary-dialog";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";
import { Tooltip } from "./ui/tooltip";
import { WelcomeDialog } from "./welcome-dialog";

const localeNameKeys = { en: "language.en", "pt-BR": "language.pt-BR", es: "language.es" } as const;

const collapsedStorageKey = "second-brain-admin.sidebar-collapsed";
const sectionsStorageKey = "second-brain-admin.sidebar-sections";
const welcomeStorageKey = "second-brain-admin.welcome-dismissed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(collapsedStorageKey) === "true";
  } catch {
    return false;
  }
}

function readSections(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(sectionsStorageKey) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function readWelcomeDismissed(): boolean {
  try {
    return window.localStorage.getItem(welcomeStorageKey) === "true";
  } catch {
    return false;
  }
}

function persistWelcomeDismissed(): void {
  try {
    window.localStorage.setItem(welcomeStorageKey, "true");
  } catch {
    // A blocked storage partition must never break the console.
  }
}

function isActiveRoute(item: NavigationItem, pathname: string): boolean {
  return item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

const navItemClass =
  "group relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground/90 transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40";

interface NavigationCount {
  count: number;
  label: string;
}

export function AppShell({ identity }: { identity?: AdminIdentity }) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [sectionState, setSectionState] = useState(readSections);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(() => !readWelcomeDismissed());
  const [askOpen, setAskOpen] = useState(readAskPanelOpen);
  const mobilePanel = useRef<HTMLDivElement>(null);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const { preference, cycle } = useTheme();
  const { locale, cycle: cycleLocale } = useLocale();
  const t = useTranslation();
  const fetching = useIsFetching();
  const commandKey = commandKeyLabel();
  const setup = useOnboardingProgress();
  const navigationSections = useMemo(
    () => navigationSectionsFor(locale, { setupComplete: setup.allComplete }),
    [locale, setup.allComplete],
  );

  // What is waiting for the person, shown as a count next to the destination that handles it.
  const briefing = useQuery({ queryKey: ["briefing"], queryFn: ({ signal }) => api.briefing(signal), refetchInterval: 60_000, staleTime: 30_000 });
  const pendingLearning = useQuery({ ...pendingSuggestionsQuery(), refetchInterval: 60_000, staleTime: 30_000 });
  const counts = useMemo<Record<string, NavigationCount>>(() => {
    const result: Record<string, NavigationCount> = {};
    const suggestions = pendingLearning.data?.items.length ?? 0;
    if (suggestions > 0) result["/learning"] = { count: suggestions, label: t("nav.badge.learning", { count: suggestions }) };
    const due = briefing.data?.dueReminders.length ?? 0;
    if (due > 0) result["/reminders"] = { count: due, label: t("nav.badge.reminders", { count: due }) };
    return result;
  }, [briefing.data, pendingLearning.data, t]);

  function dismissWelcome() {
    setWelcomeOpen(false);
    persistWelcomeDismissed();
  }

  function startFromWelcome() {
    dismissWelcome();
    navigate(setup.next?.to ?? "/getting-started");
  }

  const closeMobile = useCallback(() => setOpen(false), []);
  useBodyScrollLock(open);
  useEscapeKey(open, closeMobile);
  useFocusTrap(mobilePanel, open);
  useCommandPaletteShortcut(useCallback(() => setPaletteOpen(true), []));
  const setAsk = useCallback((next: boolean) => {
    persistAskPanelOpen(next);
    setAskOpen(next);
  }, []);
  const toggleAsk = useCallback(() => {
    setAskOpen((current) => {
      persistAskPanelOpen(!current);
      return !current;
    });
  }, []);
  useAskPanelShortcut(toggleAsk);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(collapsedStorageKey, String(next));
      } catch {
        // A blocked storage partition must never break the console.
      }
      return next;
    });
  }

  function sectionOpen(section: NavigationSection): boolean {
    if (!section.collapsible) return true;
    if (section.items.some((item) => isActiveRoute(item, location.pathname))) return true;
    return sectionState[section.id] ?? section.defaultOpen;
  }

  function toggleSection(section: NavigationSection) {
    setSectionState((current) => {
      const next = { ...current, [section.id]: !sectionOpen(section) };
      try {
        window.localStorage.setItem(sectionsStorageKey, JSON.stringify(next));
      } catch {
        // A blocked storage partition must never break the console.
      }
      return next;
    });
  }

  const paletteActions = useMemo<CommandAction[]>(
    () => [
      {
        id: "theme",
        label: t("shell.action.theme.label"),
        group: t("commandPalette.groupActions"),
        icon: preference === "dark" ? Moon : preference === "light" ? Sun : Monitor,
        hint: t("shell.action.theme.hint", { theme: t(`theme.${preference}`) }),
        keywords: t("shell.action.theme.keywords").split(" "),
        run: cycle,
      },
      {
        id: "language",
        label: t("shell.action.language.label"),
        group: t("commandPalette.groupActions"),
        icon: Languages,
        hint: t("shell.action.language.hint", { locale: t(localeNameKeys[locale]) }),
        keywords: t("shell.action.language.keywords").split(" "),
        run: cycleLocale,
      },
      {
        id: "refresh",
        label: t("shell.action.refresh.label"),
        group: t("commandPalette.groupActions"),
        icon: RefreshCw,
        hint: t("shell.action.refresh.hint"),
        keywords: t("shell.action.refresh.keywords").split(" "),
        run: () => void queryClient.invalidateQueries(),
      },
      {
        id: "sign-out",
        label: t("shell.signOut"),
        group: t("commandPalette.groupActions"),
        icon: LogOut,
        hint: t("shell.action.signOut.hint"),
        keywords: t("shell.action.signOut.keywords").split(" "),
        run: () => void signOutOAuth(),
      },
      {
        id: "ask",
        label: t("askPanel.open"),
        group: t("commandPalette.groupActions"),
        icon: MessageCircleQuestion,
        hint: t("askPanel.action.hint"),
        keywords: t("askPanel.action.keywords").split(" "),
        run: () => setAsk(true),
      },
      {
        id: "glossary",
        label: t("glossary.dialog.openButtonLabel"),
        group: t("commandPalette.groupActions"),
        icon: HelpCircle,
        hint: t("glossary.dialog.description"),
        keywords: t("nav.gettingStarted.keywords").split(" "),
        run: () => setGlossaryOpen(true),
      },
      {
        id: "welcome",
        label: t("welcome.reopenAction.label"),
        group: t("commandPalette.groupActions"),
        icon: Sparkles,
        hint: t("welcome.reopenAction.hint"),
        keywords: t("welcome.reopenAction.keywords").split(" "),
        run: () => setWelcomeOpen(true),
      },
    ],
    [cycle, preference, cycleLocale, locale, queryClient, setAsk, t],
  );

  const navItem = (item: NavigationItem, rail: boolean) => {
    const { to, label, icon: Icon, end } = item;
    const waiting = counts[to];
    return (
      <Tooltip hidden={!rail} key={to} label={waiting ? `${label} · ${waiting.count}` : label}>
        <NavLink
          className={({ isActive }) => cn(navItemClass, isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground", rail && "justify-center px-0")}
          end={end ?? false}
          onClick={closeMobile}
          to={to}
        >
          {({ isActive }) => (
            <>
              {isActive && <span aria-hidden="true" className="aurora absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full" data-nav-marker />}
              <Icon aria-hidden="true" className={cn("size-4 shrink-0", isActive ? "text-sidebar-accent-foreground" : "text-sidebar-muted group-hover:text-sidebar-accent-foreground")} />
              <span className={cn("truncate", rail && "sr-only")}>{label}</span>
              {waiting && (
                <>
                  {" "}
                  <span className="sr-only">{waiting.label}</span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1.5 text-[11px] font-medium tabular-nums",
                      isActive ? "bg-sidebar/70 text-sidebar-foreground" : "bg-sidebar-accent text-sidebar-muted group-hover:text-sidebar-accent-foreground",
                      rail && "absolute -right-0.5 -top-0.5 h-4 min-w-4 px-1 text-[10px]",
                    )}
                  >
                    {waiting.count > 99 ? "99+" : waiting.count}
                  </span>
                </>
              )}
            </>
          )}
        </NavLink>
      </Tooltip>
    );
  };

  const sidebar = (id: string, mobile = false) => {
    const rail = collapsed && !mobile;
    return (
      <aside
        className={cn(
          "flex h-full flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200",
          !mobile && "border-r border-sidebar-border",
          rail ? "w-[3.75rem]" : "w-64",
        )}
        id={id}
      >
        <div className={cn("flex h-14 shrink-0 items-center gap-2.5 px-3", rail && "justify-center px-0")}>
          <div className="aurora flex size-8 shrink-0 items-center justify-center rounded-lg shadow-xs">
            <BrainCircuit aria-hidden="true" className="size-4" />
          </div>
          {!rail && (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight tracking-tight" id={mobile ? "mobile-navigation-title" : undefined}>{t("shell.appName")}</p>
              <p className="truncate text-xs text-sidebar-muted">{t("shell.adminConsole")}</p>
            </div>
          )}
          {mobile && (
            <Button aria-label={t("shell.closeNavigation")} className="ml-auto text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" onClick={closeMobile} size="icon-sm" variant="ghost">
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
        <nav aria-label={t("shell.primaryNavigation")} className="flex-1 overflow-y-auto px-2 pb-3 pt-1">
          <div className="space-y-0.5">{navigationSections[0]?.items.map((item) => navItem(item, rail))}</div>
          {navigationSections.slice(1).map((section) => {
            const expanded = sectionOpen(section);
            return (
              <div className={cn("mt-4", rail && "mt-2 border-t border-sidebar-border pt-2")} key={section.id}>
                {!rail && (
                  <button
                    aria-expanded={expanded}
                    className="flex h-7 w-full cursor-pointer items-center gap-1 rounded-md px-2.5 text-xs font-medium uppercase tracking-[0.06em] text-sidebar-muted transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40"
                    onClick={() => toggleSection(section)}
                    type="button"
                  >
                    <span className="flex-1 truncate text-left">{section.title}</span>
                    <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform duration-200", !expanded && "-rotate-90")} />
                  </button>
                )}
                {(rail || expanded) && <div className="mt-0.5 space-y-0.5">{section.items.map((item) => navItem(item, rail))}</div>}
              </div>
            );
          })}
        </nav>
      </aside>
    );
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground lg:h-dvh lg:p-3">
      <a className="sr-only z-60 rounded-md border border-border bg-card p-3 text-sm font-medium shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3" href="#main-content">
        {t("shell.skipToMainContent")}
      </a>
      <div className="flex min-h-0 flex-1 bg-frame lg:overflow-hidden lg:rounded-2xl lg:border lg:border-border lg:shadow-frame">
        <div className="hidden h-full lg:block">{sidebar("desktop-admin-navigation")}</div>
        {open && (
          <div aria-labelledby="mobile-navigation-title" aria-modal="true" className="fixed inset-0 z-50 animate-fade-in bg-black/60 backdrop-blur-xs lg:hidden" onClick={closeMobile} role="dialog">
            <div className="h-full w-fit border-r border-sidebar-border" onClick={(event) => event.stopPropagation()} ref={mobilePanel}>
              {sidebar("admin-navigation", true)}
            </div>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col lg:overflow-y-auto">
          <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-frame/90 backdrop-blur-md">
            {fetching > 0 && (
              <div aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 overflow-hidden">
                <div className="aurora h-full w-full animate-indeterminate" />
              </div>
            )}
            <div className="flex h-14 items-center gap-1.5 px-3 sm:px-4">
              <Button
                aria-controls="admin-navigation"
                aria-expanded={open}
                aria-label={t("shell.openNavigation")}
                className="text-muted-foreground hover:text-foreground lg:hidden"
                onClick={() => setOpen(true)}
                ref={mobileTrigger}
                size="icon-sm"
                variant="ghost"
              >
                <Menu aria-hidden="true" />
              </Button>
              <Button
                aria-label={collapsed ? t("shell.expandNavigation") : t("shell.collapseNavigation")}
                className="hidden text-muted-foreground hover:text-foreground lg:inline-flex"
                onClick={toggleCollapsed}
                size="icon-sm"
                variant="ghost"
              >
                <PanelLeft aria-hidden="true" />
              </Button>
              <div aria-hidden="true" className="mx-1.5 hidden h-4 w-px bg-border lg:block" />
              <Breadcrumbs className="hidden sm:block" pathname={location.pathname} />
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  aria-keyshortcuts="Meta+K Control+K"
                  className="inline-flex h-8 cursor-pointer items-center gap-2 overflow-hidden whitespace-nowrap rounded-md border border-border bg-card px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 sm:w-56 sm:justify-start"
                  onClick={() => setPaletteOpen(true)}
                  type="button"
                >
                  <Search aria-hidden="true" className="size-4 shrink-0" />
                  <span className="hidden min-w-0 flex-1 truncate text-left sm:inline">{t("shell.searchButtonLabel")}</span>
                  <span className="hidden shrink-0 items-center gap-0.5 sm:flex"><Kbd>{commandKey}</Kbd><Kbd>K</Kbd></span>
                </button>
                <Button
                  aria-label={t("askPanel.open")}
                  aria-pressed={askOpen}
                  className={cn("text-muted-foreground hover:text-foreground", askOpen && "bg-muted text-foreground")}
                  onClick={toggleAsk}
                  size="icon-sm"
                  variant="ghost"
                >
                  <MessageCircleQuestion aria-hidden="true" />
                </Button>
                <Button aria-label={t("glossary.dialog.openButtonLabel")} className="text-muted-foreground hover:text-foreground" onClick={() => setGlossaryOpen(true)} size="icon-sm" variant="ghost">
                  <HelpCircle aria-hidden="true" />
                </Button>
                <AccountMenu className="ml-1" identity={identity} />
              </div>
            </div>
          </header>
          <main
            className="mx-auto w-full max-w-6xl flex-1 animate-fade-in overflow-x-clip p-4 outline-none sm:p-5 lg:px-6 lg:py-5"
            id="main-content"
            key={location.pathname}
            tabIndex={-1}
          >
            <RouteErrorBoundary resetKey={location.pathname}>
              <Suspense fallback={<PageSkeleton />}>
                <Outlet />
              </Suspense>
            </RouteErrorBoundary>
          </main>
        </div>
        <AskPanel onClose={() => setAsk(false)} open={askOpen} />
      </div>
      <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} open={paletteOpen} />
      <GlossaryDialog onClose={() => setGlossaryOpen(false)} open={glossaryOpen} />
      <WelcomeDialog nextStep={setup.next} onClose={dismissWelcome} onStart={startFromWelcome} open={welcomeOpen} />
    </div>
  );
}
