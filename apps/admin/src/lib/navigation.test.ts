import { describe, expect, it } from "vitest";

import { breadcrumbsFor, navigationItemsFor, navigationSectionsFor, routeTitle } from "./navigation";

describe("admin navigation model", () => {
  it("exposes everyday destinations first, then advanced ones, as a flat searchable list", () => {
    expect(navigationItemsFor().map((item) => item.to)).toEqual([
      "/",
      "/status",
      "/getting-started",
      "/connect",
      "/agent-resources",
      "/reminders",
      "/projects",
      "/learning",
      "/memories",
      "/knowledge",
      "/brain-map",
      "/automation/dreaming",
      "/usage",
      "/configuration/environment",
      "/automation/jobs",
      "/audit",
    ]);
  });

  it("groups the brain's own destinations under Your brain and the rest under Advanced", () => {
    const sections = navigationSectionsFor();
    expect(sections.map((section) => section.title)).toEqual(["", "Your brain", "Advanced"]);
    expect(sections[0]?.items.map((item) => item.to)).toEqual(["/", "/status", "/getting-started", "/connect", "/agent-resources"]);
    expect(sections[1]?.items.map((item) => item.to)).toEqual(["/reminders", "/projects", "/learning", "/memories", "/knowledge", "/brain-map", "/automation/dreaming"]);
    expect(sections[2]?.items.map((item) => item.label)).toEqual(["AI consumption", "Settings", "Background work", "Activity"]);
  });

  it("marks the sections that start collapsed so the sidebar stays short for newcomers", () => {
    const sections = navigationSectionsFor();
    expect(sections.map((section) => section.id)).toEqual(["primary", "brain", "advanced"]);
    expect(sections.map((section) => section.collapsible)).toEqual([false, true, true]);
    expect(sections.map((section) => section.defaultOpen)).toEqual([true, true, false]);
  });

  it("hides Setup from the sidebar once setup is complete, but keeps it searchable", () => {
    const sidebar = navigationSectionsFor("en", { setupComplete: true });
    expect(sidebar.flatMap((section) => section.items.map((item) => item.to))).not.toContain("/getting-started");
    expect(navigationItemsFor().map((item) => item.to)).toContain("/getting-started");
  });

  it("gives every destination search keywords so the palette matches synonyms", () => {
    for (const item of navigationItemsFor()) {
      expect(item.keywords.length).toBeGreaterThan(0);
    }
  });

  it("titles known routes in founder-facing language", () => {
    expect(routeTitle("/")).toBe("Home");
    expect(routeTitle("/ask")).toBe("Home");
    expect(routeTitle("/briefing")).toBe("Home");
    expect(routeTitle("/status")).toBe("Status");
    expect(routeTitle("/automation/jobs")).toBe("Background work");
    expect(routeTitle("/brain-map")).toBe("Brain map");
    expect(breadcrumbsFor("/brain-map")).toEqual([{ label: "Brain map" }]);
    expect(routeTitle("/knowledge/abc/documents/def")).toBe("Document");
    expect(routeTitle("/nowhere")).toBe("Page not found");
  });

  it("builds a linked trail for nested routes", () => {
    expect(breadcrumbsFor("/knowledge/abc/documents/def")).toEqual([
      { label: "Documents", to: "/knowledge" },
      { label: "Folder", to: "/knowledge/abc" },
      { label: "Document" },
    ]);
  });

  it("makes agent resources discoverable by their purpose in every locale", () => {
    for (const [locale, title, keyword] of [
      ["en", "Skills & prompts", "calibration"],
      ["pt-BR", "Skills e prompts", "nivelamento"],
      ["es", "Skills y prompts", "nivelación"],
    ] as const) {
      const item = navigationItemsFor(locale).find((entry) => entry.to === "/agent-resources");
      expect(item?.label).toBe(title);
      expect(item?.keywords).toContain(keyword);
      expect(routeTitle("/agent-resources", locale)).toBe(title);
      expect(breadcrumbsFor("/agent-resources", locale)).toEqual([{ label: title }]);
    }
  });

  it("titles and trails the Brain Pack pages under Documents", () => {
    expect(routeTitle("/knowledge/packs")).toBe("Brain Packs");
    expect(routeTitle("/knowledge/packs/import")).toBe("Import Brain Pack");
    expect(routeTitle("/knowledge/packs/export")).toBe("Export Brain Pack");
    expect(breadcrumbsFor("/knowledge/packs/export").at(-1)).toEqual({ label: "Export Brain Pack" });
    expect(routeTitle("/knowledge/packs/imports/run-1")).toBe("Import");
    expect(breadcrumbsFor("/knowledge/packs/imports/run-1")).toEqual([
      { label: "Documents", to: "/knowledge" },
      { label: "Brain Packs", to: "/knowledge/packs" },
      { label: "Import" },
    ]);
    expect(breadcrumbsFor("/knowledge/packs")).toEqual([{ label: "Documents", to: "/knowledge" }, { label: "Brain Packs" }]);
  });

  it("keeps the trail to a single entry for top-level routes", () => {
    expect(breadcrumbsFor("/memories")).toEqual([{ label: "Things to remember" }]);
  });

  it("trails a nightly review recap back to its section", () => {
    expect(breadcrumbsFor("/automation/dreaming/runs/run-1")).toEqual([
      { label: "Nightly review", to: "/automation/dreaming" },
      { label: "Nightly recap" },
    ]);
  });

  it("translates destinations, titles, and breadcrumbs for another locale", () => {
    expect(navigationItemsFor("pt-BR").find((item) => item.to === "/automation/jobs")?.label).toBe("Em segundo plano");
    expect(navigationItemsFor("pt-BR").find((item) => item.to === "/status")?.label).toBe("Status");
    expect(routeTitle("/", "pt-BR")).toBe("Início");
    expect(routeTitle("/brain-map", "pt-BR")).toBe("Mapa do cérebro");
    expect(routeTitle("/status", "es")).toBe("Estado");
    expect(routeTitle("/automation/jobs", "es")).toBe("En segundo plano");
    expect(breadcrumbsFor("/memories", "pt-BR")).toEqual([{ label: "O que lembrar" }]);
  });

  it("keeps the English keywords searchable alongside the localized ones", () => {
    const settings = navigationItemsFor("pt-BR").find((item) => item.to === "/configuration/environment");
    expect(settings?.keywords).toEqual(expect.arrayContaining(["ajustes", "secrets"]));
  });

  it("associates home searches with Home instead of the brain map or Status", () => {
    const english = navigationItemsFor("en");
    expect(english.find((item) => item.to === "/")?.keywords).toContain("home");
    expect(english.find((item) => item.to === "/brain-map")?.keywords).not.toContain("home");
    expect(english.find((item) => item.to === "/status")?.keywords).not.toContain("home");

    const portuguese = navigationItemsFor("pt-BR");
    expect(portuguese.find((item) => item.to === "/")?.keywords).toEqual(expect.arrayContaining(["início", "inicio"]));
    expect(portuguese.find((item) => item.to === "/status")?.keywords).not.toEqual(expect.arrayContaining(["início", "inicio"]));

    const spanish = navigationItemsFor("es");
    expect(spanish.find((item) => item.to === "/")?.keywords).toContain("inicio");
    expect(spanish.find((item) => item.to === "/status")?.keywords).not.toContain("inicio");
  });
});
