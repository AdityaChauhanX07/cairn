import { useState } from 'react';
import { SkeletonText } from './Skeleton';
import type { FindingsReport, Finding } from '../types';

interface Props {
  report: FindingsReport | null;
  generating: boolean;
  progress: string[];
  error: string;
  onBack: () => void;
  // Focus a finding's affected node in the relationship graph.
  onLocate: (nodeId: string) => void;
}

// Severity ordering (most urgent first) + reuse of the runbook severity palette.
const SEVERITY_ORDER = ['high', 'medium', 'low'];
const SEVERITY_CLASS: Record<string, string> = {
  high: 'critical',
  medium: 'warning',
  low: 'info',
};

const CATEGORY_LABEL: Record<string, string> = {
  orphaned_object: 'Orphaned object',
  alert_empty_index: 'Alert on empty index',
  alert_no_action: 'Alert with no action',
  alert_no_owner: 'Alert with no owner',
};

export default function FindingsView({ report, generating, progress, error, onBack, onLocate }: Props) {
  return (
    <div className="starter-kit">
      <div className="starter-kit-head">
        <button className="starter-back" onClick={onBack}>← Back to Guide</button>
        <h1 className="guide-title">Findings</h1>
        <p className="starter-kit-sub">
          Environment-hygiene issues found while exploring — each with a ready-to-apply fix.
          Cairn advises; you apply. Nothing here changes Splunk.
        </p>
      </div>

      {error && (
        <div className="error-banner" style={{ marginBottom: 20 }}>
          <span className="error-mark">!</span>
          <span>
            <span className="error-title">Findings scan stalled</span>
            <span className="error-hint">{error}</span>
          </span>
        </div>
      )}

      {!report && generating && (
        <div className="starter-progress">
          <div className="starter-progress-status">
            <span className="pulse-dot" />
            {progress[progress.length - 1] ?? 'scanning for hygiene issues…'}
          </div>
          <SkeletonText lines={5} />
        </div>
      )}

      {report && <FindingsBody report={report} onLocate={onLocate} />}
    </div>
  );
}

function FindingsBody({ report, onLocate }: { report: FindingsReport; onLocate: (id: string) => void }) {
  if (report.findings.length === 0) {
    return (
      <section className="starter-block">
        <p className="starter-empty">
          No hygiene issues found — this environment is clean. ✓
        </p>
      </section>
    );
  }

  // Group by severity, canonical order then any extras.
  const bySeverity = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const list = bySeverity.get(f.severity) ?? [];
    list.push(f);
    bySeverity.set(f.severity, list);
  }
  const sevs = [
    ...SEVERITY_ORDER.filter(s => bySeverity.has(s)),
    ...[...bySeverity.keys()].filter(s => !SEVERITY_ORDER.includes(s)),
  ];

  return (
    <>
      <div className="findings-summary">
        {report.findings.length} issue{report.findings.length === 1 ? '' : 's'} across this environment
      </div>
      {sevs.map(sev => (
        <section key={sev} className="starter-block">
          <h2 className="starter-section-header">{sev} severity</h2>
          {bySeverity.get(sev)!.map(f => (
            <FindingCard key={f.id} finding={f} onLocate={onLocate} />
          ))}
        </section>
      ))}
    </>
  );
}

function FindingCard({ finding: f, onLocate }: { finding: Finding; onLocate: (id: string) => void }) {
  const sevClass = SEVERITY_CLASS[f.severity] ?? 'info';
  return (
    <div className="runbook-card">
      <div className="runbook-header">
        <span className={`runbook-severity runbook-severity-${sevClass}`} />
        <span className="runbook-title">{f.title}</span>
        <span className={`runbook-sev-label sev-${sevClass}`}>
          {CATEGORY_LABEL[f.category] ?? f.category}
        </span>
      </div>

      {f.summary && <p className="runbook-text">{f.summary}</p>}

      <div className="runbook-section-label">Fix</div>
      <p className="runbook-text">{f.fix}</p>

      {f.fix_spl && (
        <>
          <div className="runbook-section-label">Suggested SPL</div>
          <CodeBlock text={f.fix_spl} />
        </>
      )}

      {f.affected_node_id && (
        <button className="starter-back" style={{ marginTop: 10 }} onClick={() => onLocate(f.affected_node_id)}>
          ◎ Locate in graph
        </button>
      )}
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
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
    <div className="query-card-spl">
      <pre><code>{text}</code></pre>
      <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
