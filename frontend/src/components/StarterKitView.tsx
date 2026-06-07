import { useEffect, useState } from 'react';
import { downloadDashboardXml } from '../utils/api';
import { useCairn } from '../context/CairnContext';
import { CodeBlock, Eyebrow, Icons, SeverityBadge } from './Primitives';
import { SkeletonText } from './Skeleton';
import type { GeneratedSPL, Runbook, DashboardPanel } from '../types';
import type { Screen } from '../App';

interface Props {
  goto: (screen: Screen) => void;
}

type Tab = 'queries' | 'runbooks' | 'dashboard';
const TABS: { k: Tab; label: string; icon: typeof Icons.search }[] = [
  { k: 'queries', label: 'Generated Queries', icon: Icons.search },
  { k: 'runbooks', label: 'Alert Runbooks', icon: Icons.shield },
  { k: 'dashboard', label: 'Dashboard Skeleton', icon: Icons.graph },
];
const Q_CATS = ['all', 'security', 'application', 'infrastructure', 'troubleshooting'];
const CAT_TONE: Record<string, string> = {
  security: 'var(--sev-high)', application: 'var(--n-index)', infrastructure: 'var(--n-dash)', troubleshooting: 'var(--n-macro)',
};
const VIZ_LABEL: Record<string, string> = { timechart: 'timechart', table: 'table', single: 'single value', bar: 'bar chart' };

export default function StarterKitView({ goto }: Props) {
  const { kit, kitGenerating, kitProgress, kitError, ensureKit } = useCairn();
  const [tab, setTab] = useState<Tab>('queries');
  const [cat, setCat] = useState('all');

  useEffect(() => { ensureKit(); }, [ensureKit]);

  const queries = !kit ? [] : cat === 'all' ? kit.generated_queries : kit.generated_queries.filter((q) => q.category === cat);

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '40px 48px 120px' }}>
        <Eyebrow>mode c · starter kit</Eyebrow>
        <h1 className="display" style={{ fontSize: 38, marginTop: 14 }}>A running start.</h1>
        <p style={{ color: 'var(--text-2)', fontSize: 16, maxWidth: 560, marginTop: 14 }}>
          Tailored SPL, per-alert runbooks and an importable dashboard — all generated from what cairn actually found in
          your environment.
        </p>

        {kitError && (
          <div style={{ marginTop: 20, color: 'var(--sev-high)', fontFamily: 'var(--mono)', fontSize: 13 }}>
            starter kit generation stalled — {kitError}
          </div>
        )}

        {!kit && kitGenerating && (
          <div style={{ marginTop: 28 }}>
            <div className="row gap-2" style={{ marginBottom: 14, color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 12.5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--live)', animation: 'blink 1.2s infinite' }} />
              {kitProgress[kitProgress.length - 1] ?? 'generating starter kit…'}
            </div>
            <SkeletonText lines={7} />
          </div>
        )}

        {kit && (
          <>
            {/* tabs */}
            <div className="row gap-2" style={{ marginTop: 28, padding: 4, background: 'var(--surface-1)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', width: 'fit-content' }}>
              {TABS.map((t) => {
                const count = t.k === 'queries' ? kit.generated_queries.length : t.k === 'runbooks' ? kit.runbooks.length : kit.dashboard_panels.length;
                const TabIcon = t.icon;
                return (
                  <button
                    key={t.k}
                    onClick={() => setTab(t.k)}
                    className="row gap-2"
                    style={{
                      padding: '9px 16px', borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer',
                      fontFamily: 'var(--sans)', fontSize: 13.5, fontWeight: tab === t.k ? 600 : 400,
                      background: tab === t.k ? 'var(--ember)' : 'transparent', color: tab === t.k ? '#1a0f08' : 'var(--text-2)', transition: 'all .15s',
                    }}
                  >
                    <TabIcon size={15} /> {t.label}
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, opacity: 0.75 }}>{count}</span>
                  </button>
                );
              })}
            </div>

            {/* QUERIES */}
            {tab === 'queries' && (
              <div style={{ marginTop: 26 }}>
                <div className="row gap-2" style={{ flexWrap: 'wrap', marginBottom: 18 }}>
                  {Q_CATS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setCat(c)}
                      style={{
                        fontFamily: 'var(--mono)', fontSize: 11.5, padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
                        border: `1px solid ${cat === c ? 'var(--ember-line)' : 'var(--line-2)'}`,
                        background: cat === c ? 'var(--ember-dim)' : 'transparent', color: cat === c ? 'var(--ember-text)' : 'var(--text-3)',
                      }}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                {queries.length === 0 ? (
                  <p style={{ color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 13 }}>No starter queries in this category.</p>
                ) : (
                  queries.map((q, i) => <QueryCard key={i} query={q} />)
                )}
              </div>
            )}

            {/* RUNBOOKS */}
            {tab === 'runbooks' && (
              <div style={{ marginTop: 26 }}>
                {kit.runbooks.length === 0 ? (
                  <p style={{ color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 13 }}>No alerts were found to document.</p>
                ) : (
                  kit.runbooks.map((r, i) => <RunbookCard key={i} rb={r} />)
                )}
              </div>
            )}

            {/* DASHBOARD */}
            {tab === 'dashboard' && <DashboardTab panels={kit.dashboard_panels} hasXml={!!kit.dashboard_xml} />}

            <div className="row" style={{ justifyContent: 'space-between', marginTop: 48, paddingTop: 24, borderTop: '1px solid var(--line)' }}>
              <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>got a question about any of this?</span>
              <button className="btn" onClick={() => goto('ask')}>
                <Icons.chat size={15} style={{ color: 'var(--ember)' }} /> Ask cairn
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function QueryCard({ query: q }: { query: GeneratedSPL }) {
  const tone = CAT_TONE[q.category] ?? 'var(--text-3)';
  return (
    <div className="card" style={{ padding: 20, marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 16 }}>{q.title}</h3>
          {q.description && <p style={{ color: 'var(--text-3)', fontSize: 13, margin: '5px 0 0' }}>{q.description}</p>}
        </div>
        <span className="pill" style={{ color: tone, borderColor: `${tone}44` }}>{q.category}</span>
      </div>
      <div style={{ marginTop: 14 }}><CodeBlock code={q.spl} /></div>
    </div>
  );
}

function RunbookCard({ rb }: { rb: Runbook }) {
  const sev = rb.severity === 'critical' ? 'critical' : rb.severity === 'info' ? 'info' : 'warning';
  return (
    <div className="card" style={{ padding: 24, marginBottom: 16, borderLeft: `2px solid ${sev === 'critical' ? 'var(--sev-high)' : sev === 'info' ? 'var(--sev-low)' : 'var(--sev-med)'}` }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <h3 style={{ fontSize: 18 }}>{rb.alert_name}</h3>
        <SeverityBadge level={sev} />
      </div>

      {rb.what_it_means && (
        <>
          <Eyebrow style={{ margin: '18px 0 8px' }}>what it means</Eyebrow>
          <p style={{ color: 'var(--text-2)', margin: 0 }}>{rb.what_it_means}</p>
        </>
      )}

      {rb.chain_summary && (
        <>
          <Eyebrow style={{ margin: '18px 0 10px' }}>dependency trail</Eyebrow>
          <div className="mono" style={{ fontSize: 12.5, color: 'var(--text-2)', background: 'var(--ink-0)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '10px 14px' }}>
            {rb.chain_summary}
          </div>
        </>
      )}

      {rb.first_checks?.length > 0 && (
        <>
          <Eyebrow style={{ margin: '18px 0 10px' }}>first checks</Eyebrow>
          <div className="col" style={{ gap: 8 }}>
            {rb.first_checks.map((c, i) => (
              <div key={i} className="row gap-3" style={{ alignItems: 'flex-start' }}>
                <span style={{ width: 19, height: 19, flexShrink: 0, borderRadius: 5, border: '1px solid var(--line-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-3)' }}>
                  {i + 1}
                </span>
                <span style={{ fontSize: 14, color: 'var(--text-2)' }}>{c}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {rb.spl_to_run && (
        <>
          <Eyebrow style={{ margin: '18px 0 8px' }}>spl to run</Eyebrow>
          <CodeBlock code={rb.spl_to_run} />
        </>
      )}

      {rb.who_to_contact && (
        <div className="row gap-2" style={{ marginTop: 16, fontSize: 13 }}>
          <Icons.chat size={14} style={{ color: 'var(--ember)' }} />
          <span style={{ color: 'var(--text-3)' }}>who to contact:</span>
          <span style={{ color: 'var(--text)' }}>{rb.who_to_contact}</span>
        </div>
      )}
    </div>
  );
}

function DashboardTab({ panels, hasXml }: { panels: DashboardPanel[]; hasXml: boolean }) {
  const [downloadError, setDownloadError] = useState('');
  async function handleDownload() {
    setDownloadError('');
    try {
      await downloadDashboardXml();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <div style={{ marginTop: 26 }}>
      <div className="card" style={{ padding: 20, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <div>
          <h3 style={{ fontSize: 16 }}>cairn-starter-dashboard.xml</h3>
          <p style={{ color: 'var(--text-3)', fontSize: 13, margin: '5px 0 0' }}>
            {panels.length} panel{panels.length !== 1 ? 's' : ''} · Simple XML · import via Settings → Dashboards
          </p>
        </div>
        <button className="btn btn-primary" onClick={handleDownload} disabled={!hasXml}>
          <Icons.download size={15} /> Download XML
        </button>
      </div>
      {downloadError && <div style={{ color: 'var(--sev-high)', fontFamily: 'var(--mono)', fontSize: 12.5, marginBottom: 12 }}>{downloadError}</div>}
      {panels.length === 0 ? (
        <p style={{ color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 13 }}>No panels were generated.</p>
      ) : (
        panels.map((p, i) => (
          <div key={i} className="card" style={{ padding: 18, marginBottom: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <h4 style={{ fontSize: 14.5 }}>{p.title}</h4>
              <span className="pill" style={{ color: 'var(--text-3)' }}>
                <Icons.dot size={8} /> {VIZ_LABEL[p.viz_type] ?? p.viz_type}
              </span>
            </div>
            <div style={{ marginTop: 12 }}><CodeBlock code={p.spl} pad="10px 14px" /></div>
          </div>
        ))
      )}
    </div>
  );
}
