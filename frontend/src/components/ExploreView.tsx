import { useState, useRef, useEffect } from 'react';
import { exploreSSE, generateSSE } from '../utils/api';
import type { AgentEvent } from '../types';

interface Props {
  onGuideReady: () => void;
}

type StreamPhase = 'idle' | 'exploring' | 'explored' | 'generating' | 'done';

const PHASE_COLORS: Record<string, string> = {
  orient: 'var(--accent-blue)',
  investigate: 'var(--accent-amber)',
  reason: 'var(--accent-purple)',
  synthesize: 'var(--accent-purple)',
  done: 'var(--accent-green)',
};

const PHASE_LABELS: Record<string, string> = {
  orient: 'orient',
  investigate: 'investigate',
  reason: 'reason',
  synthesize: 'synthesize',
  done: 'done',
};

export default function ExploreView({ onGuideReady }: Props) {
  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [genEvents, setGenEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events, genEvents]);

  function startExplore() {
    setError('');
    setEvents([]);
    setPhase('exploring');
    cancelRef.current = exploreSSE(
      (ev) => setEvents(prev => [...prev, ev]),
      () => setPhase('explored'),
      (err) => { setError(err); setPhase('idle'); }
    );
  }

  function startGenerate() {
    setError('');
    setGenEvents([]);
    setPhase('generating');
    cancelRef.current = generateSSE(
      (ev) => setGenEvents(prev => [...prev, ev]),
      () => { setPhase('done'); onGuideReady(); },
      (err) => { setError(err); setPhase('explored'); }
    );
  }

  useEffect(() => {
    return () => { cancelRef.current?.(); };
  }, []);

  return (
    <div className="explore-container">
      <header className="app-header">
        <span className="logo-emoji">🪨</span>
        <span className="logo-text">Cairn</span>
        <span className="header-tagline">Exploring your Splunk environment...</span>
      </header>

      {phase === 'idle' && (
        <div className="explore-start">
          <p className="explore-description">
            Cairn will connect to your Splunk instance, discover saved searches,
            alerts, and dashboards, then generate a tailored operations guide.
          </p>
          <button className="btn btn-primary" onClick={startExplore}>
            Start Exploration
          </button>
        </div>
      )}

      {(events.length > 0 || genEvents.length > 0) && (
        <div className="feed-wrapper">
          <div className="feed-header">
            <span className="feed-title">Agent Log</span>
            {(phase === 'exploring' || phase === 'generating') && (
              <span className="feed-status">
                <span className="pulse-dot" />
                Live
              </span>
            )}
          </div>
          <div className="feed" ref={feedRef}>
            {events.map((ev, i) => (
              <EventRow key={i} event={ev} />
            ))}
            {genEvents.map((ev, i) => (
              <EventRow key={`gen-${i}`} event={ev} />
            ))}
          </div>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {phase === 'explored' && (
        <div className="explore-action">
          <button className="btn btn-primary" onClick={startGenerate}>
            Generate Guide
          </button>
        </div>
      )}

      {phase === 'generating' && (
        <div className="explore-action">
          <div className="generating-status">
            <span className="spinner" />
            Writing guide sections...
          </div>
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: AgentEvent }) {
  const color = PHASE_COLORS[event.phase] ?? 'var(--text-muted)';
  const label = PHASE_LABELS[event.phase] ?? event.phase;

  return (
    <div className="feed-row">
      <span className="phase-badge" style={{ '--phase-color': color } as React.CSSProperties}>
        <span className="phase-dot" />
        {label}
      </span>
      <span className="feed-message">{event.message}</span>
      {event.detail && <span className="feed-detail">{event.detail}</span>}
    </div>
  );
}
