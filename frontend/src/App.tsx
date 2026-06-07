import { useEffect, useState, type ReactNode } from 'react';
import { CairnProvider, useCairn } from './context/CairnContext';
import { exportGuide } from './utils/api';
import { envSummaryLine } from './utils/env';
import LandingPage from './components/LandingPage';
import ConnectForm from './components/ConnectForm';
import ExploreView from './components/ExploreView';
import GuideView from './components/GuideView';
import FindingsView from './components/FindingsView';
import StarterKitView from './components/StarterKitView';
import ChatView from './components/ChatView';
import { Icons, ReadOnlyBadge, ThemeToggle, Wordmark } from './components/Primitives';

export type Screen = 'landing' | 'connect' | 'explore' | 'guide' | 'findings' | 'kit' | 'ask';

interface TrailStop {
  k: Screen;
  name: string;
  icon: (typeof Icons)[string];
  mode: string | null;
}
const TRAIL: TrailStop[] = [
  { k: 'connect', name: 'Connect', icon: Icons.plug, mode: null },
  { k: 'explore', name: 'Explore', icon: Icons.graph, mode: null },
  { k: 'guide', name: 'Guide', icon: Icons.doc, mode: 'A' },
  { k: 'findings', name: 'Findings', icon: Icons.flag, mode: 'B' },
  { k: 'kit', name: 'Starter Kit', icon: Icons.kit, mode: 'C' },
  { k: 'ask', name: 'Ask', icon: Icons.chat, mode: null },
];

type StopStatus = 'active' | 'done' | 'ready' | 'locked';

export default function App() {
  return (
    <CairnProvider>
      <Shell />
    </CairnProvider>
  );
}

function Shell() {
  const cairn = useCairn();
  const [screen, setScreen] = useState<Screen>('landing');
  const [explored, setExplored] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('cairn-theme') || 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('cairn-theme', theme);
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  function go(k: Screen) {
    if (k === 'connect') return;
    if (!explored && k !== 'explore') return;
    setScreen(k);
  }

  const onConnect = () => setScreen('explore');
  const onExploreComplete = () => {
    setExplored(true);
    setScreen('guide');
  };

  function status(k: Screen): StopStatus {
    if (k === 'connect') return screen === 'connect' ? 'active' : 'done';
    if (k === 'explore') {
      if (screen === 'explore') return 'active';
      return explored ? 'done' : screen === 'connect' ? 'locked' : 'active';
    }
    if (!explored) return 'locked';
    return screen === k ? 'active' : 'ready';
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
    } catch {
      /* export failed — surfaced elsewhere; keep the shell responsive */
    } finally {
      setExporting(false);
    }
  }

  // Landing: full-screen 3D hero, the first thing users see. No shell.
  if (screen === 'landing') {
    return <LandingPage onEnter={() => setScreen('connect')} />;
  }

  // Connect screen: full bleed, no shell.
  if (screen === 'connect') {
    return (
      <>
        <ConnectForm onConnected={onConnect} />
        <ThemeToggle theme={theme} onToggle={toggleTheme} floating />
      </>
    );
  }

  const views: Record<Exclude<Screen, 'landing' | 'connect'>, ReactNode> = {
    explore: <ExploreView replay={explored} onComplete={onExploreComplete} />,
    guide: <GuideView goto={go} />,
    findings: <FindingsView goto={go} />,
    kit: <StarterKitView goto={go} />,
    ask: <ChatView />,
  };

  const envLine = envSummaryLine(cairn.env);
  const objCount = cairn.counts?.total;
  const topBar = [envLine, objCount ? `${objCount} objects` : '', cairn.env?.host].filter(Boolean).join(' · ');

  const alertCount = cairn.counts?.alert ?? 0;
  const findingsTotal = cairn.findings?.findings.length;
  const orphanCount = cairn.findings?.dead_node_ids.length;
  const highCount = cairn.findings?.findings.filter((f) => f.severity === 'high').length ?? 0;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--ink-0)' }}>
      {/* TOP BAR */}
      <header className="row" style={{ height: 60, padding: '0 22px', borderBottom: '1px solid var(--line)', background: 'var(--ink)', flexShrink: 0, gap: 20 }}>
        <Wordmark size={18} />
        <span className="grow" />
        {topBar && (
          <div className="row gap-3" style={{ color: 'var(--text-2)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--live)' }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--text-2)' }}>{topBar}</span>
          </div>
        )}
        <span style={{ width: 1, height: 22, background: 'var(--line-2)' }} />
        <ReadOnlyBadge />
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
        {explored && cairn.guide && (
          <button className="btn btn-ghost" onClick={handleExport} disabled={exporting} style={{ fontFamily: 'var(--sans)' }}>
            <Icons.download size={15} /> {exporting ? 'Exporting…' : 'Export'}
          </button>
        )}
      </header>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* TRAIL NAV */}
        <nav style={{ width: 232, flexShrink: 0, borderRight: '1px solid var(--line)', background: 'var(--ink)', padding: '26px 0', overflowY: 'auto' }}>
          <div className="eyebrow" style={{ padding: '0 24px 18px' }}>the trail</div>
          <div style={{ position: 'relative', padding: '0 16px' }}>
            {TRAIL.map((s, i) => (
              <TrailStopButton key={s.k} stop={s} st={status(s.k)} last={i === TRAIL.length - 1} onClick={() => go(s.k)} />
            ))}
          </div>

          <div style={{ padding: '26px 24px 0' }}>
            <div className="eyebrow" style={{ marginBottom: 12 }}>this environment</div>
            <MiniStat n={alertCount} l="alerts" sub={cairn.counts?.critical ? `${cairn.counts.critical} critical` : 'scheduled'} />
            <MiniStat n={findingsTotal ?? '—'} l="findings" sub={findingsTotal != null ? `${highCount} high` : 'open Findings'} tone="var(--sev-high)" />
            <MiniStat n={orphanCount ?? '—'} l="orphans" sub="dead weight" tone="var(--sev-med)" />
          </div>
        </nav>

        {/* MAIN */}
        <main key={screen} style={{ flex: 1, overflow: 'hidden', background: 'var(--ink-0)' }}>
          {views[screen as Exclude<Screen, 'landing' | 'connect'>]}
        </main>
      </div>
    </div>
  );
}

function TrailStopButton({ stop, st, last, onClick }: { stop: TrailStop; st: StopStatus; last: boolean; onClick: () => void }) {
  const locked = st === 'locked';
  const active = st === 'active';
  const done = st === 'done';
  const tone = active ? 'var(--ember)' : done ? 'var(--good)' : locked ? 'var(--text-4)' : 'var(--text-2)';
  const lineTone = done ? 'var(--good)' : 'var(--line-2)';
  return (
    <button
      onClick={onClick}
      disabled={locked}
      style={{
        display: 'flex', alignItems: 'center', gap: 13, width: '100%', textAlign: 'left',
        padding: '9px 8px', borderRadius: 'var(--r-sm)', border: 'none', cursor: locked ? 'default' : 'pointer',
        background: active ? 'var(--ember-dim)' : 'transparent', position: 'relative', marginBottom: 2, transition: 'background .15s',
      }}
    >
      {!last && <span style={{ position: 'absolute', left: 22.5, top: 34, height: 18, width: 2, background: lineTone, opacity: 0.6 }} />}
      <span style={{ width: 30, height: 22, flexShrink: 0, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span
          style={{
            width: 22, height: 13, borderRadius: 999,
            background: done ? 'var(--good)' : active ? 'var(--ember)' : 'transparent',
            border: locked || (!done && !active) ? '1.5px solid var(--line-3)' : 'none',
            boxShadow: active ? '0 0 0 4px var(--ember-dim)' : 'none', transition: 'all .2s',
          }}
        />
      </span>
      <span className="grow" style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 14.5, fontWeight: active ? 600 : 500, color: active ? 'var(--text)' : tone }}>{stop.name}</span>
      </span>
      {stop.mode && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em', color: locked ? 'var(--text-4)' : 'var(--text-3)', border: '1px solid var(--line-2)', borderRadius: 4, padding: '2px 5px' }}>
          MODE {stop.mode}
        </span>
      )}
      {locked && <Icons.lock size={13} style={{ color: 'var(--text-4)' }} />}
      {done && <Icons.check size={14} style={{ color: 'var(--good)' }} />}
    </button>
  );
}

function MiniStat({ n, l, sub, tone }: { n: ReactNode; l: string; sub: string; tone?: string }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: 'baseline', marginBottom: 11 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 19, fontWeight: 500, color: tone || 'var(--text)', width: 28 }}>{n}</span>
      <span style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{l}</span>
        <span className="eyebrow" style={{ fontSize: 9 }}>{sub}</span>
      </span>
    </div>
  );
}
