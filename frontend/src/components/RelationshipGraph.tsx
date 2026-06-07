// Layered dependency graph. Click a node to trace its downstream chain; dead /
// orphaned nodes (Mode B) render dashed. Reads the backend's trimmed graph
// (GraphNode / GraphEdge) directly — `saved_search` nodes are drawn on the
// `search` layer to match the design's alert → saved → macro → lookup → index
// hierarchy.
import { useMemo } from 'react';
import { NODE_TONE } from './Primitives';
import type { GraphNode, GraphEdge } from '../types';

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  deadNodeIds?: string[];
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  focusNode?: string | null;
  height?: number;
  hint?: boolean;
}

const LAYERS = ['alert', 'search', 'macro', 'lookup', 'index'] as const;
const LAYER_Y: Record<string, number> = { alert: 64, search: 150, macro: 240, lookup: 320, index: 404 };
const W = 1180;
const H = 470;
const PAD_X = 70;

// The backend layer a node belongs to (saved_search shares the "search" row).
function layerOf(type: string): string {
  return type === 'saved_search' ? 'search' : type;
}

export default function RelationshipGraph({
  nodes, edges, deadNodeIds = [], selected, onSelect, focusNode, height = 440, hint = true,
}: Props) {
  // Position nodes across their layer, evenly spaced.
  const pos = useMemo(() => {
    const p: Record<string, { x: number; y: number; node: GraphNode }> = {};
    for (const layer of LAYERS) {
      const ns = nodes.filter((n) => layerOf(n.type) === layer);
      const span = W - PAD_X * 2;
      ns.forEach((n, i) => {
        const x = ns.length === 1 ? W / 2 : PAD_X + (span * i) / (ns.length - 1);
        p[n.id] = { x, y: LAYER_Y[layer], node: n };
      });
    }
    return p;
  }, [nodes]);

  // Downstream adjacency for chain tracing.
  const adj = useMemo(() => {
    const a: Record<string, string[]> = {};
    for (const e of edges) (a[e.source] = a[e.source] || []).push(e.target);
    return a;
  }, [edges]);

  const active = selected || focusNode || null;

  const traced = useMemo(() => {
    if (!active || !pos[active]) return null;
    const seen = new Set<string>([active]);
    const stack = [active];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const nx of adj[cur] || []) {
        if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
      }
    }
    // Include direct upstream so clicking an index shows what depends on it.
    for (const e of edges) if (e.target === active) seen.add(e.source);
    return seen;
  }, [active, adj, edges, pos]);

  const dead = useMemo(() => new Set(deadNodeIds), [deadNodeIds]);

  const edgePath = (a: string, b: string): string | null => {
    const A = pos[a];
    const B = pos[b];
    if (!A || !B) return null;
    const my = (A.y + B.y) / 2;
    return `M ${A.x} ${A.y + 14} C ${A.x} ${my}, ${B.x} ${my}, ${B.x} ${B.y - 14}`;
  };

  if (edges.length === 0) return null;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {hint && (
        <div style={{ position: 'absolute', top: 14, right: 18, zIndex: 3 }} className="eyebrow">
          {active ? 'tracing dependency chain' : 'click any node to trace its chain'}
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ height, display: 'block' }}
        onClick={() => onSelect && onSelect(null)}
        role="img"
        aria-label="Relationship graph of Splunk knowledge objects"
      >
        <defs>
          <linearGradient id="emberEdge" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--ember)" stopOpacity="0.9" />
            <stop offset="1" stopColor="var(--ember)" stopOpacity="0.5" />
          </linearGradient>
        </defs>

        {/* layer labels */}
        {LAYERS.map((l) => (
          <text
            key={l}
            x={20}
            y={LAYER_Y[l] + 4}
            fontFamily="var(--mono)"
            fontSize="10"
            letterSpacing="1.5"
            fill="var(--text-4)"
            style={{ textTransform: 'uppercase' }}
          >
            {l === 'search' ? 'saved' : l}
          </text>
        ))}

        {/* edges */}
        <g>
          {edges.map((e, i) => {
            const d = edgePath(e.source, e.target);
            if (!d) return null;
            const lit = !!traced && traced.has(e.source) && traced.has(e.target);
            return (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={lit ? 'url(#emberEdge)' : 'var(--line-2)'}
                strokeWidth={lit ? 1.8 : 1}
                opacity={active ? (lit ? 1 : 0.18) : 0.5}
                style={{ transition: 'opacity .35s, stroke-width .25s' }}
              />
            );
          })}
        </g>

        {/* nodes */}
        <g>
          {Object.entries(pos).map(([id, P]) => {
            const n = P.node;
            const tone = NODE_TONE[n.type] || 'var(--text-2)';
            const isDead = dead.has(id);
            const isEmpty = n.type === 'index' && (n.eventCount ?? -1) === 0;
            const dim = !!active && !!traced && !traced.has(id);
            const isActive = active === id;
            const label = n.name.length > 17 ? n.name.slice(0, 16) + '…' : n.name;
            const w = Math.max(72, label.length * 6.6 + 30);
            return (
              <g
                key={id}
                transform={`translate(${P.x - w / 2}, ${P.y - 13})`}
                style={{ cursor: 'pointer', transition: 'opacity .35s', opacity: dim ? 0.22 : 1 }}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onSelect && onSelect(isActive ? null : id);
                }}
              >
                <title>{isDead ? `${n.type}: ${n.name} — flagged (Mode B)` : `${n.type}: ${n.name}`}</title>
                <rect
                  width={w}
                  height={26}
                  rx={7}
                  fill={isActive ? 'var(--ember-dim)' : 'var(--surface-2)'}
                  stroke={isActive ? 'var(--ember)' : isDead ? 'var(--sev-med)' : `${tone}88`}
                  strokeWidth={isActive ? 1.6 : 1}
                  strokeDasharray={isDead ? '3 3' : undefined}
                />
                <circle cx={12} cy={13} r={3.5} fill={tone} opacity={isEmpty ? 0.4 : 1} />
                <text
                  x={22}
                  y={17}
                  fontFamily="var(--mono)"
                  fontSize="11"
                  fill={isActive ? 'var(--ember-text)' : dim ? 'var(--text-3)' : 'var(--text)'}
                >
                  {label}
                </text>
                {isDead && (
                  <text x={w - 8} y={17} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--sev-med)">
                    orphan
                  </text>
                )}
                {isEmpty && !isDead && (
                  <text x={w - 8} y={17} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--text-4)">
                    empty
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* legend */}
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, paddingLeft: 4 }}>
        {([['alert', 'alert'], ['search', 'saved search'], ['macro', 'macro'], ['lookup', 'lookup'], ['index', 'index']] as const).map(
          ([t, l]) => (
            <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: NODE_TONE[t] }} /> {l}
            </span>
          ),
        )}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--sev-med)' }}>
          <span style={{ width: 10, height: 8, borderRadius: 3, border: '1px dashed var(--sev-med)' }} /> orphan
        </span>
      </div>
    </div>
  );
}
