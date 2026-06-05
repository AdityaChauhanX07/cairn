import { useState, useRef, useEffect, useMemo } from 'react';
import { exploreSSE, generateSSE } from '../utils/api';
import { parseDeploymentInfo, connectedHost, saveEnv, envSummaryLine } from '../utils/env';
import type { CairnEnv } from '../utils/env';
import type { AgentEvent, GraphNode, GraphEdge } from '../types';
import RelationshipGraph from './RelationshipGraph';
import CairnMark from './CairnMark';
import { SkeletonText } from './Skeleton';

interface Props {
  onGuideReady: () => void;
}

type StreamPhase = 'idle' | 'exploring' | 'explored' | 'generating' | 'done';

// An event plus the wall-clock time it arrived (the backend doesn't timestamp).
interface FeedItem {
  ev: AgentEvent;
  ts: string;
}

const PHASE_COLORS: Record<string, string> = {
  orient: 'var(--accent-blue)',
  investigate: 'var(--accent-amber)',
  reason: 'var(--accent-violet)',
  synthesize: 'var(--accent-violet)',
  done: 'var(--accent-green)',
  error: 'var(--accent-red)',
};

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

const COUNTERS = [
  { key: 'index', label: 'Indexes' },
  { key: 'alert', label: 'Alerts' },
  { key: 'saved_search', label: 'Searches' },
  { key: 'macro', label: 'Macros' },
  { key: 'dashboard', label: 'Dashboards' },
  { key: 'lookup', label: 'Lookups' },
] as const;

type Counts = Record<string, number>;

function nowStamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function eventData(ev: AgentEvent): Record<string, unknown> {
  return (ev.data as Record<string, unknown>) ?? {};
}

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

// Accumulate the relationship graph from the SSE stream. Each event carries
// the full current node/edge view, so we keep the last non-empty snapshot —
// the graph only ever grows during a single exploration.
function deriveGraph(events: AgentEvent[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];
  for (const ev of events) {
    const d = eventData(ev);
    if (Array.isArray(d.graph_nodes)) nodes = d.graph_nodes as GraphNode[];
    if (Array.isArray(d.graph_edges)) edges = d.graph_edges as GraphEdge[];
  }
  return { nodes, edges };
}

function deriveEnv(events: AgentEvent[]): CairnEnv {
  let env: CairnEnv = {};
  for (const ev of events) {
    const d = eventData(ev);
    const info = d.info as Record<string, unknown> | undefined;
    if (info && typeof info === 'object') env = { ...env, ...parseDeploymentInfo(info) };
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
  if (idx < maxSeen) return 'complete';
  if (idx === maxSeen) return 'active';
  return 'pending';
}

export default function ExploreView({ onGuideReady }: Props) {
  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [events, setEvents] = useState<FeedItem[]>([]);
  const [genEvents, setGenEvents] = useState<FeedItem[]>([]);
  const [error, setError] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const allEvents = useMemo(
    () => [...events, ...genEvents].map(f => f.ev),
    [events, genEvents]
  );
  const counts = useMemo(() => deriveCounts(allEvents), [allEvents]);
  const graph = useMemo(() => deriveGraph(allEvents), [allEvents]);
  const env = useMemo(() => deriveEnv(allEvents), [allEvents]);
  const maxSeen = useMemo(() => maxPhaseSeen(allEvents), [allEvents]);
  const envLine = envSummaryLine(env);

  useEffect(() => {
    if (env.version || env.total) saveEnv(env);
  }, [env]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [events, genEvents]);

  function startExplore() {
    setError('');
    setEvents([]);
    setPhase('exploring');
    cancelRef.current = exploreSSE(
      (ev) => setEvents(prev => [...prev, { ev, ts: nowStamp() }]),
      () => setPhase('explored'),
      (err) => { setError(err); setPhase('idle'); }
    );
  }

  function startGenerate() {
    setError('');
    setGenEvents([]);
    setPhase('generating');
    cancelRef.current = generateSSE(
      (ev) => setGenEvents(prev => [...prev, { ev, ts: nowStamp() }]),
      () => { setPhase('done'); onGuideReady(); },
      (err) => { setError(err); setPhase('explored'); }
    );
  }

  useEffect(() => () => { cancelRef.current?.(); }, []);

  const live = phase === 'exploring' || phase === 'generating';
  const started = phase !== 'idle';

  // Stones light up as the agentic loop advances: each phase seen stacks one
  // more stone (orient→1 … synthesize→4). Once exploration completes the cairn
  // stays fully stacked through guide generation.
  const cairnStacked =
    phase === 'idle'
      ? 0
      : phase === 'explored' || phase === 'generating' || phase === 'done'
        ? 4
        : Math.min(4, Math.max(0, maxSeen + 1));

  return (
    <div className="explore-container">
      <header className="app-header">
        <div className="brand">
          <CairnMark
            stacked={cairnStacked}
            size={24}
            className={phase === 'generating' ? 'cairn-pulsing' : undefined}
          />
          <span className="brand-text">cairn</span>
          <span className="brand-dot">.</span>
        </div>
        {envLine && (
          <span className="header-env"><span className="env-dot" />{envLine}</span>
        )}
      </header>

      {phase === 'idle' && (
        <div className="explore-start">
          <p className="explore-description">
            Cairn connects to your Splunk instance, traces how saved searches,
            alerts, macros and lookups depend on each other, reasons about what
            matters, and writes the guide you wish the last on-call had left you.
          </p>
          <button className="btn btn-primary" onClick={startExplore}>Explore</button>
        </div>
      )}

      {started && (
        <div className="explore-grid">
          {/* Left — live agent feed */}
          <div className="feed-wrapper">
            <div className="feed-header">
              <span className="feed-title">Agent log</span>
              {live && <span className="feed-status"><span className="pulse-dot" />live</span>}
            </div>
            <div className="feed" ref={feedRef}>
              {phase === 'exploring' && events.length === 0 && (
                <div className="feed-skeleton"><SkeletonText lines={5} /></div>
              )}
              {events.map((f, i) => <EventRow key={i} item={f} />)}
              {genEvents.map((f, i) => <EventRow key={`gen-${i}`} item={f} />)}
            </div>
          </div>

          {/* Right — discovery dashboard */}
          <aside className="discovery-panel">
            <div>
              <div className="dash-block-label">Environment</div>
              {envLine ? (
                <>
                  <div className="env-title">{env.version ? `Splunk ${env.version}` : 'Splunk'}</div>
                  <div className="env-sub">
                    {[env.product, env.os, env.server, env.host].filter(Boolean).join(' · ')}
                  </div>
                </>
              ) : (
                <div className="env-sub env-waiting">detecting deployment</div>
              )}
            </div>

            <div>
              <div className="dash-block-label">Objects discovered</div>
              <div className="counter-grid">
                {COUNTERS.map(c => {
                  const value = counts[c.key] ?? 0;
                  return (
                    <div className="counter" key={c.key}>
                      {/* key={value} remounts on change, replaying the amber flash */}
                      <span key={value} className={`counter-value ${value > 0 ? 'flash' : 'is-zero'}`}>
                        {value}
                      </span>
                      <span className="counter-label">{c.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="dash-block-label">Agentic loop</div>
              <div className="waypoints">
                {WAYPOINTS.map((wp, idx) => {
                  const status = waypointStatus(idx, phase, maxSeen);
                  return (
                    <div className={`waypoint ${status} ${wp.key}`} key={wp.key}>
                      <span className="waypoint-marker" />
                      <span className="waypoint-label">{wp.label}</span>
                      <span className="waypoint-status">{status}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {graph.edges.length > 0 && (
              <div>
                <div className="dash-block-label">Relationship graph</div>
                <RelationshipGraph nodes={graph.nodes} edges={graph.edges} animated />
              </div>
            )}

            {phase === 'explored' && (
              <div className="dash-action">
                <button className="btn btn-primary btn-full" onClick={startGenerate}>Build guide</button>
              </div>
            )}
            {phase === 'generating' && (
              <div className="dash-action"><div className="progress-rail" /></div>
            )}
          </aside>
        </div>
      )}

      {error && (
        <div style={{ padding: '16px 24px' }}>
          <div className="error-banner">
            <span className="error-mark">!</span>
            <span>
              <span className="error-title">Exploration stalled</span>
              <span className="error-hint">{error}</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function EventRow({ item }: { item: FeedItem }) {
  const { ev, ts } = item;
  const data = (ev.data as Record<string, unknown>) ?? {};
  const observation = typeof data.observation === 'string' ? data.observation : '';

  if (ev.phase === 'reason' && observation) {
    return (
      <div className="event-reasoning">
        <div className="event-header">agent reasoning</div>
        <div className="event-body">{observation}</div>
      </div>
    );
  }

  if (ev.phase === 'done') {
    return (
      <div className="event-done">
        <div className="event-header">{ev.message}</div>
        {ev.detail && <div className="event-body">{ev.detail}</div>}
      </div>
    );
  }

  const color = PHASE_COLORS[ev.phase] ?? 'var(--text-muted)';
  return (
    <div className="feed-row">
      <span className="feed-time">{ts}</span>
      <span className="phase-badge" style={{ '--phase-color': color } as React.CSSProperties}>
        <span className="phase-dot" />{ev.phase}
      </span>
      <span className="feed-message">{ev.message}</span>
      {ev.detail && <span className="feed-detail">{ev.detail}</span>}
    </div>
  );
}
