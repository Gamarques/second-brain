import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";

import type { BrainMapEdge, BrainMapNode, BrainMapNodeType } from "./api-types";

export type LabelSide = "below" | "above" | "right" | "left";

export interface LayoutNode extends BrainMapNode {
  x: number;
  y: number;
  radius: number;
  degree: number;
  labelSide: LabelSide;
  /** Whether the label is drawn at rest; a selected or hovered node is labelled regardless. */
  labelVisible: boolean;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  /** Label every node that has room, not only the hubs (small maps). */
  labelEverything?: boolean;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type SimulationNode = BrainMapNode & { x: number; y: number; radius: number; degree: number; vx?: number; vy?: number };

const nodeTypes: readonly BrainMapNodeType[] = ["memory", "knowledge_base", "document", "person", "project"];
const margin = 40;
const labelCharacterWidth = 5.6;
const labelHeight = 12;
const labelGap = 8;
const labelSides: readonly LabelSide[] = ["below", "above", "right", "left"];
const ticks = 150;

export function truncateLabel(label: string): string {
  return label.length > 22 ? `${label.slice(0, 21)}…` : label;
}

/**
 * One anchor per information type that is present: memories in the middle,
 * everything else evenly on an ellipse. A brain with only documents and folders
 * therefore fills the map instead of huddling in one corner.
 */
function anchorsFor(nodes: readonly BrainMapNode[], width: number, height: number): Record<BrainMapNodeType, { x: number; y: number }> {
  const center = { x: width / 2, y: height / 2 };
  const present = nodeTypes.filter((type) => nodes.some((node) => node.type === type));
  const others = present.filter((type) => type !== "memory");
  const anchors = { memory: center, knowledge_base: center, document: center, person: center, project: center } as Record<BrainMapNodeType, { x: number; y: number }>;
  if (others.length === 1 && !present.includes("memory")) return anchors;
  others.forEach((type, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / others.length + (others.length === 2 ? Math.PI / 2 : 0);
    anchors[type] = { x: center.x + Math.cos(angle) * width * 0.3, y: center.y + Math.sin(angle) * height * 0.3 };
  });
  return anchors;
}

/** The starting picture: each type packed on rings around its anchor, so the simulation only has to relax it. */
function seed(nodes: readonly BrainMapNode[], edges: readonly BrainMapEdge[], width: number, height: number): SimulationNode[] {
  const degrees = new Map<string, number>();
  for (const edge of edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  const anchors = anchorsFor(nodes, width, height);
  const indexByType = new Map<BrainMapNodeType, number>();
  return nodes.map((node) => {
    const index = indexByType.get(node.type) ?? 0;
    indexByType.set(node.type, index + 1);
    const anchor = anchors[node.type];
    const ring = Math.floor(Math.sqrt(index));
    const slots = 6 + ring * 6;
    const angle = index === 0 ? 0 : (index * Math.PI * 2) / slots + ring * 0.4;
    const distance = index === 0 ? 0 : 60 + ring * 34;
    const degree = degrees.get(node.id) ?? 0;
    return { ...node, x: anchor.x + Math.cos(angle) * distance, y: anchor.y + Math.sin(angle) * distance, radius: Math.min(18, 8 + Math.sqrt(degree) * 2.5), degree };
  });
}

export function labelBox(node: Pick<LayoutNode, "x" | "y" | "radius" | "label" | "labelSide">): Box {
  const width = truncateLabel(node.label).length * labelCharacterWidth + 8;
  const height = labelHeight;
  switch (node.labelSide) {
    case "below":
      return { x: node.x - width / 2, y: node.y + node.radius + labelGap, width, height };
    case "above":
      return { x: node.x - width / 2, y: node.y - node.radius - labelGap - height, width, height };
    case "right":
      return { x: node.x + node.radius + labelGap - 2, y: node.y - height / 2, width, height };
    case "left":
      return { x: node.x - node.radius - labelGap + 2 - width, y: node.y - height / 2, width, height };
  }
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function circleTouchesBox(circle: { x: number; y: number; r: number }, box: Box): boolean {
  const nearestX = Math.max(box.x, Math.min(circle.x, box.x + box.width));
  const nearestY = Math.max(box.y, Math.min(circle.y, box.y + box.height));
  return Math.hypot(circle.x - nearestX, circle.y - nearestY) < circle.r;
}

/**
 * Lays the map out: a seeded, synchronous force simulation (links pull,
 * bodies repel, each type drifts toward its anchor, nothing overlaps, nothing
 * leaves the canvas), then labels placed greedily by importance so no two
 * visible labels collide. Pure: the same map always gives the same picture.
 */
export function layoutBrainMap(nodes: readonly BrainMapNode[], edges: readonly BrainMapEdge[], options: LayoutOptions = {}): LayoutNode[] {
  const width = options.width ?? 1000;
  const height = options.height ?? 600;
  const labelEverything = options.labelEverything ?? nodes.length <= 16;
  const anchors = anchorsFor(nodes, width, height);
  const simulated = seed(nodes, edges, width, height);
  const ids = new Set(simulated.map((node) => node.id));
  const links = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({ source: edge.source, target: edge.target }));

  const simulation = forceSimulation<SimulationNode>(simulated)
    .stop()
    .alphaDecay(1 - Math.pow(0.001, 1 / ticks))
    .force("link", forceLink<SimulationNode, { source: string; target: string }>(links).id((node) => node.id).distance(90).strength(0.4))
    .force("charge", forceManyBody<SimulationNode>().strength(-140).distanceMax(220))
    .force("collide", forceCollide<SimulationNode>((node) => node.radius + 5).iterations(2))
    .force("x", forceX<SimulationNode>((node) => anchors[node.type].x).strength(0.06))
    .force("y", forceY<SimulationNode>((node) => anchors[node.type].y).strength(0.06));
  // Clamping after each integration step keeps every node on the canvas; a
  // node pinned to an edge then pushes its neighbour inward instead of both
  // being dragged back onto each other.
  const keepInside = () => {
    for (const node of simulated) {
      node.x = Math.min(width - margin, Math.max(margin, node.x));
      node.y = Math.min(height - margin, Math.max(margin, node.y));
    }
  };
  for (let tick = 0; tick < ticks; tick += 1) {
    simulation.tick();
    keepInside();
  }
  // A short settle with only the collision force clears any overlap the attractions left behind.
  simulation.force("link", null).force("charge", null).force("x", null).force("y", null).alpha(0.3);
  for (let tick = 0; tick < 30; tick += 1) {
    simulation.tick();
    keepInside();
  }

  const laid: LayoutNode[] = simulated.map((node) => ({
    id: node.id,
    type: node.type,
    label: node.label,
    description: node.description,
    tags: node.tags,
    version: node.version,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    x: Number(node.x.toFixed(2)),
    y: Number(node.y.toFixed(2)),
    radius: node.radius,
    degree: node.degree,
    labelSide: "below",
    labelVisible: false,
  }));

  const circles = laid.map((node) => ({ id: node.id, x: node.x, y: node.y, r: node.radius + 4 }));
  const placed: Box[] = [];
  const byImportance = [...laid].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
  for (const node of byImportance) {
    const wanted = labelEverything || node.degree >= 3;
    const side = labelSides.find((candidate) => {
      const box = labelBox({ ...node, labelSide: candidate });
      if (placed.some((other) => intersects(other, box))) return false;
      return !circles.some((circle) => circle.id !== node.id && circleTouchesBox(circle, box));
    });
    if (side) {
      node.labelSide = side;
      node.labelVisible = wanted;
      if (wanted) placed.push(labelBox(node));
    }
  }
  return laid;
}
