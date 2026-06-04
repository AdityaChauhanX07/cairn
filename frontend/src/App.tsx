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
          <GuideView onStartChat={handleStartChat} showChat={showChat} />
          {showChat && (
            <div id="chat-section" className="chat-section">
              <ChatView />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
