import { useEffect, useState, type ReactNode } from 'react';
import { CairnProvider, useCairn } from './context/CairnContext';
import { exportGuide, getHealth } from './utils/api';
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
  // Restore the trail position from sessionStorage so a refresh resumes where
  // the user left off (and clears when the tab closes). Landing/connect are not
  // resumable — those are entry screens, not progress.
  const [screen, setScreen] = useState<Screen>(() => {
    try {
      const saved = sessionStorage.getItem('cairn-screen') as Screen | null;
      if (saved && saved !== 'landing' && saved !== 'connect') return saved;
    } catch {
      /* storage unavailable — fall through */
    }
    return 'landing';
  });
  const [explored, setExplored] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('cairn-explored') === 'true';
    } catch {
      return false;
    }
  });
  // Screens the user has navigated past — rendered "done" (green ✓) in the trail.
  const [visited, setVisited] = useState<Set<Screen>>(() => {
    try {
      const saved = sessionStorage.getItem('cairn-visited');
      if (saved) return new Set(JSON.parse(saved) as Screen[]);
    } catch {
      /* storage unavailable / bad JSON — start empty */
    }
    return new Set();
  });
  // While true, we've restored a post-connect screen but haven't yet confirmed
  // the backend session is still alive — show a brief splash instead of mounting
  // a view that would fire (and fail) data fetches against a dead session.
  const [booting, setBooting] = useState<boolean>(() => screen !== 'landing' && screen !== 'connect');
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

  // Persist trail progress to sessionStorage on every change.
  useEffect(() => {
    try { sessionStorage.setItem('cairn-screen', screen); } catch { /* ignore */ }
  }, [screen]);
  useEffect(() => {
    try { sessionStorage.setItem('cairn-explored', explored ? 'true' : 'false'); } catch { /* ignore */ }
  }, [explored]);
  useEffect(() => {
    try { sessionStorage.setItem('cairn-visited', JSON.stringify([...visited])); } catch { /* ignore */ }
  }, [visited]);

  // Drop the restored session and return to Connect. Used when the backend has
  // no live session for the restored screen (it restarted, or this is a fresh
  // server) — the persisted progress is meaningless without it.
  function resetToConnect() {
    try { sessionStorage.clear(); } catch { /* ignore */ }
    cairn.resetSession();
    setExplored(false);
    setVisited(new Set());
    setScreen('connect');
  }

  // On a refresh that restored a post-connect screen, confirm the backend
  // session is alive before showing it. If it's gone, fall back to Connect; the
  // views themselves re-fetch their data (guide/findings/kit) once we proceed.
  useEffect(() => {
    if (!booting) return;
    let cancelled = false;
    getHealth()
      .then((h) => {
        if (cancelled) return;
        if (!h.connected) { resetToConnect(); return; }
        // Trust the server's view of whether exploration finished.
        if (h.has_explored) setExplored(true);
      })
      .catch(() => { if (!cancelled) resetToConnect(); })
      .finally(() => { if (!cancelled) setBooting(false); });
    return () => { cancelled = true; };
    // Runs once on mount; resetToConnect/setters are stable enough for this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function go(k: Screen) {
    if (k === 'connect') return;
    if (!explored && k !== 'explore') return;
    // Mark the screen we're leaving as visited before moving on.
    setVisited((prev) => new Set([...prev, screen]));
    setScreen(k);
  }

  const onConnect = () => {
    // Fresh session — drop any data left over from a previous connect/refresh.
    cairn.resetSession();
    setVisited((prev) => new Set([...prev, 'connect']));
    setScreen('explore');
  };
  const onExploreComplete = () => {
    setExplored(true);
    setVisited((prev) => new Set([...prev, 'explore']));
    setScreen('guide');
  };

  function status(k: Screen): StopStatus {
    if (k === screen) return 'active';
    if (k === 'connect') return 'done'; // always past it once the shell shows
    if (k === 'explore') return explored ? 'done' : 'locked';
    if (!explored) return 'locked';
    if (visited.has(k)) return 'done';
    return 'ready';
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

  // Validating a restored session — show a brief splash rather than flashing a
  // view (and firing failing fetches) before we know the session is alive.
  if (booting) {
    return (
      <div
        className="center"
        style={{ height: '100vh', flexDirection: 'column', gap: 14, background: 'var(--ink-0)', color: 'var(--text-3)' }}
      >
        <Wordmark size={20} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>restoring your session…</span>
      </div>
    );
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
