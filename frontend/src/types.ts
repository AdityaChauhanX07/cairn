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

export interface Guide {
  [key: string]: GuideSection;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AppState = 'connect' | 'explore' | 'guide' | 'qa';
