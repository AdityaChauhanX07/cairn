// Session-wide state for the trail-nav app. The design splits Guide / Findings
// / Starter Kit / Ask into separate screens that mount and unmount as you
// navigate, so the data they share (the guide, the dependency graph, the
// findings report, the starter kit, the chat transcript, and the cross-screen
// "focus this node in the graph" link) lives here rather than inside any one
// screen. All backend connectivity flows through utils/api.ts unchanged.
import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import {
  getGuide, generateFindingsSSE, getFindings, generateStarterKitSSE, getStarterKit,
  askQuestion,
} from '../utils/api';
import { loadEnv, type CairnEnv } from '../utils/env';
import { deriveCounts, deriveGuideGraph, type Counts } from '../utils/guide';
import type {
  Guide, GraphData, FindingsReport, StarterKit, ChatMessage,
} from '../types';

interface CairnContextValue {
  // environment identity (captured during explore, persisted to localStorage)
  env: CairnEnv | null;
  refreshEnv: () => void;

  // guide (Mode A)
  guide: Guide | null;
  guideError: string;
  counts: Counts | null;
  graph: GraphData;
  loadGuide: () => void;

  // dependency-graph cross-link (findings "locate" → guide/explore highlight)
  graphFocus: string | null;
  setGraphFocus: (id: string | null) => void;

  // findings (Mode B)
  findings: FindingsReport | null;
  findingsGenerating: boolean;
  findingsProgress: string[];
  findingsError: string;
  ensureFindings: () => void;

  // starter kit (Mode C)
  kit: StarterKit | null;
  kitGenerating: boolean;
  kitProgress: string[];
  kitError: string;
  ensureKit: () => void;

  // ask (grounded Q&A)
  chat: ChatMessage[];
  chatLoading: boolean;
  chatError: string;
  sendChat: (question: string) => void;
}

const Ctx = createContext<CairnContextValue | null>(null);

export function useCairn(): CairnContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCairn must be used within <CairnProvider>');
  return v;
}

export function CairnProvider({ children }: { children: ReactNode }) {
  const [env, setEnv] = useState<CairnEnv | null>(() => loadEnv());
  const refreshEnv = useCallback(() => setEnv(loadEnv()), []);

  // ── Guide ──
  const [guide, setGuide] = useState<Guide | null>(null);
  const [guideError, setGuideError] = useState('');
  const guideLoadingRef = useRef(false);
  const loadGuide = useCallback(() => {
    if (guide || guideLoadingRef.current) return;
    guideLoadingRef.current = true;
    getGuide()
      .then((g) => { setGuide(g); refreshEnv(); })
      .catch((err) => setGuideError(err instanceof Error ? err.message : String(err)))
      .finally(() => { guideLoadingRef.current = false; });
  }, [guide, refreshEnv]);

  const counts = useMemo(() => (guide ? deriveCounts(guide) : null), [guide]);
  const graph = useMemo(
    () => (guide ? deriveGuideGraph(guide) : { nodes: [], edges: [] }),
    [guide],
  );

  // ── Graph cross-link ──
  const [graphFocus, setGraphFocus] = useState<string | null>(null);

  // ── Findings (Mode B) ──
  const [findings, setFindings] = useState<FindingsReport | null>(null);
  const [findingsGenerating, setFindingsGenerating] = useState(false);
  const [findingsProgress, setFindingsProgress] = useState<string[]>([]);
  const [findingsError, setFindingsError] = useState('');
  const findingsCancel = useRef<(() => void) | null>(null);
  const findingsStarted = useRef(false);
  const ensureFindings = useCallback(() => {
    if (findingsStarted.current) return;
    findingsStarted.current = true;
    setFindingsError('');
    setFindingsProgress([]);
    setFindingsGenerating(true);
    findingsCancel.current = generateFindingsSSE(
      (ev) => { if (ev.message) setFindingsProgress((p) => [...p, ev.message]); },
      () => {
        getFindings()
          .then(setFindings)
          .catch((err) => setFindingsError(err instanceof Error ? err.message : String(err)))
          .finally(() => setFindingsGenerating(false));
      },
      (err) => { setFindingsError(err); setFindingsGenerating(false); findingsStarted.current = false; },
    );
  }, []);

  // ── Starter kit (Mode C) ──
  const [kit, setKit] = useState<StarterKit | null>(null);
  const [kitGenerating, setKitGenerating] = useState(false);
  const [kitProgress, setKitProgress] = useState<string[]>([]);
  const [kitError, setKitError] = useState('');
  const kitCancel = useRef<(() => void) | null>(null);
  const kitStarted = useRef(false);
  const ensureKit = useCallback(() => {
    if (kitStarted.current) return;
    kitStarted.current = true;
    setKitError('');
    setKitProgress([]);
    setKitGenerating(true);
    kitCancel.current = generateStarterKitSSE(
      (ev) => { if (ev.message) setKitProgress((p) => [...p, ev.message]); },
      () => {
        getStarterKit()
          .then(setKit)
          .catch((err) => setKitError(err instanceof Error ? err.message : String(err)))
          .finally(() => setKitGenerating(false));
      },
      (err) => { setKitError(err); setKitGenerating(false); kitStarted.current = false; },
    );
  }, []);

  // ── Ask (grounded Q&A) ──
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState('');
  const sendChat = useCallback((question: string) => {
    const q = question.trim();
    if (!q || chatLoading) return;
    setChatError('');
    setChat((m) => [...m, { role: 'user', content: q }]);
    setChatLoading(true);
    askQuestion(q)
      .then(({ answer, live_queries }) => {
        setChat((m) => [...m, { role: 'assistant', content: answer, liveQueries: live_queries }]);
      })
      .catch((err) => setChatError(err instanceof Error ? err.message : String(err)))
      .finally(() => setChatLoading(false));
  }, [chatLoading]);

  const value: CairnContextValue = {
    env, refreshEnv,
    guide, guideError, counts, graph, loadGuide,
    graphFocus, setGraphFocus,
    findings, findingsGenerating, findingsProgress, findingsError, ensureFindings,
    kit, kitGenerating, kitProgress, kitError, ensureKit,
    chat, chatLoading, chatError, sendChat,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
