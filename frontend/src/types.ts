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

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AppState = 'connect' | 'explore' | 'guide' | 'qa';
