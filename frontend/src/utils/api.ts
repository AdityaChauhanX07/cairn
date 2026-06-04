import type { AgentEvent, Guide } from '../types';

const BASE = 'http://localhost:8000/api';

export async function connect(splunkUrl: string, token: string): Promise<void> {
  const res = await fetch(`${BASE}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ splunk_url: splunkUrl, token }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((err as { detail?: string }).detail ?? res.statusText);
  }
}

export function exploreSSE(
  onEvent: (event: AgentEvent) => void,
  onDone: () => void,
  onError: (err: string) => void
): () => void {
  let cancelled = false;

  (async () => {
    try {
      const res = await fetch(`${BASE}/explore`);
      if (!res.ok || !res.body) {
        onError(`Explore failed: ${res.statusText}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const parsed = parseSseBlock(part);
          if (!parsed) continue;
          onEvent(parsed);
          if (parsed.phase === 'done') {
            onDone();
            reader.cancel();
            return;
          }
        }
      }
    } catch (e) {
      if (!cancelled) onError(String(e));
    }
  })();

  return () => { cancelled = true; };
}

export function generateSSE(
  onEvent: (event: AgentEvent) => void,
  onDone: () => void,
  onError: (err: string) => void
): () => void {
  let cancelled = false;

  (async () => {
    try {
      const res = await fetch(`${BASE}/generate`);
      if (!res.ok || !res.body) {
        onError(`Generate failed: ${res.statusText}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const parsed = parseSseBlock(part);
          if (!parsed) continue;
          onEvent(parsed);
          if (parsed.phase === 'done') {
            onDone();
            reader.cancel();
            return;
          }
        }
      }
    } catch (e) {
      if (!cancelled) onError(String(e));
    }
  })();

  return () => { cancelled = true; };
}

export async function getGuide(): Promise<Guide> {
  const res = await fetch(`${BASE}/guide`);
  if (!res.ok) throw new Error(`Failed to load guide: ${res.statusText}`);
  return res.json() as Promise<Guide>;
}

export async function askQuestion(question: string): Promise<string> {
  const res = await fetch(`${BASE}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((err as { detail?: string }).detail ?? res.statusText);
  }
  const data = await res.json() as { answer: string };
  return data.answer;
}

export async function exportGuide(format: string): Promise<string> {
  const res = await fetch(`${BASE}/export?format=${encodeURIComponent(format)}`);
  if (!res.ok) throw new Error(`Export failed: ${res.statusText}`);
  return res.text();
}

function parseSseBlock(block: string): AgentEvent | null {
  const lines = block.split('\n');
  let dataStr = '';
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataStr += line.slice(5).trim();
    }
  }
  if (!dataStr) return null;
  try {
    return JSON.parse(dataStr) as AgentEvent;
  } catch {
    return null;
  }
}
