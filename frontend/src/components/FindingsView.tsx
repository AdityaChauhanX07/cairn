import { useEffect, useRef, useState } from 'react';
import { useCairn } from '../context/CairnContext';
import RelationshipGraph from './RelationshipGraph';
import { CodeBlock, Eyebrow, Icons, SeverityBadge, SEV } from './Primitives';
import { SkeletonText } from './Skeleton';
import type { Finding } from '../types';
import type { Screen } from '../App';

interface Props {
  goto: (screen: Screen) => void;
}

const CAT_LABEL: Record<string, string> = {
  alert_empty_index: 'alert → empty index',
  alert_no_action: 'alert → no action',
  orphaned_object: 'orphaned object',
  alert_no_owner: 'alert → no owner',
};

// Coerce the backend's evidence object into ordered [key, value] pairs.
function evidencePairs(ev: Record<string, unknown>): [string, string][] {
  return Object.entries(ev ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]);
}

export default function FindingsView({ goto }: Props) {
  const { findings, findingsGenerating, findingsProgress, findingsError, ensureFindings, graph } = useCairn();
  const scrollRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => { ensureFindings(); }, [ensureFindings]);

  function locate(nodeId: string) {
    setFocus(nodeId);
    setSel(nodeId);
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    graphRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const counts = {
    total: findings?.findings.length ?? 0,
    high: findings?.findings.filter((f) => f.severity === 'high').length ?? 0,
    medium: findings?.findings.filter((f) => f.severity === 'medium').length ?? 0,
    low: findings?.findings.filter((f) => f.severity === 'low').length ?? 0,
  };

  const groups = (['high', 'medium', 'low'] as const)
    .map((sev) => ({ sev, items: findings?.findings.filter((f) => f.severity === sev) ?? [] }))
    .filter((g) => g.items.length);

  return (
    <div ref={scrollRef} style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 840, margin: '0 auto', padding: '40px 48px 120px' }}>
        <Eyebrow>mode b · findings</Eyebrow>
        <h1 className="display" style={{ fontSize: 38, marginTop: 14 }}>What's quietly broken.</h1>
        <p style={{ color: 'var(--text-2)', fontSize: 16, maxWidth: 580, marginTop: 14 }}>
          The same relationship graph that powers the guide reveals hygiene issues for free. Each finding ships with a
          ready-to-apply fix.{' '}
          <strong style={{ color: 'var(--text)' }}>cairn advises; you apply. Nothing here changes Splunk.</strong>
        </p>

        {findingsError && (
          <div style={{ marginTop: 20, color: 'var(--sev-high)', fontFamily: 'var(--mono)', fontSize: 13 }}>
            findings scan stalled — {findingsError}
          </div>
        )}

        {!findings && findingsGenerating && (
          <div style={{ marginTop: 28 }}>
            <div className="row gap-2" style={{ marginBottom: 14, color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 12.5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--live)', animation: 'blink 1.2s infinite' }} />
              {findingsProgress[findingsProgress.length - 1] ?? 'scanning for hygiene issues…'}
            </div>
            <SkeletonText lines={6} />
          </div>
        )}

        {findings && (
          <>
            {/* summary tiles */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginTop: 28 }}>
              <SummaryTile big value={counts.total} label="total findings" />
              <SummaryTile value={counts.high} label="high" tone="var(--sev-high)" />
              <SummaryTile value={counts.medium} label="medium" tone="var(--sev-med)" />
              <SummaryTile value={counts.low} label="low" tone="var(--sev-low)" />
            </div>

            {counts.total === 0 ? (
              <div className="card" style={{ marginTop: 24, padding: 24, textAlign: 'center', color: 'var(--good)', fontFamily: 'var(--mono)', fontSize: 13.5 }}>
                ✓ no hygiene issues found — this environment is clean.
              </div>
            ) : (
              <>
                {/* graph with highlight */}
                {graph.edges.length > 0 && (
                  <div ref={graphRef} className="card" style={{ marginTop: 18, padding: '16px 16px 12px' }}>
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                      <Eyebrow>where they live</Eyebrow>
                      {focus && (
                        <button
                          className="btn btn-ghost"
                          style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '4px 8px' }}
                          onClick={() => { setFocus(null); setSel(null); }}
                        >
                          clear
                        </button>
                      )}
                    </div>
                    <RelationshipGraph
                      nodes={graph.nodes}
                      edges={graph.edges}
                      deadNodeIds={findings.dead_node_ids}
                      selected={sel}
                      focusNode={focus}
                      onSelect={(id) => { setSel(id); setFocus(id); }}
                      height={320}
                      hint={false}
                    />
                  </div>
                )}

                {/* findings by severity */}
                {groups.map((g) => (
                  <div key={g.sev} style={{ marginTop: 40 }}>
                    <div className="row gap-3" style={{ marginBottom: 14 }}>
                      <SeverityBadge level={g.sev} big />
                      <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                        {g.items.length} finding{g.items.length > 1 ? 's' : ''}
                      </span>
                    </div>
                    {g.items.map((f) => (
                      <FindingCard key={f.id} f={f} onLocate={locate} active={sel === f.affected_node_id} />
                    ))}
                  </div>
                ))}

                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 48, paddingTop: 24, borderTop: '1px solid var(--line)' }}>
                  <button className="btn btn-primary" onClick={() => goto('kit')}>
                    Build the starter kit <Icons.arrowR size={15} />
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SummaryTile({ value, label, tone, big }: { value: number; label: string; tone?: string; big?: boolean }) {
  return (
    <div className="card" style={{ padding: '16px 18px', borderColor: tone ? `${tone}33` : 'var(--line)' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: big ? 32 : 28, fontWeight: 500, color: tone || 'var(--text)', lineHeight: 1 }}>{value}</div>
      <div className="eyebrow" style={{ marginTop: 8, fontSize: 10 }}>{label}</div>
    </div>
  );
}

function FindingCard({ f, onLocate, active }: { f: Finding; onLocate: (id: string) => void; active: boolean }) {
  const s = SEV[f.severity] || SEV.low;
  const pairs = evidencePairs(f.evidence);
  return (
    <div
      className="card"
      style={{ padding: 22, marginBottom: 14, borderLeft: `2px solid ${s.c}`, boxShadow: active ? `0 0 0 1px ${s.c}66` : 'none', transition: 'box-shadow .25s' }}
    >
      <div className="row" style={{ justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <h3 style={{ fontSize: 17.5 }}>{f.title}</h3>
        <span className="pill" style={{ color: s.c, borderColor: `${s.c}44` }}>{CAT_LABEL[f.category] ?? f.category}</span>
      </div>
      <p style={{ color: 'var(--text-2)', marginTop: 10, marginBottom: 16 }}>{f.summary}</p>

      {pairs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {pairs.map(([k, v], i) => (
            <span key={i} style={{ fontFamily: 'var(--mono)', fontSize: 11.5, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 9px' }}>
              <span style={{ color: 'var(--text-4)' }}>{k}</span> <span style={{ color: 'var(--text)' }}>{v}</span>
            </span>
          ))}
        </div>
      )}

      <div style={{ borderRadius: 'var(--r-md)', background: 'rgba(127,169,140,0.06)', border: '1px solid rgba(127,169,140,0.22)', padding: '14px 16px' }}>
        <div className="row gap-2" style={{ marginBottom: 8 }}>
          <Icons.check size={14} style={{ color: 'var(--good)' }} />
          <span className="eyebrow" style={{ color: 'var(--good)' }}>suggested fix</span>
        </div>
        <p style={{ color: 'var(--text)', fontSize: 14, margin: 0 }}>{f.fix}</p>
        {f.fix_spl && <div style={{ marginTop: 12 }}><CodeBlock code={f.fix_spl} pad="10px 14px" /></div>}
      </div>

      {f.affected_node_id && (
        <button
          onClick={() => onLocate(f.affected_node_id)}
          className="row gap-2"
          style={{ marginTop: 14, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 12, padding: 0 }}
        >
          <Icons.pin size={13} /> locate in graph
        </button>
      )}
    </div>
  );
}
