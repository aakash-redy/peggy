"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send, Sparkles, ShieldCheck, Gauge, Trash2, Copy, Plus,
  MessageSquare, BrainCircuit, CheckCircle2, XCircle,
  ChevronRight, LayoutDashboard, Menu, X, LogOut, Lock,
  Box, Maximize2, Download, ZoomIn, ZoomOut, RotateCw,
  Info, Layers, Grid3x3, Ruler, Eye, EyeOff,
  Play, Pause, AlertTriangle, Loader2, Target, Flag,
  Radio, Activity, Cpu, Zap, TrendingUp, Clock, ChevronDown,
  BarChart2, Shield, Settings, Search
} from "lucide-react";
import { createClient, Session } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DECLARATIONS
// ─────────────────────────────────────────────────────────────────────────────
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string | null;
        alt?: string;
        'auto-rotate'?: boolean | string;
        'camera-controls'?: boolean | string;
        'shadow-intensity'?: string | number;
        'environment-image'?: string;
        exposure?: string | number;
        loading?: string;
        class?: string;
        style?: React.CSSProperties;
        ref?: any;
        crossorigin?: string;
        bounds?: string;
        'touch-action'?: string;
        'camera-orbit'?: string;
        'min-camera-orbit'?: string;
        'ar-status'?: string;
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const getEnvVar = (key: string, fallback = '') => import.meta.env[key] || fallback;
const API_URL = getEnvVar('VITE_API_URL', 'http://localhost:8000');
const MAX_MESSAGE_LENGTH = 1000;
const RATE_LIMIT_DELAY = 1000;
const supabase = createClient(getEnvVar('VITE_SUPABASE_URL'), getEnvVar('VITE_SUPABASE_ANON_KEY'));

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
interface Citation { rule_id: string; content: string; }
interface ModelMetadata { name: string; category: string; tags: string[]; description?: string; fileSize?: string; highlight_material?: string; }
interface Message { id: string; role: "user" | "bot" | "error"; text: string; citations?: Citation[]; model_url?: string; model_metadata?: ModelMetadata; timestamp: number; }
interface AuthMessage { type: 'error' | 'success'; text: string; }
interface QuizQuestion { question: string; options: string[]; correctAnswer: number; explanation: string; }

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ DATA
// ─────────────────────────────────────────────────────────────────────────────
const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    question: "What is the minimum required force that the brake pedal system must be designed to withstand without failure?",
    options: ["1000 N", "1500 N", "2000 N", "2500 N"],
    correctAnswer: 2,
    explanation: "Rule T6.1.13: The brake pedal and its mounting must be designed to withstand a force of 2000 N without yielding."
  },
  {
    question: "Which material is strictly prohibited for use in the primary structure's main roll hoop?",
    options: ["Carbon Steel", "Aluminum Alloy", "Titanium", "Chromoly"],
    correctAnswer: 1,
    explanation: "Rule T3.2.1: Aluminum alloys are not permitted for the Main Roll Hoop or Front Roll Hoop."
  },
  {
    question: "What is the required color for the Cockpit Master Switch (Shutdown Button)?",
    options: ["Red", "Blue with Red outline", "Red with a Yellow background", "Black with a Red outline"],
    correctAnswer: 2,
    explanation: "Rule EV4.3.3: All shutdown buttons must be Red, mounted on a Yellow background for high visibility."
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// QUICK SUGGESTIONS
// ─────────────────────────────────────────────────────────────────────────────
const QUICK_QUERIES = [
  { label: "Front impact structure specs", icon: <Shield size={13} /> },
  { label: "Roll hoop material constraints", icon: <Target size={13} /> },
  { label: "Brake pedal force limits", icon: <Activity size={13} /> },
  { label: "IA foam dimensions", icon: <Ruler size={13} /> },
];

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
const sanitizeInput = (s: string) => s.trim().slice(0, MAX_MESSAGE_LENGTH);

// ─────────────────────────────────────────────────────────────────────────────
// TELEMETRY BAR (top strip)
// ─────────────────────────────────────────────────────────────────────────────
function TelemetryStrip() {
  const [tick, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1200); return () => clearInterval(id); }, []);
  const rpm = (6800 + Math.sin(tick * 0.7) * 800).toFixed(0);
  const temp = (92 + Math.sin(tick * 0.3) * 4).toFixed(1);
  const voltage = (396 + Math.sin(tick * 0.5) * 3).toFixed(1);
  return (
    <div className="hidden md:flex items-center gap-6 text-[9px] font-mono tracking-widest text-slate-500 select-none">
      <span className="flex items-center gap-1.5"><span className="text-[#FF2800]">RPM</span> {rpm}</span>
      <span className="w-px h-3 bg-white/10" />
      <span className="flex items-center gap-1.5"><span className="text-[#FF2800]">TEMP</span> {temp}°C</span>
      <span className="w-px h-3 bg-white/10" />
      <span className="flex items-center gap-1.5"><span className="text-[#FF2800]">HV</span> {voltage}V</span>
      <span className="w-px h-3 bg-white/10" />
      <span className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-[#FF2800] animate-pulse shadow-[0_0_6px_#FF2800]" />
        <span className="text-[#FF2800]">LIVE</span>
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCANLINE OVERLAY
// ─────────────────────────────────────────────────────────────────────────────
function Scanlines() {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 opacity-[0.025]"
      style={{
        backgroundImage: 'repeating-linear-gradient(to bottom, transparent, transparent 2px, rgba(255,255,255,0.4) 2px, rgba(255,255,255,0.4) 4px)',
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CORNER BRACKETS
// ─────────────────────────────────────────────────────────────────────────────
function CornerBrackets({ className = "" }: { className?: string }) {
  return (
    <span className={`pointer-events-none absolute inset-0 ${className}`}>
      <span className="absolute top-0 left-0 w-3 h-3 border-t border-l border-[#FF2800]/60" />
      <span className="absolute top-0 right-0 w-3 h-3 border-t border-r border-[#FF2800]/60" />
      <span className="absolute bottom-0 left-0 w-3 h-3 border-b border-l border-[#FF2800]/60" />
      <span className="absolute bottom-0 right-0 w-3 h-3 border-b border-r border-[#FF2800]/60" />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function IndraWorkspace() {
  // Auth
  const [session, setSession] = useState<Session | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [authMessage, setAuthMessage] = useState<AuthMessage | null>(null);

  // App
  const [appMode, setAppMode] = useState<"ask" | "quiz" | "gallery">("ask");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState([
    { id: 1, title: "Brake Pedal Tolerances", date: "Today", tag: "T6" },
    { id: 2, title: "TS Accumulator Rules", date: "Yesterday", tag: "EV5" },
    { id: 3, title: "Roll Hoop Geometry", date: "2d ago", tag: "T3" },
  ]);

  // Chat
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [lastMessageTime, setLastMessageTime] = useState(0);

  // 3D
  const [activeModelUrl, setActiveModelUrl] = useState<string | null>(null);
  const [activeModelMetadata, setActiveModelMetadata] = useState<ModelMetadata | null>(null);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [modelLoadProgress, setModelLoadProgress] = useState(0);
  const [is3DFullscreen, setIs3DFullscreen] = useState(false);
  const [showModelInfo, setShowModelInfo] = useState(true);
  const [autoRotateEnabled, setAutoRotateEnabled] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [modelZoom, setModelZoom] = useState(1);

  // Quiz
  const [qIndex, setQIndex] = useState(0);
  const [selectedAns, setSelectedAns] = useState<number | null>(null);
  const [isAnsChecked, setIsAnsChecked] = useState(false);
  const [quizScore, setQuizScore] = useState(0);
  const [quizFinished, setQuizFinished] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modelViewerRef = useRef<any>(null);

  // ── Effects ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isThinking]);

  useEffect(() => {
    const mv = modelViewerRef.current;
    if (!mv) return;
    
    const onLoad = () => {
      const materials = mv.model?.materials;
      if (!materials) return;

      materials.forEach((mat: any) => {
        if (!activeModelMetadata?.highlight_material) {
          // No highlight requested -> Standard opaque metal
          mat.pbrMetallicRoughness.setBaseColorFactor([0.8, 0.8, 0.8, 1]);
          mat.setAlphaMode('OPAQUE');
        } else if (mat.name === activeModelMetadata.highlight_material) {
          // INDRA Highlight (Red/Orange)
          mat.pbrMetallicRoughness.setBaseColorFactor([1, 0.16, 0, 1]);
          mat.setAlphaMode('OPAQUE');
        } else {
          // Ghost Mode (Visible Slate Glass)
          mat.pbrMetallicRoughness.setBaseColorFactor([0.3, 0.3, 0.35, 0.25]);
          mat.setAlphaMode('BLEND');
        }
      });
      // Force render update
      if (typeof mv.queueRender === 'function') mv.queueRender();
    };

    mv.addEventListener('load', onLoad);
    if (mv.model) onLoad(); // Trigger if already loaded
    return () => mv.removeEventListener('load', onLoad);
  }, [activeModelUrl, activeModelMetadata]);

  // ── Handlers ──
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAuthLoading(true);
    setAuthMessage(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authEmail)) { setAuthMessage({ type: 'error', text: 'Invalid email address' }); setIsAuthLoading(false); return; }
    if (authPassword.length < 6) { setAuthMessage({ type: 'error', text: 'Password must be ≥ 6 characters' }); setIsAuthLoading(false); return; }
    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({ email: authEmail, password: authPassword });
        if (error) throw error;
        setAuthMessage({ type: 'success', text: 'Access request submitted. Awaiting system admin approval.' });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
        if (error) throw error;
      }
    } catch (err: any) { setAuthMessage({ type: 'error', text: err.message || 'Authentication failed.' }); }
    finally { setIsAuthLoading(false); }
  };

  const deleteSession = useCallback((id: number, e: React.MouseEvent) => { e.stopPropagation(); setChatHistory(p => p.filter(s => s.id !== id)); }, []);
  const copyToClipboard = useCallback(async (text: string, id: string) => { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(null), 2000); }, []);

  const sendMessage = useCallback(async (text: string) => {
    const sanitized = sanitizeInput(text);
    if (!sanitized || isThinking) return;
    const now = Date.now();
    if (now - lastMessageTime < RATE_LIMIT_DELAY) {
      setMessages(p => [...p, { id: crypto.randomUUID(), role: "error", text: "Rate limit — please wait a moment before querying again.", timestamp: now }]);
      return;
    }
    setLastMessageTime(now);
    setMessages(p => [...p, { id: crypto.randomUUID(), role: "user", text: sanitized, timestamp: now }]);
    setInput(""); setIsThinking(true); setActiveModelUrl(null); setActiveModelMetadata(null);
    try {
      if (!session?.access_token) throw new Error('Authentication token missing.');
      const res = await fetch(`${API_URL}/ask_indra`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ message: sanitized, domain: "Formula Bharat 2027 Full" }),
      });
      if (!res.ok) throw new Error(`Telemetry uplink failure: ${res.status}`);
      const data = await res.json();
      setMessages(p => [...p, { id: crypto.randomUUID(), role: "bot", text: data.answer, citations: data.citations, model_url: data.model_url, model_metadata: data.model_metadata, timestamp: Date.now() }]);
      if (data.model_url) { setIsModelLoading(true); let prog = 0; const iv = setInterval(() => { prog += 10; setModelLoadProgress(prog); if (prog >= 100) { clearInterval(iv); setIsModelLoading(false); setModelLoadProgress(0); } }, 100); }
    } catch (err: any) {
      setMessages(p => [...p, { id: crypto.randomUUID(), role: "error", text: err.message, timestamp: Date.now() }]);
    } finally { setIsThinking(false); inputRef.current?.focus(); }
  }, [isThinking, lastMessageTime, session]);

  const handle3DModelLoad = useCallback((url: string, meta?: ModelMetadata) => {
    setActiveModelUrl(url); setActiveModelMetadata(meta || null); setIsModelLoading(true); setModelLoadProgress(0);
    let prog = 0; const iv = setInterval(() => { prog += 15; setModelLoadProgress(Math.min(prog, 100)); if (prog >= 100) { clearInterval(iv); setIsModelLoading(false); } }, 150);
  }, []);

  const close3DModel = useCallback(() => { setActiveModelUrl(null); setActiveModelMetadata(null); setIs3DFullscreen(false); setModelZoom(1); }, []);

  const downloadModel = useCallback(async () => {
    if (!activeModelUrl) return;
    try {
      const res = await fetch(activeModelUrl); const blob = await res.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = activeModelMetadata?.name || 'model.glb';
      document.body.appendChild(a); a.click(); URL.revokeObjectURL(url); document.body.removeChild(a);
    } catch { }
  }, [activeModelUrl, activeModelMetadata]);

  const reset3DCamera = useCallback(() => { modelViewerRef.current?.resetTurntableRotation(); setModelZoom(1); }, []);

  const handleAnswerSubmit = useCallback(() => {
    if (selectedAns !== null) { setIsAnsChecked(true); if (selectedAns === QUIZ_QUESTIONS[qIndex].correctAnswer) setQuizScore(p => p + 1); }
  }, [selectedAns, qIndex]);

  const nextQuestion = useCallback(() => {
    if (qIndex < QUIZ_QUESTIONS.length - 1) { setQIndex(p => p + 1); setSelectedAns(null); setIsAnsChecked(false); } else setQuizFinished(true);
  }, [qIndex]);

  const resetQuiz = useCallback(() => { setQIndex(0); setSelectedAns(null); setIsAnsChecked(false); setQuizScore(0); setQuizFinished(false); }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGIN SCREEN
  // ═══════════════════════════════════════════════════════════════════════════
  if (!session) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-[#060606] overflow-hidden" style={{ fontFamily: "'Rajdhani', 'DIN Next', system-ui, sans-serif" }}>
        {/* Animated grid */}
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(rgba(255,40,0,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,40,0,0.6) 1px, transparent 1px)', backgroundSize: '60px 60px' }} />
        {/* Glow */}
        <div className="absolute -top-[30%] left-1/2 -translate-x-1/2 w-[900px] h-[500px] rounded-full bg-[#FF2800]/5 blur-[100px] pointer-events-none" />

        {/* Speed lines */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="absolute h-px bg-gradient-to-r from-transparent via-[#FF2800]/20 to-transparent"
              style={{ top: `${15 + i * 14}%`, left: 0, right: 0, animationDelay: `${i * 0.4}s` }} />
          ))}
        </div>

        <div className="relative z-10 w-full max-w-[420px] px-4">
          {/* Header */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-3 mb-6">
              <div className="relative">
                <div className="w-10 h-10 bg-[#FF2800] flex items-center justify-center shadow-[0_0_30px_rgba(255,40,0,0.6)]">
                  <Zap size={20} className="text-white" />
                </div>
                <div className="absolute -inset-1 border border-[#FF2800]/30 animate-pulse" />
              </div>
              <div className="text-left">
                <div className="text-[11px] font-bold tracking-[0.3em] text-[#FF2800] uppercase">INDRA SYSTEM</div>
                <div className="text-[9px] tracking-[0.4em] text-slate-600 uppercase">Neural Rulebook Core</div>
              </div>
            </div>
            <h1 className="text-4xl font-black text-white tracking-tight mb-1">INDRA</h1>
            <p className="text-[10px] tracking-[0.35em] text-slate-500 uppercase">Integrated Neural Design and Rulebook Assistant</p>
          </div>

          {/* Card */}
          <div className="relative bg-[#0c0c0c] border border-white/[0.06] p-8">
            <CornerBrackets />

            <div className="mb-7">
              <p className="text-[10px] tracking-[0.3em] text-slate-500 uppercase mb-5">
                {isSignUp ? "Request System Access" : "Secure Login"}
              </p>

              <form onSubmit={handleAuthSubmit} className="space-y-4">
                <div>
                  <label className="block text-[9px] font-bold text-[#FF2800]/70 uppercase tracking-widest mb-2">Email</label>
                  <input type="email" required value={authEmail} onChange={e => setAuthEmail(e.target.value)}
                    className="w-full bg-[#111] border border-white/[0.07] px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF2800]/40 transition-colors placeholder:text-slate-700 font-mono"
                    placeholder="engineer@indra.sys" />
                </div>
                <div>
                  <label className="block text-[9px] font-bold text-[#FF2800]/70 uppercase tracking-widest mb-2">Password</label>
                  <input type="password" required value={authPassword} onChange={e => setAuthPassword(e.target.value)}
                    className="w-full bg-[#111] border border-white/[0.07] px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF2800]/40 transition-colors placeholder:text-slate-700 font-mono"
                    placeholder="••••••••" minLength={6} />
                </div>

                {authMessage && (
                  <div className={`px-4 py-3 text-[10px] font-mono tracking-wider border ${authMessage.type === 'error' ? 'bg-red-950/40 border-red-900/60 text-red-400' : 'bg-emerald-950/40 border-emerald-900/60 text-emerald-400'}`}>
                    {authMessage.text}
                  </div>
                )}

                <button type="submit" disabled={isAuthLoading}
                  className="relative w-full py-4 mt-2 bg-[#FF2800] text-white font-black text-[11px] tracking-[0.3em] uppercase hover:bg-[#e02400] transition-colors disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden group">
                  <span className="relative z-10">{isAuthLoading ? "AUTHENTICATING..." : isSignUp ? "REQUEST ACCESS" : "LAUNCH INDRA"}</span>
                  <div className="absolute inset-0 bg-white/10 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-500 skew-x-12" />
                </button>
              </form>
            </div>

            <div className="text-center">
              <button onClick={() => { setIsSignUp(!isSignUp); setAuthMessage(null); }}
                className="text-[9px] tracking-widest text-slate-600 hover:text-slate-400 uppercase transition-colors">
                {isSignUp ? "Already have access? Sign in" : "New engineer? Request access"}
              </button>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-center gap-6 mt-6 text-[8px] tracking-widest text-slate-700 uppercase">
            <span className="flex items-center gap-1.5"><Shield size={9} /> Encrypted</span>
            <span className="w-px h-3 bg-white/10" />
            <span className="flex items-center gap-1.5"><Lock size={9} /> Validated</span>
            <span className="w-px h-3 bg-white/10" />
            <span className="flex items-center gap-1.5"><Activity size={9} /> Live DB</span>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN WORKSPACE
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div
      className="flex h-screen w-full overflow-hidden bg-[#060606] text-slate-200 relative select-none"
      style={{ fontFamily: "'Rajdhani', 'DIN Next', system-ui, sans-serif" }}
    >
      <Scanlines />

      {/* Grid bg */}
      <div className="absolute inset-0 opacity-[0.025] pointer-events-none"
        style={{ backgroundImage: 'linear-gradient(rgba(255,40,0,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,40,0,0.5) 1px, transparent 1px)', backgroundSize: '80px 80px' }} />
      {/* Red glow top-left */}
      <div className="absolute -top-[20%] -left-[10%] w-[700px] h-[500px] rounded-full bg-[#FF2800]/4 blur-[120px] pointer-events-none" />

      {/* Mobile sidebar backdrop */}
      {isSidebarOpen && <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40 md:hidden" onClick={() => setIsSidebarOpen(false)} />}

      {/* ─── SIDEBAR ─────────────────────────────────────────────────────────── */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-[260px] h-full flex flex-col bg-[#080808] border-r border-white/[0.05] transition-transform duration-300 ease-out md:relative md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        {/* Brand */}
        <div className="px-6 pt-6 pb-5 border-b border-white/[0.05]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative w-8 h-8 bg-[#FF2800] flex items-center justify-center shadow-[0_0_20px_rgba(255,40,0,0.5)]">
                <Zap size={16} className="text-white" />
              </div>
              <div>
                <div className="text-[11px] font-black tracking-[0.2em] text-white uppercase">INDRA OS</div>
                <div className="text-[8px] tracking-[0.3em] text-[#FF2800] uppercase">v2.5</div>
              </div>
            </div>
            <button onClick={() => setIsSidebarOpen(false)} className="md:hidden text-slate-600 hover:text-white p-1"><X size={16} /></button>
          </div>
        </div>

        {/* New query */}
        <div className="px-4 py-4">
          <button
            onClick={() => { setAppMode("ask"); setMessages([]); setActiveModelUrl(null); setActiveModelMetadata(null); setIsSidebarOpen(false); }}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 bg-[#FF2800]/10 border border-[#FF2800]/20 text-[10px] font-bold tracking-widest uppercase text-[#FF2800] hover:bg-[#FF2800]/15 transition-colors group"
          >
            <Plus size={13} className="group-hover:rotate-90 transition-transform duration-300" /> New Query
          </button>
        </div>

        {/* Mode nav */}
        <div className="px-4 mb-2">
          <p className="text-[8px] font-bold tracking-[0.3em] text-slate-700 uppercase mb-2 px-1">Modules</p>
          {[
            { id: 'ask', icon: <MessageSquare size={13} />, label: 'Regulation Query', sub: 'AI-powered' },
            { id: 'quiz', icon: <BrainCircuit size={13} />, label: 'Compliance Test', sub: `${QUIZ_QUESTIONS.length} questions` },
            { id: 'gallery', icon: <Layers size={13} />, label: 'CAD Library', sub: '3D assets' },
          ].map(m => (
            <button key={m.id} onClick={() => { setAppMode(m.id as any); setActiveModelUrl(null); setIsSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 mb-1 text-left transition-all group relative ${appMode === m.id ? 'text-white' : 'text-slate-500 hover:text-slate-300'}`}>
              {appMode === m.id && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[#FF2800] shadow-[0_0_8px_#FF2800]" />}
              <span className={appMode === m.id ? 'text-[#FF2800]' : 'text-slate-600 group-hover:text-slate-400'}>{m.icon}</span>
              <div>
                <div className="text-[10px] font-bold tracking-wide uppercase">{m.label}</div>
                <div className="text-[8px] text-slate-700 uppercase tracking-wider">{m.sub}</div>
              </div>
            </button>
          ))}
        </div>

        {/* History */}
        <div className="flex-1 overflow-y-auto px-4 mt-2">
          <p className="text-[8px] font-bold tracking-[0.3em] text-slate-700 uppercase mb-2 px-1">Recent Sessions</p>
          {chatHistory.map(chat => (
            <div key={chat.id}
              className="group flex items-center justify-between px-3 py-2.5 mb-0.5 cursor-pointer hover:bg-white/[0.03] transition-colors">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-[8px] font-black px-1.5 py-0.5 bg-[#FF2800]/10 text-[#FF2800] border border-[#FF2800]/20 shrink-0">{chat.tag}</span>
                <span className="text-[10px] text-slate-500 truncate group-hover:text-slate-300 transition-colors">{chat.title}</span>
              </div>
              <button onClick={(e) => deleteSession(chat.id, e)} className="opacity-0 group-hover:opacity-100 text-slate-700 hover:text-red-500 transition-all p-1 shrink-0">
                <Trash2 size={10} />
              </button>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-white/[0.05] p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-6 h-6 rounded-full bg-[#FF2800]/20 border border-[#FF2800]/30 flex items-center justify-center text-[8px] font-black text-[#FF2800] uppercase">
              {session.user.email?.charAt(0)}
            </div>
            <span className="text-[9px] text-slate-600 font-mono truncate flex-1">{session.user.email}</span>
          </div>
          <button onClick={() => supabase.auth.signOut()}
            className="w-full flex items-center gap-2 px-3 py-2 text-[9px] font-bold tracking-widest uppercase text-slate-600 hover:text-red-400 hover:bg-red-950/30 transition-all border border-transparent hover:border-red-900/30 group">
            <LogOut size={11} className="group-hover:-translate-x-0.5 transition-transform" /> End Session
          </button>
        </div>
      </aside>

      {/* ─── MAIN ────────────────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col h-full min-w-0 relative z-10">

        {/* TOP BAR */}
        <header className="shrink-0 h-12 flex items-center justify-between px-4 md:px-6 border-b border-white/[0.05] bg-black/60 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <button onClick={() => setIsSidebarOpen(true)} className="md:hidden text-slate-600 hover:text-white p-1">
              <Menu size={18} />
            </button>
            {/* Breadcrumb */}
            <div className="flex items-center gap-2 text-[9px] font-bold tracking-[0.25em] uppercase">
              <span className="text-slate-700">INDRA</span>
              <ChevronRight size={10} className="text-slate-800" />
              <span className="text-slate-400">{appMode === 'ask' ? 'QUERY ENGINE' : appMode === 'quiz' ? 'COMPLIANCE TEST' : 'CAD LIBRARY'}</span>
            </div>
          </div>
          <TelemetryStrip />
        </header>

        {/* CONTENT AREA */}
        <div className="flex-1 flex flex-row overflow-hidden">

          {/* LEFT PANEL */}
          <div className={`flex flex-col h-full transition-all duration-500 ease-out ${activeModelUrl ? 'w-full md:w-1/2' : 'w-full'}`}>

            {/* ── ASK MODE ── */}
            {appMode === 'ask' && (
              <>
                <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6 scroll-smooth">
                  {messages.length === 0 && !isThinking ? (
                    /* Empty state */
                    <div className="h-full flex flex-col items-center justify-center max-w-xl mx-auto text-center">
                      {/* Hero icon */}
                      <div className="relative mb-8">
                        <div className="w-16 h-16 bg-[#FF2800]/10 border border-[#FF2800]/20 flex items-center justify-center">
                          <Target size={28} className="text-[#FF2800]/70" />
                        </div>
                        <div className="absolute -inset-3 border border-[#FF2800]/10 animate-pulse" />
                      </div>

                      <h2 className="text-2xl font-black tracking-tight text-white mb-2 uppercase">Ready for Input</h2>
                      <p className="text-[10px] tracking-[0.25em] text-slate-600 uppercase mb-10">
                        Regulation Intelligence — 1,362 rules indexed
                      </p>

                      {/* Quick queries */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full">
                        {QUICK_QUERIES.map((q, i) => (
                          <button key={i} onClick={() => setInput(q.label)}
                            className="flex items-center gap-3 px-4 py-3 bg-[#0c0c0c] border border-white/[0.06] hover:border-[#FF2800]/30 hover:bg-[#FF2800]/5 transition-all text-left group">
                            <span className="text-[#FF2800]/50 group-hover:text-[#FF2800] transition-colors shrink-0">{q.icon}</span>
                            <span className="text-[10px] font-bold tracking-wider uppercase text-slate-500 group-hover:text-slate-300 transition-colors">{q.label}</span>
                            <ChevronRight size={10} className="text-slate-700 ml-auto group-hover:text-[#FF2800] group-hover:translate-x-0.5 transition-all" />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    /* Messages */
                    <div className="max-w-3xl mx-auto space-y-5 pb-6">
                      {messages.map(msg => (
                        <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>

                          {/* Role label */}
                          <span className={`text-[8px] tracking-[0.3em] uppercase mb-1.5 font-bold ${msg.role === 'user' ? 'text-slate-600' : msg.role === 'error' ? 'text-red-600' : 'text-[#FF2800]/60'}`}>
                            {msg.role === 'user' ? 'YOU' : msg.role === 'error' ? '⚠ SYSTEM' : 'INDRA'}
                          </span>

                          {/* Bubble */}
                          <div className={`relative group max-w-[88%] px-5 py-4 text-sm leading-relaxed font-sans select-text ${
                            msg.role === 'user'
                              ? 'bg-white/[0.06] border border-white/[0.08] text-slate-200'
                              : msg.role === 'error'
                              ? 'bg-red-950/30 border border-red-900/40 text-red-400 font-mono text-xs'
                              : 'bg-[#0c0c0c] border border-white/[0.07] text-slate-300 border-l-2 border-l-[#FF2800]/60'
                          }`}>
                            {msg.role === 'bot' && <CornerBrackets />}
                            <p className="whitespace-pre-wrap relative z-10">{msg.text}</p>

                            {/* 3D model button */}
                            {msg.model_url && msg.role === 'bot' && (
                              <div className="mt-4 pt-4 border-t border-white/[0.07]">
                                <button onClick={() => handle3DModelLoad(msg.model_url!, msg.model_metadata)}
                                  className={`flex items-center gap-2.5 px-4 py-2.5 text-[10px] font-black tracking-widest uppercase transition-all ${activeModelUrl === msg.model_url ? 'bg-[#FF2800] text-white shadow-[0_0_20px_rgba(255,40,0,0.3)]' : 'border border-[#FF2800]/30 text-[#FF2800] hover:bg-[#FF2800]/10'}`}>
                                  <Box size={12} />
                                  {activeModelUrl === msg.model_url ? 'Model Active' : 'Load 3D Model'}
                                </button>
                                {msg.model_metadata && (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    <span className="text-[8px] font-bold uppercase tracking-widest px-2 py-1 bg-white/[0.04] text-slate-500">{msg.model_metadata.name}</span>
                                    <span className="text-[8px] font-bold uppercase tracking-widest px-2 py-1 bg-[#FF2800]/10 text-[#FF2800]/70">{msg.model_metadata.category}</span>
                                    {msg.model_metadata.highlight_material && <span className="text-[8px] font-bold uppercase tracking-widest px-2 py-1 bg-amber-900/20 text-amber-500">Ghost Mode</span>}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Copy btn */}
                            {msg.role === 'bot' && (
                              <button onClick={() => copyToClipboard(msg.text, msg.id)}
                                className="absolute top-2 right-2 p-1.5 opacity-0 group-hover:opacity-100 transition-opacity text-slate-600 hover:text-slate-300">
                                <Copy size={11} />
                              </button>
                            )}
                          </div>

                          {/* Citations */}
                          {msg.citations && msg.citations.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {msg.citations.map(c => (
                                <div key={c.rule_id} className="group/cite relative">
                                  <span className="inline-flex items-center gap-1 px-2 py-1 bg-[#FF2800]/8 border border-[#FF2800]/20 text-[8px] font-black tracking-widest text-[#FF2800]/70 cursor-help uppercase hover:border-[#FF2800]/40 transition-colors">
                                    <ShieldCheck size={8} /> {c.rule_id}
                                  </span>
                                  <div className="absolute bottom-full left-0 mb-2 w-72 p-4 bg-[#0d0d0d] border border-[#FF2800]/20 text-[9px] font-mono hidden group-hover/cite:block z-50 shadow-2xl">
                                    <p className="text-[#FF2800] font-black mb-1.5 uppercase tracking-widest">{c.rule_id}</p>
                                    <p className="text-slate-400 leading-relaxed">{c.content}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}

                      {isThinking && (
                        <div className="flex items-center gap-3 text-[9px] font-bold tracking-[0.25em] text-[#FF2800]/60 uppercase">
                          <Loader2 size={12} className="animate-spin text-[#FF2800]" />
                          Scanning regulations...
                        </div>
                      )}
                      <div ref={bottomRef} />
                    </div>
                  )}
                </div>

                {/* INPUT BAR */}
                <div className="shrink-0 px-4 md:px-6 py-4 bg-gradient-to-t from-[#060606] via-[#060606]/90 to-transparent border-t border-white/[0.04]">
                  <div className="max-w-3xl mx-auto relative flex items-center gap-2">
                    <div className="relative flex-1">
                      <input ref={inputRef} value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
                        placeholder="Query regulations, dimensions, materials..."
                        disabled={isThinking}
                        maxLength={MAX_MESSAGE_LENGTH}
                        className="w-full bg-[#0c0c0c] border border-white/[0.07] focus:border-[#FF2800]/30 px-4 py-3.5 pr-4 text-sm text-white placeholder:text-slate-700 focus:outline-none transition-colors font-sans disabled:opacity-40"
                      />
                    </div>
                    <button onClick={() => sendMessage(input)} disabled={isThinking || !input.trim()}
                      className={`shrink-0 px-5 py-3.5 flex items-center gap-2 text-[10px] font-black tracking-widest uppercase transition-all ${input.trim() && !isThinking ? 'bg-[#FF2800] text-white hover:bg-[#e02400] shadow-[0_0_20px_rgba(255,40,0,0.3)]' : 'bg-white/5 text-slate-700 cursor-not-allowed'}`}>
                      {isThinking ? <Loader2 size={14} className="animate-spin" /> : <><Send size={14} /> Send</>}
                    </button>
                  </div>
                  <p className="max-w-3xl mx-auto text-[8px] text-slate-800 mt-2 tracking-widest uppercase">
                    {input.length}/{MAX_MESSAGE_LENGTH} chars
                  </p>
                </div>
              </>
            )}

            {/* ── QUIZ MODE ── */}
            {appMode === 'quiz' && (
              <div className="flex-1 overflow-y-auto px-4 md:px-8 py-10 flex items-center justify-center">
                <div className="w-full max-w-2xl">
                  {!quizFinished ? (
                    <div className="relative bg-[#0c0c0c] border border-white/[0.06] p-8 md:p-10">
                      <CornerBrackets />
                      {/* Progress */}
                      <div className="flex items-center justify-between mb-7">
                        <span className="text-[9px] font-black tracking-[0.3em] text-[#FF2800] uppercase">Compliance Test</span>
                        <span className="text-[9px] tracking-widest text-slate-600 font-mono">{qIndex + 1} / {QUIZ_QUESTIONS.length}</span>
                      </div>
                      {/* Progress bar */}
                      <div className="h-px bg-white/[0.06] mb-8 overflow-hidden">
                        <div className="h-full bg-[#FF2800] transition-all duration-500 shadow-[0_0_8px_#FF2800]"
                          style={{ width: `${((qIndex) / QUIZ_QUESTIONS.length) * 100}%` }} />
                      </div>

                      <h3 className="text-base md:text-lg font-bold text-white leading-relaxed mb-8">{QUIZ_QUESTIONS[qIndex].question}</h3>

                      <div className="space-y-2.5">
                        {QUIZ_QUESTIONS[qIndex].options.map((opt, idx) => {
                          let cls = "bg-[#111] border-white/[0.06] text-slate-400 hover:border-white/20 hover:text-slate-200";
                          let icon = null;
                          if (isAnsChecked) {
                            if (idx === QUIZ_QUESTIONS[qIndex].correctAnswer) { cls = "bg-emerald-950/40 border-emerald-700/50 text-emerald-400"; icon = <CheckCircle2 size={14} className="shrink-0" />; }
                            else if (idx === selectedAns) { cls = "bg-red-950/40 border-red-700/50 text-red-400"; icon = <XCircle size={14} className="shrink-0" />; }
                            else { cls = "bg-[#111] border-white/[0.04] text-slate-700 opacity-40"; }
                          } else if (selectedAns === idx) { cls = "bg-[#FF2800]/8 border-[#FF2800]/40 text-white"; }

                          return (
                            <button key={idx} onClick={() => !isAnsChecked && setSelectedAns(idx)} disabled={isAnsChecked}
                              className={`w-full flex items-center justify-between px-5 py-3.5 border text-[11px] font-bold tracking-wide uppercase text-left transition-all ${cls}`}>
                              <span>{opt}</span>
                              {icon}
                            </button>
                          );
                        })}
                      </div>

                      {isAnsChecked && (
                        <div className="mt-7 p-4 bg-black/60 border-l-2 border-slate-700 text-[10px] text-slate-400 leading-relaxed font-mono">
                          <span className="text-[#FF2800] font-black block mb-1 uppercase tracking-widest text-[9px]">Regulation Reference</span>
                          {QUIZ_QUESTIONS[qIndex].explanation}
                        </div>
                      )}

                      <div className="mt-8 flex justify-end">
                        {!isAnsChecked
                          ? <button onClick={handleAnswerSubmit} disabled={selectedAns === null}
                              className="px-8 py-3 bg-[#FF2800] text-white text-[10px] font-black tracking-widest uppercase disabled:opacity-30 hover:bg-[#e02400] transition-colors">
                              Confirm
                            </button>
                          : <button onClick={nextQuestion}
                              className="px-8 py-3 bg-white text-black text-[10px] font-black tracking-widest uppercase flex items-center gap-2 hover:bg-slate-200 transition-colors">
                              {qIndex === QUIZ_QUESTIONS.length - 1 ? 'Finish' : 'Next'} <ChevronRight size={12} />
                            </button>
                        }
                      </div>
                    </div>
                  ) : (
                    <div className="relative bg-[#0c0c0c] border border-white/[0.06] p-12 text-center">
                      <CornerBrackets />
                      <div className="relative inline-flex items-center justify-center w-28 h-28 mb-8">
                        <div className="absolute inset-0 border-2 border-[#FF2800]/20 rotate-45" />
                        <span className="text-4xl font-black text-[#FF2800]">{quizScore}/{QUIZ_QUESTIONS.length}</span>
                      </div>
                      <h2 className="text-xl font-black text-white uppercase tracking-widest mb-2">Assessment Complete</h2>
                      <p className="text-[10px] text-slate-600 tracking-[0.3em] uppercase mb-8">
                        {quizScore === QUIZ_QUESTIONS.length ? "Full compliance achieved" : "Review flagged regulations"}
                      </p>
                      <button onClick={resetQuiz} className="px-8 py-3 bg-[#FF2800] text-white font-black text-[10px] tracking-widest uppercase hover:bg-[#e02400] transition-colors">
                        Restart Test
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── GALLERY MODE ── */}
            {appMode === 'gallery' && (
              <div className="flex-1 overflow-y-auto px-4 md:px-8 py-8">
                <div className="max-w-5xl mx-auto">
                  <div className="flex items-end justify-between mb-6">
                    <div>
                      <h2 className="text-xl font-black text-white uppercase tracking-tight mb-1">CAD Asset Library</h2>
                      <p className="text-[9px] tracking-[0.3em] text-[#FF2800]/60 uppercase">Geometric Data</p>
                    </div>
                    <div className="relative hidden md:block">
                      <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-700" />
                      <input placeholder="Search assets..." className="pl-8 pr-4 py-2 bg-[#0c0c0c] border border-white/[0.06] text-[10px] text-slate-400 placeholder:text-slate-700 focus:outline-none focus:border-[#FF2800]/30 w-48 transition-colors" />
                    </div>
                  </div>

                  {/* Filter chips */}
                  <div className="flex flex-wrap gap-2 mb-6">
                    {['All', 'Chassis', 'Powertrain', 'Braking', 'Safety', 'Aero'].map(cat => (
                      <button key={cat}
                        className="px-3 py-1.5 text-[9px] font-black tracking-widest uppercase border border-white/[0.06] text-slate-600 hover:border-[#FF2800]/30 hover:text-[#FF2800] transition-all">
                        {cat}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {[
                      { name: 'Front Impact Structure', category: 'Safety', tags: ['T3.14', 'T3.12'], icon: '🛡', desc: 'Primary deformable structure' },
                      { name: 'Main Roll Hoop', category: 'Chassis', tags: ['T3.2.1'], icon: '⭕', desc: 'Rollover protection system' },
                      { name: 'TS Accumulator', category: 'Powertrain', tags: ['EV5.1'], icon: '⚡', desc: 'High-voltage energy store' },
                      { name: 'Brake Pedal Assembly', category: 'Braking', tags: ['T6.1.13'], icon: '🔴', desc: 'Dual-circuit hydraulic brake' },
                      { name: 'Side Impact Structure', category: 'Safety', tags: ['T3.17'], icon: '🔷', desc: 'Lateral load path' },
                      { name: 'Front Wing', category: 'Aero', tags: ['T7.1'], icon: '🪂', desc: 'Downforce generating element' },
                    ].map((model, idx) => (
                      <div key={idx}
                        className="relative bg-[#0c0c0c] border border-white/[0.06] hover:border-[#FF2800]/30 cursor-pointer transition-all group p-5">
                        <CornerBrackets />
                        <div className="aspect-video bg-[#0a0a0a] border border-white/[0.04] mb-4 flex items-center justify-center text-3xl group-hover:bg-[#FF2800]/5 transition-colors">
                          {model.icon}
                        </div>
                        <div className="flex items-start justify-between mb-1">
                          <h3 className="text-[11px] font-black text-white uppercase tracking-wide leading-tight">{model.name}</h3>
                        </div>
                        <p className="text-[8px] text-[#FF2800]/60 uppercase tracking-widest mb-1 font-bold">{model.category}</p>
                        <p className="text-[9px] text-slate-600 mb-3">{model.desc}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {model.tags.map(tag => (
                            <span key={tag} className="px-1.5 py-0.5 bg-white/[0.04] border border-white/[0.06] text-[8px] text-slate-600 font-mono">{tag}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ─── 3D VIEWER ─────────────────────────────────────────────────────── */}
          {activeModelUrl && (
            <div className={`${is3DFullscreen ? 'fixed inset-0 z-50' : 'hidden md:flex w-1/2'} flex-col bg-[#070707] border-l border-white/[0.05] relative`}>

              {/* Viewer top bar */}
              <div className="absolute top-4 left-4 right-4 z-30 flex items-center justify-between pointer-events-none">
                <div className="bg-black/80 backdrop-blur border border-[#FF2800]/20 px-3 py-1.5 flex items-center gap-2 pointer-events-auto">
                  <span className="w-1.5 h-1.5 bg-[#FF2800] animate-pulse shadow-[0_0_6px_#FF2800]" />
                  <span className="text-[9px] font-black tracking-[0.25em] text-[#FF2800] uppercase">Live Render</span>
                </div>
                <div className="flex items-center gap-1.5 pointer-events-auto">
                  <button onClick={() => setShowModelInfo(!showModelInfo)} className="p-2 bg-black/80 border border-white/[0.08] hover:border-white/20 text-slate-500 hover:text-white transition-all">
                    <Eye size={12} />
                  </button>
                  <button onClick={() => setIs3DFullscreen(!is3DFullscreen)} className="p-2 bg-black/80 border border-white/[0.08] hover:border-white/20 text-slate-500 hover:text-white transition-all">
                    <Maximize2 size={12} />
                  </button>
                  <button onClick={close3DModel} className="p-2 bg-[#FF2800]/80 hover:bg-[#FF2800] text-white transition-all">
                    <X size={12} />
                  </button>
                </div>
              </div>

              {/* Loading overlay */}
              {isModelLoading && (
                <div className="absolute inset-0 z-40 bg-[#070707] flex flex-col items-center justify-center">
                  <div className="relative mb-6">
                    <div className="w-12 h-12 border border-[#FF2800]/20 flex items-center justify-center">
                      <Target size={20} className="text-[#FF2800] animate-pulse" />
                    </div>
                    <div className="absolute -inset-2 border border-[#FF2800]/10 animate-pulse" />
                  </div>
                  <p className="text-[9px] font-bold tracking-[0.3em] text-white uppercase mb-4">Compiling Geometry</p>
                  <div className="w-40 h-px bg-white/[0.06] overflow-hidden">
                    <div className="h-full bg-[#FF2800] shadow-[0_0_8px_#FF2800] transition-all duration-300" style={{ width: `${modelLoadProgress}%` }} />
                  </div>
                  <p className="text-[8px] text-[#FF2800]/60 mt-2 font-mono">{modelLoadProgress}%</p>
                </div>
              )}

              {/* model-viewer */}
              <div className="flex-1 w-full h-full cursor-move">
                <model-viewer
                  ref={modelViewerRef}
                  src={activeModelUrl}
                  alt={activeModelMetadata?.name || "3D Engineering Model"}
                  auto-rotate={autoRotateEnabled ? "true" : "false"}
                  camera-controls="true"
                  shadow-intensity="1.5"
                  environment-image="neutral"
                  exposure="1.2"
                  bounds="tight"
                  crossorigin="anonymous"
                  touch-action="pan-y"
                  camera-orbit="45deg 75deg 105%"
                  min-camera-orbit="auto auto 5%"
                  style={{
                    width: '100%', height: '100%',
                    backgroundColor: '#080808',
                    backgroundImage: showGrid ? 'radial-gradient(rgba(255,40,0,0.08) 1px, transparent 1px)' : 'none',
                    backgroundSize: '40px 40px',
                    transform: `scale(${modelZoom})`,
                  }}
                >
                  <div slot="poster" className="absolute inset-0 flex items-center justify-center bg-[#060606]">
                    <div className="flex flex-col items-center gap-3">
                      <Loader2 className="animate-spin text-[#FF2800]" size={24} />
                      <span className="text-[10px] text-slate-600 uppercase tracking-[0.3em]">Downloading Mesh...</span>
                    </div>
                  </div>
                </model-viewer>
              </div>

              {/* Model info panel */}
              {showModelInfo && activeModelMetadata && (
                <div className="absolute bottom-4 left-4 right-4 z-30 bg-black/90 backdrop-blur border border-white/[0.08] p-4">
                  <div className="flex items-start justify-between mb-3 pb-3 border-b border-white/[0.06]">
                    <div>
                      <h3 className="text-[11px] font-black text-white uppercase tracking-wide mb-0.5">{activeModelMetadata.name}</h3>
                      <p className="text-[8px] text-[#FF2800]/70 uppercase tracking-widest font-bold">{activeModelMetadata.category}</p>
                    </div>
                    <button onClick={downloadModel} className="p-1.5 text-slate-600 hover:text-white transition-colors">
                      <Download size={12} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex gap-1.5">
                      <button onClick={() => setAutoRotateEnabled(!autoRotateEnabled)}
                        className={`p-1.5 border text-[9px] transition-all ${autoRotateEnabled ? 'bg-[#FF2800]/20 border-[#FF2800]/40 text-[#FF2800]' : 'bg-white/[0.04] border-white/[0.08] text-slate-600'}`}>
                        <Play size={10} />
                      </button>
                      <button onClick={() => setShowGrid(!showGrid)}
                        className={`p-1.5 border text-[9px] transition-all ${showGrid ? 'bg-[#FF2800]/20 border-[#FF2800]/40 text-[#FF2800]' : 'bg-white/[0.04] border-white/[0.08] text-slate-600'}`}>
                        <Grid3x3 size={10} />
                      </button>
                      <button onClick={reset3DCamera} className="p-1.5 bg-white/[0.04] border border-white/[0.08] text-slate-600 hover:text-white transition-all">
                        <RotateCw size={10} />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setModelZoom(Math.max(0.5, modelZoom - 0.1))} className="p-1 text-slate-600 hover:text-white"><ZoomOut size={10} /></button>
                      <span className="text-[9px] text-slate-500 font-mono w-8 text-center">{Math.round(modelZoom * 100)}%</span>
                      <button onClick={() => setModelZoom(Math.min(2, modelZoom + 0.1))} className="p-1 text-slate-600 hover:text-white"><ZoomIn size={10} /></button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}