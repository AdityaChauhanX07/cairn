import { useState } from 'react';
import ConnectForm from './components/ConnectForm';
import ExploreView from './components/ExploreView';
import GuideView from './components/GuideView';
import ChatView from './components/ChatView';
import type { AppState } from './types';

export default function App() {
  const [appState, setAppState] = useState<AppState>('connect');
  const [showChat, setShowChat] = useState(false);

  function handleConnected() {
    setAppState('explore');
  }

  function handleGuideReady() {
    setAppState('guide');
  }

  function handleStartChat() {
    setShowChat(true);
    // Small delay then scroll to chat
    setTimeout(() => {
      document.getElementById('chat-section')?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }

  function handleReExplore() {
    setShowChat(false);
    setAppState('explore');
  }

  // Shared chip handler: a Splunk-object chip can be clicked from either the
  // guide or the Q&A chat. Both live as siblings under App, so we fan the term
  // out over a window event that GuideView (which owns the sections + graph)
  // resolves into a scroll / highlight.
  function handleChipClick(term: string) {
    window.dispatchEvent(new CustomEvent('cairn:chip-click', { detail: term }));
  }

  return (
    <div className="app-root">
      {appState === 'connect' && (
        <div className="screen screen-center">
          <ConnectForm onConnected={handleConnected} />
        </div>
      )}

      {appState === 'explore' && (
        <div className="screen">
          <ExploreView onGuideReady={handleGuideReady} />
        </div>
      )}

      {appState === 'guide' && (
        <div className="screen">
          <GuideView
            onStartChat={handleStartChat}
            onReExplore={handleReExplore}
            showChat={showChat}
            onChipClick={handleChipClick}
          />
          {showChat && (
            <div id="chat-section" className="chat-section">
              <ChatView onChipClick={handleChipClick} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
