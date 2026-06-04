import { useState, useEffect, useMemo, useRef, forwardRef } from 'react';
import { getGuide, exportGuide } from '../utils/api';
import { markdownToHtml } from '../utils/markdown';
import { loadEnv, envSummaryLine } from '../utils/env';
import type { Guide, GuideSection } from '../types';

interface Props {
  onStartChat: () => void;
  onReExplore: () => void;
  showChat: boolean;
}

interface SnapNode {
  type: string;
  name: string;
  properties?: Record<string, unknown>;
}

// Per-section presentation: icon + a summary builder driven by graph counts.
// Keyed by the backend's section titles; unknown titles fall back to a default.
const SECTION_META: Record<string, { icon: string; summary: (c: Counts) => string }> = {
  'Critical Alerts & What They Mean': {
    icon: '🚨',
    summary: (c) =>
      c.alert === 0
        ? 'No alerts found'
        : `${c.alert} alert${c.alert !== 1 ? 's' : ''}${c.critical ? `, ${c.critical} critical` : ''}`,
  },
  'Your Data Landscape': {
    icon: '🗂️',
    summary: (c) => `${c.index} index${c.index !== 1 ? 'es' : ''} discovered`,
  },
  "Your Team's Dashboards": {
    icon: '📊',
    summary: (c) => `${c.dashboard} dashboard${c.dashboard !== 1 ? 's' : ''}`,
  },
  'The Shorthand': {
    icon: '🔤',
    summary: (c) => `${c.macro} macro${c.macro !== 1 ? 's' : ''}, ${c.lookup} lookup${c.lookup !== 1 ? 's' : ''}`,
  },
  'Who Knows What': {
    icon: '👤',
    summary: (c) => (c.owners ? `${c.owners} owner${c.owners !== 1 ? 's' : ''}` : 'Ownership signals'),
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

export default function GuideView({ onStartChat, onReExplore, showChat }: Props) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);

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
  const env = useMemo(() => loadEnv(), []);

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

  return (
    <div className="guide-container">
      <header className="app-header">
        <span className="logo-emoji">🪨</span>
        <span className="logo-text">Cairn</span>
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
            {exporting ? 'Exporting…' : 'Export Guide'}
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

      {!guide && !error && (
        <div className="guide-loading"><span className="spinner" />Loading guide…</div>
      )}

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
              <h1 className="guide-title">Your Splunk Operations Guide</h1>
              <p className="guide-subtitle">
                {[envLine || 'Splunk environment', `${counts.total} objects discovered`]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>

            <div className="guide-sections">
              {sections.map((section, i) => (
                <GuideCard
                  key={i}
                  ref={el => { sectionRefs.current[i] = el; }}
                  index={i}
                  section={section}
                  counts={counts}
                  defaultOpen
                />
              ))}
            </div>

            {!showChat && (
              <div className="explore-action" style={{ padding: '32px 0 0' }}>
                <button className="btn btn-primary" onClick={onStartChat}>
                  Ask a Question
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface CardProps {
  index: number;
  section: GuideSection;
  counts: Counts;
  defaultOpen: boolean;
}

const GuideCard = forwardRef<HTMLDivElement, CardProps>(function GuideCard(
  { index, section, counts, defaultOpen },
  ref
) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = SECTION_META[section.title] ?? { icon: '📄', summary: () => '' };
  const summary = meta.summary(counts);

  // Severity accent on the critical-alerts section only.
  const isAlerts = section.title === 'Critical Alerts & What They Mean';
  const sevClass = isAlerts
    ? counts.critical > 0 ? 'sev-critical' : counts.alert > 0 ? 'sev-warning' : ''
    : '';

  return (
    <div
      ref={ref}
      data-index={index}
      className={`guide-card ${open ? 'open' : ''} ${sevClass}`}
    >
      <button className="guide-card-header" onClick={() => setOpen(o => !o)}>
        <span className="guide-card-icon">{meta.icon}</span>
        <span className="guide-card-heading">
          <span className="guide-card-title">{section.title}</span>
          {summary && <span className="guide-card-summary">{summary}</span>}
        </span>
        <span className="guide-card-chevron">▸</span>
      </button>
      {open && (
        <div
          className="guide-card-body"
          dangerouslySetInnerHTML={{ __html: markdownToHtml(section.content || '') }}
        />
      )}
    </div>
  );
});
