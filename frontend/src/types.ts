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

// Matches OnboardingGuide.to_dict() from the backend: a flat map of
// section title -> markdown body, plus the full markdown and graph snapshot.
export interface Guide {
  markdown: string;
  sections: Record<string, string>;
  graph_snapshot?: Record<string, unknown>;
  graph_nodes?: GraphNode[];
  graph_edges?: GraphEdge[];
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

export type AppState = 'connect' | 'explore' | 'guide' | 'qa';
