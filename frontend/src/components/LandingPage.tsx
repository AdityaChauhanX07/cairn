import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import CairnMark from './CairnMark';
import { Icons } from './Primitives';

// three.js is heavy (~210 kB gzip), so the WebGL constellation is split into its
// own chunk and lazy-loaded. The gradient + hero text paint immediately; the 3D
// layer streams in behind them and is scoped to the hero only.
const Constellation = lazy(() => import('./Constellation'));

interface Props {
  onEnter: () => void;
}

const MODES: { tag: string; title: string; body: string; viz: ReactNode }[] = [
  {
    tag: 'Mode A · Explain',
    title: 'The guide',
    body:
      'A six-section onboarding document. Every alert in plain English, every SPL query explained, every dependency chain drawn — organised by the workflows your team actually runs.',
    viz: (
      <>
        <Chip tone="var(--n-alert)">alert</Chip>
        <Arrow />
        <Chip tone="var(--n-macro)">macro</Chip>
        <Arrow />
        <Chip tone="var(--n-lookup)">lookup</Chip>
        <Arrow />
        <Chip tone="var(--n-index)">index</Chip>
      </>
    ),
  },
  {
    tag: 'Mode B · Flag',
    title: 'The findings',
    body:
      'The same relationship graph reveals hygiene issues for free — orphaned macros, alerts on empty indexes, alerts that fire into the void. Each one ships with a ready-to-apply fix.',
    viz: (
      <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
        <Chip tone="var(--sev-high)">● high · empty index</Chip>
        <Chip tone="var(--sev-med)">● med · orphaned</Chip>
      </div>
    ),
  },
  {
    tag: 'Mode C · Build',
    title: 'The starter kit',
    body:
      'Tailored SPL for common tasks, a runbook for every alert with first-check steps, and an importable dashboard skeleton — all generated from what cairn actually found.',
    viz: (
      <span style={{ color: 'var(--code-text)' }}>
        <span style={{ color: 'var(--ember-text)' }}>index</span>=auth_events&nbsp;
        <span style={{ color: 'var(--ember)' }}>|</span>&nbsp;
        <span style={{ color: 'var(--ember-text)' }}>stats</span>&nbsp;count
      </span>
    ),
  },
];

const LOOP = [
  { n: '01', name: 'Orient', q: 'What indexes, apps and users exist?' },
  { n: '02', name: 'Reason', q: 'What stands out and why?' },
  { n: '03', name: 'Investigate', q: 'Follow every dependency chain.' },
  { n: '04', name: 'Decide', q: 'Loose ends? Loop back.' },
  { n: '05', name: 'Synthesize', q: 'Guide, findings, starter kit.' },
];

const STATS: { n: ReactNode; l: string }[] = [
  { n: '13', l: 'MCP tools wired' },
  { n: '3', l: 'modes, one pass' },
  { n: <>~10<span style={{ fontSize: '0.5em' }}>min</span></>, l: 'to full clarity' },
  { n: '0', l: 'writes to splunk' },
];

// Full landing experience — a dramatic hero over a fixed-position constellation,
// with the pitch sections scrolling naturally over it. The background layers
// (constellation, vignette, grain) are position:fixed and sit behind .landing-
// content (z-index:2); below-fold sections wrap in .landing-solid so the text
// reads cleanly over the canvas.
export default function LandingPage({ onEnter }: Props) {
  const [scrolled, setScrolled] = useState(false);

  // The app body is normally overflow:hidden (each screen manages its own scroll
  // region). The landing is the exception — it scrolls the page naturally so the
  // fixed background can parallax. Relax the lock while it's mounted, restore on
  // unmount.
  useEffect(() => {
    document.documentElement.classList.add('landing-scroll');
    window.scrollTo(0, 0);
    return () => document.documentElement.classList.remove('landing-scroll');
  }, []);

  // Nav gains a frosted background once the hero starts scrolling away.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Reveal-on-scroll for the below-fold sections (default viewport root).
  useEffect(() => {
    const els = Array.from(document.querySelectorAll('.reveal:not(.in)')) as HTMLElement[];
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.15 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const scrollToId = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="landing-wrap">
      {/* ── FIXED BACKGROUND LAYERS (z:0 / z:1) ── */}
      <div className="landing-bg-fixed">
        <Suspense fallback={null}>
          <Constellation />
        </Suspense>
      </div>
      <div className="landing-vignette" />
      <div className="landing-grain" />

      {/* ── SCROLLING CONTENT OVER THE FIXED BG (z:2) ── */}
      <div className="landing-content">
        {/* FIXED NAV */}
        <nav className={`landing-nav${scrolled ? ' scrolled' : ''}`}>
          <div className="row gap-2" style={{ alignItems: 'center' }}>
            <CairnMark size={26} tone="var(--ember)" />
            <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 19, letterSpacing: '-0.02em', color: 'var(--text)' }}>
              cairn<span style={{ color: 'var(--ember)' }}>.</span>
            </span>
          </div>
          <div className="landing-nav-links">
            <button className="landing-nav-link" onClick={() => scrollToId('landing-how')}>How it works</button>
            <button className="landing-nav-link" onClick={() => scrollToId('landing-modes')}>The three modes</button>
            <button className="landing-nav-link" onClick={() => scrollToId('landing-loop')}>The loop</button>
            <button className="btn btn-primary" onClick={onEnter}>
              Launch app
            </button>
          </div>
        </nav>

        {/* HERO */}
        <header className="landing-hero">
          <div className="landing-hero-content">
            <div className="eyebrow" style={{ marginBottom: 26, letterSpacing: '0.22em' }}>
              Splunk Agentic Ops Hackathon · Platform &amp; Developer Experience
            </div>
            <h1 className="landing-h1">
              You inherited
              <br />
              the environment.
              <br />
              <span style={{ color: 'var(--ember)' }}>Now understand it.</span>
            </h1>
            <p className="landing-lead">
              cairn is an AI agent that walks into any Splunk deployment, traces every dependency, documents what
              everything does, flags what's broken, and hands you a starter kit. A week of tribal knowledge transfer in
              ten minutes.
            </p>
            <div className="landing-cta">
              <button className="btn btn-primary btn-lg" onClick={onEnter}>
                Connect &amp; explore <Icons.arrowR size={17} />
              </button>
              <button className="btn btn-lg" onClick={() => scrollToId('landing-how')}>
                See how it works
              </button>
            </div>
            <div className="landing-trust">
              <span className="landing-trust-dot" /> read-only · it advises, you apply · nothing is ever mutated
            </div>
          </div>

          <button className="landing-scrollcue" onClick={() => scrollToId('landing-how')} aria-label="Scroll down">
            <span className="landing-mouse" />
            scroll
          </button>
        </header>

        {/* ── BELOW THE FOLD — .landing-solid gives a gradient backdrop so text
            reads over the constellation ── */}
        <div className="landing-solid">
          {/* THE PROBLEM + THE THREE MODES */}
          <section className="landing-band" id="landing-how">
          <div className="landing-sec-head">
            <div className="eyebrow reveal">The problem</div>
            <h2 className="landing-h2 reveal d1">
              Someone else built this Splunk instance.
              <br />
              They're gone. The pager isn't.
            </h2>
            <p className="landing-sec-p reveal d2">
              Hundreds of saved searches, alerts that fire at 3am, macros nobody remembers writing, lookups pointing at
              lookups. cairn connects through the official MCP Server and explores it the way a senior engineer would —
              one agentic pass, visible reasoning, three outputs.
            </p>
          </div>

          <div className="landing-modes" id="landing-modes">
            {MODES.map((m, i) => (
              <div key={m.tag} className={`landing-mode-card reveal d${i}`}>
                <div className="landing-mode-tag">{m.tag}</div>
                <h3 className="landing-mode-title">{m.title}</h3>
                <p className="landing-mode-body">{m.body}</p>
                <div className="landing-mode-viz">{m.viz}</div>
              </div>
            ))}
          </div>
        </section>

        {/* THE LOOP */}
        <section className="landing-band" id="landing-loop">
          <div className="landing-sec-head" style={{ marginBottom: 40 }}>
            <div className="eyebrow reveal">The signature moment</div>
            <h2 className="landing-h2 reveal d1">Watch it think.</h2>
            <p className="landing-sec-p reveal d2">
              cairn isn't a pipeline — it's an agent. It streams its reasoning live and decides what to investigate based
              on what it finds. Every output is downstream of one loop.
            </p>
          </div>
          <div className="landing-loop reveal d2">
            {LOOP.map((p, i) => (
              <div key={p.n} className="landing-loop-step">
                <div className="landing-loop-node">
                  <div className="landing-loop-dot">{p.n}</div>
                  <b>{p.name}</b>
                  <span>{p.q}</span>
                </div>
                {i < LOOP.length - 1 && <span className="landing-loop-link" />}
              </div>
            ))}
          </div>
        </section>

          {/* STATS */}
          <div className="landing-stats">
            {STATS.map((s, i) => (
              <div key={s.l} className={`landing-stat reveal d${i}`}>
                <div className="landing-stat-n">{s.n}</div>
                <div className="landing-stat-l">{s.l}</div>
              </div>
            ))}
          </div>
        </div>
        {/* /.landing-solid */}

        {/* FINAL CTA — no solid backdrop, the constellation shows through */}
        <section className="landing-final">
          <div className="landing-final-glow" />
          <div className="eyebrow reveal" style={{ marginBottom: 24 }}>Built for the trail ahead</div>
          <h2 className="landing-h2 reveal d1" style={{ margin: '0 auto' }}>
            Point it at a Splunk instance.
            <br />
            Get the map.
          </h2>
          <div className="landing-cta reveal d2" style={{ justifyContent: 'center', marginTop: 40 }}>
            <button className="btn btn-primary btn-lg" onClick={onEnter}>
              Connect &amp; explore <Icons.arrowR size={17} />
            </button>
          </div>
        </section>

        <footer className="landing-footer">
          <div className="row gap-2" style={{ fontFamily: 'var(--mono)' }}>
            <CairnMark size={18} tone="var(--ember)" />
            cairn — a stack of stones marking the trail.
          </div>
          <div>Splunk Agentic Ops Hackathon 2026 · read-only by design</div>
        </footer>
      </div>
    </div>
  );
}

function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="landing-chip" style={{ color: tone, borderColor: `${tone}55` }}>
      {children}
    </span>
  );
}

function Arrow() {
  return <span className="landing-arrow">→</span>;
}
