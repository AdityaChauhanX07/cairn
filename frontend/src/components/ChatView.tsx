import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useCairn } from '../context/CairnContext';
import CairnMark from './CairnMark';
import { CodeBlock, Eyebrow, Icons } from './Primitives';
import type { ChatMessage, LiveQuery } from '../types';

const SUGGESTED_QUESTIONS = [
  "What does 'Critical: Multiple Failed Logins from Same IP' mean and what should I do when it fires?",
  'Which indexes are most important and what data lives in each?',
  'What macros does this environment use and where?',
  'Show me recent failed login attempts',
  'What should I clean up first?',
];

// Minimal markdown: paragraphs, "- " lists, **bold**, `code`, *italic*.
function renderMd(md: string): ReactNode[] {
  const blocks = md.split('\n');
  const out: ReactNode[] = [];
  let list: string[] | null = null;
  let key = 0;

  const inline = (txt: string): ReactNode[] => {
    const parts: ReactNode[] = [];
    let i = 0;
    const re = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\*[^*\n]+\*)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt)) !== null) {
      if (m.index > last) parts.push(txt.slice(last, m.index));
      if (m[1]) parts.push(<strong key={i++} style={{ color: 'var(--text)' }}>{m[1].slice(2, -2)}</strong>);
      else if (m[2]) parts.push(<code key={i++} style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ember-text)', background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 4 }}>{m[2].slice(1, -1)}</code>);
      else if (m[3]) parts.push(<em key={i++} style={{ color: 'var(--text)', fontStyle: 'italic' }}>{m[3].slice(1, -1)}</em>);
      last = m.index + m[0].length;
    }
    if (last < txt.length) parts.push(txt.slice(last));
    return parts;
  };

  const flushList = () => {
    if (list) {
      const items = list;
      out.push(
        <ul key={`u${key++}`} style={{ margin: '0 0 10px', paddingLeft: 18 }}>
          {items.map((li, j) => <li key={j} style={{ marginBottom: 5, color: 'var(--text-2)' }}>{inline(li)}</li>)}
        </ul>,
      );
      list = null;
    }
  };

  blocks.forEach((b) => {
    const t = b.trim();
    if (t.startsWith('- ')) { (list = list || []).push(t.slice(2)); return; }
    flushList();
    if (t === '') return;
    out.push(<p key={`p${key++}`} style={{ margin: '0 0 10px', color: 'var(--text-2)', lineHeight: 1.6 }}>{inline(t)}</p>);
  });
  flushList();
  return out;
}

export default function ChatView() {
  const { chat, chatLoading, chatError, sendChat } = useCairn();
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat, chatLoading]);

  function ask(q?: string) {
    const question = (q ?? input).trim();
    if (!question || chatLoading) return;
    setInput('');
    sendChat(question);
  }

  const empty = chat.length === 0;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '16px 28px', borderBottom: '1px solid var(--line)' }}>
        <div className="row gap-3">
          <Icons.chat size={17} style={{ color: 'var(--ember)' }} />
          <span style={{ fontWeight: 600 }}>Ask cairn</span>
        </div>
        <span className="pill" style={{ color: 'var(--good)', borderColor: 'rgba(127,169,140,0.3)' }}>
          <Icons.shield size={11} /> answers grounded in your environment
        </span>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '28px 28px 40px' }}>
          {empty && (
            <div className="center" style={{ flexDirection: 'column', paddingTop: 30, paddingBottom: 30 }}>
              <CairnMark size={48} tone="var(--ember)" />
              <h2 style={{ fontSize: 24, marginTop: 18, textAlign: 'center' }}>Ask anything about this deployment.</h2>
              <p style={{ color: 'var(--text-3)', textAlign: 'center', maxWidth: 440, marginTop: 8 }}>
                Grounded in the discovered environment. cairn can trace a dependency chain or run a live, guardrailed
                query to back its answer.
              </p>
            </div>
          )}

          {chat.map((m, i) => <Bubble key={i} message={m} />)}

          {chatLoading && (
            <div style={{ marginBottom: 24 }}>
              <div className="row gap-2" style={{ marginBottom: 10 }}>
                <CairnMark size={20} tone="var(--ember)" />
                <span className="eyebrow">cairn</span>
              </div>
              <div className="row gap-2" style={{ color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
                <Dots /> tracing dependencies &amp; running queries…
              </div>
            </div>
          )}

          {chatError && (
            <div style={{ color: 'var(--sev-high)', fontFamily: 'var(--mono)', fontSize: 12.5, marginBottom: 16 }}>{chatError}</div>
          )}

          {/* suggested questions */}
          {!chatLoading && (
            <div style={{ marginTop: empty ? 12 : 26 }}>
              {empty && <div className="eyebrow" style={{ marginBottom: 12, textAlign: 'center' }}>try asking</div>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, justifyContent: empty ? 'center' : 'flex-start' }}>
                {SUGGESTED_QUESTIONS.filter((q) => !chat.some((m) => m.content === q)).map((q) => (
                  <button
                    key={q}
                    onClick={() => ask(q)}
                    className="row gap-2"
                    style={{ background: 'var(--surface-1)', border: '1px solid var(--line-2)', borderRadius: 999, padding: '8px 14px', cursor: 'pointer', color: 'var(--text-2)', fontSize: 13, fontFamily: 'var(--sans)' }}
                  >
                    {q.length > 64 ? `${q.slice(0, 64)}…` : q}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* input */}
      <div style={{ borderTop: '1px solid var(--line)', padding: '16px 28px', background: 'var(--ink)' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <div className="row gap-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--line-2)', borderRadius: 'var(--r-md)', padding: '6px 6px 6px 16px' }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ask()}
              placeholder="Ask about an alert, index, macro…"
              spellCheck={false}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 14.5, fontFamily: 'var(--sans)' }}
            />
            <button className="btn btn-primary" onClick={() => ask()} disabled={!input.trim() || chatLoading} style={{ padding: '9px 14px' }}>
              <Icons.send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ message: m }: { message: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 18 }}>
        <div style={{ background: 'var(--ember-dim)', border: '1px solid var(--ember-line)', color: 'var(--text)', padding: '11px 16px', borderRadius: '14px 14px 4px 14px', maxWidth: '78%', fontSize: 14.5 }}>
          {m.content}
        </div>
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 24 }}>
      <div className="row gap-2" style={{ marginBottom: 10 }}>
        <CairnMark size={20} tone="var(--ember)" />
        <span className="eyebrow">cairn</span>
      </div>
      <div style={{ fontSize: 14.5 }}>{renderMd(m.content)}</div>
      {m.liveQueries && m.liveQueries.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Eyebrow style={{ marginBottom: 8 }}>
            <Icons.search size={11} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            live queries run against splunk
          </Eyebrow>
          {m.liveQueries.map((q, j) => <QueryProvenance key={j} q={q} />)}
        </div>
      )}
    </div>
  );
}

function QueryProvenance({ q }: { q: LiveQuery }) {
  const label = q.type === 'saved_search' ? q.name ?? 'saved search' : q.name ?? 'live query';
  return (
    <div className="provenance" style={{ marginBottom: 10 }}>
      <div className="row gap-2 provenance-tag" style={{ marginBottom: 5 }}>
        <span className="pill" style={{ fontSize: 10, color: 'var(--text-3)' }}>{q.type}</span>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{label}</span>
      </div>
      {q.query && <CodeBlock code={q.query} pad="10px 14px" />}
    </div>
  );
}

function Dots() {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--ember)', animation: `blink 1s ${i * 0.2}s infinite` }} />
      ))}
    </span>
  );
}
