import type { AgentEvent, Guide, GraphData, AskResponse, StarterKit, FindingsReport } from '../types';
import { parseDeploymentInfo } from './env';

const BASE = (import.meta.env.VITE_API_BASE as string) || 'http://localhost:8000/api';

// Resolves with the detected Splunk version (when the deployment reports one)
// so the connect form can confirm exactly what it validated against.
export async function connect(splunkUrl: string, token: string): Promise<{ version?: string }> {
  const res = await fetch(`${BASE}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ splunk_url: splunkUrl, token }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((err as { detail?: string }).detail ?? res.statusText);
  }
  const data = (await res.json().catch(() => ({}))) as {
    deployment?: Record<string, unknown> | null;
  };
  const env = data.deployment ? parseDeploymentInfo(data.deployment) : {};
  return { version: env.version };
}

// Shared SSE streaming — used by both explore and generate.
function streamSSE(
  url: string,
  onEvent: (event: AgentEvent) => void,
  onDone: () => void,
  onError: (err: string) => void
): () => void {
  let cancelled = false;
  let doneCalled = false;

  function callDone() {
    if (!doneCalled) {
      doneCalled = true;
      onDone();
    }
  }

  (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        onError(`SSE request failed (${res.status}): ${res.statusText}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!cancelled) {
        const { done, value } = await reader.read();

        // Decode chunk. When done=true, value may still carry the final bytes.
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
        }

        // Split on SSE event boundaries: handles \n\n and \r\n\r\n
        const parts = buffer.split(/\r\n\r\n|\n\n/);
        // Last element is an incomplete block — keep it in the buffer
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (!part.trim()) continue;
          const parsed = parseSseBlock(part);
          if (!parsed) {
            console.debug('[SSE] skipping unparsed block:', JSON.stringify(part));
            continue;
          }
          console.log('[SSE] event:', parsed.phase, parsed.message);
          onEvent(parsed);
          if (parsed.phase === 'done') {
            callDone();
            reader.cancel();
            return;
          }
        }

        // Stream is finished — flush whatever is still in the buffer
        if (done) {
          if (buffer.trim()) {
            const parsed = parseSseBlock(buffer);
            if (parsed) {
              console.log('[SSE] final buffered event:', parsed.phase, parsed.message);
              onEvent(parsed);
              if (parsed.phase === 'done') {
                callDone();
                return;
              }
            }
          }
          // Stream closed cleanly — signal done even without explicit done event
          callDone();
          break;
        }
      }
    } catch (e) {
      if (!cancelled) onError(String(e));
    }
  })();

  return () => { cancelled = true; };
}

export function exploreSSE(
  onEvent: (event: AgentEvent) => void,
  onDone: () => void,
  onError: (err: string) => void
): () => void {
  return streamSSE(`${BASE}/explore`, onEvent, onDone, onError);
}

export function generateSSE(
  onEvent: (event: AgentEvent) => void,
  onDone: () => void,
  onError: (err: string) => void
): () => void {
  return streamSSE(`${BASE}/generate`, onEvent, onDone, onError);
}

// Stream Mode C starter-kit generation. ``onError`` is optional so callers that
// only care about progress + completion can omit it.
export function generateStarterKitSSE(
  onEvent: (event: AgentEvent) => void,
  onDone: () => void,
  onError?: (err: string) => void
): () => void {
  return streamSSE(`${BASE}/starter-kit`, onEvent, onDone, onError ?? (() => {}));
}

export async function getStarterKit(): Promise<StarterKit> {
  const res = await fetch(`${BASE}/starter-kit/data`);
  if (!res.ok) throw new Error(`Failed to load starter kit: ${res.statusText}`);
  return res.json() as Promise<StarterKit>;
}

// Stream Mode B findings generation. ``onError`` is optional so callers that
// only care about progress + completion can omit it.
export function generateFindingsSSE(
  onEvent: (event: AgentEvent) => void,
  onDone: () => void,
  onError?: (err: string) => void
): () => void {
  return streamSSE(`${BASE}/findings`, onEvent, onDone, onError ?? (() => {}));
}

export async function getFindings(): Promise<FindingsReport> {
  const res = await fetch(`${BASE}/findings/data`);
  if (!res.ok) throw new Error(`Failed to load findings: ${res.statusText}`);
  return res.json() as Promise<FindingsReport>;
}

// Fetch the generated Simple XML and trigger a real browser download.
export async function downloadDashboardXml(): Promise<void> {
  const res = await fetch(`${BASE}/starter-kit/dashboard-xml`);
  if (!res.ok) throw new Error(`Dashboard download failed: ${res.statusText}`);
  const xml = await res.text();
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cairn-starter-dashboard.xml';
  a.click();
  URL.revokeObjectURL(url);
}

export async function getGuide(): Promise<Guide> {
  const res = await fetch(`${BASE}/guide`);
  if (!res.ok) throw new Error(`Failed to load guide: ${res.statusText}`);
  return res.json() as Promise<Guide>;
}

export async function getGraph(): Promise<GraphData> {
  const res = await fetch(`${BASE}/graph`);
  if (!res.ok) throw new Error(`Failed to load graph: ${res.statusText}`);
  return res.json() as Promise<GraphData>;
}

export async function askQuestion(question: string): Promise<AskResponse> {
  const res = await fetch(`${BASE}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((err as { detail?: string }).detail ?? res.statusText);
  }
  // Tolerate the legacy shape (a bare string) as well as the current
  // { answer, live_queries } object — older backends may return either.
  const data = await res.json() as string | Partial<AskResponse>;
  if (typeof data === 'string') return { answer: data, live_queries: [] };
  return { answer: data.answer ?? '', live_queries: data.live_queries ?? [] };
}

export async function exportGuide(format: string): Promise<string> {
  const res = await fetch(`${BASE}/export?format=${encodeURIComponent(format)}`);
  if (!res.ok) throw new Error(`Export failed: ${res.statusText}`);
  return res.text();
}

// Parse a single SSE event block (the text between blank-line separators).
// Handles both \n and \r\n line endings.
function parseSseBlock(block: string): AgentEvent | null {
  const lines = block.split(/\r\n|\n/);
  let dataStr = '';
  for (const line of lines) {
    if (line.startsWith('data:')) {
      // "data: {...}" or "data:{...}" — slice past the colon, trim whitespace
      dataStr += line.slice(5).trim();
    }
  }
  if (!dataStr) return null;
  try {
    return JSON.parse(dataStr) as AgentEvent;
  } catch (e) {
    console.warn('[SSE] JSON parse failed:', e, 'raw:', dataStr);
    return null;
  }
}
