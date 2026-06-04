// Cross-screen Splunk environment identity, captured during exploration and
// reused on the guide screen (top bar + title block). Persisted to
// localStorage so it survives the explore → guide transition without prop
// drilling through App.

export interface CairnEnv {
  version?: string;
  os?: string;
  product?: string;
  server?: string;
  host?: string;
  /** node_type -> count, from the explore "done" summary */
  counts?: Record<string, number>;
  total?: number;
}

const ENV_KEY = 'cairn_env';
const URL_KEY = 'cairn_splunk_url';

export function saveEnv(env: CairnEnv): void {
  try {
    localStorage.setItem(ENV_KEY, JSON.stringify(env));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function loadEnv(): CairnEnv | null {
  try {
    const raw = localStorage.getItem(ENV_KEY);
    return raw ? (JSON.parse(raw) as CairnEnv) : null;
  } catch {
    return null;
  }
}

/** Hostname of the connected Splunk URL (best-effort). */
export function connectedHost(): string | undefined {
  const url = (() => {
    try {
      return localStorage.getItem(URL_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  })();
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Parse the flat splunk_get_info dict into the fields we display. */
export function parseDeploymentInfo(info: Record<string, unknown>): CairnEnv {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = info[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
    return undefined;
  };
  const generator = info.generator as Record<string, unknown> | undefined;
  return {
    version:
      pick('version') ??
      (generator && typeof generator.version === 'string' ? generator.version : undefined),
    os: pick('os_name', 'osName', 'os'),
    product: pick('product_type', 'instance_type', 'instanceType'),
    server: pick('server_name', 'serverName', 'host'),
  };
}

/** Build a "Splunk 10.4.0 · MSI · Windows" style identity string. */
export function envSummaryLine(env: CairnEnv | null): string {
  if (!env) return '';
  const parts = [
    env.version ? `Splunk ${env.version}` : undefined,
    env.product,
    env.os,
    env.server,
  ].filter(Boolean);
  return parts.join(' · ');
}
