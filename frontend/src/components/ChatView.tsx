import { useState, useRef, useEffect } from 'react';
import { askQuestion } from '../utils/api';
import { markdownToHtml } from '../utils/markdown';
import type { ChatMessage } from '../types';

const SUGGESTED_QUESTION =
  "What does 'Critical: Multiple Failed Logins from Same IP' mean and what should I do when it fires?";

export default function ChatView() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function send(question: string) {
    if (!question.trim() || loading) return;
    const q = question.trim();
    setInput('');
    setError('');
    setMessages(prev => [...prev, { role: 'user', content: q }]);
    setLoading(true);
    try {
      const answer = await askQuestion(q);
      setMessages(prev => [...prev, { role: 'assistant', content: answer }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <div className="chat-container">
      {messages.length > 0 && (
        <div className="chat-messages">
          {messages.map((msg, i) => (
            <ChatBubble key={i} message={msg} />
          ))}
          {loading && (
            <div className="chat-bubble assistant">
              <div className="bubble-body loading-dots">
                <span /><span /><span />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {error && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          <span className="error-mark">!</span>
          <span><span className="error-hint">{error}</span></span>
        </div>
      )}

      {messages.length === 0 && !loading && (
        <div className="chat-suggested">
          <button className="chat-suggested-link" onClick={() => send(SUGGESTED_QUESTION)}>
            {SUGGESTED_QUESTION}
          </button>
        </div>
      )}

      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask…"
          rows={2}
          disabled={loading}
        />
        <button
          className="btn btn-primary chat-send-btn"
          onClick={() => send(input)}
          disabled={loading || !input.trim()}
          aria-label="Ask"
        >
          {loading ? <span className="spinner" /> : '→'}
        </button>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`chat-bubble ${isUser ? 'user' : 'assistant'}`}>
      {isUser ? (
        <div className="bubble-body">{message.content}</div>
      ) : (
        <div
          className="bubble-body markdown-body"
          dangerouslySetInnerHTML={{ __html: markdownToHtml(message.content) }}
        />
      )}
    </div>
  );
}
