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

// Matches OnboardingGuide.to_dict() from the backend: a flat map of
// section title -> markdown body, plus the full markdown and graph snapshot.
export interface Guide {
  markdown: string;
  sections: Record<string, string>;
  graph_snapshot?: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AppState = 'connect' | 'explore' | 'guide' | 'qa';
