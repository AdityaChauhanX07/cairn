// Derivations over the synthesized guide: the trimmed dependency graph and the
// environment object counts. Shared by the guide screen, the findings screen,
// and the app shell's sidebar so the numbers stay consistent everywhere.
import type { Guide, GraphNode, GraphEdge } from '../types';

export interface SnapNode {
  type: string;
  name: string;
  properties?: Record<string, unknown>;
}

export interface Counts {
  index: number;
  alert: number;
  saved_search: number;
  macro: number;
  lookup: number;
  dashboard: number;
  critical: number;
  owners: number;
  total: number;
  mltkAlgorithms: number;
  mltkModels: number;
}

export function looksCritical(node: SnapNode): boolean {
  const sev = node.properties?.alert_severity;
  if (typeof sev === 'number') return sev >= 5;
  if (typeof sev === 'string' && /crit|^5$|high/i.test(sev)) return true;
  return /^critical\b/i.test(node.name);
}

export function deriveCounts(guide: Guide): Counts {
  const nodes = (guide.graph_snapshot?.nodes as SnapNode[] | undefined) ?? [];
  const c: Counts = {
    index: 0, alert: 0, saved_search: 0, macro: 0, lookup: 0, dashboard: 0,
    critical: 0, owners: 0, total: nodes.length,
    mltkAlgorithms: guide.mltk_algorithm_count ?? 0,
    mltkModels: guide.mltk_model_count ?? 0,
  };
  const owners = new Set<string>();
  for (const n of nodes) {
    if (n.type in c) (c as unknown as Record<string, number>)[n.type] += 1;
    if (n.type === 'alert' && looksCritical(n)) c.critical += 1;
    const owner = n.properties?.owner;
    if (typeof owner === 'string' && owner.trim()) owners.add(owner);
  }
  c.owners = owners.size;
  return c;
}

// Node types / edge relationships the visual graph cares about — used when
// falling back to the full graph_snapshot for guides generated before the
// trimmed graph_nodes / graph_edges fields existed.
const VIEW_NODE_TYPES = ['alert', 'saved_search', 'macro', 'lookup', 'index'];
const VIEW_EDGE_TYPES = ['references_macro', 'references_lookup', 'reads_from_index'];

export function deriveGuideGraph(guide: Guide): { nodes: GraphNode[]; edges: GraphEdge[] } {
  // Preferred: the backend already trimmed these for us.
  if (guide.graph_nodes && guide.graph_edges) {
    return { nodes: guide.graph_nodes, edges: guide.graph_edges };
  }
  // Fallback: filter the full snapshot the same way the backend would.
  const snapNodes = (guide.graph_snapshot?.nodes as SnapNode[] | undefined) ?? [];
  const snapEdges =
    (guide.graph_snapshot?.edges as { source: string; target: string; type: string }[] | undefined) ?? [];
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  for (const n of snapNodes) {
    const anyN = n as SnapNode & { id?: string };
    if (!VIEW_NODE_TYPES.includes(n.type)) continue;
    if (n.properties?.placeholder) continue;
    if (n.type === 'index' && n.name.startsWith('_')) continue;
    const id = anyN.id ?? `${n.type}:${n.name}`;
    ids.add(id);
    nodes.push({ id, name: n.name, type: n.type as GraphNode['type'] });
  }
  const edges: GraphEdge[] = snapEdges
    .filter((e) => VIEW_EDGE_TYPES.includes(e.type) && ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, relationship: e.type }));
  return { nodes, edges };
}

// Short label for a left-rail / sidebar count badge per guide section.
export function navCount(title: string, c: Counts): string {
  switch (title) {
    case 'Critical Alerts & What They Mean': return String(c.alert);
    case 'Your Data Landscape': return String(c.index);
    case "Your Team's Dashboards": return String(c.dashboard);
    case 'The Shorthand': return String(c.macro + c.lookup);
    case 'Who Knows What': return c.owners ? String(c.owners) : '';
    case 'AI & ML Footprint': return c.mltkAlgorithms ? String(c.mltkAlgorithms) : '';
    default: return '';
  }
}
