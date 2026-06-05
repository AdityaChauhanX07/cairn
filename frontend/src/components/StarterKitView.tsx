import { useState } from 'react';
import { downloadDashboardXml } from '../utils/api';
import { SkeletonText } from './Skeleton';
import type { StarterKit, GeneratedSPL, Runbook, DashboardPanel } from '../types';

interface Props {
  kit: StarterKit | null;
  generating: boolean;
  progress: string[];
  error: string;
  onBack: () => void;
}

// Category tints for the query chips — same palette as the index tiles, plus a
// violet for "troubleshooting" which has no index-tile equivalent.
const CATEGORY_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  security: { bg: 'rgba(248, 113, 113, 0.12)', border: 'rgba(248, 113, 113, 0.35)', text: '#f87171' },
  application: { bg: 'rgba(96, 165, 250, 0.12)', border: 'rgba(96, 165, 250, 0.35)', text: '#60a5fa' },
  infrastructure: { bg: 'rgba(52, 211, 153, 0.12)', border: 'rgba(52, 211, 153, 0.35)', text: '#34d399' },
  troubleshooting: { bg: 'rgba(167, 139, 250, 0.12)', border: 'rgba(167, 139, 250, 0.35)', text: '#a78bfa' },
  other: { bg: 'rgba(160, 160, 176, 0.08)', border: 'rgba(160, 160, 176, 0.25)', text: '#a0a0b0' },
};

// Stable category ordering so the most safety-relevant queries lead.
const CATEGORY_ORDER = ['security', 'application', 'infrastructure', 'troubleshooting', 'other'];

export default function StarterKitView({ kit, generating, progress, error, onBack }: Props) {
  return (
    <div className="starter-kit">
      <div className="starter-kit-head">
        <button className="starter-back" onClick={onBack}>← Back to Guide</button>
        <h1 className="guide-title">Starter Kit</h1>
        <p className="starter-kit-sub">
          Tailored SPL, per-alert runbooks, and an importable dashboard skeleton —
          generated from your environment.
        </p>
      </div>

      {error && (
        <div className="error-banner" style={{ marginBottom: 20 }}>
          <span className="error-mark">!</span>
          <span>
            <span className="error-title">Starter kit generation stalled</span>
            <span className="error-hint">{error}</span>
          </span>
        </div>
      )}

      {!kit && generating && (
        <div className="starter-progress">
          <div className="starter-progress-status">
            <span className="pulse-dot" />
            {progress[progress.length - 1] ?? 'generating starter kit…'}
          </div>
          <SkeletonText lines={6} />
        </div>
      )}

      {kit && (
        <>
          <QueriesBlock queries={kit.generated_queries} />
          <RunbooksBlock runbooks={kit.runbooks} />
          <DashboardBlock panels={kit.dashboard_panels} hasXml={!!kit.dashboard_xml} />
        </>
      )}
    </div>
  );
}

// ── 1. Generated queries ────────────────────────────────────────────────────

function QueriesBlock({ queries }: { queries: GeneratedSPL[] }) {
  // Group by category, preserving the canonical order then any extras.
  const byCategory = new Map<string, GeneratedSPL[]>();
  for (const q of queries) {
    const list = byCategory.get(q.category) ?? [];
    list.push(q);
    byCategory.set(q.category, list);
  }
  const cats = [
    ...CATEGORY_ORDER.filter(c => byCategory.has(c)),
    ...[...byCategory.keys()].filter(c => !CATEGORY_ORDER.includes(c)),
  ];

  return (
    <section id="starter-queries" className="starter-block">
      <h2 className="starter-section-header">Generated Queries</h2>
      {queries.length === 0 ? (
        <p className="starter-empty">No starter queries were generated for this environment.</p>
      ) : (
        cats.map(cat => (
          <div key={cat} className="query-group">
            <div className="query-group-label">{cat}</div>
            {byCategory.get(cat)!.map((q, i) => (
              <QueryCard key={i} query={q} />
            ))}
          </div>
        ))
      )}
    </section>
  );
}

function QueryCard({ query }: { query: GeneratedSPL }) {
  return (
    <div className="query-card">
      <div className="query-card-toprow">
        <span className="query-card-title">{query.title}</span>
        <CategoryChip category={query.category} />
      </div>
      {query.description && <div className="query-card-desc">{query.description}</div>}
      <CodeBlock text={query.spl} />
    </div>
  );
}

function CategoryChip({ category }: { category: string }) {
  const c = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other;
  return (
    <span
      className="query-cat-chip"
      style={{ background: c.bg, borderColor: c.border, color: c.text }}
    >
      {category}
    </span>
  );
}

// ── 2. Alert runbooks ───────────────────────────────────────────────────────

function RunbooksBlock({ runbooks }: { runbooks: Runbook[] }) {
  return (
    <section id="starter-runbooks" className="starter-block">
      <h2 className="starter-section-header">Alert Runbooks</h2>
      {runbooks.length === 0 ? (
        <p className="starter-empty">No alerts were found to document.</p>
      ) : (
        runbooks.map((rb, i) => <RunbookCard key={i} runbook={rb} />)
      )}
    </section>
  );
}

function RunbookCard({ runbook: rb }: { runbook: Runbook }) {
  const sev = rb.severity === 'critical' ? 'critical' : rb.severity === 'info' ? 'info' : 'warning';
  return (
    <div className="runbook-card">
      <div className="runbook-header">
        <span className={`runbook-severity runbook-severity-${sev}`} />
        <span className="runbook-title">{rb.alert_name}</span>
        <span className={`runbook-sev-label sev-${sev}`}>{rb.severity}</span>
      </div>

      {rb.what_it_means && (
        <>
          <div className="runbook-section-label">What it means</div>
          <p className="runbook-text">{rb.what_it_means}</p>
        </>
      )}

      {rb.chain_summary && (
        <>
          <div className="runbook-section-label">Dependency chain</div>
          <pre className="runbook-chain"><code>{rb.chain_summary}</code></pre>
        </>
      )}

      {rb.first_checks?.length > 0 && (
        <>
          <div className="runbook-section-label">First checks</div>
          <ol className="runbook-checks">
            {rb.first_checks.map((check, i) => (
              <li key={i}>{check}</li>
            ))}
          </ol>
        </>
      )}

      {rb.spl_to_run && (
        <>
          <div className="runbook-section-label">Investigative SPL</div>
          <CodeBlock text={rb.spl_to_run} />
        </>
      )}

      {rb.who_to_contact && (
        <div className="runbook-contact">
          <span className="runbook-contact-label">Who to contact:</span> {rb.who_to_contact}
        </div>
      )}
    </div>
  );
}

// ── 3. Dashboard skeleton ───────────────────────────────────────────────────

function DashboardBlock({ panels, hasXml }: { panels: DashboardPanel[]; hasXml: boolean }) {
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
    <section id="starter-dashboard" className="starter-block">
      <h2 className="starter-section-header">Dashboard Skeleton</h2>
      {panels.length === 0 ? (
        <p className="starter-empty">No panels were generated.</p>
      ) : (
        panels.map((p, i) => (
          <div key={i} className="panel-preview">
            <div className="panel-preview-head">
              <span className="panel-preview-title">{p.title}</span>
              <span className="panel-viz">{p.viz_type}</span>
            </div>
            <CodeBlock text={p.spl} />
          </div>
        ))
      )}

      <button
        className="dashboard-download-btn"
        onClick={handleDownload}
        disabled={!hasXml}
      >
        ↓ Download Dashboard XML
      </button>
      {downloadError && <div className="starter-empty" style={{ color: 'var(--accent-red)' }}>{downloadError}</div>}

      <p className="dashboard-note">
        Import this XML into Splunk: Settings → User Interface → Views → New Dashboard
        → Source → paste the XML
      </p>
    </section>
  );
}

// ── Shared: SPL code block with a copy button ───────────────────────────────

function CodeBlock({ text }: { text: string }) {
  return (
    <div className="query-card-spl">
      <pre><code>{text}</code></pre>
      <CopyButton text={text} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure context / permissions); fail quietly.
    }
  }

  return (
    <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
