import { describe, expect, it } from "vitest";

import type { BrainMapSnapshot } from "./api-types";
import {
  createLargeBrainMapMock,
  isLargeBrainMapMockEnabled,
} from "./brain-map-mock";

const baseline: BrainMapSnapshot = {
  generatedAt: "2026-08-25T12:00:00.000Z",
  periodDays: 30,
  counts: { memories: 0, knowledgeBases: 0, documents: 0, people: 0, projects: 0 },
  totalItems: 0,
  growth: 0,
  explicitConnections: 0,
  connectedItems: 0,
  connectedCoverage: 0,
  truncated: false,
  nodes: [],
  edges: [],
  series: [],
};

describe("large local brain map mock", () => {
  it("builds a deterministic, fully connected stress-test graph", () => {
    const snapshot = createLargeBrainMapMock(baseline);
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));

    expect(snapshot.counts).toEqual({
      memories: 120,
      knowledgeBases: 16,
      documents: 120,
      people: 64,
      projects: 40,
    });
    expect(snapshot.totalItems).toBe(360);
    expect(snapshot.nodes).toHaveLength(360);
    expect(snapshot.edges).toHaveLength(544);
    expect(nodeIds).toHaveLength(360);
    expect(snapshot.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))).toBe(true);
    expect(snapshot.connectedItems).toBe(360);
    expect(snapshot.connectedCoverage).toBe(1);
    expect(snapshot.truncated).toBe(false);
  });

  it("activates only through the explicit stress-test query on a loopback host", () => {
    expect(isLargeBrainMapMockEnabled("127.0.0.1", "?mock=large")).toBe(true);
    expect(isLargeBrainMapMockEnabled("localhost", "?mock=large")).toBe(true);
    expect(isLargeBrainMapMockEnabled("127.0.0.1", "")).toBe(false);
    expect(isLargeBrainMapMockEnabled("second-brain.example.com", "?mock=large")).toBe(false);
  });
});
