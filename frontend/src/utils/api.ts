import type { AgentEvent, Guide, GraphData } from '../types';

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
