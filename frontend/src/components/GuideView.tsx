import { Fragment, useEffect, useMemo, useRef, useState, forwardRef, type ReactNode } from 'react';
import { useCairn } from '../context/CairnContext';
import { markdownToHtml } from '../utils/markdown';
import { envSummaryLine } from '../utils/env';
import { navCount, type Counts } from '../utils/guide';
import { categorize } from './IndexTiles';
import RelationshipGraph from './RelationshipGraph';
import { Eyebrow, Icons } from './Primitives';
import { SkeletonText } from './Skeleton';
import type {
  GuideSection,
  ObjectRef,
  StructuredData,
} from '../types';
import type { Screen } from '../App';

interface Props {
  goto: (screen: Screen) => void;
}

// Per-section accent + summary, keyed by the backend's section titles.
const SECTION_META: Record<string, { accent: string; summary: (c: Counts) => string }> = {
  'Critical Alerts & What They Mean': {
    accent: 'var(--n-alert)',
    summary: (c) =>
      c.alert === 0 ? 'no alerts found' : `${c.alert} alert${c.alert !== 1 ? 's' : ''}${c.critical ? ` · ${c.critical} critical` : ''}`,
  },
  'Your Data Landscape': { accent: 'var(--n-index)', summary: (c) => `${c.index} index${c.index !== 1 ? 'es' : ''}` },
  "Your Team's Dashboards": { accent: 'var(--n-dash)', summary: (c) => `${c.dashboard} dashboard${c.dashboard !== 1 ? 's' : ''}` },
  'The Shorthand': { accent: 'var(--n-macro)', summary: (c) => `${c.macro} macro${c.macro !== 1 ? 's' : ''} · ${c.lookup} lookup${c.lookup !== 1 ? 's' : ''}` },
  'Who Knows What': { accent: 'var(--n-search)', summary: (c) => (c.owners ? `${c.owners} owner${c.owners !== 1 ? 's' : ''}` : 'ownership') },
  'AI & ML Footprint': {
    accent: 'var(--ember)',
    summary: (c) => `${c.mltkAlgorithms} algorithm${c.mltkAlgorithms !== 1 ? 's' : ''}${c.mltkModels ? ` · ${c.mltkModels} models` : ' · no trained models'}`,
  },
};

const ALERTS_TITLE = 'Critical Alerts & What They Mean';
const DATA_LANDSCAPE_TITLE = 'Your Data Landscape';
const DASHBOARDS_TITLE = "Your Team's Dashboards";
const SHORTHAND_TITLE = 'The Shorthand';
const OWNERSHIP_TITLE = 'Who Knows What';
const ML_TITLE = 'AI & ML Footprint';

export default function GuideView({ goto }: Props) {
  const { guide, guideError, counts, graph, findings, graphFocus, setGraphFocus, loadGuide, env } = useCairn();
  const scrollRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState<Set<number>>(new Set());

  useEffect(() => { loadGuide(); }, [loadGuide]);

  const sections: GuideSection[] = useMemo(
    () => (guide ? Object.entries(guide.sections ?? {}).map(([title, content]) => ({ title, content })) : []),
    [guide],
  );

  // User-created index nodes for the data-landscape tiles, largest volume first.
  const indexTiles = useMemo(
    () =>
      graph.nodes
        .filter((n) => n.type === 'index' && !n.name.startsWith('_'))
        .map((n) => ({ name: n.name, events: n.eventCount ?? 0, group: categorize(n.name), sourcetype: n.sourcetypes?.[0], empty: (n.eventCount ?? 0) === 0 }))
        .sort((a, b) => b.events - a.events),
    [graph],
  );

  // Scroll-spy for the section TOC.
  function onScroll() {
    const c = scrollRef.current;
    if (!c) return;
    const y = c.scrollTop + 120;
    let cur = 0;
    refs.current.forEach((el, i) => { if (el && el.offsetTop <= y) cur = i; });
    setActive(cur);
  }

  function jump(i: number) {
    const el = refs.current[i];
    const c = scrollRef.current;
    if (el && c) c.scrollTo({ top: el.offsetTop - 16, behavior: 'smooth' });
  }

  function toggleSection(i: number) {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  // Resolve a clicked Splunk-object chip into a highlighted graph chain + an
  // expanded/scrolled section.
  function focusTerm(term: string) {
    const t = term.trim().toLowerCase();
    if (!t) return;
    const node =
      graph.nodes.find((n) => n.name.toLowerCase() === t) ??
      graph.nodes.find((n) => t.includes(n.name.toLowerCase()));
    setGraphFocus(node ? node.id : null);

    const idx = sections.findIndex((s) => s.title.toLowerCase().includes(t) || s.content.toLowerCase().includes(t));
    if (idx >= 0) {
      setClosed((prev) => {
        if (!prev.has(idx)) return prev;
        const next = new Set(prev);
        next.delete(idx);
        return next;
      });
      requestAnimationFrame(() => jump(idx));
    } else if (node) {
      graphRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  const envLine = envSummaryLine(env);

  if (guideError) {
    return (
      <div className="center" style={{ height: '100%', flexDirection: 'column', gap: 10, color: 'var(--text-2)' }}>
        <Icons.alert size={26} style={{ color: 'var(--sev-high)' }} />
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>couldn't load the guide</div>
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}>{guideError}</div>
      </div>
    );
  }

  if (!guide || !counts) {
    return (
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '48px' }}>
        <SkeletonText lines={3} />
        <div style={{ height: 24 }} />
        <SkeletonText lines={8} />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      {/* section TOC */}
      <aside style={{ width: 212, flexShrink: 0, borderRight: '1px solid var(--line)', padding: '26px 0', overflowY: 'auto', background: 'var(--ink)' }}>
        <div className="eyebrow" style={{ padding: '0 22px 16px' }}>sections</div>
        {sections.map((s, i) => {
          const badge = navCount(s.title, counts);
          return (
            <button
              key={i}
              onClick={() => jump(i)}
              style={{
                display: 'flex', width: '100%', textAlign: 'left', gap: 10, alignItems: 'baseline',
                padding: '9px 22px', border: 'none', background: 'transparent', cursor: 'pointer',
                borderLeft: active === i ? '2px solid var(--ember)' : '2px solid transparent',
              }}
            >
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: active === i ? 'var(--ember)' : 'var(--text-4)', width: 16 }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="grow" style={{ fontSize: 13.5, lineHeight: 1.3, color: active === i ? 'var(--text)' : 'var(--text-2)', fontWeight: active === i ? 600 : 400 }}>
                {s.title}
              </span>
              {badge && <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: s.title === ML_TITLE ? 'var(--ember-text)' : 'var(--text-4)' }}>{badge}</span>}
            </button>
          );
        })}
        <div style={{ padding: '20px 22px 0' }}>
          <button className="btn" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => goto('ask')}>
            <Icons.chat size={15} style={{ color: 'var(--ember)' }} /> Ask cairn
          </button>
        </div>
      </aside>

      {/* document — position:relative so section.offsetTop is measured against
          this scroll container (TOC jump + scroll-spy depend on that). */}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        <div style={{ maxWidth: 880, margin: '0 auto', padding: '40px 48px 120px' }}>
          <Eyebrow>mode a · the guide</Eyebrow>
          <h1 className="display" style={{ fontSize: 38, marginTop: 14 }}>
            The guide you wish<br />someone had left you.
          </h1>
          <p style={{ color: 'var(--text-2)', fontSize: 16, maxWidth: 560, marginTop: 14 }}>
            {envLine
              ? `Synthesised from one exploration pass of your ${envLine} deployment. Every claim traces back to a real object.`
              : 'Synthesised from one exploration pass. Every claim traces back to a real object.'}
          </p>

          {/* dependency map hero */}
          {graph.edges.length > 0 && (
            <div className="card" ref={graphRef} style={{ marginTop: 30, padding: '18px 18px 14px' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <Eyebrow>dependency map</Eyebrow>
              </div>
              <RelationshipGraph
                nodes={graph.nodes}
                edges={graph.edges}
                deadNodeIds={findings?.dead_node_ids}
                selected={graphFocus}
                onSelect={setGraphFocus}
                height={360}
              />
            </div>
          )}

          {/* sections */}
          {sections.map((s, i) => (
            <GuideSectionCard
              key={i}
              ref={(el) => { refs.current[i] = el; }}
              n={i + 1}
              section={s}
              counts={counts}
              open={!closed.has(i)}
              onToggle={() => toggleSection(i)}
              onChipClick={focusTerm}
              topSlot={s.title === DATA_LANDSCAPE_TITLE ? <IndexTileGrid tiles={indexTiles} /> : undefined}
              rich={renderRichSection(s.title, guide.structured, focusTerm)}
            />
          ))}

          {/* footer */}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 48, paddingTop: 24, borderTop: '1px solid var(--line)' }}>
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>two more modes downstream of this pass →</span>
            <div className="row gap-3">
              <button className="btn" onClick={() => goto('findings')}>
                <Icons.flag size={15} style={{ color: 'var(--sev-high)' }} /> Findings
              </button>
              <button className="btn" onClick={() => goto('kit')}>
                <Icons.kit size={15} style={{ color: 'var(--ember)' }} /> Starter Kit
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Index tiles (Data Landscape) ─────────────────────────────────────────────
interface Tile {
  name: string;
  events: number;
  group: string;
  sourcetype?: string;
  empty: boolean;
}
const GROUP_TONE: Record<string, string> = {
  security: 'var(--n-alert)', application: 'var(--n-index)', deployment: 'var(--n-dash)', other: 'var(--text-3)',
};
function fmtEvents(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function IndexTileGrid({ tiles }: { tiles: Tile[] }) {
  if (tiles.length === 0) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginTop: 4, marginBottom: 18 }}>
      {tiles.map((t) => {
        const tone = GROUP_TONE[t.group] ?? 'var(--text-3)';
        return (
          <div
            key={t.name}
            style={{
              borderRadius: 'var(--r-md)', padding: 14,
              background: t.empty ? 'transparent' : 'var(--surface-2)',
              border: t.empty ? '1px dashed var(--line-2)' : '1px solid var(--line)',
            }}
            title={`${t.name} · ${t.events.toLocaleString()} events`}
          >
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: t.empty ? 'var(--text-3)' : 'var(--text)' }}>{t.name}</span>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: t.empty ? 'var(--text-4)' : tone }} />
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 24, fontWeight: 500, marginTop: 12, color: t.empty ? 'var(--text-4)' : 'var(--text)' }}>{fmtEvents(t.events)}</div>
            <div className="eyebrow" style={{ fontSize: 9, marginTop: 5 }}>{t.group}</div>
            {t.sourcetype && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-4)', marginTop: 4 }}>{t.sourcetype}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ── Section card ──────────────────────────────────────────────────────────────
function isThinSection(content: string): boolean {
  const stripped = content.replace(/[#*`_[\]]/g, '').trim();
  if (stripped.length < 200) return true;
  const thin = ['no ownership signals', 'no specific guidance', 'not currently used by any', 'there are no', 'no data available', 'no results found', 'could not be generated', 'rate limit'];
  return thin.some((p) => stripped.toLowerCase().includes(p));
}
const THIN_HINTS: Record<string, string> = {
  'Who Knows What': 'With more usage data in _audit, this section maps who created and most frequently uses each object — showing you exactly who to ask about what.',
  'The Shorthand': 'As more macros and lookups are used across saved searches, this section traces where each shorthand appears and why it was created.',
  "Your Team's Dashboards": 'With dashboard panel SPL queries, this section explains exactly what metrics each dashboard tracks.',
};
function thinHint(title: string, content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('could not be generated')) {
    return 'This section will populate when the AI service is available. Try re-exploring.';
  }
  return THIN_HINTS[title] ?? 'This section needs more environment data to be fully useful.';
}

interface CardProps {
  n: number;
  section: GuideSection;
  counts: Counts;
  open: boolean;
  onToggle: () => void;
  onChipClick: (term: string) => void;
  topSlot?: ReactNode;
  // Rich, structured rendering for this section. When present it replaces the
  // markdown body; when null we fall back to markdown (with the thin-section
  // treatment as before).
  rich?: ReactNode;
}

const GuideSectionCard = forwardRef<HTMLElement, CardProps>(function GuideSectionCard(
  { n, section, counts, open, onToggle, onChipClick, topSlot, rich },
  ref,
) {
  const meta = SECTION_META[section.title] ?? { accent: 'var(--line)', summary: () => '' };
  const sub = meta.summary(counts);

  function handleBodyClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.classList.contains('chip-clickable')) {
      const term = target.getAttribute('data-term');
      if (term) onChipClick(term);
    }
  }

  // Rich sections are never "thin" — they carry real structured content.
  if (!rich && isThinSection(section.content || '')) {
    return (
      <section ref={ref} style={{ marginTop: 54, scrollMarginTop: 20 }}>
        <div className="row gap-3" style={{ alignItems: 'baseline', marginBottom: 6 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ember)' }}>{String(n).padStart(2, '0')}</span>
          <h2 style={{ fontSize: 26 }}>{section.title}</h2>
        </div>
        <div className="card" style={{ padding: 18, marginTop: 12, opacity: 0.85 }}>
          <p style={{ color: 'var(--text-3)', fontSize: 13.5, margin: 0 }}>{thinHint(section.title, section.content || '')}</p>
        </div>
      </section>
    );
  }

  return (
    <section ref={ref} style={{ marginTop: 54, scrollMarginTop: 20, ['--section-accent' as string]: meta.accent }}>
      <button
        onClick={onToggle}
        style={{ display: 'flex', width: '100%', textAlign: 'left', alignItems: 'baseline', gap: 12, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ember)' }}>{String(n).padStart(2, '0')}</span>
        <span className="grow">
          <h2 style={{ fontSize: 26 }}>{section.title}</h2>
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 20, color: 'var(--text-3)' }}>{open ? '−' : '+'}</span>
      </button>
      {sub && <div className="eyebrow" style={{ marginTop: 6, marginBottom: 14 }}>{sub}</div>}
      {open &&
        (rich ? (
          <div style={{ marginTop: 4 }}>
            {topSlot}
            {rich}
          </div>
        ) : (
          <div className="markdown-body" onClick={handleBodyClick}>
            {topSlot}
            {section.content?.trim() ? (
              <div dangerouslySetInnerHTML={{ __html: markdownToHtml(section.content) }} />
            ) : (
              <SkeletonText lines={5} />
            )}
          </div>
        ))}
    </section>
  );
});

// ── Rich structured cards (Mode A) ───────────────────────────────────────────

// Map a section title to its rich renderer. Returns null when there's no
// structured data for it, so the card falls back to markdown.
function renderRichSection(
  title: string,
  s: StructuredData | undefined,
  onChip: (term: string) => void,
): ReactNode | null {
  if (!s) return null;
  switch (title) {
    case ALERTS_TITLE:
      return s.alerts.length ? <AlertCards alerts={s.alerts} onChip={onChip} /> : null;
    case DASHBOARDS_TITLE:
      return s.dashboards.length ? <DashboardCards dashboards={s.dashboards} onChip={onChip} /> : null;
    case SHORTHAND_TITLE:
      return s.macros.length || s.lookups.length ? <ShorthandCards macros={s.macros} lookups={s.lookups} onChip={onChip} /> : null;
    case OWNERSHIP_TITLE: {
      const cards = <OwnershipCards data={s} />;
      return cards ? cards : null;
    }
    case ML_TITLE:
      return s.mltk_algorithms.length ? <MLFootprint algorithms={s.mltk_algorithms} models={s.mltk_models} /> : null;
    default:
      return null;
  }
}

// chip glyph + class per object type, matching the dependency-graph palette.
const CHAIN_GLYPH: Record<string, string> = {
  alert: '△', saved_search: '◇', macro: '◇', lookup: '▫', index: '▪', sourcetype: '▪',
};
function chainClass(type: string): string {
  return `chain-chip chain-${type}`;
}

function ChainChip({ node, onChip }: { node: ObjectRef; onChip?: (t: string) => void }) {
  return (
    <button
      type="button"
      className={chainClass(node.type)}
      onClick={onChip ? () => onChip(node.name) : undefined}
      style={{ cursor: onChip ? 'pointer' : 'default' }}
      title={`${node.type}: ${node.name}`}
    >
      {CHAIN_GLYPH[node.type] ?? '▪'} {node.name}
    </button>
  );
}

function ChainFlow({ chain, onChip }: { chain: ObjectRef[]; onChip?: (t: string) => void }) {
  if (!chain.length) return null;
  return (
    <div className="chain-flow">
      {chain.map((dep, i) => (
        <Fragment key={`${dep.type}:${dep.name}`}>
          {i > 0 && <span className="chain-arrow">→</span>}
          <ChainChip node={dep} onChip={onChip} />
        </Fragment>
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          },
          () => {},
        );
      }}
    >
      {copied ? 'copied' : 'copy'}
    </button>
  );
}

function SplBlock({ spl }: { spl: string }) {
  if (!spl?.trim()) return null;
  return (
    <div className="spl-block">
      <code>{spl}</code>
      <CopyButton text={spl} />
    </div>
  );
}

function SevBadge({ severity }: { severity: string }) {
  const sev = severity?.toLowerCase() === 'critical' ? 'critical' : severity?.toLowerCase() === 'info' ? 'info' : 'warning';
  return <span className={`sev-badge sev-${sev}`}>● {sev}</span>;
}

function AlertCards({ alerts, onChip }: { alerts: StructuredData['alerts']; onChip: (t: string) => void }) {
  return (
    <div>
      {alerts.map((a) => (
        <div className="rich-card alert-card" key={a.name}>
          <div className="rich-card-head">
            <h4>{a.name}</h4>
            <SevBadge severity={a.severity} />
          </div>
          {a.spl_explanation && <p className="rich-card-desc">{a.spl_explanation}</p>}
          {a.chain.length > 0 && (
            <>
              <div className="eyebrow" style={{ marginTop: 14 }}>dependency chain</div>
              <ChainFlow chain={a.chain} onChip={onChip} />
            </>
          )}
          <SplBlock spl={a.spl} />
          <div className="rich-meta">
            {a.cron && <span>runs {a.cron}</span>}
            <span>{a.actions ? `action: ${a.actions}` : 'no alert action'}</span>
            {a.owner && <span>owner: {a.owner}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function DashboardCards({ dashboards, onChip }: { dashboards: StructuredData['dashboards']; onChip: (t: string) => void }) {
  return (
    <div>
      {dashboards.map((d) => (
        <div className="rich-card dash-card" key={d.name}>
          <div className="rich-card-head">
            <h4>{d.name.replace(/_/g, ' ')}</h4>
            {d.panelCount > 0 && <span className="panel-count">{d.panelCount} panels</span>}
          </div>
          {d.indexes.length > 0 && (
            <div className="chain-flow" style={{ marginTop: 10 }}>
              {d.indexes.map((idx) => (
                <ChainChip key={idx} node={{ name: idx, type: 'index' }} onChip={onChip} />
              ))}
            </div>
          )}
          {d.owner && <div className="rich-meta"><span>owner: {d.owner}</span></div>}
        </div>
      ))}
    </div>
  );
}

function UsedByRow({ usedBy, onChip }: { usedBy: ObjectRef[]; onChip: (t: string) => void }) {
  if (!usedBy.length) return <div className="used-by used-by-none">not referenced by any object</div>;
  return (
    <div className="chain-flow" style={{ marginTop: 8 }}>
      <span className="used-by-label">used by</span>
      {usedBy.map((u) => (
        <ChainChip key={`${u.type}:${u.name}`} node={u} onChip={onChip} />
      ))}
    </div>
  );
}

function ShorthandCards({
  macros,
  lookups,
  onChip,
}: {
  macros: StructuredData['macros'];
  lookups: StructuredData['lookups'];
  onChip: (t: string) => void;
}) {
  return (
    <div>
      {macros.length > 0 && (
        <>
          <div className="eyebrow" style={{ marginBottom: 10 }}>macros</div>
          {macros.map((m) => (
            <div className="rich-card macro-card" key={m.name}>
              <div className="rich-card-head">
                <ChainChip node={{ name: m.name, type: 'macro' }} onChip={onChip} />
                {m.usedBy.length > 0 && <span className="used-count">used × {m.usedBy.length}</span>}
              </div>
              <SplBlock spl={m.definition} />
              <UsedByRow usedBy={m.usedBy} onChip={onChip} />
            </div>
          ))}
        </>
      )}
      {lookups.length > 0 && (
        <>
          <div className="eyebrow" style={{ margin: '22px 0 10px' }}>lookups</div>
          {lookups.map((l) => (
            <div className="rich-card macro-card" key={l.name}>
              <div className="rich-card-head">
                <ChainChip node={{ name: l.name, type: 'lookup' }} onChip={onChip} />
                {l.usedBy.length > 0 && <span className="used-count">used × {l.usedBy.length}</span>}
              </div>
              <UsedByRow usedBy={l.usedBy} onChip={onChip} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// Group MLTK algorithm names into the four MLTK families. Anything unmatched
// falls into "other" so nothing is dropped.
const ML_CATEGORIES: { key: string; label: string; desc: string; match: string[] }[] = [
  { key: 'anomaly', label: 'Anomaly detection', desc: 'Surface login anomalies or system outliers', match: ['LocalOutlierFactor', 'MultivariateOutlierDetection', 'OneClassSVM', 'DBSCAN'] },
  { key: 'forecasting', label: 'Forecasting', desc: 'Predict future values in time-series', match: ['ARIMA', 'AutoPrediction', 'StateSpaceForecast', 'PACF', 'ACF', 'Kalman'] },
  { key: 'clustering', label: 'Clustering', desc: 'Group similar users, apps or systems', match: ['KMeans', 'XMeans', 'Birch', 'GMeans', 'SpectralClustering'] },
  { key: 'classification', label: 'Classification', desc: 'Classify events or entities', match: ['DecisionTreeClassifier', 'GradientBoostingClassifier', 'LogisticRegression', 'RandomForestClassifier', 'SVM', 'BernoulliNB', 'GaussianNB', 'MLPClassifier'] },
];

function MLFootprint({ algorithms, models }: { algorithms: string[]; models: string[] }) {
  const used = new Set<string>();
  const groups = ML_CATEGORIES.map((cat) => {
    const items = algorithms.filter((a) => cat.match.some((m) => a.toLowerCase().includes(m.toLowerCase())));
    items.forEach((i) => used.add(i));
    return { ...cat, items };
  }).filter((g) => g.items.length > 0);

  const other = algorithms.filter((a) => !used.has(a));
  if (other.length) groups.push({ key: 'other', label: 'Other algorithms', desc: 'Additional MLTK algorithms available', match: [], items: other });

  return (
    <div>
      <div className="ml-grid">
        {groups.map((g) => (
          <div className="rich-card ml-card" key={g.key}>
            <h4>{g.label}</h4>
            <div className="ml-chips">
              {g.items.map((it) => (
                <span className="ml-chip" key={it}>{it}</span>
              ))}
            </div>
            <div className="ml-card-desc">{g.desc}</div>
          </div>
        ))}
      </div>
      <div className="rich-meta" style={{ marginTop: 14 }}>
        <span>{algorithms.length} algorithms available</span>
        <span>{models.length ? `${models.length} trained model${models.length !== 1 ? 's' : ''}` : 'no trained models yet'}</span>
      </div>
    </div>
  );
}

function OwnershipCards({ data }: { data: StructuredData }): ReactNode | null {
  // Tally ownership across the owned object types.
  const counts = new Map<string, number>();
  const bump = (owner: string) => {
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  };
  data.alerts.forEach((a) => bump(a.owner));
  data.saved_searches.forEach((s) => bump(s.owner));
  data.dashboards.forEach((d) => bump(d.owner));

  const owners = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (owners.length === 0) return null;

  const total = owners.reduce((sum, [, c]) => sum + c, 0);
  const [topOwner, topCount] = owners[0];
  const busFactor = total >= 3 && topCount / total >= 0.6;
  const roleFor = (name: string) => data.users.find((u) => u.name === name)?.roles || '';

  return (
    <div>
      {busFactor && (
        <div className="bus-factor-card">
          <h4>⚠ Bus-factor risk</h4>
          <p>
            <b>{topOwner}</b> owns {topCount} of {total} objects ({Math.round((topCount / total) * 100)}%). If they leave,
            most of this environment's knowledge leaves with them — start spreading ownership.
          </p>
        </div>
      )}
      <div className="owner-grid">
        {owners.map(([name, c]) => (
          <div className="rich-card owner-card" key={name}>
            <div className="rich-card-head">
              <h4>{name}</h4>
              <span className="used-count">{c} object{c !== 1 ? 's' : ''}</span>
            </div>
            {roleFor(name) && <div className="rich-meta"><span>{roleFor(name)}</span></div>}
          </div>
        ))}
      </div>
    </div>
  );
}
