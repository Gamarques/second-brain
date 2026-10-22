import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  Maximize2,
  Minus,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link, useLocation } from "react-router-dom";

import { EmptyState, ErrorState, LoadingState } from "../components/async-state";
import { EmptyMapIllustration } from "../components/illustrations/empty-map";
import { Meta, MetaItem, Page } from "../components/page";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/field";
import { AreaSeries } from "../components/viz/sparkline";
import { api } from "../lib/api";
import type { BrainMapEdge, BrainMapNode, BrainMapNodeType } from "../lib/api-types";
import { layoutBrainMap, truncateLabel, type LayoutNode } from "../lib/brain-map-layout";
import { createLargeBrainMapMock, isLargeBrainMapMockEnabled } from "../lib/brain-map-mock";
import { useLocale, useTranslation, type Translator } from "../lib/i18n";
import { cn, formatDate } from "../lib/utils";

const nodeTypes: readonly BrainMapNodeType[] = [
  "memory",
  "knowledge_base",
  "document",
  "person",
  "project",
];

/** Monochrome by default; memories carry the sunrise so the brain's core reads at a glance. */
const nodeTone: Readonly<Record<BrainMapNodeType, { fill: string; stroke: string }>> = {
  memory: { fill: "color-mix(in srgb, var(--aurora-pink) 14%, var(--card))", stroke: "var(--aurora-pink)" },
  knowledge_base: { fill: "var(--card)", stroke: "var(--foreground)" },
  document: { fill: "var(--muted)", stroke: "var(--muted-foreground)" },
  person: { fill: "var(--card)", stroke: "var(--muted-foreground)" },
  project: { fill: "var(--card)", stroke: "var(--foreground)" },
};

type ViewportPan = Readonly<{ x: number; y: number }>;

const minimumZoom = 0.55;
const maximumZoom = 2.4;

function clampZoom(value: number): number {
  return Math.min(maximumZoom, Math.max(minimumZoom, Number(value.toFixed(3))));
}

export function BrainMapPage() {
  const location = useLocation();
  const { locale } = useLocale();
  const t = useTranslation();
  const [search, setSearch] = useState("");
  const [enabledTypes, setEnabledTypes] = useState<ReadonlySet<BrainMapNodeType>>(() => new Set(nodeTypes));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<ViewportPan>({ x: 0, y: 0 });
  const query = useQuery({
    queryKey: ["brain-map"],
    queryFn: ({ signal }) => api.brainMap(30, signal),
  });
  const snapshot = useMemo(() => {
    if (!query.data) return null;
    return isLargeBrainMapMockEnabled(window.location.hostname, location.search)
      ? createLargeBrainMapMock(query.data)
      : query.data;
  }, [location.search, query.data]);

  const visible = useMemo(() => {
    if (!snapshot) return { nodes: [], edges: [] };
    const normalized = search.trim().toLocaleLowerCase(locale);
    const nodes = snapshot.nodes.filter((node) => {
      if (!enabledTypes.has(node.type)) return false;
      if (normalized === "") return true;
      return [node.label, node.description ?? "", ...node.tags]
        .join(" ")
        .toLocaleLowerCase(locale)
        .includes(normalized);
    });
    const ids = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: snapshot.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    };
  }, [enabledTypes, locale, search, snapshot]);

  if (query.isPending) {
    return (
      <Page>
        <section aria-labelledby="brain-map-title" className="relative grid h-[calc(100dvh-6rem)] lg:h-[calc(100dvh-8.25rem)] min-h-[540px] overflow-hidden rounded-xl border border-border bg-card">
          <h1 className="absolute left-5 top-5 z-10 text-sm font-medium tracking-tight" id="brain-map-title">
            {t("nav.brainMap.label")}
          </h1>
          <LoadingState className="h-full" label={t("brainMap.loading")} />
        </section>
      </Page>
    );
  }
  if (query.isError) {
    return (
      <Page>
        <section aria-labelledby="brain-map-title" className="relative grid h-[calc(100dvh-6rem)] lg:h-[calc(100dvh-8.25rem)] min-h-[540px] place-items-center overflow-hidden rounded-xl border border-border bg-card p-6">
          <h1 className="sr-only" id="brain-map-title">{t("nav.brainMap.label")}</h1>
          <div className="w-full max-w-lg"><ErrorState error={query.error} retry={() => query.refetch()} /></div>
        </section>
      </Page>
    );
  }
  if (snapshot === null) return null;

  const selected = visible.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedEdges = selected === null
    ? []
    : visible.edges.filter((edge) => edge.source === selected.id || edge.target === selected.id);
  function toggleType(type: BrainMapNodeType) {
    setEnabledTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  return (
    <Page>
    <section
      aria-labelledby="brain-map-title"
      className="relative isolate h-[calc(100dvh-6rem)] lg:h-[calc(100dvh-8.25rem)] min-h-[540px] overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-between gap-3">
        <div className="pointer-events-auto flex min-w-0 max-w-[calc(100%-3.5rem)] flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-card/85 p-1.5 pl-3 backdrop-blur-md">
            <h1 className="shrink-0 text-sm font-medium tracking-tight" id="brain-map-title">
              {t("nav.brainMap.label")}
            </h1>
            <span aria-hidden="true" className="h-4 w-px bg-border" />
            <label className="relative block min-w-36 flex-1 sm:min-w-72">
              <span className="sr-only">{t("brainMap.search.label")}</span>
              <Search aria-hidden="true" className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label={t("brainMap.search.label")}
                className="h-8 border-transparent bg-transparent pl-8 text-xs shadow-none focus-visible:border-border focus-visible:bg-card"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("brainMap.search.placeholder")}
                type="search"
                value={search}
              />
            </label>
          </div>
          <div aria-label={t("brainMap.filter.ariaLabel")} className="flex max-w-full gap-1 overflow-x-auto pl-1" role="group">
            {nodeTypes.map((type) => (
              <Button
                aria-pressed={enabledTypes.has(type)}
                className={cn("shrink-0 rounded-full bg-card/85 text-muted-foreground backdrop-blur-md hover:text-foreground", enabledTypes.has(type) ? "text-foreground" : "opacity-50 line-through decoration-muted-foreground/60")}
                key={type}
                onClick={() => toggleType(type)}
                size="sm"
                variant="ghost"
              >
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full border"
                  style={{ background: nodeTone[type].fill, borderColor: nodeTone[type].stroke }}
                />
                {t(`brainMap.filter.${type}`)}
              </Button>
            ))}
          </div>
        </div>
        <div className="pointer-events-auto flex shrink-0 gap-0.5 rounded-lg border border-border/70 bg-card/85 p-1 backdrop-blur-md">
          <Button aria-label={t("brainMap.graph.zoomOut")} disabled={zoom <= minimumZoom} onClick={() => setZoom((value) => clampZoom(value - 0.15))} size="icon-sm" variant="ghost">
            <Minus aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            aria-label={t("brainMap.graph.resetZoom")}
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            size="icon-sm"
            variant="ghost"
          >
            <Maximize2 aria-hidden="true" className="size-3.5" />
          </Button>
          <Button aria-label={t("brainMap.graph.zoomIn")} disabled={zoom >= maximumZoom} onClick={() => setZoom((value) => clampZoom(value + 0.15))} size="icon-sm" variant="ghost">
            <Plus aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      </div>

      {visible.nodes.length === 0 ? (
        <div className="grid h-full place-items-center p-6">
          <EmptyState className="w-full max-w-md" description={t("brainMap.graph.empty.description")} illustration={<EmptyMapIllustration />} title={t("brainMap.graph.empty.title")} />
        </div>
      ) : (
        <GraphCanvas
          edges={visible.edges}
          nodes={visible.nodes}
          onPanChange={setPan}
          onSelect={setSelectedId}
          onZoomChange={setZoom}
          pan={pan}
          selectedId={selectedId}
          t={t}
          zoom={zoom}
        />
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 z-10 grid max-w-[calc(100%-1.5rem)] gap-2">
        <div className="pointer-events-auto flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-border/70 bg-card/85 px-4 py-2.5 backdrop-blur-md">
          <dl aria-label={t("brainMap.metrics.ariaLabel")} className="contents">
            <MapStat label={t("home.brain.memories", { count: snapshot.counts.memories })} value={snapshot.counts.memories} />
            <MapStat label={t("home.brain.documents", { count: snapshot.counts.documents })} value={snapshot.counts.documents} />
            <MapStat label={t("brainMap.stats.people", { count: snapshot.counts.people })} value={snapshot.counts.people} />
          </dl>
          <AreaSeries className="h-7 w-24 text-muted-foreground" label={t("brainMap.growth.ariaLabel")} values={snapshot.series.map((point) => point.total)} />
          {snapshot.growth > 0 && (
            <p className="text-xs font-medium text-muted-foreground">{t("brainMap.stats.growth", { count: snapshot.growth, days: snapshot.periodDays })}</p>
          )}
        </div>
        {snapshot.truncated && (
          <p className="pointer-events-auto rounded-lg border border-border/70 bg-card/85 px-3 py-2 text-xs text-muted-foreground backdrop-blur-md">
            {t("brainMap.graph.truncated", { visible: snapshot.nodes.length, total: snapshot.totalItems })}
          </p>
        )}
      </div>

      <DetailPanel
        edges={selectedEdges}
        locale={locale}
        node={selected}
        nodes={visible.nodes}
        onClose={() => setSelectedId(null)}
        onSelect={setSelectedId}
        t={t}
      />
    </section>
    </Page>
  );
}

/** A big number with its noun; the translated label already contains the count, so only the noun is shown next to it. */
function MapStat({ label, value }: { label: string; value: number }) {
  const noun = label.replace(/^[\d.,\s]+/u, "");
  return (
    <div className="flex items-baseline gap-1.5">
      <dd className="text-lg font-medium tabular-nums tracking-tight text-foreground">{value}</dd>
      <dt className="text-xs text-muted-foreground">{noun}</dt>
    </div>
  );
}

function curvedEdgePath(source: LayoutNode, target: LayoutNode, index: number): string {
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  const bend = Math.min(38, distance * 0.12) * (index % 2 === 0 ? 1 : -1);
  const controlX = (source.x + target.x) / 2 - (deltaY / distance) * bend;
  const controlY = (source.y + target.y) / 2 + (deltaX / distance) * bend;
  return `M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`;
}

function GraphCanvas({ nodes, edges, selectedId, onPanChange, onSelect, onZoomChange, pan, zoom, t }: {
  nodes: readonly BrainMapNode[];
  edges: readonly BrainMapEdge[];
  selectedId: string | null;
  onPanChange: (pan: ViewportPan) => void;
  onSelect: (id: string) => void;
  onZoomChange: (zoom: number) => void;
  pan: ViewportPan;
  zoom: number;
  t: Translator;
}) {
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{
    readonly pointerId: number;
    readonly startClientX: number;
    readonly startClientY: number;
    readonly startPan: ViewportPan;
  } | null>(null);
  const plotted = useMemo(() => layoutBrainMap(nodes, edges), [edges, nodes]);
  const byId = useMemo(() => new Map(plotted.map((node) => [node.id, node])), [plotted]);
  const transform = `translate(${500 - 500 * zoom + pan.x} ${300 - 300 * zoom + pan.y}) scale(${zoom})`;
  function startPanning(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("[data-brain-map-node]")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPan: pan,
    };
    setHoveredEdgeId(null);
    setDragging(true);
  }
  function moveCanvas(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const pixelsPerViewBoxUnit = Math.min(bounds.width / 1000, bounds.height / 600);
    if (!Number.isFinite(pixelsPerViewBoxUnit) || pixelsPerViewBoxUnit <= 0) return;
    event.preventDefault();
    onPanChange({
      x: Number((drag.startPan.x + (event.clientX - drag.startClientX) / pixelsPerViewBoxUnit).toFixed(2)),
      y: Number((drag.startPan.y + (event.clientY - drag.startClientY) / pixelsPerViewBoxUnit).toFixed(2)),
    });
  }
  function stopPanning(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  }
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const zoomWithWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      onZoomChange(clampZoom(zoom * Math.exp(-event.deltaY * 0.0015)));
    };
    canvas.addEventListener("wheel", zoomWithWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", zoomWithWheel);
  }, [onZoomChange, zoom]);
  return (
    <div className="brain-map-canvas relative h-full overflow-hidden">
      <svg
        aria-label={t("brainMap.graph.ariaLabel")}
        className={cn("brain-map-viewport h-full w-full", dragging ? "cursor-grabbing" : "cursor-grab")}
        data-dragging={dragging}
        data-pan-x={pan.x}
        data-pan-y={pan.y}
        data-zoom={zoom}
        onPointerCancel={stopPanning}
        onPointerDown={startPanning}
        onPointerMove={moveCanvas}
        onPointerUp={stopPanning}
        preserveAspectRatio="xMidYMid meet"
        ref={canvasRef}
        role="group"
        viewBox="0 0 1000 600"
      >
        <defs>
          <linearGradient id="brain-map-signal-gradient" gradientUnits="userSpaceOnUse" x1="80" x2="920" y1="80" y2="520">
            <stop offset="0%" stopColor="var(--aurora-orange)" />
            <stop offset="52%" stopColor="var(--aurora-pink)" />
            <stop offset="100%" stopColor="var(--aurora-blue)" />
          </linearGradient>
          <linearGradient id="brain-map-aurora" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--aurora-orange)" />
            <stop offset="52%" stopColor="var(--aurora-pink)" />
            <stop offset="100%" stopColor="var(--aurora-blue)" />
          </linearGradient>
          <filter height="180%" id="brain-map-edge-glow" width="180%" x="-40%" y="-40%">
            <feGaussianBlur in="SourceGraphic" result="blur" stdDeviation="2.4" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g transform={transform}>
          {edges.map((edge, index) => {
            const source = byId.get(edge.source);
            const target = byId.get(edge.target);
            if (!source || !target) return null;
            const selected = selectedId === edge.source || selectedId === edge.target;
            const hovered = hoveredEdgeId === edge.id;
            const path = curvedEdgePath(source, target, index);
            return (
              <g
                data-edge-id={edge.id}
                data-hovered={hovered}
                key={edge.id}
                onMouseEnter={() => setHoveredEdgeId(edge.id)}
                onMouseLeave={() => setHoveredEdgeId((current) => current === edge.id ? null : current)}
              >
                <path
                  className={cn(
                    "brain-map-edge",
                    selected && "brain-map-edge--selected",
                    hovered && "brain-map-edge--hovered",
                  )}
                  d={path}
                  stroke={hovered ? "url(#brain-map-signal-gradient)" : selected ? "var(--aurora-pink)" : "var(--muted-foreground)"}
                />
                {hovered && (
                  <circle className="brain-map-synapse-pulse" fill="var(--aurora-pink)" r="3.2">
                    <animateMotion dur="900ms" path={path} repeatCount="indefinite" />
                  </circle>
                )}
                <path aria-hidden="true" className="brain-map-edge-hit" d={path} />
              </g>
            );
          })}
          {plotted.map((node) => {
            const selected = selectedId === node.id;
            const ariaLabel = `${t(`brainMap.nodeType.${node.type}`)}: ${node.label}`;
            const selectOnKeyboard = (event: KeyboardEvent<SVGGElement>) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(node.id);
              }
            };
            return (
              <g
                aria-label={ariaLabel}
                className="brain-map-node group cursor-pointer outline-none"
                data-brain-map-node=""
                key={node.id}
                onClick={() => onSelect(node.id)}
                onKeyDown={selectOnKeyboard}
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() => setHoveredNodeId((current) => (current === node.id ? null : current))}
                role="button"
                tabIndex={0}
                transform={`translate(${node.x} ${node.y})`}
              >
                <circle
                  className={cn("transition-opacity group-focus-visible:opacity-100", selected ? "opacity-100" : "opacity-0")}
                  fill="none"
                  r={node.radius + 8}
                  stroke={nodeTone[node.type].stroke}
                  strokeOpacity="0.5"
                  strokeWidth="1.5"
                />
                <NodeGlyph node={node} />
                {(node.labelVisible || selected || hoveredNodeId === node.id) && (
                  <text
                    fill={selected ? "var(--foreground)" : "var(--muted-foreground)"}
                    fontSize="10.5"
                    fontWeight={selected ? 600 : 500}
                    paintOrder="stroke"
                    stroke="var(--card)"
                    strokeWidth="4"
                    {...labelPlacement(node)}
                  >
                    {truncateLabel(node.label)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

/** Where a node's label sits, as decided by the layout so labels never cover each other. */
function labelPlacement(node: LayoutNode): { x?: number; y: number; textAnchor: "middle" | "start" | "end" } {
  switch (node.labelSide) {
    case "above":
      return { y: -(node.radius + 10), textAnchor: "middle" };
    case "right":
      return { x: node.radius + 7, y: 3.5, textAnchor: "start" };
    case "left":
      return { x: -(node.radius + 7), y: 3.5, textAnchor: "end" };
    default:
      return { y: node.radius + 18, textAnchor: "middle" };
  }
}

/**
 * One small mark per kind inside the node: a dot for a memory, a dot in a ring
 * for a person, two lines of text for a document, a folder, a diamond for a
 * project. Memories are the only nodes drawn in the sunrise.
 */
function NodeGlyph({ node }: { node: LayoutNode }) {
  const tone = nodeTone[node.type];
  const unit = Math.max(2.4, node.radius * 0.24);
  let marker;
  if (node.type === "document") {
    marker = <path d={`M ${-unit * 1.2} ${-unit * 0.7} H ${unit * 1.2} M ${-unit * 1.2} ${unit * 0.7} H ${unit * 0.3}`} fill="none" stroke={tone.stroke} strokeLinecap="round" strokeWidth="1.4" />;
  } else if (node.type === "project") {
    marker = <path d={`M 0 ${-unit * 1.25} L ${unit * 1.25} 0 L 0 ${unit * 1.25} L ${-unit * 1.25} 0 Z`} fill="none" stroke={tone.stroke} strokeLinejoin="round" strokeWidth="1.4" />;
  } else if (node.type === "knowledge_base") {
    marker = <path d={`M ${-unit * 1.4} ${-unit * 0.9} h ${unit * 0.9} l ${unit * 0.4} ${unit * 0.45} h ${unit * 1.5} v ${unit * 1.5} h ${-unit * 2.8} z`} fill="none" stroke={tone.stroke} strokeLinejoin="round" strokeWidth="1.3" />;
  } else if (node.type === "person") {
    marker = (
      <>
        <circle fill={tone.stroke} r={unit * 0.8} />
        <circle fill="none" r={unit * 1.7} stroke={tone.stroke} strokeOpacity="0.7" strokeWidth="1" />
      </>
    );
  } else {
    marker = <circle fill={tone.stroke} r={unit} />;
  }
  return (
    <g className="brain-map-node-glyph">
      <circle className="brain-map-node-aura" fill={tone.stroke} fillOpacity="0.08" r={node.radius + 6} />
      <circle className="brain-map-node-soma" fill={tone.fill} r={node.radius} stroke={node.type === "memory" ? "url(#brain-map-aurora)" : tone.stroke} strokeWidth="1.4" />
      {marker}
    </g>
  );
}

function DetailPanel({ node, edges, nodes, onSelect, onClose, locale, t }: {
  node: BrainMapNode | null;
  edges: readonly BrainMapEdge[];
  nodes: readonly BrainMapNode[];
  onSelect: (id: string) => void;
  onClose: () => void;
  locale: "en" | "pt-BR" | "es";
  t: Translator;
}) {
  if (node === null) return null;
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const related = edges
    .map((edge) => byId.get(edge.source === node.id ? edge.target : edge.source))
    .filter((candidate): candidate is BrainMapNode => candidate !== undefined);
  const route = sourceRoute(node, edges);
  return (
    <Card className="absolute bottom-3 right-3 z-20 max-h-[calc(100%-8rem)] w-[min(22rem,calc(100%-1.5rem))] overflow-y-auto border-border/70 bg-card/95 shadow-elevated backdrop-blur-md">
      <CardHeader className="relative border-b border-border/60 pr-14">
        <CardTitle role="heading">{node.label}</CardTitle>
        {node.description && <CardDescription className="line-clamp-6">{node.description}</CardDescription>}
        <Meta>
          <MetaItem>
            <span aria-hidden="true" className="size-2 rounded-full border" style={{ background: nodeTone[node.type].fill, borderColor: nodeTone[node.type].stroke }} />
            {t(`brainMap.nodeType.${node.type}`)}
          </MetaItem>
          {node.version !== null && <MetaItem>{t("brainMap.detail.version", { version: node.version })}</MetaItem>}
          <MetaItem>{t("brainMap.detail.created", { date: formatDate(node.createdAt, locale) })}</MetaItem>
          {node.updatedAt && <MetaItem>{t("brainMap.detail.updated", { date: formatDate(node.updatedAt, locale) })}</MetaItem>}
        </Meta>
        <Button
          aria-label={t("brainMap.detail.close")}
          className="absolute right-4 top-4"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 pt-4 sm:pt-5">
        {node.tags.length > 0 && (
          <Meta>
            {node.tags.map((tag) => (
              <MetaItem key={tag}>
                <span aria-hidden="true" className="opacity-50">#</span>
                {tag}
              </MetaItem>
            ))}
          </Meta>
        )}
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            {t("brainMap.detail.connections", { count: related.length })}
          </p>
          <ul className="mt-1 divide-y divide-border/60">
            {related.map((candidate) => (
              <li key={candidate.id}>
                <button
                  className="flex w-full cursor-pointer items-center gap-2 py-1.5 text-left text-xs font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                  onClick={() => onSelect(candidate.id)}
                  type="button"
                >
                  <span aria-hidden="true" className="size-2 shrink-0 rounded-full border" style={{ background: nodeTone[candidate.type].fill, borderColor: nodeTone[candidate.type].stroke }} />
                  <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {route && (
          <Link
            className={cn(buttonVariants({ variant: "outline" }), "w-full")}
            to={route}
          >
            {t("brainMap.detail.openRecord")} <ExternalLink aria-hidden="true" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function sourceRoute(node: BrainMapNode, edges: readonly BrainMapEdge[]): string | null {
  if (node.id.startsWith("mock:")) return null;
  if (node.type === "memory") return "/memories";
  if (node.type === "knowledge_base") return `/knowledge/${node.id}`;
  if (node.type === "document") {
    const container = edges.find((edge) => edge.type === "contains" && edge.target === node.id);
    return container ? `/knowledge/${container.source}/documents/${node.id}` : "/knowledge";
  }
  return null;
}
