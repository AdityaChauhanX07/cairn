import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode, GraphEdge, GraphNodeType } from '../types';

interface RelationshipGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  animated?: boolean; // true during exploration (nodes fade in), false in guide
  focusedNodeId?: string | null; // set externally (e.g. by a chip click) to highlight a chain
  onNodeClick?: (nodeId: string | null) => void;
  deadNodeIds?: string[]; // Mode B: orphaned / dead nodes to flag in red
}

// Top-to-bottom layering. The dependency story reads downward:
// alert → saved search → macro → lookup → index.
const TYPE_ORDER: GraphNodeType[] = ['alert', 'saved_search', 'macro', 'lookup', 'index'];

// Per-type tint, pulled from the design tokens (chip colors).
const TYPE_COLOR: Record<string, string> = {
  alert: 'var(--type-alert)',
  saved_search: 'var(--type-saved-search)',
  macro: 'var(--type-macro)',
  lookup: 'var(--type-lookup)',
  index: 'var(--type-index)',
};

const LAYER_HEIGHT = 80;
const NODE_WIDTH = 160;
const NODE_HEIGHT = 36;
const NODE_GAP = 20;
const PADDING = 40;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 300;

// Icon sits at the left of the node; the label flows after it.
const ICON_SIZE = 14;
const ICON_X = 12;
const TEXT_X = 34;
const TEXT_RIGHT_PAD = 12;

// Per-type glyph drawn in a 14×14 box (stroke-based, inherits the node tint via
// currentColor). Kept deliberately simple so they read at 14px.
const TYPE_ICON: Partial<Record<GraphNodeType, string[]>> = {
  // warning triangle with an exclamation
  alert: ['M7 1.5 L13 12 H1 Z', 'M7 5.5 V8.5', 'M7 10.4 V10.5'],
  // magnifier
  saved_search: ['M6 6 m-4 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0', 'M9 9 L12.5 12.5'],
  // function braces
  macro: ['M6 2 C4 2 5 6 3 7 C5 8 4 12 6 12', 'M8 2 C10 2 9 6 11 7 C9 8 10 12 8 12'],
  // table with a divider
  lookup: ['M2 3 H12 V11 H2 Z', 'M2 6.3 H12', 'M6.7 3 V11'],
  // database cylinder
  index: ['M2 3 C2 1.9 4.2 1 7 1 C9.8 1 12 1.9 12 3 C12 4.1 9.8 5 7 5 C4.2 5 2 4.1 2 3', 'M2 3 V11 C2 12.1 4.2 13 7 13 C9.8 13 12 12.1 12 11 V3'],
};

function NodeIcon({ type, color }: { type: GraphNodeType; color: string }) {
  const paths = TYPE_ICON[type];
  if (!paths) return null;
  return (
    <g
      transform={`translate(${ICON_X}, ${(NODE_HEIGHT - ICON_SIZE) / 2})`}
      fill="none"
      stroke={color}
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      pointerEvents="none"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  );
}

interface Pos {
  x: number;
  y: number;
}

interface Layout {
  positions: Record<string, Pos>;
  width: number;
  height: number;
}

// Arrange the relevant nodes into horizontal, evenly-spaced layers by type.
function layoutNodes(nodes: GraphNode[]): Layout {
  const layers = TYPE_ORDER.map((type) => nodes.filter((n) => n.type === type));

  const maxCount = layers.reduce((m, l) => Math.max(m, l.length), 0);
  const widestRow = maxCount * NODE_WIDTH + Math.max(0, maxCount - 1) * NODE_GAP;
  const width = Math.max(MIN_WIDTH, widestRow + PADDING * 2);

  // Only count layers that actually have nodes toward the height, so an empty
  // middle layer doesn't leave a dead band.
  const occupied = layers.map((l) => l.length > 0);
  const lastOccupied = occupied.lastIndexOf(true);
  const height = Math.max(
    MIN_HEIGHT,
    PADDING * 2 + (lastOccupied + 1) * LAYER_HEIGHT - (LAYER_HEIGHT - NODE_HEIGHT),
  );

  const positions: Record<string, Pos> = {};
  layers.forEach((layer, layerIndex) => {
    const rowWidth = layer.length * NODE_WIDTH + Math.max(0, layer.length - 1) * NODE_GAP;
    const startX = (width - rowWidth) / 2;
    layer.forEach((node, nodeIndex) => {
      positions[node.id] = {
        x: startX + nodeIndex * (NODE_WIDTH + NODE_GAP),
        y: PADDING + layerIndex * LAYER_HEIGHT,
      };
    });
  });

  return { positions, width, height };
}

// A gentle downward S-curve from the bottom-center of source to top-center of
// target. Cubic with vertical control points reads cleanly for a hierarchy.
function edgePath(s: Pos, t: Pos): string {
  const x1 = s.x + NODE_WIDTH / 2;
  const y1 = s.y + NODE_HEIGHT;
  const x2 = t.x + NODE_WIDTH / 2;
  const y2 = t.y;
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

function truncate(name: string): string {
  // Space left for the label after the icon, at ~0.72rem mono ≈ 7px/char.
  const max = Math.floor((NODE_WIDTH - TEXT_X - TEXT_RIGHT_PAD) / 7);
  if (name.length <= max) return name;
  return name.slice(0, Math.max(1, max - 1)) + '…';
}

// All nodes reachable downward from `start` (inclusive) — the dependency chain.
function descendants(start: string, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const next of adjacency.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

export default function RelationshipGraph({
  nodes,
  edges,
  animated = false,
  focusedNodeId,
  onNodeClick,
  deadNodeIds,
}: RelationshipGraphProps) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const deadSet = useMemo(() => new Set(deadNodeIds ?? []), [deadNodeIds]);

  // Mirror an externally-driven focus (a chip click) into the internal state so
  // it lights up the same chain as a direct node click. undefined means the
  // parent isn't controlling focus, so we leave internal interaction alone.
  useEffect(() => {
    if (focusedNodeId !== undefined) setFocusId(focusedNodeId);
  }, [focusedNodeId]);

  // Tracks which node / edge keys have already been on screen, so freshly
  // arrived ones (during live exploration) get the enter animation exactly once.
  const seenNodes = useRef<Set<string>>(new Set());
  const seenEdges = useRef<Set<string>>(new Set());

  // Keep only the node types we lay out, and drop edges whose endpoints aren't
  // both present (defensive — the backend already trims, but live snapshots
  // can momentarily reference a node that hasn't landed yet).
  const relevantNodes = useMemo(
    () => nodes.filter((n) => TYPE_ORDER.includes(n.type)),
    [nodes],
  );
  const nodeIds = useMemo(() => new Set(relevantNodes.map((n) => n.id)), [relevantNodes]);
  const relevantEdges = useMemo(
    () => edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target)),
    [edges, nodeIds],
  );

  const { positions, width, height } = useMemo(
    () => layoutNodes(relevantNodes),
    [relevantNodes],
  );

  const adjacency = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of relevantEdges) {
      const list = m.get(e.source) ?? [];
      list.push(e.target);
      m.set(e.source, list);
    }
    return m;
  }, [relevantEdges]);

  const highlighted = useMemo(
    () => (focusId ? descendants(focusId, adjacency) : null),
    [focusId, adjacency],
  );

  // Clear focus if the focused node disappears (e.g. graph re-fetched).
  useEffect(() => {
    if (focusId && !nodeIds.has(focusId)) setFocusId(null);
  }, [focusId, nodeIds]);

  // After paint, remember everything currently on screen as "seen".
  useEffect(() => {
    for (const n of relevantNodes) seenNodes.current.add(n.id);
    for (const e of relevantEdges) seenEdges.current.add(`${e.source}->${e.target}`);
  });

  // Nothing to show without dependencies — don't render an orphan node soup.
  if (relevantEdges.length === 0) return null;

  function handleNodeClick(id: string) {
    const next = focusId === id ? null : id;
    setFocusId(next);
    onNodeClick?.(next);
  }

  function isEdgeHighlighted(e: GraphEdge): boolean {
    if (!highlighted) return false;
    return highlighted.has(e.source) && highlighted.has(e.target);
  }

  return (
    <div
      className="graph-container"
      onClick={() => {
        setFocusId(null);
        onNodeClick?.(null);
      }}
    >
      <svg
        className="relationship-graph"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        style={{
          width: '100%',
          height: 'auto',
          maxWidth: width,
          minHeight: MIN_HEIGHT,
          display: 'block',
          margin: '0 auto',
        }}
        role="img"
        aria-label="Relationship graph of Splunk knowledge objects"
      >
        {/* Edges first so nodes sit on top of them */}
        <g className="graph-edges">
          {relevantEdges.map((e) => {
            const s = positions[e.source];
            const t = positions[e.target];
            if (!s || !t) return null;
            const key = `${e.source}->${e.target}`;
            const hl = isEdgeHighlighted(e);
            const dimmed = highlighted !== null && !hl;
            const isNew = animated && !seenEdges.current.has(key);
            return (
              <path
                key={key}
                className={[
                  'graph-edge',
                  hl ? 'graph-highlighted-edge' : '',
                  dimmed ? 'graph-dimmed' : '',
                  isNew ? 'edge-entering' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                d={edgePath(s, t)}
                pathLength={1}
                fill="none"
                stroke={hl ? 'var(--accent-amber)' : 'var(--border)'}
                strokeOpacity={hl ? 1 : 0.6}
                strokeWidth={hl ? 2.5 : 1.5}
              />
            );
          })}
        </g>

        {/* Nodes */}
        <g className="graph-nodes">
          {relevantNodes.map((n) => {
            const p = positions[n.id];
            if (!p) return null;
            const color = TYPE_COLOR[n.type] ?? 'var(--border)';
            const hl = highlighted?.has(n.id) ?? false;
            const dimmed = highlighted !== null && !hl;
            const isNew = animated && !seenNodes.current.has(n.id);
            const isDead = deadSet.has(n.id);
            const DEAD_COLOR = 'var(--accent-red, #f87171)';
            return (
              <g
                key={n.id}
                className={[
                  'graph-node',
                  dimmed ? 'graph-dimmed' : '',
                  isNew ? 'entering' : '',
                  isDead ? 'graph-node-dead' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                transform={`translate(${p.x}, ${p.y})`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  handleNodeClick(n.id);
                }}
              >
                <title>{isDead ? `${n.type}: ${n.name} — flagged (Mode B)` : `${n.type}: ${n.name}`}</title>
                <rect
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={6}
                  ry={6}
                  fill={isDead ? DEAD_COLOR : color}
                  fillOpacity={isDead ? 0.12 : hl ? 0.28 : 0.15}
                  stroke={isDead ? DEAD_COLOR : color}
                  strokeOpacity={isDead ? 0.9 : hl || highlighted === null ? 0.7 : 0.4}
                  strokeWidth={isDead ? 1.5 : 1}
                  strokeDasharray={isDead ? '4 2' : undefined}
                />
                {isDead && (
                  <circle cx={NODE_WIDTH - 7} cy={7} r={4} fill={DEAD_COLOR} stroke="var(--bg-base, #0a0c10)" strokeWidth={1}>
                    <title>Flagged by Mode B</title>
                  </circle>
                )}
                <NodeIcon type={n.type} color={isDead ? DEAD_COLOR : color} />
                <text
                  x={TEXT_X}
                  y={NODE_HEIGHT / 2}
                  textAnchor="start"
                  dominantBaseline="central"
                  className="graph-node-label"
                  fill={hl ? 'var(--text-primary)' : 'var(--text-secondary)'}
                >
                  {truncate(n.name)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
