// Shared visual primitives for the cairn UI — icons, SPL code block, badges,
// node chips, dependency chains, and the theme toggle. Ported from the design
// system; pure presentation, no data fetching.
import { useState, type CSSProperties, type ReactNode } from 'react';
import CairnMark from './CairnMark';

// ---------------- icons (minimal stroke) ----------------
interface IconProps {
  size?: number;
  fill?: boolean;
  sw?: number;
  style?: CSSProperties;
  children?: ReactNode;
  d?: string;
}

function Icon({ d, size = 16, fill, sw = 1.6, style, children }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {children || (d ? <path d={d} /> : null)}
    </svg>
  );
}

type IconCmp = (p: IconProps) => ReactNode;

export const Icons: Record<string, IconCmp> = {
  copy: (p) => (
    <Icon {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </Icon>
  ),
  check: (p) => <Icon {...p} d="M5 12.5l4.5 4.5L19 7" />,
  arrowR: (p) => <Icon {...p} d="M5 12h14M13 6l6 6-6 6" />,
  chevR: (p) => <Icon {...p} d="M9 6l6 6-6 6" />,
  download: (p) => (
    <Icon {...p}>
      <path d="M12 4v11M7 11l5 5 5-5" />
      <path d="M5 20h14" />
    </Icon>
  ),
  lock: (p) => (
    <Icon {...p}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Icon>
  ),
  search: (p) => (
    <Icon {...p}>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-3.5-3.5" />
    </Icon>
  ),
  send: (p) => <Icon {...p} d="M5 12l14-7-5 16-3.5-6.5L5 12z" />,
  spark: (p) => (
    <Icon
      {...p}
      d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"
    />
  ),
  alert: (p) => (
    <Icon {...p}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 4l-7 12a2 2 0 0 0 1.7 3h14a2 2 0 0 0 1.7-3l-7-12a2 2 0 0 0-3.4 0z" />
    </Icon>
  ),
  index: (p) => (
    <Icon {...p}>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.6 3.1 3 7 3s7-1.4 7-3V6" />
      <path d="M5 12c0 1.6 3.1 3 7 3s7-1.4 7-3" />
    </Icon>
  ),
  macro: (p) => <Icon {...p} d="M8 6l-4 6 4 6M16 6l4 6-4 6" />,
  lookup: (p) => (
    <Icon {...p}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 10h16M10 5v14" />
    </Icon>
  ),
  graph: (p) => (
    <Icon {...p}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <circle cx="9" cy="18" r="2.5" />
      <path d="M8 7.3l8 1M8.5 16l-1-6M16 11l-6 5.5" />
    </Icon>
  ),
  doc: (p) => (
    <Icon {...p}>
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5M9 13h7M9 17h5" />
    </Icon>
  ),
  flag: (p) => <Icon {...p} d="M6 21V4h10l-1.5 4L16 12H6" />,
  kit: (p) => (
    <Icon {...p}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18" />
    </Icon>
  ),
  chat: (p) => <Icon {...p} d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4V6a1 1 0 0 1 1-1z" />,
  plug: (p) => (
    <Icon {...p}>
      <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8zM12 16v5" />
    </Icon>
  ),
  shield: (p) => <Icon {...p} d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />,
  dot: (p) => (
    <Icon {...p} fill>
      <circle cx="12" cy="12" r="4" />
    </Icon>
  ),
  pin: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="10" r="3" />
      <path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z" />
    </Icon>
  ),
  refresh: (p) => (
    <Icon {...p}>
      <path d="M20 11a8 8 0 1 0-1 5" />
      <path d="M20 5v6h-6" />
    </Icon>
  ),
  sun: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
    </Icon>
  ),
  moon: (p) => <Icon {...p} d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
};

// Graph node "type" -> icon. Splunk's saved searches arrive as `saved_search`;
// the design layout calls that layer `search`, so we accept both.
export const typeIcon: Record<string, IconCmp> = {
  alert: Icons.alert,
  search: Icons.search,
  saved_search: Icons.search,
  macro: Icons.macro,
  lookup: Icons.lookup,
  index: Icons.index,
};

// ---------------- Wordmark ----------------
export function Wordmark({ size = 19 }: { size?: number }) {
  return (
    <div className="row gap-2" style={{ alignItems: 'center' }}>
      <CairnMark size={size + 8} tone="var(--ember)" />
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontWeight: 600,
          fontSize: size,
          letterSpacing: '-0.02em',
          color: 'var(--text)',
        }}
      >
        cairn<span style={{ color: 'var(--ember)' }}>.</span>
      </span>
    </div>
  );
}

// ---------------- SPL syntax highlight ----------------
const SPL_CMDS = [
  'stats', 'timechart', 'tstats', 'where', 'lookup', 'sort', 'head', 'top', 'rest',
  'table', 'eval', 'search', 'rename', 'fields', 'dedup', 'by', 'count', 'sum', 'avg',
  'max', 'min', 'p95', 'span', 'limit', 'as', 'output', 'inputlookup', 'outputlookup',
];

export function highlightSpl(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  const re =
    /(`[^`]+`)|("[^"]*")|(\b\d+(?:\.\d+)?\b)|(\|)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_"`|]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[1]) out.push(<span key={i++} className="tok-kw">{m[1]}</span>);
    else if (m[2]) out.push(<span key={i++} className="tok-str">{m[2]}</span>);
    else if (m[3]) out.push(<span key={i++} className="tok-num">{m[3]}</span>);
    else if (m[4]) out.push(<span key={i++} className="tok-cmd" style={{ fontWeight: 600 }}>{m[4]}</span>);
    else if (m[5]) {
      const w = m[5];
      if (SPL_CMDS.includes(w.toLowerCase())) out.push(<span key={i++} className="tok-cmd">{w}</span>);
      else out.push(<span key={i++}>{w}</span>);
    } else out.push(<span key={i++}>{m[0]}</span>);
  }
  return out;
}

// ---------------- CodeBlock with copy ----------------
interface CodeBlockProps {
  code: string;
  scroll?: boolean;
  pad?: string;
  inlineCopy?: boolean;
}

export function CodeBlock({ code, scroll = true, pad = '14px 16px', inlineCopy = true }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const doCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(code);
    } catch {
      /* clipboard blocked — fail quietly */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="code" style={{ padding: pad, overflowX: scroll ? 'auto' : 'visible' }}>
      {inlineCopy && (
        <button
          onClick={doCopy}
          title="Copy"
          style={{
            position: 'absolute', top: 8, right: 8, zIndex: 2, display: 'flex',
            alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 11,
            color: copied ? 'var(--good)' : 'var(--text-3)', background: 'var(--surface-2)',
            border: '1px solid var(--line-2)', borderRadius: 6, padding: '4px 8px',
            cursor: 'pointer', transition: 'color .15s',
          }}
        >
          {copied ? <Icons.check size={12} /> : <Icons.copy size={12} />}
          {copied ? 'copied' : 'copy'}
        </button>
      )}
      <pre
        style={{
          margin: 0, fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.7,
          whiteSpace: 'pre', color: 'var(--code-text)',
        }}
      >
        {code.split('\n').map((ln, idx) => (
          <div key={idx}>
            {highlightSpl(ln)}
            {ln === '' ? '​' : ''}
          </div>
        ))}
      </pre>
    </div>
  );
}

// ---------------- Severity badge ----------------
interface SevSpec {
  c: string;
  bg: string;
  label: string;
}
export const SEV: Record<string, SevSpec> = {
  high: { c: 'var(--sev-high)', bg: 'var(--sev-high-bg)', label: 'high' },
  critical: { c: 'var(--sev-high)', bg: 'var(--sev-high-bg)', label: 'critical' },
  medium: { c: 'var(--sev-med)', bg: 'var(--sev-med-bg)', label: 'medium' },
  warning: { c: 'var(--sev-med)', bg: 'var(--sev-med-bg)', label: 'warning' },
  low: { c: 'var(--sev-low)', bg: 'var(--sev-low-bg)', label: 'low' },
  info: { c: 'var(--sev-low)', bg: 'var(--sev-low-bg)', label: 'info' },
};

export function SeverityBadge({ level, children, big }: { level: string; children?: ReactNode; big?: boolean }) {
  const s = SEV[level] || SEV.low;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)',
        fontSize: big ? 12 : 11, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: s.c, background: s.bg, border: `1px solid ${s.c}33`,
        padding: big ? '5px 11px' : '3px 8px', borderRadius: 999, fontWeight: 500,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: s.c }} />
      {children || s.label}
    </span>
  );
}

// ---------------- Node chip (graph node types) ----------------
export const NODE_TONE: Record<string, string> = {
  alert: 'var(--n-alert)',
  search: 'var(--n-search)',
  saved_search: 'var(--n-search)',
  macro: 'var(--n-macro)',
  lookup: 'var(--n-lookup)',
  index: 'var(--n-index)',
  dashboard: 'var(--n-dash)',
};

export function NodeChip({ type, label, sub }: { type: string; label: string; sub?: string }) {
  const Tip = typeIcon[type] || Icons.dot;
  const tone = NODE_TONE[type] || 'var(--text-2)';
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--mono)',
        fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--line-2)',
        borderRadius: 7, padding: '4px 9px', color: 'var(--text)',
      }}
    >
      <Tip size={13} style={{ color: tone, flexShrink: 0 }} />
      <span style={{ color: 'var(--text)' }}>{label}</span>
      {sub && <span style={{ color: 'var(--text-3)' }}>{sub}</span>}
    </span>
  );
}

// ---------------- Dependency chain renderer ----------------
export interface ChainLink {
  type: string;
  id: string;
}
export function Chain({ chain }: { chain: ChainLink[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, rowGap: 10 }}>
      {chain.map((c, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <NodeChip type={c.type} label={c.id} />
          {i < chain.length - 1 && <Icons.arrowR size={14} style={{ color: 'var(--text-4)' }} />}
        </span>
      ))}
    </div>
  );
}

// ---------------- Eyebrow ----------------
export function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="eyebrow" style={style}>
      {children}
    </div>
  );
}

// ---------------- read-only trust badge ----------------
export function ReadOnlyBadge() {
  return (
    <span
      className="pill"
      style={{
        color: 'var(--good)', borderColor: 'rgba(127,169,140,0.3)',
        background: 'rgba(127,169,140,0.08)',
      }}
    >
      <Icons.shield size={12} /> read-only · nothing mutated
    </span>
  );
}

// ---------------- theme toggle ----------------
export function ThemeToggle({
  theme,
  onToggle,
  floating,
}: {
  theme: string;
  onToggle: () => void;
  floating?: boolean;
}) {
  const light = theme === 'light';
  return (
    <button
      onClick={onToggle}
      title={light ? 'Switch to dark' : 'Switch to light'}
      className="row"
      style={{
        gap: 7, cursor: 'pointer', padding: '7px 11px', borderRadius: 999,
        border: '1px solid var(--line-2)',
        background: floating ? 'var(--surface-glass)' : 'transparent',
        color: 'var(--text-2)', backdropFilter: floating ? 'blur(8px)' : 'none',
        position: floating ? 'fixed' : 'static',
        top: floating ? 18 : 'auto', right: floating ? 18 : 'auto', zIndex: 50,
      }}
    >
      {light ? <Icons.moon size={15} /> : <Icons.sun size={15} />}
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.04em' }}>
        {light ? 'dark' : 'light'}
      </span>
    </button>
  );
}
