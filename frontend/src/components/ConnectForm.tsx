import { useState } from 'react';
import { connect } from '../utils/api';
import CairnMark from './CairnMark';

const STORAGE_KEY = 'cairn_splunk_url';
const DEFAULT_URL = 'https://localhost:8089/services/mcp';

interface Props {
  onConnected: () => void;
}

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

export default function ConnectForm({ onConnected }: Props) {
  const [splunkUrl, setSplunkUrl] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_URL
  );
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<TestStatus>('idle');
  const [version, setVersion] = useState<string | undefined>();

  // "Connect" implicitly tests the MCP connection first: validate, then hold on
  // a brief verified-success state before handing off to the explore screen.
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setStatus('testing');
    try {
      localStorage.setItem(STORAGE_KEY, splunkUrl);
      const { version: detected } = await connect(splunkUrl, token);
      setVersion(detected);
      setStatus('success');
      // The pause is intentional — it lets the user register that the
      // connection was actually verified before the screen changes.
      setTimeout(onConnected, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  return (
    <>
      <div className="connect-logo">
        <CairnMark stacked={0} size={64} />
        <div className="brand">
          <span className="brand-text">cairn</span>
          <span className="brand-dot">.</span>
        </div>
      </div>
      <p className="connect-tagline">
        Point it at a Splunk instance. It maps the place and writes the guide.
      </p>

      <div className="connect-container">
      <form className="connect-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label className="form-label" htmlFor="splunk-url">Splunk MCP URL</label>
          <input
            id="splunk-url"
            className="form-input"
            type="text"
            value={splunkUrl}
            onChange={e => setSplunkUrl(e.target.value)}
            placeholder={DEFAULT_URL}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="auth-token">Auth Token</label>
          <input
            id="auth-token"
            className="form-input"
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Splunk authentication token"
            autoComplete="current-password"
          />
        </div>

        {status === 'success' ? (
          <div className="connect-status connect-status-success">
            <span className="connect-status-dot" />
            {version ? `Connected to Splunk ${version}` : 'Connected'}
          </div>
        ) : (
          <button
            className="btn btn-primary btn-full"
            type="submit"
            disabled={status === 'testing' || !splunkUrl || !token}
          >
            {status === 'testing' ? <span className="spinner" /> : null}
            {status === 'testing' ? 'Connecting…' : 'Connect'}
          </button>
        )}

        {status === 'error' && error && (
          <div className="connect-status connect-status-error">
            {error} — double-check the MCP URL and that your auth token is valid.
          </div>
        )}
      </form>
      </div>
    </>
  );
}
