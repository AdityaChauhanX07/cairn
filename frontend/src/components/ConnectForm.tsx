import { useState, type CSSProperties, type ReactNode } from 'react';
import { connect } from '../utils/api';
import CairnMark from './CairnMark';
import { Icons, ReadOnlyBadge } from './Primitives';

const STORAGE_KEY = 'cairn_splunk_url';
const DEFAULT_URL = 'https://localhost:8089/services/mcp';

interface Props {
  onConnected: () => void;
}

type Phase = 'idle' | 'connecting' | 'ready' | 'error';

export default function ConnectForm({ onConnected }: Props) {
  const [url, setUrl] = useState(() => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_URL);
  const [token, setToken] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [version, setVersion] = useState<string | undefined>();
  const [error, setError] = useState('');

  const busy = phase === 'connecting';

  async function handleConnect() {
    if (phase === 'connecting' || phase === 'ready') return;
    setError('');
    setPhase('connecting');
    try {
      localStorage.setItem(STORAGE_KEY, url);
      const { version: detected } = await connect(url, token);
      setVersion(detected);
      setPhase('ready');
      // Brief verified-success beat so the user registers the real connection
      // before the trail opens.
      setTimeout(onConnected, 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        background:
          'radial-gradient(1100px 620px at 50% -8%, rgba(205,122,76,0.10), transparent 60%), var(--ink-0)',
      }}
    >
      <div
        style={{
          minHeight: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', padding: '60px 24px',
        }}
      >
        {/* hero */}
        <div className="center" style={{ flexDirection: 'column', marginBottom: 30 }}>
          <div style={{ position: 'relative' }}>
            <div
              style={{
                position: 'absolute', inset: -40,
                background: 'radial-gradient(circle, rgba(205,122,76,0.18), transparent 70%)',
                filter: 'blur(6px)',
              }}
            />
            <CairnMark size={76} animate tone="var(--ember)" />
          </div>
          <h1 className="display" style={{ fontFamily: 'var(--mono)', fontSize: 46, marginTop: 26, letterSpacing: '-0.03em' }}>
            cairn<span style={{ color: 'var(--ember)' }}>.</span>
          </h1>
          <p style={{ color: 'var(--text-2)', fontSize: 17, maxWidth: 440, textAlign: 'center', marginTop: 14, lineHeight: 1.5 }}>
            Point it at a Splunk instance. It maps the place, traces every dependency, and
            writes the guide you wish the last on-call had left you.
          </p>
          <div style={{ marginTop: 18 }}>
            <ReadOnlyBadge />
          </div>
        </div>

        {/* form */}
        <div className="card" style={{ width: '100%', maxWidth: 460, padding: 26, boxShadow: 'var(--sh-3)' }}>
          {phase === 'ready' ? (
            <div className="center" style={{ flexDirection: 'column', padding: '20px 0' }}>
              <Icons.check size={30} style={{ color: 'var(--good)' }} />
              <div style={{ marginTop: 12, fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                {version ? `connected to Splunk ${version} — opening the trail` : 'connected — opening the trail'}
              </div>
            </div>
          ) : (
            <>
              <Field label="Splunk MCP URL">
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                  style={inputStyle}
                />
              </Field>
              <Field label="Auth token" hint="needs mcp_tool_execute">
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={busy}
                  type="password"
                  placeholder="paste a read-scoped token"
                  autoComplete="current-password"
                  style={inputStyle}
                />
              </Field>

              <button
                className="btn btn-primary"
                style={{ width: '100%', marginTop: 8, padding: '13px' }}
                onClick={handleConnect}
                disabled={busy || !url || !token}
              >
                {busy ? (
                  <span style={{ fontFamily: 'var(--mono)' }}>connecting…</span>
                ) : (
                  <>
                    <Icons.plug size={16} /> Connect &amp; explore
                  </>
                )}
              </button>

              {phase === 'error' && error && (
                <div
                  style={{
                    marginTop: 14, fontSize: 12.5, color: 'var(--sev-high)',
                    fontFamily: 'var(--mono)', lineHeight: 1.5, textAlign: 'center',
                  }}
                >
                  {error} — double-check the MCP URL and that your auth token is valid.
                </div>
              )}
            </>
          )}
        </div>

        {/* capability strip */}
        <div className="row" style={{ gap: 26, marginTop: 28, flexWrap: 'wrap', justifyContent: 'center' }}>
          {([
            ['13 MCP tools', 'across splunk_ & saia_'],
            ['3 modes', 'explain · flag · build'],
            ['one pass', 'agentic exploration'],
          ] as const).map(([a, b]) => (
            <div key={a} className="center" style={{ flexDirection: 'column', gap: 2 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text-2)' }}>{a}</span>
              <span className="eyebrow" style={{ fontSize: 10 }}>{b}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: '100%', background: 'var(--ink-0)', border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-sm)', padding: '12px 14px', color: 'var(--text)',
  fontFamily: 'var(--mono)', fontSize: 13.5, outline: 'none',
};

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="eyebrow">{label}</span>
        {hint && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}
