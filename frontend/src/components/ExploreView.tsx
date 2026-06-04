import { useState, useRef, useEffect, useMemo } from 'react';
import { exploreSSE, generateSSE } from '../utils/api';
import { parseDeploymentInfo, connectedHost, saveEnv, envSummaryLine } from '../utils/env';
import type { CairnEnv } from '../utils/env';
import type { AgentEvent } from '../types';

interface Props {
  onGuideReady: () => void;
}

type StreamPhase = 'idle' | 'exploring' | 'explored' | 'generating' | 'done';

const PHASE_COLORS: Record<string, string> = {
  orient: 'var(--accent-blue)',
  investigate: 'var(--accent-amber)',
  reason: 'var(--accent-violet)',
  synthesize: 'var(--accent-violet)',
  done: 'var(--accent-green)',
  error: 'var(--accent-red)',
};

// Canonical order of the agentic phases for the waypoint stepper.
const PHASE_INDEX: Record<string, number> = {
  orient: 0,
  investigate: 1,
  reason: 2,
  synthesize: 3,
};

const WAYPOINTS = [
  { key: 'orient', label: 'Orient' },
  { key: 'investigate', label: 'Investigate' },
  { key: 'reason', label: 'Reason' },
  { key: 'synthesize', label: 'Synthesize' },
] as const;

// The six counters and how they map onto graph node types.
const COUNTERS = [
  { key: 'index', label: 'Indexes', color: 'var(--chip-index)' },
  { key: 'alert', label: 'Alerts', color: 'var(--chip-alert)' },
  { key: 'saved_search', label: 'Searches', color: 'var(--chip-saved-search)' },
  { key: 'macro', label: 'Macros', color: 'var(--chip-macro)' },
  { key: 'dashboard', label: 'Dashboards', color: 'var(--chip-dashboard)' },
  { key: 'lookup', label: 'Lookups', color: 'var(--chip-lookup)' },
] as const;

type Counts = Record<string, number>;

function eventData(ev: AgentEvent): Record<string, unknown> {
  return (ev.data as Record<string, unknown>) ?? {};
}

// Tick counters up from individual events; the explore "done" summary
// (nodes_by_type) is authoritative and overrides — it's the only source that
// splits alerts from saved searches.
function deriveCounts(events: AgentEvent[]): Counts {
  const c: Counts = { index: 0, alert: 0, saved_search: 0, macro: 0, lookup: 0, dashboard: 0 };
  for (const ev of events) {
    const d = eventData(ev);
    if (Array.isArray(d.indexes)) c.index = d.indexes.length;

    if (typeof d.count === 'number') {
      const m = ev.message ?? '';
      if (/macros/.test(m)) c.macro = d.count;
      else if (/lookups/.test(m)) c.lookup = d.count;
      else if (/views/.test(m)) c.dashboard = d.count;
      else if (/saved_searches/.test(m)) c.saved_search = d.count;
    }

    const summary = d.summary as { nodes_by_type?: Record<string, number> } | undefined;
    const nbt = summary?.nodes_by_type;
    if (nbt) {
      for (const key of Object.keys(c)) {
        if (typeof nbt[key] === 'number') c[key] = nbt[key];
      }
    }
  }
  return c;
}

function deriveEnv(events: AgentEvent[]): CairnEnv {
  let env: CairnEnv = {};
  for (const ev of events) {
    const d = eventData(ev);
    const info = d.info as Record<string, unknown> | undefined;
    if (info && typeof info === 'object') {
      env = { ...env, ...parseDeploymentInfo(info) };
    }
    const summary = d.summary as { nodes_by_type?: Record<string, number>; node_total?: number } | undefined;
    if (summary?.nodes_by_type) {
      env.counts = summary.nodes_by_type;
      env.total = summary.node_total;
    }
  }
  env.host = connectedHost();
  return env;
}

function maxPhaseSeen(events: AgentEvent[]): number {
  let max = -1;
  for (const ev of events) {
    const idx = PHASE_INDEX[ev.phase];
    if (idx !== undefined && idx > max) max = idx;
  }
  return max;
}

type WaypointStatus = 'complete' | 'active' | 'pending';

function waypointStatus(idx: number, stream: StreamPhase, maxSeen: number): WaypointStatus {
  if (stream === 'done') return 'complete';
  if (stream === 'explored') return idx <= 2 ? 'complete' : 'pending';
  if (stream === 'generating') return idx <= 2 ? 'complete' : 'active';
  // idle / exploring — monotonic by canonical phase order
  if (idx < maxSeen) return 'complete';
  if (idx === maxSeen) return 'active';
  return 'pending';
}

export default function ExploreView({ onGuideReady }: Props) {
  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [genEvents, setGenEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const allEvents = useMemo(() => [...events, ...genEvents], [events, genEvents]);
  const counts = useMemo(() => deriveCounts(allEvents), [allEvents]);
  const env = useMemo(() => deriveEnv(allEvents), [allEvents]);
  const maxSeen = useMemo(() => maxPhaseSeen(allEvents), [allEvents]);
  const envLine = envSummaryLine(env);

  // Persist environment identity for the guide screen once we know it.
  useEffect(() => {
    if (env.version || env.total) saveEnv(env);
  }, [env]);

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

  useEffect(() => () => { cancelRef.current?.(); }, []);

  const live = phase === 'exploring' || phase === 'generating';
  const started = phase !== 'idle';

  return (
    <div className="explore-container">
      <header className="app-header">
        <span className="logo-emoji">🪨</span>
        <span className="logo-text">Cairn</span>
        {envLine ? (
          <span className="header-env"><span className="env-dot" />{envLine}</span>
        ) : (
          <span className="header-tagline">Exploring your Splunk environment…</span>
        )}
      </header>

      {phase === 'idle' && (
        <div className="explore-start">
          <p className="explore-description">
            Cairn will connect to your Splunk instance, discover saved searches,
            alerts, and dashboards, reason about what matters, then generate a
            tailored operations guide.
          </p>
          <button className="btn btn-primary" onClick={startExplore}>
            Start Exploration
          </button>
        </div>
      )}

      {started && (
        <div className="explore-grid">
          {/* Left — live agent feed */}
          <div className="feed-wrapper">
            <div className="feed-header">
              <span className="feed-title">Agent Log</span>
              {live && (
                <span className="feed-status"><span className="pulse-dot" />Live</span>
              )}
            </div>
            <div className="feed" ref={feedRef}>
              {phase === 'exploring' && events.length === 0 && (
                <div className="feed-row">
                  <span className="phase-badge"><span className="phase-dot" />connect</span>
                  <span className="feed-message">Connecting to Splunk and starting exploration…</span>
                </div>
              )}
              {events.map((ev, i) => <EventRow key={i} event={ev} />)}
              {genEvents.map((ev, i) => <EventRow key={`gen-${i}`} event={ev} />)}
            </div>
          </div>

          {/* Right — live discovery dashboard */}
          <aside className="discovery-panel">
            <div className="dash-card env-card">
              <div className="dash-card-label">Environment</div>
              {envLine ? (
                <>
                  <div className="env-title">{env.version ? `Splunk ${env.version}` : 'Splunk'}</div>
                  <div className="env-sub">
                    {[env.product, env.os, env.server, env.host].filter(Boolean).join(' · ')}
                  </div>
                </>
              ) : (
                <div className="env-sub env-waiting">Detecting deployment…</div>
              )}
            </div>

            <div className="dash-card">
              <div className="dash-card-label">Objects Discovered</div>
              <div className="counter-grid">
                {COUNTERS.map(c => {
                  const value = counts[c.key] ?? 0;
                  return (
                    <div className="counter" key={c.key}>
                      <span className="counter-name" style={{ ['--counter-color' as string]: c.color }}>
                        {c.label}
                      </span>
                      {/* key={value} remounts the node so the pop animation replays on change */}
                      <span
                        key={value}
                        className={`counter-value ${value > 0 ? 'bumped' : 'is-zero'}`}
                      >
                        {value}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="dash-card">
              <div className="dash-card-label">Agentic Loop</div>
              <div className="waypoints">
                {WAYPOINTS.map((wp, idx) => {
                  const status = waypointStatus(idx, phase, maxSeen);
                  return (
                    <div className={`waypoint ${status} ${wp.key}`} key={wp.key}>
                      <span className="waypoint-marker">{status === 'complete' ? '✓' : ''}</span>
                      <span className="waypoint-label">{wp.label}</span>
                      <span className="waypoint-status">
                        {status === 'complete' ? 'complete' : status === 'active' ? 'active' : 'pending'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {phase === 'explored' && (
              <div className="dash-card dash-action">
                <button className="btn btn-primary btn-full" onClick={startGenerate}>
                  Generate Guide
                </button>
              </div>
            )}
            {phase === 'generating' && (
              <div className="dash-card">
                <div className="generating-status">
                  <span className="spinner" />
                  Writing guide sections…
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      {error && (
        <div className="explore-action">
          <div className="error-banner">
            <span className="error-icon">⚠</span>
            <span>
              <span className="error-title">Exploration hit a snag</span>
              <span className="error-hint">{error}</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: AgentEvent }) {
  const data = (event.data as Record<string, unknown>) ?? {};
  const observation = typeof data.observation === 'string' ? data.observation : '';

  // The agent's analysis — the "it's actually thinking" moment. Only the event
  // that carries an observation becomes the prominent violet card; the kickoff
  // "asking the LLM…" reason line stays in the terminal feed below.
  if (event.phase === 'reason' && observation) {
    return (
      <div className="event-reasoning">
        <div className="event-header">🧠 Agent Reasoning</div>
        <div className="event-body">{observation}</div>
      </div>
    );
  }

  if (event.phase === 'done') {
    return (
      <div className="event-done">
        <div className="event-header">✓ {event.message}</div>
        {event.detail && <div className="event-body">{event.detail}</div>}
      </div>
    );
  }

  // Everything else — compact monospace terminal line.
  const color = PHASE_COLORS[event.phase] ?? 'var(--text-muted)';

  return (
    <div className="feed-row">
      <span className="phase-badge" style={{ '--phase-color': color } as React.CSSProperties}>
        <span className="phase-dot" />
        {event.phase}
      </span>
      <span className="feed-message">{event.message}</span>
      {event.detail && <span className="feed-detail">{event.detail}</span>}
    </div>
  );
}
