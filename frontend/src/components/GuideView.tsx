import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useCairn } from '../context/CairnContext';
import { markdownToHtml } from '../utils/markdown';
import { envSummaryLine } from '../utils/env';
import { navCount, type Counts } from '../utils/guide';
import { categorize } from './IndexTiles';
import RelationshipGraph from './RelationshipGraph';
import { Chain, CodeBlock, Eyebrow, Icons, NodeChip, SeverityBadge } from './Primitives';
import { SkeletonText } from './Skeleton';
import type {
  GuideSection,
  StructuredAlert,
  StructuredDashboard,
  StructuredData,
  StructuredLookup,
  StructuredMacro,
} from '../types';
import type { Screen } from '../App';

interface Props {
  goto: (screen: Screen) => void;
}

const ALERTS_TITLE = 'Critical Alerts & What They Mean';
const DATA_LANDSCAPE_TITLE = 'Your Data Landscape';
const DASHBOARDS_TITLE = "Your Team's Dashboards";
const SHORTHAND_TITLE = 'The Shorthand';
const OWNERSHIP_TITLE = 'Who Knows What';
const ML_TITLE = 'AI & ML Footprint';

// Per-section subtitle (the small eyebrow under the heading), keyed by title.
const SECTION_SUB: Record<string, (c: Counts) => string> = {
  [ALERTS_TITLE]: (c) =>
    c.alert === 0 ? 'no alerts found' : `${c.alert} alert${c.alert !== 1 ? 's' : ''}${c.critical ? ` · ${c.critical} critical` : ''}`,
  [DATA_LANDSCAPE_TITLE]: (c) => `${c.index} index${c.index !== 1 ? 'es' : ''}`,
  [DASHBOARDS_TITLE]: (c) => `${c.dashboard} dashboard${c.dashboard !== 1 ? 's' : ''}`,
  [SHORTHAND_TITLE]: (c) => `${c.macro} macro${c.macro !== 1 ? 's' : ''} · ${c.lookup} lookup${c.lookup !== 1 ? 's' : ''}`,
  [OWNERSHIP_TITLE]: (c) => (c.owners ? `${c.owners} owner${c.owners !== 1 ? 's' : ''}` : 'ownership'),
  [ML_TITLE]: (c) =>
    `${c.mltkAlgorithms} algorithm${c.mltkAlgorithms !== 1 ? 's' : ''}${c.mltkModels ? ` · ${c.mltkModels} models` : ' · no trained models'}`,
};

// Keep card descriptions to the design's concise 1–2 sentences rather than the
// LLM's full SPL explanation paragraph.
function truncateToSentences(text: string, n = 2): string {
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences.slice(0, n).join(' ').trim();
}

// Flatten markdown to plain prose so we can lift a short section lead from it.
function stripMarkdown(md: string): string {
  return (md || '')
    .replace(/```[\s\S]*?```/g, ' ') // fenced code (incl. dependency-chain trees)
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/^#{1,6}\s.*$/gm, ' ') // headings
    .replace(/[*_>#[\]]/g, ' ') // markdown punctuation
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function leadText(md: string): string {
  return truncateToSentences(stripMarkdown(md), 2);
}

export default function GuideView({ goto }: Props) {
  const { guide, guideError, counts, graph, findings, graphFocus, setGraphFocus, loadGuide, env } = useCairn();
  const scrollRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLElement | null)[]>([]);
  const [active, setActive] = useState(0);

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

  // Resolve a clicked Splunk-object name into a highlighted graph chain and a
  // scrolled-to section.
  function focusTerm(term: string) {
    const t = term.trim().toLowerCase();
    if (!t) return;
    const node =
      graph.nodes.find((n) => n.name.toLowerCase() === t) ??
      graph.nodes.find((n) => t.includes(n.name.toLowerCase()));
    setGraphFocus(node ? node.id : null);
    const idx = sections.findIndex((s) => s.title.toLowerCase().includes(t) || s.content.toLowerCase().includes(t));
    if (idx >= 0) requestAnimationFrame(() => jump(idx));
    else if (node) graphRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

      {/* document */}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        <div style={{ maxWidth: 880, margin: '0 auto', padding: '40px 48px 120px' }}>
          {/* hero */}
          <Eyebrow>mode a · the guide</Eyebrow>
          <h1 className="display" style={{ fontSize: 38, marginTop: 14 }}>
            The guide you wish<br />someone had left you.
          </h1>
          <p style={{ color: 'var(--text-2)', fontSize: 16, maxWidth: 560, marginTop: 14 }}>
            {envLine
              ? `${sections.length} sections, synthesised from one exploration pass of your ${envLine} deployment. Every claim traces back to a real object.`
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
            <Section key={i} ref={(el) => { refs.current[i] = el; }} n={i + 1} title={s.title} sub={SECTION_SUB[s.title]?.(counts) ?? ''}>
              <SectionBody section={s} structured={guide.structured} tiles={indexTiles} onChip={focusTerm} />
            </Section>
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

// ── Section shell ─────────────────────────────────────────────────────────────
interface SectionProps {
  n: number;
  title: string;
  sub: string;
  children: ReactNode;
  ref?: React.Ref<HTMLElement>;
}
function Section({ n, title, sub, children, ref }: SectionProps) {
  return (
    <section ref={ref} style={{ marginTop: 54, scrollMarginTop: 20 }}>
      <div className="row gap-3" style={{ alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ember)' }}>{String(n).padStart(2, '0')}</span>
        <h2 style={{ fontSize: 26 }}>{title}</h2>
      </div>
      {sub && <div className="eyebrow" style={{ marginBottom: 14 }}>{sub}</div>}
      {children}
    </section>
  );
}

// ── Section body dispatcher ───────────────────────────────────────────────────
function SectionBody({
  section,
  structured,
  tiles,
  onChip,
}: {
  section: GuideSection;
  structured?: StructuredData;
  tiles: Tile[];
  onChip: (t: string) => void;
}) {
  const lead = leadText(section.content);
  const Lead = lead ? <p className="sec-lead">{lead}</p> : null;

  switch (section.title) {
    case ALERTS_TITLE:
      if (structured?.alerts.length) {
        return (
          <>
            {Lead}
            {structured.alerts.map((a) => (
              <AlertCard key={a.name} a={a} onChip={onChip} />
            ))}
          </>
        );
      }
      break;
    case DATA_LANDSCAPE_TITLE:
      return (
        <>
          {Lead}
          <IndexTileGrid tiles={tiles} />
          <Markdown content={section.content} onChip={onChip} />
        </>
      );
    case DASHBOARDS_TITLE:
      if (structured?.dashboards.length) {
        return (
          <>
            {Lead}
            {structured.dashboards.map((d) => (
              <DashboardCard key={d.name} d={d} onChip={onChip} />
            ))}
          </>
        );
      }
      break;
    case SHORTHAND_TITLE:
      if (structured?.macros.length || structured?.lookups.length) {
        return <ShorthandSection lead={Lead} macros={structured?.macros ?? []} lookups={structured?.lookups ?? []} onChip={onChip} />;
      }
      break;
    case OWNERSHIP_TITLE: {
      const ownership = structured ? <OwnershipSection lead={Lead} data={structured} /> : null;
      if (ownership) return ownership;
      break;
    }
    case ML_TITLE:
      if (structured?.mltk_algorithms.length) {
        return <MLSection lead={Lead} algorithms={structured.mltk_algorithms} models={structured.mltk_models} />;
      }
      break;
    default:
      break;
  }

  // Fallback: render the section markdown directly.
  return <Markdown content={section.content} onChip={onChip} />;
}

function Markdown({ content, onChip }: { content: string; onChip?: (t: string) => void }) {
  if (!content?.trim()) return <SkeletonText lines={5} />;
  function handleClick(e: React.MouseEvent) {
    if (!onChip) return;
    const target = e.target as HTMLElement;
    if (target.classList.contains('chip-clickable')) {
      const term = target.getAttribute('data-term');
      if (term) onChip(term);
    }
  }
  return <div className="markdown-body" onClick={handleClick} dangerouslySetInnerHTML={{ __html: markdownToHtml(content) }} />;
}

// ── Alerts ────────────────────────────────────────────────────────────────────
function AlertCard({ a, onChip }: { a: StructuredAlert; onChip: (t: string) => void }) {
  const crit = a.severity?.toLowerCase() === 'critical';
  const desc = truncateToSentences(a.spl_explanation, 2);
  return (
    <div className="card" style={{ padding: 22, marginTop: 16, borderLeft: crit ? '2px solid var(--sev-high)' : '1px solid var(--line)' }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <h3 style={{ fontSize: 18, cursor: 'pointer' }} onClick={() => onChip(a.name)}>{a.name}</h3>
        <SeverityBadge level={a.severity} />
      </div>
      {desc && <p style={{ color: 'var(--text-2)', marginTop: 10, marginBottom: 16 }}>{desc}</p>}
      {a.chain.length > 0 && (
        <>
          <Eyebrow style={{ marginBottom: 10 }}>dependency chain</Eyebrow>
          <Chain chain={a.chain.map((c) => ({ type: c.type, id: c.name }))} />
        </>
      )}
      {a.spl && <div style={{ marginTop: 16 }}><CodeBlock code={a.spl} /></div>}
      <div className="row gap-2" style={{ marginTop: 12, fontSize: 12.5, color: 'var(--text-3)', flexWrap: 'wrap' }}>
        {a.cron && <><span className="mono">runs {a.cron}</span><span>·</span></>}
        <span className="mono">action: {a.actions || 'none'}</span>
        {a.owner && <><span>·</span><span className="mono">owner: {a.owner}</span></>}
      </div>
    </div>
  );
}

// ── Dashboards ────────────────────────────────────────────────────────────────
function DashboardCard({ d, onChip }: { d: StructuredDashboard; onChip: (t: string) => void }) {
  return (
    <div className="card" style={{ padding: 20, marginTop: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <h3 style={{ fontSize: 17 }}>{d.name.replace(/_/g, ' ')}</h3>
        {d.panelCount > 0 && <span className="pill"><Icons.dot size={9} /> {d.panelCount} panels</span>}
      </div>
      {d.indexes.length > 0 && (
        <div className="row gap-2" style={{ flexWrap: 'wrap', marginTop: 12 }}>
          {d.indexes.map((r) => (
            <span key={r} onClick={() => onChip(r)} style={{ cursor: 'pointer' }}>
              <NodeChip type="index" label={r} />
            </span>
          ))}
        </div>
      )}
      {d.owner && (
        <p style={{ color: 'var(--text-3)', fontSize: 13, margin: '10px 0 0' }}>
          owner: <span className="mono" style={{ color: 'var(--text-2)' }}>{d.owner}</span>
        </p>
      )}
    </div>
  );
}

// ── The Shorthand (macros + lookups) ──────────────────────────────────────────
function ShorthandSection({
  lead,
  macros,
  lookups,
  onChip,
}: {
  lead: ReactNode;
  macros: StructuredMacro[];
  lookups: StructuredLookup[];
  onChip: (t: string) => void;
}) {
  return (
    <>
      {lead}
      {macros.length > 0 && (
        <>
          <Eyebrow style={{ margin: '20px 0 12px' }}>macros</Eyebrow>
          {macros.map((m) => (
            <ShorthandRow key={m.name} type="macro" name={m.name} def={m.definition} usedBy={m.usedBy.map((u) => u.name)} onChip={onChip} />
          ))}
        </>
      )}
      {lookups.length > 0 && (
        <>
          <Eyebrow style={{ margin: '22px 0 12px' }}>lookups</Eyebrow>
          {lookups.map((l) => (
            <ShorthandRow key={l.name} type="lookup" name={l.name} usedBy={l.usedBy.map((u) => u.name)} onChip={onChip} />
          ))}
        </>
      )}
    </>
  );
}

function ShorthandRow({
  type,
  name,
  def,
  usedBy,
  onChip,
}: {
  type: string;
  name: string;
  def?: string;
  usedBy: string[];
  onChip: (t: string) => void;
}) {
  const orphan = usedBy.length === 0;
  return (
    <div
      className="card"
      style={{
        padding: 16,
        marginBottom: 10,
        opacity: orphan ? 0.86 : 1,
        borderColor: orphan ? 'color-mix(in srgb, var(--sev-med) 35%, transparent)' : 'var(--line)',
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
        <span onClick={() => onChip(name)} style={{ cursor: 'pointer' }}>
          <NodeChip type={type} label={name} />
        </span>
        {orphan ? (
          <span className="pill" style={{ color: 'var(--sev-med)', borderColor: 'color-mix(in srgb, var(--sev-med) 45%, transparent)' }}>
            orphaned · 0 refs
          </span>
        ) : (
          <span className="pill" style={{ color: 'var(--good)', borderColor: 'rgba(127,169,140,0.44)' }}>
            used ×{usedBy.length}
          </span>
        )}
      </div>
      {def && <div style={{ marginTop: 12 }}><CodeBlock code={def} pad="10px 14px" /></div>}
      {usedBy.length > 0 && (
        <p style={{ color: 'var(--text-3)', fontSize: 13, margin: '10px 0 0' }}>
          used by <span className="mono" style={{ color: 'var(--text-2)' }}>{usedBy.join(', ')}</span>
        </p>
      )}
    </div>
  );
}

// ── Who Knows What (ownership / bus factor) ───────────────────────────────────
function OwnershipSection({ lead, data }: { lead: ReactNode; data: StructuredData }): ReactNode {
  const counts = new Map<string, number>();
  const bump = (owner: string) => { if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1); };
  data.alerts.forEach((a) => bump(a.owner));
  data.saved_searches.forEach((s) => bump(s.owner));
  data.dashboards.forEach((d) => bump(d.owner));

  const owners = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (owners.length === 0) return null;

  const total = owners.reduce((sum, [, c]) => sum + c, 0);
  const [topOwner, topCount] = owners[0];
  const busFactor = total >= 3 && topCount / total >= 0.6;
  const roleFor = (name: string) => data.users.find((u) => u.name === name)?.roles || '';
  const alertCount = data.alerts.filter((a) => a.owner === topOwner).length;
  const searchCount = data.saved_searches.filter((s) => s.owner === topOwner).length;

  return (
    <>
      {lead}
      {busFactor && (
        <div className="card" style={{ padding: 22, marginTop: 16, borderLeft: '2px solid var(--sev-med)' }}>
          <div className="row gap-3">
            <Icons.alert size={18} style={{ color: 'var(--sev-med)' }} />
            <h3 style={{ fontSize: 17 }}>Bus factor: {owners.length === 1 ? 'one' : owners.length}</h3>
          </div>
          <p style={{ color: 'var(--text-2)', marginTop: 10, marginBottom: 0 }}>
            <strong style={{ color: 'var(--text)' }}>{topOwner}</strong> owns {topCount} of {total} objects
            {alertCount || searchCount ? ` (${alertCount} alert${alertCount !== 1 ? 's' : ''}, ${searchCount} saved search${searchCount !== 1 ? 'es' : ''})` : ''}. If
            they leave, most of this environment's knowledge leaves with them — start spreading ownership.
          </p>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
        {owners.map(([name, c]) => (
          <div key={name} className="card" style={{ padding: 18 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <h4 style={{ fontSize: 15 }}>{name}</h4>
              <span className="pill">{c} object{c !== 1 ? 's' : ''}</span>
            </div>
            {roleFor(name) && (
              <p style={{ color: 'var(--text-3)', fontSize: 12.5, margin: '8px 0 0', fontFamily: 'var(--mono)' }}>{roleFor(name)}</p>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ── AI & ML Footprint ─────────────────────────────────────────────────────────
const ML_CATEGORIES: { key: string; label: string; desc: string; match: string[] }[] = [
  { key: 'anomaly', label: 'Anomaly detection', desc: 'Surface login anomalies or system outliers', match: ['LocalOutlierFactor', 'MultivariateOutlierDetection', 'OneClassSVM', 'DBSCAN'] },
  { key: 'forecasting', label: 'Forecasting', desc: 'Predict future values in time-series', match: ['ARIMA', 'AutoPrediction', 'StateSpaceForecast', 'PACF', 'ACF', 'Kalman'] },
  { key: 'clustering', label: 'Clustering', desc: 'Group similar users, apps or systems', match: ['KMeans', 'XMeans', 'Birch', 'GMeans', 'SpectralClustering'] },
  { key: 'classification', label: 'Classification', desc: 'Classify events or entities', match: ['DecisionTreeClassifier', 'GradientBoostingClassifier', 'LogisticRegression', 'RandomForestClassifier', 'SVM', 'BernoulliNB', 'GaussianNB', 'MLPClassifier'] },
];

function MLSection({ lead, algorithms, models }: { lead: ReactNode; algorithms: string[]; models: string[] }) {
  const used = new Set<string>();
  const groups = ML_CATEGORIES.map((cat) => {
    const items = algorithms.filter((a) => cat.match.some((m) => a.toLowerCase().includes(m.toLowerCase())));
    items.forEach((i) => used.add(i));
    return { ...cat, items };
  }).filter((g) => g.items.length > 0);

  const other = algorithms.filter((a) => !used.has(a));
  if (other.length) groups.push({ key: 'other', label: 'Other algorithms', desc: 'Additional MLTK algorithms available', match: [], items: other });

  return (
    <>
      <div className="row gap-3" style={{ marginBottom: 4, flexWrap: 'wrap' }}>
        <span className="pill" style={{ color: 'var(--ember-text)', borderColor: 'var(--ember-line)' }}>
          <Icons.spark size={12} /> ML Toolkit detected
        </span>
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {algorithms.length} algorithms · {models.length} trained model{models.length !== 1 ? 's' : ''}
        </span>
      </div>
      {lead && <div style={{ marginTop: 12 }}>{lead}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
        {groups.map((g) => (
          <div key={g.key} className="card" style={{ padding: 16 }}>
            <h4 style={{ fontSize: 14.5 }}>{g.label}</h4>
            <div className="row gap-2" style={{ flexWrap: 'wrap', margin: '10px 0' }}>
              {g.items.map((it) => (
                <span key={it} className="mono" style={{ fontSize: 11, color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 5, padding: '2px 7px' }}>
                  {it}
                </span>
              ))}
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: 0 }}>{g.desc}</p>
          </div>
        ))}
      </div>
    </>
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
