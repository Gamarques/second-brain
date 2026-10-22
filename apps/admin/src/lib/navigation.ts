import {
  Bell,
  Brain,
  ChartColumn,
  FileClock,
  FileText,
  FolderKanban,
  Gauge,
  House,
  Inbox,
  Library,
  ListChecks,
  MoonStar,
  Plug,
  Settings2,
  Sparkles,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

import { translate, type CatalogKey } from "./i18n/catalog";
import { defaultLocale, type Locale } from "./i18n/locale";

export interface NavigationItem {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
  keywords: string[];
  end?: boolean;
}

export interface NavigationSection {
  /** Locale-independent, so the sidebar can remember which groups are folded. */
  id: string;
  title: string;
  items: NavigationItem[];
  /** A titled group the sidebar can fold; the untitled first group never folds. */
  collapsible: boolean;
  /** Whether a collapsible group starts open the first time someone sees it. */
  defaultOpen: boolean;
}

interface NavigationItemDefinition {
  to: string;
  icon: LucideIcon;
  labelKey: CatalogKey;
  descriptionKey: CatalogKey;
  keywordsKey: CatalogKey;
  end?: boolean;
  hideWhenSetupComplete?: boolean;
}

interface NavigationSectionDefinition {
  id: string;
  titleKey: CatalogKey | null;
  items: NavigationItemDefinition[];
  defaultOpen?: boolean;
}

const sectionDefinitions: NavigationSectionDefinition[] = [
  {
    id: "primary",
    titleKey: null,
    items: [
      {
        to: "/",
        icon: House,
        labelKey: "nav.home.label",
        descriptionKey: "nav.home.description",
        keywordsKey: "nav.home.keywords",
        end: true,
      },
      {
        to: "/status",
        icon: Gauge,
        labelKey: "nav.dashboard.label",
        descriptionKey: "nav.dashboard.description",
        keywordsKey: "nav.dashboard.keywords",
      },
      {
        to: "/getting-started",
        icon: Sparkles,
        labelKey: "nav.gettingStarted.label",
        descriptionKey: "nav.gettingStarted.description",
        keywordsKey: "nav.gettingStarted.keywords",
        hideWhenSetupComplete: true,
      },
      {
        to: "/connect",
        icon: Plug,
        labelKey: "nav.connect.label",
        descriptionKey: "nav.connect.description",
        keywordsKey: "nav.connect.keywords",
      },
      {
        to: "/agent-resources",
        icon: FileText,
        labelKey: "agentResources.title",
        descriptionKey: "agentResources.description",
        keywordsKey: "agentResources.keywords",
      },
    ],
  },
  {
    id: "brain",
    titleKey: "nav.section.general",
    defaultOpen: true,
    items: [
      {
        to: "/reminders",
        icon: Bell,
        labelKey: "reminders.title",
        descriptionKey: "reminders.description",
        keywordsKey: "reminders.keywords",
      },
      {
        to: "/projects",
        icon: FolderKanban,
        labelKey: "projects.title",
        descriptionKey: "projects.description",
        keywordsKey: "projects.keywords",
      },
      {
        to: "/learning",
        icon: Inbox,
        labelKey: "learning.title",
        descriptionKey: "learning.description",
        keywordsKey: "learning.keywords",
      },
      {
        to: "/memories",
        icon: Brain,
        labelKey: "nav.memories.label",
        descriptionKey: "nav.memories.description",
        keywordsKey: "nav.memories.keywords",
      },
      {
        to: "/knowledge",
        icon: Library,
        labelKey: "nav.knowledge.label",
        descriptionKey: "nav.knowledge.description",
        keywordsKey: "nav.knowledge.keywords",
      },
      {
        to: "/brain-map",
        icon: Waypoints,
        labelKey: "nav.brainMap.label",
        descriptionKey: "nav.brainMap.description",
        keywordsKey: "nav.brainMap.keywords",
      },
      {
        to: "/automation/dreaming",
        icon: MoonStar,
        labelKey: "nav.dreaming.label",
        descriptionKey: "nav.dreaming.description",
        keywordsKey: "nav.dreaming.keywords",
      },
    ],
  },
  {
    id: "advanced",
    titleKey: "nav.section.advanced",
    defaultOpen: false,
    items: [
      { to: "/usage", icon: ChartColumn, labelKey: "usage.title", descriptionKey: "usage.description", keywordsKey: "usage.keywords" },
      {
        to: "/configuration/environment",
        icon: Settings2,
        labelKey: "nav.environment.label",
        descriptionKey: "nav.environment.description",
        keywordsKey: "nav.environment.keywords",
      },
      {
        to: "/automation/jobs",
        icon: ListChecks,
        labelKey: "nav.jobs.label",
        descriptionKey: "nav.jobs.description",
        keywordsKey: "nav.jobs.keywords",
      },
      {
        to: "/audit",
        icon: FileClock,
        labelKey: "nav.audit.label",
        descriptionKey: "nav.audit.description",
        keywordsKey: "nav.audit.keywords",
      },
    ],
  },
];

/**
 * Splits a catalog's space-separated keyword list into tokens. Non-English
 * locales keep the English keywords too, so a search for "secrets" still
 * finds Settings even while reading the console in Portuguese.
 */
function keywordsFor(locale: Locale, key: CatalogKey): string[] {
  const localized = translate(locale, key).toLowerCase().split(/\s+/).filter(Boolean);
  if (locale === defaultLocale) return localized;
  const english = translate(defaultLocale, key).toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set([...localized, ...english])];
}

function itemsFor(locale: Locale, items: NavigationItemDefinition[]): NavigationItem[] {
  return items.map((item) => ({
    to: item.to,
    icon: item.icon,
    ...(item.end === undefined ? {} : { end: item.end }),
    label: translate(locale, item.labelKey),
    description: translate(locale, item.descriptionKey),
    keywords: keywordsFor(locale, item.keywordsKey),
  }));
}

export function navigationSectionsFor(
  locale: Locale = defaultLocale,
  options: { setupComplete?: boolean } = {},
): NavigationSection[] {
  return sectionDefinitions
    .map((section) => ({
      id: section.id,
      title: section.titleKey ? translate(locale, section.titleKey) : "",
      collapsible: section.titleKey !== null,
      defaultOpen: section.defaultOpen ?? true,
      items: itemsFor(
        locale,
        section.items.filter((item) => !(item.hideWhenSetupComplete && options.setupComplete)),
      ),
    }))
    .filter((section) => section.items.length > 0);
}

export function navigationItemsFor(locale: Locale = defaultLocale): NavigationItem[] {
  return navigationSectionsFor(locale).flatMap((section) => section.items);
}

export function routeTitle(pathname: string, locale: Locale = defaultLocale): string {
  if (pathname === "/" || pathname === "/ask" || pathname === "/briefing") return translate(locale, "route.home");
  if (pathname === "/usage") return translate(locale, "usage.title");
  if (pathname === "/status") return translate(locale, "route.dashboard");
  if (pathname === "/login") return translate(locale, "route.login");
  if (pathname === "/oauth/callback") return translate(locale, "route.oauthCallback");
  if (pathname === "/getting-started") return translate(locale, "route.gettingStarted");
  if (pathname === "/connect") return translate(locale, "route.connect");
  if (pathname === "/agent-resources") return translate(locale, "agentResources.title");
  if (pathname === "/configuration/environment") return translate(locale, "route.environment");
  if (pathname.startsWith("/automation/dreaming/runs/")) return translate(locale, "route.dreamingReport");
  if (pathname === "/automation/dreaming") return translate(locale, "route.dreaming");
  if (pathname === "/automation/jobs") return translate(locale, "route.jobs");
  if (pathname === "/brain-map") return translate(locale, "route.brainMap");
  if (pathname === "/reminders") return translate(locale, "reminders.title");
  if (pathname === "/projects" || pathname.startsWith("/projects/")) return translate(locale, "projects.title");
  if (pathname === "/learning" || pathname.startsWith("/learning/")) return translate(locale, "learning.title");
  if (pathname === "/memories") return translate(locale, "route.memories");
  if (pathname.startsWith("/knowledge/packs/imports/")) return translate(locale, "route.packRun");
  if (pathname === "/knowledge/packs/import") return translate(locale, "route.packImport");
  if (pathname === "/knowledge/packs/export") return translate(locale, "route.packExport");
  if (pathname === "/knowledge/packs") return translate(locale, "route.packs");
  if (pathname.includes("/knowledge/") && pathname.includes("/documents/")) return translate(locale, "route.knowledgeDocument");
  if (pathname.startsWith("/knowledge/")) return translate(locale, "route.knowledgeBase");
  if (pathname === "/knowledge") return translate(locale, "route.knowledge");
  if (pathname === "/audit") return translate(locale, "route.audit");
  return translate(locale, "route.notFound");
}

export interface Crumb {
  label: string;
  to?: string;
}

export function breadcrumbsFor(pathname: string, locale: Locale = defaultLocale): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "knowledge" && segments[1]) {
    const base: Crumb[] = [{ label: translate(locale, "route.knowledge"), to: "/knowledge" }];
    if (segments[1] === "packs") {
      const packs: Crumb[] = [...base, { label: translate(locale, "route.packs"), to: "/knowledge/packs" }];
      if (segments[2] === "import") return [...packs, { label: translate(locale, "route.packImport") }];
      if (segments[2] === "export") return [...packs, { label: translate(locale, "route.packExport") }];
      if (segments[2] === "imports" && segments[3]) return [...packs, { label: translate(locale, "route.packRun") }];
      return [...base, { label: translate(locale, "route.packs") }];
    }
    if (segments[2] === "documents" && segments[3]) {
      return [
        ...base,
        { label: translate(locale, "route.knowledgeBase"), to: `/knowledge/${segments[1]}` },
        { label: translate(locale, "route.knowledgeDocument") },
      ];
    }
    return [...base, { label: translate(locale, "route.knowledgeBase") }];
  }
  if (segments[0] === "automation" && segments[1] === "dreaming" && segments[2] === "runs") {
    return [{ label: translate(locale, "route.dreaming"), to: "/automation/dreaming" }, { label: translate(locale, "route.dreamingReport") }];
  }
  return [{ label: routeTitle(pathname, locale) }];
}
