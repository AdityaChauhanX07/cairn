import { useState, useRef, useEffect } from 'react';
import { askQuestion } from '../utils/api';
import { markdownToHtml } from '../utils/markdown';
import { SkeletonText } from './Skeleton';
import type { ChatMessage } from '../types';

const SUGGESTED_QUESTION =
  "What does 'Critical: Multiple Failed Logins from Same IP' mean and what should I do when it fires?";

interface Props {
  onChipClick?: (term: string) => void;
}

// Catch clicks bubbling up from a rendered Splunk-object chip and forward the
// term. Shared by every markdown surface so the behavior stays uniform.
function chipClickHandler(onChipClick?: (term: string) => void) {
  return (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('chip-clickable')) {
      const term = target.getAttribute('data-term');
      if (term) onChipClick?.(term);
    }
  };
}

export default function ChatView({ onChipClick }: Props) {
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
      <div className="chat-scroll">
        {messages.length === 0 && !loading && (
          <div className="chat-suggested">
            <span className="chat-suggested-label">Try asking</span>
            <button className="chat-suggested-link" onClick={() => send(SUGGESTED_QUESTION)}>
              {SUGGESTED_QUESTION}
            </button>
          </div>
        )}

        {messages.length > 0 && (
          <div className="chat-messages">
            {messages.map((msg, i) => (
              <ChatBubble key={i} message={msg} onChipClick={onChipClick} />
            ))}
            {loading && (
              <div className="chat-bubble assistant">
                <div className="bubble-body skeleton-answer">
                  <SkeletonText lines={4} />
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="error-banner" style={{ marginTop: 16 }}>
            <span className="error-mark">!</span>
            <span><span className="error-hint">{error}</span></span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

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

function ChatBubble({
  message,
  onChipClick,
}: {
  message: ChatMessage;
  onChipClick?: (term: string) => void;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={`chat-bubble ${isUser ? 'user' : 'assistant'}`}>
      {isUser ? (
        <div className="bubble-body">{message.content}</div>
      ) : (
        <div
          className="bubble-body markdown-body"
          onClick={chipClickHandler(onChipClick)}
          dangerouslySetInnerHTML={{ __html: markdownToHtml(message.content) }}
        />
      )}
    </div>
  );
}
