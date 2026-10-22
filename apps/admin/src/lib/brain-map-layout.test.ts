import { describe, expect, it } from "vitest";

import type { BrainMapEdge, BrainMapNode, BrainMapSnapshot } from "./api-types";
import { labelBox, layoutBrainMap } from "./brain-map-layout";
import { createLargeBrainMapMock } from "./brain-map-mock";

const node = (id: string, type: BrainMapNode["type"], label: string): BrainMapNode => ({
  id, type, label, description: null, tags: [], version: null, createdAt: "2026-08-24T12:00:00.000Z", updatedAt: null,
});
const small = {
  nodes: [node("m1", "memory", "Prefers concise status updates"), node("p1", "person", "Alex")],
  edges: [{ id: "e1", source: "m1", target: "p1", type: "mentions" }] as BrainMapEdge[],
};
const emptySnapshot: BrainMapSnapshot = {
  generatedAt: "2026-08-25T12:00:00.000Z", periodDays: 30,
  counts: { memories: 0, knowledgeBases: 0, documents: 0, people: 0, projects: 0 },
  totalItems: 0, growth: 0, explicitConnections: 0, connectedItems: 0, connectedCoverage: 0, truncated: false,
  nodes: [], edges: [], series: [],
};

function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("layoutBrainMap", () => {
  it("gives the same answer for the same map", () => {
    expect(layoutBrainMap(small.nodes, small.edges)).toEqual(layoutBrainMap(small.nodes, small.edges));
  });

  it("labels every node of a small map, without overlap", () => {
    const laid = layoutBrainMap(small.nodes, small.edges, { labelEverything: true });

    expect(laid.every((item) => item.labelVisible)).toBe(true);
    expect(intersects(labelBox(laid[0]!), labelBox(laid[1]!))).toBe(false);
  });

  it("keeps a crowded map inside the canvas, apart, and its visible labels clear of each other", () => {
    const big = createLargeBrainMapMock(emptySnapshot);
    const started = performance.now();
    const laid = layoutBrainMap(big.nodes, big.edges);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(laid).toHaveLength(360);

    for (const item of laid) {
      expect(item.x).toBeGreaterThanOrEqual(30);
      expect(item.x).toBeLessThanOrEqual(970);
      expect(item.y).toBeGreaterThanOrEqual(30);
      expect(item.y).toBeLessThanOrEqual(570);
    }
    let overlaps = 0;
    for (let i = 0; i < laid.length; i += 1) {
      for (let j = i + 1; j < laid.length; j += 1) {
        const a = laid[i]!;
        const b = laid[j]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius - 1) overlaps += 1;
      }
    }
    expect(overlaps).toBe(0);
    const boxes = laid.filter((item) => item.labelVisible).map(labelBox);
    expect(boxes.length).toBeGreaterThan(0);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(intersects(boxes[i]!, boxes[j]!)).toBe(false);
      }
    }
  });
});
