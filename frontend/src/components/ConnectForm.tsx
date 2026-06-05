import { useState } from 'react';
import { connect } from '../utils/api';
import CairnMark from './CairnMark';

const STORAGE_KEY = 'cairn_splunk_url';
const DEFAULT_URL = 'https://localhost:8089/services/mcp';

interface Props {
  onConnected: () => void;
}

export default function ConnectForm({ onConnected }: Props) {
  const [splunkUrl, setSplunkUrl] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_URL
  );
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      localStorage.setItem(STORAGE_KEY, splunkUrl);
      await connect(splunkUrl, token);
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
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

        {error && (
          <div className="error-banner">
            <span className="error-icon">⚠</span>
            <span>
              <span className="error-title">Couldn't connect</span>
              <span className="error-hint">
                {error} — double-check the MCP URL and that your auth token is valid.
              </span>
            </span>
          </div>
        )}

        <button
          className="btn btn-primary btn-full"
          type="submit"
          disabled={loading || !splunkUrl || !token}
        >
          {loading ? <span className="spinner" /> : null}
          {loading ? 'Connecting…' : 'Connect'}
        </button>
      </form>
      </div>
    </>
  );
}
