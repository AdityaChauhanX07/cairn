import { useState, useRef, useEffect } from 'react';
import { askQuestion } from '../utils/api';
import { markdownToHtml } from '../utils/markdown';
import type { ChatMessage } from '../types';

const SUGGESTED_QUESTIONS = [
  "This alert 'Critical: Multiple Failed Logins from Same IP' paged me at 3am. What does it mean and what should I do?",
  'Which indexes hold authentication data?',
  'What does the high_severity_filter macro do?',
  'Who owns the most alerts?',
];

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

  function useSuggested(q: string) {
    setInput(q);
    inputRef.current?.focus();
  }

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h2 className="chat-title">Ask a Question</h2>
        <p className="chat-subtitle">Ask about your Splunk environment, alerts, or anything in the guide.</p>
      </div>

      {messages.length === 0 && !loading && (
        <div className="chat-suggestion">
          <span className="suggestion-label">Try asking</span>
          <div className="suggestion-pills">
            {SUGGESTED_QUESTIONS.map((q, i) => (
              <button key={i} className="suggestion-btn" onClick={() => useSuggested(q)}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {messages.length > 0 && (
        <div className="chat-messages">
          {messages.map((msg, i) => (
            <ChatBubble key={i} message={msg} />
          ))}
          {loading && (
            <div className="chat-bubble assistant">
              <div className="bubble-role">Cairn</div>
              <div className="bubble-body loading-dots">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your Splunk environment... (Enter to send, Shift+Enter for newline)"
          rows={3}
          disabled={loading}
        />
        <button
          className="btn btn-primary chat-send-btn"
          onClick={() => send(input)}
          disabled={loading || !input.trim()}
        >
          {loading ? <span className="spinner" /> : 'Send'}
        </button>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`chat-bubble ${isUser ? 'user' : 'assistant'}`}>
      <div className="bubble-role">{isUser ? 'You' : 'Cairn'}</div>
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
