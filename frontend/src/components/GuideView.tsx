import { useState, useEffect, useMemo, useRef, forwardRef, type ReactNode } from 'react';
import { getGuide, exportGuide } from '../utils/api';
import { markdownToHtml } from '../utils/markdown';
import { loadEnv, envSummaryLine } from '../utils/env';
import RelationshipGraph from './RelationshipGraph';
import ChatView from './ChatView';
import CairnMark from './CairnMark';
import IndexTiles, { categorize, type IndexTile } from './IndexTiles';
import { SkeletonGuide, SkeletonText } from './Skeleton';
import type { Guide, GuideSection, GraphNode, GraphEdge } from '../types';

// Title of the section the index-tile visualization belongs above.
const DATA_LANDSCAPE_TITLE = 'Your Data Landscape';

interface Props {
  onReExplore: () => void;
  onChipClick?: (term: string) => void;
}

interface SnapNode {
  type: string;
  name: string;
  properties?: Record<string, unknown>;
}

// Per-section presentation: a left accent color (by object type) + a summary
// built from graph counts. Keyed by the backend's titles; unknown -> default.
const SECTION_META: Record<string, { accent: string; summary: (c: Counts) => string }> = {
  'Critical Alerts & What They Mean': {
    accent: 'var(--type-alert)',
    summary: (c) =>
      c.alert === 0
        ? 'no alerts found'
        : `${c.alert} alert${c.alert !== 1 ? 's' : ''}${c.critical ? `, ${c.critical} critical` : ''}`,
  },
  'Your Data Landscape': {
    accent: 'var(--type-index)',
    summary: (c) => `${c.index} index${c.index !== 1 ? 'es' : ''}`,
  },
  "Your Team's Dashboards": {
    accent: 'var(--type-dashboard)',
    summary: (c) => `${c.dashboard} dashboard${c.dashboard !== 1 ? 's' : ''}`,
  },
  'The Shorthand': {
    accent: 'var(--type-macro)',
    summary: (c) => `${c.macro} macro${c.macro !== 1 ? 's' : ''}, ${c.lookup} lookup${c.lookup !== 1 ? 's' : ''}`,
  },
  'Who Knows What': {
    accent: 'var(--type-saved-search)',
    summary: (c) => (c.owners ? `${c.owners} owner${c.owners !== 1 ? 's' : ''}` : 'ownership signals'),
  },
};

interface Counts {
  index: number;
  alert: number;
  saved_search: number;
  macro: number;
  lookup: number;
  dashboard: number;
  critical: number;
  owners: number;
  total: number;
}

function looksCritical(node: SnapNode): boolean {
  const sev = node.properties?.alert_severity;
  if (typeof sev === 'number') return sev >= 5;
  if (typeof sev === 'string' && /crit|^5$|high/i.test(sev)) return true;
  return /^critical\b/i.test(node.name);
}

function deriveCounts(guide: Guide): Counts {
  const nodes = (guide.graph_snapshot?.nodes as SnapNode[] | undefined) ?? [];
  const c: Counts = {
    index: 0, alert: 0, saved_search: 0, macro: 0, lookup: 0, dashboard: 0,
    critical: 0, owners: 0, total: nodes.length,
  };
  const owners = new Set<string>();
  for (const n of nodes) {
    if (n.type in c) (c as unknown as Record<string, number>)[n.type] += 1;
    if (n.type === 'alert' && looksCritical(n)) c.critical += 1;
    const owner = n.properties?.owner;
    if (typeof owner === 'string' && owner.trim()) owners.add(owner);
  }
  c.owners = owners.size;
  return c;
}

// Short label for the left-rail count badge per section.
function navCount(title: string, c: Counts): string {
  switch (title) {
    case 'Critical Alerts & What They Mean': return String(c.alert);
    case 'Your Data Landscape': return String(c.index);
    case "Your Team's Dashboards": return String(c.dashboard);
    case 'The Shorthand': return String(c.macro + c.lookup);
    case 'Who Knows What': return c.owners ? String(c.owners) : '';
    default: return '';
  }
}

// Edge relationships and node types the visualization cares about — used when
// falling back to the full graph_snapshot for guides generated before the
// trimmed graph_nodes / graph_edges fields existed.
const VIEW_NODE_TYPES = ['alert', 'saved_search', 'macro', 'lookup', 'index'];
const VIEW_EDGE_TYPES = ['references_macro', 'references_lookup', 'reads_from_index'];

function deriveGuideGraph(guide: Guide): { nodes: GraphNode[]; edges: GraphEdge[] } {
  // Preferred: the backend already trimmed these for us.
  if (guide.graph_nodes && guide.graph_edges) {
    return { nodes: guide.graph_nodes, edges: guide.graph_edges };
  }
  // Fallback: filter the full snapshot the same way the backend would.
  const snapNodes = (guide.graph_snapshot?.nodes as SnapNode[] | undefined) ?? [];
  const snapEdges =
    (guide.graph_snapshot?.edges as { source: string; target: string; type: string }[] | undefined) ?? [];
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  for (const n of snapNodes) {
    const anyN = n as SnapNode & { id?: string };
    if (!VIEW_NODE_TYPES.includes(n.type)) continue;
    if (n.properties?.placeholder) continue;
    if (n.type === 'index' && n.name.startsWith('_')) continue;
    const id = anyN.id ?? `${n.type}:${n.name}`;
    ids.add(id);
    nodes.push({ id, name: n.name, type: n.type as GraphNode['type'] });
  }
  const edges: GraphEdge[] = snapEdges
    .filter((e) => VIEW_EDGE_TYPES.includes(e.type) && ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, relationship: e.type }));
  return { nodes, edges };
}

export default function GuideView({ onReExplore, onChipClick }: Props) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Narrow-screen overlay: the Q&A panel is docked on wide screens, a drawer below.
  const [chatOpen, setChatOpen] = useState(false);
  // Sections collapse on demand; a card is open unless its index is in this set.
  const [closedSections, setClosedSections] = useState<Set<number>>(new Set());
  // Node lit up by a chip click — fed to the graph so it highlights that chain.
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const graphRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getGuide()
      .then(setGuide)
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const sections: GuideSection[] = useMemo(
    () => (guide ? Object.entries(guide.sections ?? {}).map(([title, content]) => ({ title, content })) : []),
    [guide]
  );
  const counts = useMemo(() => (guide ? deriveCounts(guide) : null), [guide]);
  const graph = useMemo(() => (guide ? deriveGuideGraph(guide) : { nodes: [], edges: [] }), [guide]);
  const env = useMemo(() => loadEnv(), []);

  // User-created index nodes as sized tiles, largest volume first.
  const indexTiles = useMemo<IndexTile[]>(
    () =>
      graph.nodes
        .filter(n => n.type === 'index' && !n.name.startsWith('_'))
        .map(n => ({
          name: n.name,
          eventCount: n.eventCount ?? 0,
          category: categorize(n.name),
          sourcetype: n.sourcetypes?.[0],
        }))
        .sort((a, b) => b.eventCount - a.eventCount),
    [graph]
  );

  // Scroll-spy: highlight the section nearest the top of the viewport.
  useEffect(() => {
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          const idx = Number((visible[0].target as HTMLElement).dataset.index);
          if (!Number.isNaN(idx)) setActiveIndex(idx);
        }
      },
      { rootMargin: '-80px 0px -65% 0px', threshold: 0 }
    );
    sectionRefs.current.forEach(el => el && observer.observe(el));
    return () => observer.disconnect();
  }, [sections.length]);

  // Resolve a clicked Splunk-object term into (a) an expanded + scrolled guide
  // section and (b) a highlighted graph chain. Either may match independently;
  // if only the graph matches we scroll the map into view instead.
  useEffect(() => {
    function focusTerm(term: string) {
      const t = term.trim().toLowerCase();
      if (!t) return;
      // On narrow screens the chat is an overlay — close it so the scroll /
      // highlight it triggers is actually visible behind it.
      setChatOpen(false);

      // Graph: prefer an exact name match, else a node whose name is embedded in
      // the term (handles "index=auth_events" pointing at the "auth_events" node).
      const node =
        graph.nodes.find(n => n.name.toLowerCase() === t) ??
        graph.nodes.find(n => t.includes(n.name.toLowerCase()));
      setFocusedNodeId(node ? node.id : null);

      // Section: first whose title or body mentions the term (case-insensitive).
      const idx = sections.findIndex(
        s => s.title.toLowerCase().includes(t) || s.content.toLowerCase().includes(t),
      );

      if (idx >= 0) {
        setClosedSections(prev => {
          if (!prev.has(idx)) return prev;
          const next = new Set(prev);
          next.delete(idx);
          return next;
        });
        // Let the expand paint before scrolling so we land at the real offset.
        requestAnimationFrame(() =>
          sectionRefs.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
      } else if (node) {
        graphRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    const handler = (e: Event) => focusTerm((e as CustomEvent<string>).detail);
    window.addEventListener('cairn:chip-click', handler);
    return () => window.removeEventListener('cairn:chip-click', handler);
  }, [sections, graph]);

  function toggleSection(i: number) {
    setClosedSections(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function handleExport() {
    setExporting(true);
    try {
      const content = await exportGuide('markdown');
      const blob = new Blob([content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cairn-guide.md';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  function jumpTo(i: number) {
    sectionRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const envLine = envSummaryLine(env);
  // The guide IS the page — title it with the environment, e.g. "MSI — Splunk 10.4.0".
  const guideTitle = (() => {
    const lead = env?.product || env?.os;
    const ver = env?.version ? `Splunk ${env.version}` : 'Splunk environment';
    return lead ? `${lead} — ${ver}` : ver;
  })();

  return (
    <div className="guide-container">
      <header className="app-header">
        <div className="brand">
          <CairnMark stacked={4} size={24} />
          <span className="brand-text">cairn</span>
          <span className="brand-dot">.</span>
        </div>
        {(envLine || counts) && (
          <span className="header-env">
            <span className="env-dot" />
            {[envLine, counts ? `${counts.total} objects` : '', env?.host]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        <div className="header-actions">
          <button className="btn btn-secondary btn-sm" onClick={onReExplore}>
            Re-explore
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export as Markdown'}
          </button>
        </div>
      </header>

      {error && (
        <div style={{ padding: '24px 28px' }}>
          <div className="error-banner">
            <span className="error-icon">⚠</span>
            <span>
              <span className="error-title">Couldn't load the guide</span>
              <span className="error-hint">{error}</span>
            </span>
          </div>
        </div>
      )}

      {!guide && !error && <SkeletonGuide />}

      {guide && counts && (
        <div className="guide-layout">
          <nav className="guide-nav">
            <div className="guide-nav-label">Sections</div>
            {sections.map((s, i) => {
              const badge = navCount(s.title, counts);
              return (
                <button
                  key={i}
                  className={`guide-nav-item ${i === activeIndex ? 'active' : ''}`}
                  onClick={() => jumpTo(i)}
                >
                  <span>{s.title}</span>
                  {badge && <span className="guide-nav-count">{badge}</span>}
                </button>
              );
            })}
          </nav>

          <div className="guide-content">
            <div className="guide-intro">
              <h1 className="guide-title">{guideTitle}</h1>
            </div>

            {graph.edges.length > 0 && (
              <div className="guide-graph" ref={graphRef}>
                <div className="guide-graph-header">
                  <span className="guide-graph-title">Dependency map</span>
                  <span className="guide-graph-hint">Click an alert to trace its chain</span>
                </div>
                <RelationshipGraph
                  nodes={graph.nodes}
                  edges={graph.edges}
                  focusedNodeId={focusedNodeId}
                  onNodeClick={setFocusedNodeId}
                />
              </div>
            )}

            <div className="guide-sections">
              {sections.map((section, i) => (
                <GuideCard
                  key={i}
                  ref={el => { sectionRefs.current[i] = el; }}
                  index={i}
                  section={section}
                  counts={counts}
                  open={!closedSections.has(i)}
                  onToggle={() => toggleSection(i)}
                  onChipClick={onChipClick}
                  topSlot={
                    section.title === DATA_LANDSCAPE_TITLE ? (
                      <IndexTiles indexes={indexTiles} />
                    ) : undefined
                  }
                />
              ))}
            </div>
          </div>

          <aside className={`guide-chat ${chatOpen ? 'open' : ''}`}>
            <div className="guide-chat-header">
              <span>Ask cairn</span>
              <button
                className="guide-chat-close"
                onClick={() => setChatOpen(false)}
                aria-label="Close chat"
              >
                ×
              </button>
            </div>
            <ChatView onChipClick={onChipClick} />
          </aside>

          <button
            className={`chat-fab ${chatOpen ? 'hidden' : ''}`}
            onClick={() => setChatOpen(true)}
            aria-label="Open chat"
          >
            Ask cairn
          </button>
        </div>
      )}
    </div>
  );
}

interface CardProps {
  index: number;
  section: GuideSection;
  counts: Counts;
  open: boolean;
  onToggle: () => void;
  onChipClick?: (term: string) => void;
  topSlot?: ReactNode; // rendered above the markdown body (e.g. the index tiles)
}

const GuideCard = forwardRef<HTMLDivElement, CardProps>(function GuideCard(
  { index, section, counts, open, onToggle, onChipClick, topSlot },
  ref
) {
  const meta = SECTION_META[section.title] ?? { accent: 'var(--border)', summary: () => '' };
  const summary = meta.summary(counts);

  function handleBodyClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.classList.contains('chip-clickable')) {
      const term = target.getAttribute('data-term');
      if (term) onChipClick?.(term);
    }
  }

  return (
    <div
      ref={ref}
      data-index={index}
      className="guide-card"
      style={{ ['--section-accent' as string]: meta.accent }}
    >
      <button className="guide-card-header" onClick={onToggle}>
        <span className="guide-card-heading">
          <span className="guide-card-title">{section.title}</span>
          {summary && <span className="guide-card-summary">{summary}</span>}
        </span>
        <span className="guide-card-toggle">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="guide-card-body" onClick={handleBodyClick}>
          {topSlot}
          {section.content?.trim() ? (
            <div dangerouslySetInnerHTML={{ __html: markdownToHtml(section.content) }} />
          ) : (
            <SkeletonText lines={5} />
          )}
        </div>
      )}
    </div>
  );
});
