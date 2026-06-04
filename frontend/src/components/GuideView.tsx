import { useState, useEffect } from 'react';
import { getGuide, exportGuide } from '../utils/api';
import { markdownToHtml } from '../utils/markdown';
import type { Guide, GuideSection } from '../types';

interface Props {
  onStartChat: () => void;
  showChat: boolean;
}

export default function GuideView({ onStartChat, showChat }: Props) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    getGuide()
      .then(setGuide)
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, []);

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

  if (error) {
    return <div className="error-banner">{error}</div>;
  }

  if (!guide) {
    return (
      <div className="guide-loading">
        <span className="spinner" />
        Loading guide...
      </div>
    );
  }

  const sections = Object.values(guide) as GuideSection[];

  return (
    <div className="guide-container">
      <header className="app-header">
        <span className="logo-emoji">🪨</span>
        <span className="logo-text">Cairn</span>
        <div className="header-actions">
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Exporting...' : 'Export Guide'}
          </button>
        </div>
      </header>

      <div className="guide-body">
        <div className="guide-intro">
          <h1 className="guide-title">Your Splunk Operations Guide</h1>
          <p className="guide-subtitle">
            {sections.length} section{sections.length !== 1 ? 's' : ''} generated
          </p>
        </div>

        <div className="guide-sections">
          {sections.map((section, i) => (
            <GuideCard key={i} section={section} defaultOpen={i === 0} />
          ))}
        </div>

        {!showChat && (
          <div className="guide-footer">
            <button className="btn btn-primary" onClick={onStartChat}>
              Ask a Question
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function GuideCard({ section, defaultOpen }: { section: GuideSection; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`guide-card ${open ? 'open' : ''}`}>
      <button className="guide-card-header" onClick={() => setOpen(o => !o)}>
        <span className="guide-card-title">{section.title}</span>
        <span className="guide-card-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div
          className="guide-card-body"
          dangerouslySetInnerHTML={{ __html: markdownToHtml(section.content) }}
        />
      )}
    </div>
  );
}
