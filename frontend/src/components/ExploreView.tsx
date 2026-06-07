import { useState, useRef, useEffect, useMemo } from 'react';
import { exploreSSE, generateSSE } from '../utils/api';
import { parseDeploymentInfo, connectedHost, saveEnv, type CairnEnv } from '../utils/env';
import { useCairn } from '../context/CairnContext';
import type { AgentEvent, GraphNode, GraphEdge } from '../types';
import RelationshipGraph from './RelationshipGraph';
import { Eyebrow, Icons } from './Primitives';
import { SkeletonText } from './Skeleton';

interface Props {
  // True when exploration already completed earlier this session — render the
  // finished state instead of re-running the stream.
  replay: boolean;
  onComplete: () => void;
}

type StreamPhase = 'idle' | 'exploring' | 'explored' | 'generating' | 'done';

interface FeedItem {
  ev: AgentEvent;
  ts: string;
}

const PHASE_META: Record<string, { c: string; label: string }> = {
  orient: { c: '#7d93b0', label: 'orient' },
  investigate: { c: 'var(--ember)', label: 'investigate' },
  reason: { c: '#a98bc0', label: 'reason' },
  synthesize: { c: 'var(--good)', label: 'synthesize' },
  done: { c: 'var(--good)', label: 'synthesize' },
  error: { c: 'var(--sev-high)', label: 'error' },
};

const PHASE_INDEX: Record<string, number> = { orient: 0, investigate: 1, reason: 2, synthesize: 3 };

const LOOP = [
  { k: 'orient', name: 'Orient', q: 'What exists here?' },
  { k: 'investigate', name: 'Investigate', q: 'Pull objects, follow chains.' },
  { k: 'reason', name: 'Reason', q: "What matters? What's broken?" },
  { k: 'synthesize', name: 'Synthesize', q: 'Build the guide.' },
] as const;

const COUNTERS = [
  { key: 'index', label: 'indexes' },
  { key: 'alert', label: 'alerts' },
  { key: 'saved_search', label: 'searches' },
  { key: 'macro', label: 'macros' },
  { key: 'lookup', label: 'lookups' },
  { key: 'dashboard', label: 'dashboards' },
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

type LoopStatus = 'complete' | 'active' | 'pending';
function loopStatus(idx: number, phase: StreamPhase, maxSeen: number): LoopStatus {
  if (phase === 'done') return 'complete';
  if (phase === 'explored') return idx <= 2 ? 'complete' : 'pending';
  if (phase === 'generating') return idx <= 2 ? 'complete' : 'active';
  if (idx < maxSeen) return 'complete';
  if (idx === maxSeen) return 'active';
  return 'pending';
}

export default function ExploreView({ replay, onComplete }: Props) {
  const cairn = useCairn();
  const [phase, setPhase] = useState<StreamPhase>(replay ? 'done' : 'idle');
  const [events, setEvents] = useState<FeedItem[]>([]);
  const [genEvents, setGenEvents] = useState<FeedItem[]>([]);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const liveEvents = useMemo(() => [...events, ...genEvents].map((f) => f.ev), [events, genEvents]);
  const liveCounts = useMemo(() => deriveCounts(liveEvents), [liveEvents]);
  const liveGraph = useMemo(() => deriveGraph(liveEvents), [liveEvents]);
  const liveEnv = useMemo(() => deriveEnv(liveEvents), [liveEvents]);
  const maxSeen = useMemo(() => maxPhaseSeen(liveEvents), [liveEvents]);

  // In replay mode, draw from the already-fetched session data.
  const counts: Counts = replay && cairn.counts ? (cairn.counts as unknown as Counts) : liveCounts;
  const graph = replay && cairn.graph.edges.length ? cairn.graph : liveGraph;
  const env = replay && cairn.env ? cairn.env : liveEnv;
  const done = phase === 'done';

  useEffect(() => {
    if (env.version || env.total) saveEnv(env);
  }, [env]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events, genEvents]);

  // Auto-start exploration on mount (unless we're replaying a finished run).
  // The cleanup cancels the in-flight stream; under React StrictMode (dev) the
  // effect runs setup→cleanup→setup, so we must NOT guard with a "started" ref
  // (that would cancel the first stream and never restart). Each setup opens a
  // fresh stream and the prior one is cancelled by its own cleanup.
  useEffect(() => {
    if (replay) return;
    setPhase('exploring');
    setEvents([]);
    const cancel = exploreSSE(
      (ev) => setEvents((prev) => [...prev, { ev, ts: nowStamp() }]),
      () => setPhase('explored'),
      (err) => { setError(err); setPhase('idle'); },
    );
    cancelRef.current = cancel;
    // Cancel whatever stream is current at cleanup time. Under StrictMode the
    // cleanup runs before the next setup, so the ref still points at this run's
    // stream; in normal use it also covers a later generate stream.
    return () => cancelRef.current?.();
  }, [replay]);

  function buildGuide() {
    setError('');
    setGenEvents([]);
    setPhase('generating');
    cancelRef.current = generateSSE(
      (ev) => setGenEvents((prev) => [...prev, { ev, ts: nowStamp() }]),
      () => { setPhase('done'); cairn.loadGuide(); onComplete(); },
      (err) => { setError(err); setPhase('explored'); },
    );
  }

  const live = phase === 'exploring' || phase === 'generating';
  const graphReady = graph.edges.length > 0;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', overflow: 'hidden' }}>
        {/* LEFT — agent log */}
        <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--line)', overflow: 'hidden' }}>
          <div className="row" style={{ justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid var(--line)' }}>
            <Eyebrow>agent log</Eyebrow>
            <span className="row gap-2" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: done ? 'var(--text-3)' : 'var(--live)' }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: done ? 'var(--text-4)' : 'var(--live)', animation: done ? 'none' : 'blink 1.2s infinite' }} />
              {done ? 'complete' : 'live'}
            </span>
          </div>

          <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 24px 24px' }}>
            {replay ? (
              <div style={{ color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 13, paddingTop: 8 }}>
                exploration already complete this session — the relationship graph is on the right.
              </div>
            ) : (
              <>
                {phase === 'exploring' && events.length === 0 && <SkeletonText lines={5} />}
                {events.map((f, i) => <LogLine key={i} item={f} />)}
                {genEvents.map((f, i) => <LogLine key={`gen-${i}`} item={f} />)}
                {!done && live && (
                  <div className="row gap-3" style={{ paddingTop: 6, opacity: 0.8 }}>
                    <span style={{ width: 8, height: 15, background: 'var(--ember)', display: 'inline-block', animation: 'blink 1s infinite' }} />
                  </div>
                )}
              </>
            )}
            {done && (
              <div
                className="rise"
                style={{
                  marginTop: 14, padding: '14px 18px', borderRadius: 'var(--r-md)',
                  background: 'rgba(127,169,140,0.08)', border: '1px solid rgba(127,169,140,0.28)',
                  fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--good)', letterSpacing: '0.04em',
                }}
              >
                ✓ exploration complete — relationship graph built, ready to synthesize the guide
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — environment + loop + graph */}
        <div style={{ overflowY: 'auto', padding: '20px 24px 24px' }}>
          <Eyebrow style={{ marginBottom: 14 }}>environment</Eyebrow>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 22, letterSpacing: '-0.01em' }}>
            {env.version ? `Splunk ${env.version}` : 'Splunk'}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--text-2)', marginTop: 4 }}>
            {[env.product, env.os, env.server, env.host].filter(Boolean).join(' · ') || 'detecting deployment'}
          </div>

          <Eyebrow style={{ margin: '26px 0 16px' }}>objects discovered</Eyebrow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 16px' }}>
            {COUNTERS.map((c) => {
              const val = counts[c.key] ?? 0;
              return (
                <div key={c.key}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 26, fontWeight: 500, lineHeight: 1, color: val > 0 ? 'var(--text)' : 'var(--text-4)', transition: 'color .4s' }}>
                    {val}
                  </div>
                  <div className="eyebrow" style={{ marginTop: 6, fontSize: 10 }}>{c.label}</div>
                </div>
              );
            })}
          </div>

          <Eyebrow style={{ margin: '30px 0 14px' }}>agentic loop</Eyebrow>
          <div style={{ position: 'relative' }}>
            {LOOP.map((p, i) => {
              const st = loopStatus(i, phase, maxSeen);
              const pm = PHASE_META[p.k];
              return (
                <div key={p.k} className="row gap-3" style={{ alignItems: 'flex-start', paddingBottom: i < LOOP.length - 1 ? 16 : 0, position: 'relative' }}>
                  {i < LOOP.length - 1 && (
                    <span style={{ position: 'absolute', left: 7, top: 18, bottom: 4, width: 2, background: st === 'complete' ? pm.c : 'var(--line-2)', opacity: st === 'complete' ? 0.5 : 1 }} />
                  )}
                  <span
                    style={{
                      width: 16, height: 16, borderRadius: 999, flexShrink: 0, marginTop: 1, position: 'relative',
                      background: st === 'pending' ? 'transparent' : pm.c,
                      border: st === 'pending' ? '2px solid var(--line-3)' : `2px solid ${pm.c}`,
                      animation: st === 'active' ? 'pulse-ring 1.6s infinite' : 'none',
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 14.5, fontWeight: 500, color: st === 'pending' ? 'var(--text-3)' : 'var(--text)' }}>{p.name}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: st === 'active' ? pm.c : st === 'complete' ? 'var(--text-3)' : 'var(--text-4)' }}>{st}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 1 }}>{p.q}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <Eyebrow style={{ margin: '30px 0 12px' }}>relationship graph</Eyebrow>
          <div className="card" style={{ padding: graphReady ? '8px 8px 14px' : 0, minHeight: 200, overflow: 'hidden', opacity: graphReady ? 1 : 0.4, transition: 'opacity .6s' }}>
            {graphReady ? (
              <RelationshipGraph nodes={graph.nodes} edges={graph.edges} deadNodeIds={cairn.findings?.dead_node_ids} selected={sel} onSelect={setSel} height={300} hint={false} />
            ) : (
              <div className="center" style={{ height: 200, flexDirection: 'column', gap: 10, color: 'var(--text-4)' }}>
                <Icons.graph size={26} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>parsing SPL to build edges…</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 24px', borderTop: '1px solid var(--line)' }}>
          <div style={{ color: 'var(--sev-high)', fontFamily: 'var(--mono)', fontSize: 12.5 }}>
            exploration stalled — {error}
          </div>
        </div>
      )}

      {/* bottom CTA */}
      <div className="row" style={{ justifyContent: 'space-between', padding: '14px 24px', borderTop: '1px solid var(--line)', background: 'var(--surface-1)' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-3)' }}>
          {done || phase === 'explored' ? 'one exploration pass → three modes' : 'the agent decides what to investigate next'}
        </span>
        {done ? (
          <button className="btn btn-primary" onClick={onComplete}>
            Open the guide <Icons.arrowR size={15} />
          </button>
        ) : (
          <button className="btn btn-primary" disabled={phase !== 'explored'} onClick={buildGuide}>
            {phase === 'generating' ? 'Building…' : 'Build the guide'} <Icons.arrowR size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

function LogLine({ item }: { item: FeedItem }) {
  const { ev, ts } = item;
  const pm = PHASE_META[ev.phase] || PHASE_META.orient;
  const data = (ev.data as Record<string, unknown>) ?? {};
  const reasoning = typeof data.observation === 'string' ? data.observation : '';
  const warn = /empty|skip|filtered|stalled/i.test(ev.message ?? '');

  return (
    <div style={{ animation: 'logline .32s ease both', marginBottom: reasoning ? 4 : 2 }}>
      <div className="row" style={{ alignItems: 'baseline', gap: 14, padding: '3px 0' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-4)', flexShrink: 0, width: 56 }}>{ts}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: pm.c, flexShrink: 0, width: 92 }}>
          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: pm.c, marginRight: 7, verticalAlign: 'middle' }} />
          {pm.label}
        </span>
        <span style={{ fontSize: 13.5, color: warn ? 'var(--sev-med)' : 'var(--text)', lineHeight: 1.5 }}>{ev.message}</span>
      </div>
      {ev.detail && (
        <div style={{ marginLeft: 162, fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-3)', paddingBottom: 4, lineHeight: 1.6 }}>{ev.detail}</div>
      )}
      {reasoning && (
        <div className="rise" style={{ margin: '6px 0 10px 162px', padding: '13px 16px', borderLeft: '2px solid #a98bc0', background: 'rgba(169,139,192,0.07)', borderRadius: '0 10px 10px 0' }}>
          <div className="eyebrow" style={{ color: '#a98bc0', marginBottom: 7 }}>agent reasoning</div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', whiteSpace: 'pre-line', lineHeight: 1.65 }}>{reasoning}</div>
        </div>
      )}
    </div>
  );
}
