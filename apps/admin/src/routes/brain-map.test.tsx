import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../lib/i18n";
import { api } from "../lib/api";
import { BrainMapPage } from "./brain-map";

const snapshot = {
  generatedAt: "2026-08-25T12:00:00.000Z",
  periodDays: 30,
  counts: { memories: 1, knowledgeBases: 1, documents: 1, people: 1, projects: 1 },
  totalItems: 5,
  growth: 2,
  explicitConnections: 1,
  connectedItems: 5,
  connectedCoverage: 1,
  truncated: false,
  nodes: [
    {
      id: "00000000-0000-4000-8000-000000000010",
      type: "memory" as const,
      label: "Prefers concise status updates",
      description: "Keep updates short and concrete.",
      tags: ["communication"],
      version: 2,
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: null,
    },
    {
      id: "00000000-0000-4000-8000-000000000011",
      type: "person" as const,
      label: "Alex",
      description: null,
      tags: [],
      version: 1,
      createdAt: "2026-08-20T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:00.000Z",
    },
  ],
  edges: [
    {
      id: "mentions:00000000-0000-4000-8000-000000000010:00000000-0000-4000-8000-000000000011",
      source: "00000000-0000-4000-8000-000000000010",
      target: "00000000-0000-4000-8000-000000000011",
      type: "mentions" as const,
    },
  ],
  series: [
    { date: "2026-08-24", memories: 0, knowledgeBases: 1, documents: 1, people: 1, projects: 0, total: 3 },
    { date: "2026-08-25", memories: 1, knowledgeBases: 1, documents: 1, people: 1, projects: 1, total: 5 },
  ],
};

function renderPage(initialEntry = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <BrainMapPage />
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe("BrainMapPage", () => {
  beforeEach(() => {
    vi.spyOn(api, "brainMap").mockResolvedValue(snapshot);
  });

  it("renders the graph as a single whiteboard workspace", async () => {
    const user = userEvent.setup();
    renderPage();

    const memoryNode = await screen.findByRole("button", { name: "Memory: Prefers concise status updates" });
    expect(screen.getByRole("heading", { name: "Brain map" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Brain map" })).toBeVisible();
    expect(screen.queryByText("Stored items")).not.toBeInTheDocument();
    expect(screen.queryByText("Added in this period")).not.toBeInTheDocument();
    expect(screen.queryByText("Visible connections")).not.toBeInTheDocument();
    expect(screen.queryByText("Visible coverage")).not.toBeInTheDocument();
    expect(screen.queryByText("Growth over time")).not.toBeInTheDocument();
    expect(screen.queryByText("Select something in the map")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Cumulative brain growth chart" })).toBeInTheDocument();

    await user.click(memoryNode);

    expect(screen.getByRole("heading", { name: "Prefers concise status updates" })).toBeVisible();
    expect(screen.getByText("communication")).toBeVisible();
  });

  it("filters the visible graph by search text", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Person: Alex" });

    await user.type(screen.getByRole("searchbox", { name: "Search the map" }), "Alex");

    expect(screen.getByRole("button", { name: "Person: Alex" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Memory: Prefers concise status updates" })).not.toBeInTheDocument();
  });

  it("zooms with the mouse wheel while the pointer is over the canvas", async () => {
    renderPage();
    const graph = await screen.findByRole("group", { name: "Interactive graph of stored brain information" });

    expect(Number(graph.getAttribute("data-zoom"))).toBe(1);
    fireEvent.wheel(graph, { deltaY: -120 });

    expect(Number(graph.getAttribute("data-zoom"))).toBeGreaterThan(1);
  });

  it("pans the canvas by dragging a free area and resets the viewport", async () => {
    const user = userEvent.setup();
    renderPage();
    const graph = await screen.findByRole("group", { name: "Interactive graph of stored brain information" });
    vi.spyOn(graph, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 1000,
      top: 0,
      width: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    expect(graph).toHaveAttribute("data-pan-x", "0");
    expect(graph).toHaveAttribute("data-pan-y", "0");

    fireEvent.pointerDown(graph, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(graph, { clientX: 160, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(graph, { clientX: 160, clientY: 140, pointerId: 1 });

    expect(graph).toHaveAttribute("data-pan-x", "60");
    expect(graph).toHaveAttribute("data-pan-y", "40");
    expect(graph).toHaveAttribute("data-dragging", "false");

    await user.click(screen.getByRole("button", { name: "Reset zoom" }));

    expect(graph).toHaveAttribute("data-pan-x", "0");
    expect(graph).toHaveAttribute("data-pan-y", "0");
  });

  it("animates a connection while it is hovered", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Memory: Prefers concise status updates" });
    const connection = document.querySelector<SVGGElement>("[data-edge-id]");

    expect(connection).not.toBeNull();
    fireEvent.mouseEnter(connection!);

    expect(connection).toHaveAttribute("data-hovered", "true");
    expect(connection?.querySelector(".brain-map-synapse-pulse")).toBeInTheDocument();

    fireEvent.mouseLeave(connection!);
    expect(connection).toHaveAttribute("data-hovered", "false");
  });

  it("renders hundreds of connected nodes in the explicit local stress-test mode", async () => {
    renderPage("/?mock=large");

    await screen.findByRole("button", { name: "Memory: Memory 001 · Product strategy" });
    const graph = screen.getByRole("group", { name: "Interactive graph of stored brain information" });

    expect(within(graph).getAllByRole("button")).toHaveLength(360);
  });
});
