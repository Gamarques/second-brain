import type {
  BrainMapCounts,
  BrainMapEdge,
  BrainMapNode,
  BrainMapNodeType,
  BrainMapSnapshot,
} from "./api-types";

const mockCounts: BrainMapCounts = {
  memories: 120,
  knowledgeBases: 16,
  documents: 120,
  people: 64,
  projects: 40,
};

const subjects = [
  "Product strategy",
  "Customer research",
  "Launch planning",
  "Engineering decisions",
  "Content operations",
  "Community insights",
  "Market positioning",
  "Team agreements",
] as const;

const nodeSpecifications: ReadonlyArray<{
  type: BrainMapNodeType;
  count: number;
  label: string;
  tags: readonly string[];
}> = [
  { type: "memory", count: mockCounts.memories, label: "Memory", tags: ["mock", "context"] },
  { type: "knowledge_base", count: mockCounts.knowledgeBases, label: "Knowledge base", tags: ["mock", "library"] },
  { type: "document", count: mockCounts.documents, label: "Document", tags: ["mock", "reference"] },
  { type: "person", count: mockCounts.people, label: "Person", tags: ["mock", "network"] },
  { type: "project", count: mockCounts.projects, label: "Project", tags: ["mock", "initiative"] },
];

const dayInMilliseconds = 24 * 60 * 60 * 1_000;

function mockNodeId(type: BrainMapNodeType, index: number): string {
  return `mock:${type}:${String(index + 1).padStart(3, "0")}`;
}

function createNodes(generatedAt: string, periodDays: number): BrainMapNode[] {
  const generatedAtMilliseconds = Date.parse(generatedAt);
  const anchor = Number.isFinite(generatedAtMilliseconds) ? generatedAtMilliseconds : 0;
  return nodeSpecifications.flatMap((specification) =>
    Array.from({ length: specification.count }, (_, index) => {
      const subject = subjects[index % subjects.length]!;
      const createdAt = new Date(anchor - (index % periodDays) * dayInMilliseconds).toISOString();
      return {
        id: mockNodeId(specification.type, index),
        type: specification.type,
        label: `${specification.label} ${String(index + 1).padStart(3, "0")} · ${subject}`,
        description: `Local stress-test ${specification.label.toLocaleLowerCase()} for ${subject.toLocaleLowerCase()}.`,
        tags: [...specification.tags, subject.toLocaleLowerCase().replaceAll(" ", "-")],
        version: specification.type === "memory" || specification.type === "document"
          ? 1 + (index % 4)
          : null,
        createdAt,
        updatedAt: index % 5 === 0 ? generatedAt : null,
      };
    }),
  );
}

function createEdges(): BrainMapEdge[] {
  const edges: BrainMapEdge[] = [];
  const add = (
    type: BrainMapEdge["type"],
    sourceType: BrainMapNodeType,
    sourceIndex: number,
    targetType: BrainMapNodeType,
    targetIndex: number,
  ) => {
    const source = mockNodeId(sourceType, sourceIndex);
    const target = mockNodeId(targetType, targetIndex);
    edges.push({ id: `mock:${type}:${sourceIndex}:${targetIndex}:${edges.length}`, source, target, type });
  };

  for (let index = 0; index < mockCounts.documents; index += 1) {
    add("contains", "knowledge_base", index % mockCounts.knowledgeBases, "document", index);
    add("covers", "document", index, "memory", index % mockCounts.memories);
  }
  for (let index = 0; index < mockCounts.memories; index += 1) {
    add("mentions", "memory", index, "person", index % mockCounts.people);
    add("belongs_to", "memory", index, "project", index % mockCounts.projects);
  }
  for (let index = 0; index < mockCounts.people; index += 1) {
    add("participates_in", "person", index, "project", index % mockCounts.projects);
  }
  return edges;
}

function createSeries(generatedAt: string, periodDays: number): BrainMapSnapshot["series"] {
  const generatedAtMilliseconds = Date.parse(generatedAt);
  const anchor = Number.isFinite(generatedAtMilliseconds) ? generatedAtMilliseconds : 0;
  return Array.from({ length: periodDays }, (_, index) => {
    const ratio = (index + 1) / periodDays;
    const counts: BrainMapCounts = {
      memories: Math.floor(mockCounts.memories * ratio),
      knowledgeBases: Math.floor(mockCounts.knowledgeBases * ratio),
      documents: Math.floor(mockCounts.documents * ratio),
      people: Math.floor(mockCounts.people * ratio),
      projects: Math.floor(mockCounts.projects * ratio),
    };
    return {
      date: new Date(anchor - (periodDays - index - 1) * dayInMilliseconds).toISOString().slice(0, 10),
      ...counts,
      total: Object.values(counts).reduce((total, count) => total + count, 0),
    };
  });
}

export function createLargeBrainMapMock(baseline: BrainMapSnapshot): BrainMapSnapshot {
  const nodes = createNodes(baseline.generatedAt, baseline.periodDays);
  const edges = createEdges();
  return {
    ...baseline,
    counts: { ...mockCounts },
    totalItems: nodes.length,
    growth: nodes.length,
    explicitConnections: edges.length,
    connectedItems: nodes.length,
    connectedCoverage: 1,
    truncated: false,
    nodes,
    edges,
    series: createSeries(baseline.generatedAt, baseline.periodDays),
  };
}

export function isLargeBrainMapMockEnabled(hostname: string, search: string): boolean {
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  return loopback && new URLSearchParams(search).get("mock") === "large";
}
