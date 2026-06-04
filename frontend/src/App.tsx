import { useState } from 'react';
import ConnectForm from './components/ConnectForm';
import ExploreView from './components/ExploreView';
import GuideView from './components/GuideView';
import type { AppState } from './types';

export default function App() {
  const [appState, setAppState] = useState<AppState>('connect');

  function handleConnected() {
    setAppState('explore');
  }

  function handleGuideReady() {
    setAppState('guide');
  }

  function handleReExplore() {
    setAppState('explore');
  }

  // Shared chip handler: a Splunk-object chip can be clicked from either the
  // guide content or the Q&A panel. We fan the term out over a window event
  // that GuideView (which owns the sections + graph) resolves into a scroll /
  // highlight.
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
          <GuideView onReExplore={handleReExplore} onChipClick={handleChipClick} />
        </div>
      )}
    </div>
  );
}
