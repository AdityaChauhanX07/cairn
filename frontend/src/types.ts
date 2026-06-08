export interface AgentEvent {
  phase: 'orient' | 'investigate' | 'reason' | 'synthesize' | 'done';
  message: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface GuideSection {
  title: string;
  content: string;
}

// ── Relationship graph ──────────────────────────────────────────────────────
// Mirrors RelationshipGraph.relationship_view() on the backend.
export type GraphNodeType =
  | 'alert'
  | 'saved_search'
  | 'macro'
  | 'lookup'
  | 'index'
  | 'dashboard'
  | 'sourcetype';

export interface GraphNode {
  id: string;
  name: string;
  type: GraphNodeType;
  eventCount?: number;
  sourcetypes?: string[];
}

export interface GraphEdge {
  source: string; // node id
  target: string; // node id
  relationship: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Structured guide data (Mode A rich cards) ────────────────────────────────
// Mirrors Orchestrator._build_structured_data(). Additive to `sections`
// (markdown): present → render rich cards, absent → fall back to markdown.
export interface ObjectRef {
  name: string;
  type: string;
}

export interface StructuredAlert {
  name: string;
  severity: string;
  spl: string;
  spl_explanation: string;
  owner: string;
  actions: string;
  cron: string;
  chain: ObjectRef[];
}

export interface StructuredSearch {
  name: string;
  spl: string;
  spl_explanation: string;
  owner: string;
  cron: string;
}

export interface StructuredIndex {
  name: string;
  eventCount: number;
  sizeMB: number;
  sourcetypes: string[];
  category: string;
  usedBy: ObjectRef[];
}

export interface StructuredDashboard {
  name: string;
  owner: string;
  indexes: string[];
  panelCount: number;
}

export interface StructuredMacro {
  name: string;
  definition: string;
  usedBy: ObjectRef[];
}

export interface StructuredLookup {
  name: string;
  usedBy: ObjectRef[];
}

export interface StructuredUser {
  name: string;
  roles: string;
}

export interface StructuredData {
  alerts: StructuredAlert[];
  saved_searches: StructuredSearch[];
  indexes: StructuredIndex[];
  dashboards: StructuredDashboard[];
  macros: StructuredMacro[];
  lookups: StructuredLookup[];
  users: StructuredUser[];
  mltk_algorithms: string[];
  mltk_models: string[];
}

// Matches OnboardingGuide.to_dict() from the backend: a flat map of
// section title -> markdown body, plus the full markdown and graph snapshot.
export interface Guide {
  markdown: string;
  sections: Record<string, string>;
  graph_snapshot?: Record<string, unknown>;
  graph_nodes?: GraphNode[];
  graph_edges?: GraphEdge[];
  // MLTK / AI-Toolkit footprint counts (0 / absent when MLTK isn't installed).
  mltk_algorithm_count?: number;
  mltk_model_count?: number;
  // Per-object structured data for rich rendering (absent on older backends).
  structured?: StructuredData;
}

export interface LiveQuery {
  type: 'spl_query' | 'saved_search' | string;
  query?: string;
  name?: string;
}

export interface AskResponse {
  answer: string;
  live_queries: LiveQuery[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  liveQueries?: LiveQuery[];
}

// ── Starter kit (Mode C) ────────────────────────────────────────────────────
// Mirrors StarterKit.to_dict() on the backend.
export interface GeneratedSPL {
  title: string;
  description: string;
  spl: string;
  category: string;
}

export interface Runbook {
  alert_name: string;
  severity: string;
  what_it_means: string;
  chain_summary: string;
  first_checks: string[];
  spl_to_run: string;
  who_to_contact: string;
}

export interface DashboardPanel {
  title: string;
  spl: string;
  viz_type: string;
}

export interface StarterKit {
  generated_queries: GeneratedSPL[];
  runbooks: Runbook[];
  dashboard_panels: DashboardPanel[];
  dashboard_xml: string;
}

// ── Findings (Mode B — Flag) ─────────────────────────────────────────────────
// Mirrors FindingsReport.to_dict() on the backend.
export interface Finding {
  id: string;
  category:
    | 'orphaned_object'
    | 'alert_empty_index'
    | 'alert_no_action'
    | 'alert_no_owner'
    | string;
  severity: 'high' | 'medium' | 'low' | string;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  affected_node_id: string;
  fix: string;
  fix_spl: string;
}

export interface FindingsReport {
  findings: Finding[];
  dead_node_ids: string[];
  counts: Record<string, number>;
}

export type AppState = 'connect' | 'explore' | 'guide' | 'qa';
