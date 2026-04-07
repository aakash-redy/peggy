import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send, ShieldCheck, Trash2, Copy, Plus,
  MessageSquare, BrainCircuit, CheckCircle2, XCircle,
  ChevronRight, Menu, X, LogOut, Lock,
  Box, Maximize2, Download, ZoomIn, ZoomOut, RotateCw,
  Eye, EyeOff, Play, Grid3x3,
  Target, Activity, Zap, Loader2, Ruler,
  Crosshair, Minimize2, Layers, RefreshCw
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
        zoom?: (amount: number) => void;
        resetTurntableRotation?: () => void;
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
interface CadNode { rule_id: string; cad_node_name: string; relevance_score?: number; }
interface ModelMetadata {
  name: string;
  category: string;
  tags: string[];
  description?: string;
  fileSize?: string;
  cad_nodes?: CadNode[];
}
interface Message {
  id: string;
  role: "user" | "bot" | "error";
  text: string;
  citations?: Citation[];
  model_url?: string;
  model_metadata?: ModelMetadata;
  cad_nodes?: CadNode[];
  timestamp: number;
}
interface AuthMessage { type: 'error' | 'success'; text: string; }
interface QuizQuestion { question: string; options: string[]; correctAnswer: number; explanation: string; }
type FocusedPanel = null | 'sidebar' | 'chat' | '3d';
type IsolationMode = 'ghost' | 'hidden';

// ─────────────────────────────────────────────────────────────────────────────
// DATA & CONSTANTS
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

const QUICK_QUERIES = [
  { label: "Front impact structure specs", icon: <ShieldCheck size={13} /> },
  { label: "Roll hoop material constraints", icon: <Target size={13} /> },
  { label: "Brake pedal force limits", icon: <Activity size={13} /> },
  { label: "IA foam dimensions", icon: <Ruler size={13} /> },
];

const sanitizeInput = (s: string) => s.trim().slice(0, MAX_MESSAGE_LENGTH);

// ─────────────────────────────────────────────────────────────────────────────
// REUSABLE COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function FocusButton({ panel, focusedPanel, onToggle }: { panel: FocusedPanel; focusedPanel: FocusedPanel; onToggle: (p: FocusedPanel) => void; }) {
  const isActive = focusedPanel === panel;
  return (
    <button
      onClick={() => onToggle(isActive ? null : panel)}
      title={isActive ? "Exit Focus Mode" : "Focus this panel"}
      className={`relative overflow-hidden flex items-center gap-1.5 px-3 py-2 md:px-2.5 md:py-1.5 text-[8px] font-black tracking-[0.25em] uppercase border transition-all duration-300 group
        ${isActive ? 'bg-[#FF2800] border-[#FF2800] text-white shadow-[0_0_16px_rgba(255,40,0,0.45)]' : 'bg-transparent border-white/[0.08] text-slate-600 hover:border-[#FF2800]/40 hover:text-[#FF2800]/80'}`}
    >
      <span className="absolute inset-0 bg-white/10 translate-x-[-110%] group-hover:translate-x-[110%] transition-transform duration-500 skew-x-12 pointer-events-none" />
      {isActive ? <Minimize2 size={9} className="shrink-0" /> : <Crosshair size={9} className="shrink-0" />}
      <span className="relative z-10 hidden md:inline">{isActive ? 'EXIT' : 'FOCUS'}</span>
    </button>
  );
}

function PanelShell({ id, focusedPanel, children, className = '' }: { id: FocusedPanel; focusedPanel: FocusedPanel; children: React.ReactNode; className?: string; }) {
  const isFocused = focusedPanel === id;
  const isDimmed = focusedPanel !== null && !isFocused;
  return (
    <div className={`transition-all duration-500 ease-out relative ${isDimmed ? 'opacity-[0.15] blur-[2px] pointer-events-none saturate-0' : 'opacity-100 blur-0 pointer-events-auto saturate-100'} ${isFocused ? 'ring-1 ring-[#FF2800]/20 shadow-[0_0_40px_rgba(255,40,0,0.06)] z-10' : ''} ${className}`}>
      {children}
    </div>
  );
}

function TelemetryStrip() {
  const [tick, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1200); return () => clearInterval(id); }, []);
  const rpm = (6800 + Math.sin(tick * 0.7) * 800).toFixed(0);
  const temp = (92 + Math.sin(tick * 0.3) * 4).toFixed(1);
  const voltage = (396 + Math.sin(tick * 0.5) * 3).toFixed(1);
  return (
    <div className="hidden md:flex items-center gap-6 text-[9px] font-mono tracking-widest text-slate-500 select-none">
      <span className="flex items-center gap-1.5"><span className="text-[#FF2800]">RPM</span> {rpm}</span><span className="w-px h-3 bg-white/10" />
      <span className="flex items-center gap-1.5"><span className="text-[#FF2800]">TEMP</span> {temp}°C</span><span className="w-px h-3 bg-white/10" />
      <span className="flex items-center gap-1.5"><span className="text-[#FF2800]">HV</span> {voltage}V</span><span className="w-px h-3 bg-white/10" />
      <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[#FF2800] animate-pulse shadow-[0_0_6px_#FF2800]" /><span className="text-[#FF2800]">LIVE</span></span>
    </div>
  );
}

function Scanlines() { return <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.025]" style={{ backgroundImage: 'repeating-linear-gradient(to bottom, transparent, transparent 2px, rgba(255,255,255,0.4) 2px, rgba(255,255,255,0.4) 4px)' }} />; }

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APPLICATION - FULL CODE WITH ALL ENHANCEMENTS
// ─────────────────────────────────────────────────────────────────────────────
export default function IndraWorkspace() {
  // Auth State
  const [session, setSession] = useState<Session | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [authMessage, setAuthMessage] = useState<AuthMessage | null>(null);

  // App State
  const [appMode, setAppMode] = useState<"ask" | "quiz">("ask");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState<{ id: number, title: string, tag: string }[]>([]);
  const [focusedPanel, setFocusedPanel] = useState<FocusedPanel>(null);
  const toggleFocus = useCallback((panel: FocusedPanel) => setFocusedPanel(prev => prev === panel ? null : panel), []);

  // Chat State
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [lastMessageTime, setLastMessageTime] = useState(0);

  // 3D State - FULLY ENHANCED
  const [activeModelUrl, setActiveModelUrl] = useState<string | null>(null);
  const [activeModelMetadata, setActiveModelMetadata] = useState<ModelMetadata | null>(null);
  const [activeCadNodes, setActiveCadNodes] = useState<CadNode[]>([]);
  const [modelParts, setModelParts] = useState<string[]>([]);
  const [isolatedParts, setIsolatedParts] = useState<string[]>([]);        // Multi-part support
  const [isolationMode, setIsolationMode] = useState<IsolationMode>('ghost');
  const [highlightSelected, setHighlightSelected] = useState(true);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [modelLoadProgress, setModelLoadProgress] = useState(0);
  const [is3DFullscreen, setIs3DFullscreen] = useState(false);
  const [showModelInfo, setShowModelInfo] = useState(true);
  const [autoRotateEnabled, setAutoRotateEnabled] = useState(true);
  const [showDebug, setShowDebug] = useState(false); // Debug Panel State

  // Quiz State
  const [qIndex, setQIndex] = useState(0);
  const [selectedAns, setSelectedAns] = useState<number | null>(null);
  const [isAnsChecked, setIsAnsChecked] = useState(false);
  const [quizScore, setQuizScore] = useState(0);
  const [quizFinished, setQuizFinished] = useState(false);

  // Refs
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modelViewerRef = useRef<any>(null);
  const originalMaterialsRef = useRef<Map<string, number[]>>(new Map());

  // ── Effects ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isThinking]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocusedPanel(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── ENHANCED 3D ISOLATION LOGIC (Advanced Regex + Fuzzy Match) ──
  const applyIsolation = useCallback(() => {
    const mv = modelViewerRef.current;
    if (!mv?.model?.materials) return;

    const materials = mv.model.materials;
    const targets = isolatedParts.map(p => p.toLowerCase().trim());

    materials.forEach((mat: any) => {
      const matName = (mat.name || '').toLowerCase().trim();
      const original = originalMaterialsRef.current.get(mat.name) || [0.7, 0.7, 0.7, 1.0];

      // Smart matching for CAD naming styles (1_frontbulkhead_mat, etc.)
      const isTarget = targets.length === 0 || targets.some(target => {
        const cleanTarget = target.replace(/[_-\s.0-9]/g, '').toLowerCase(); 
        const cleanMat = matName.replace(/[_-\s.0-9]/g, '').toLowerCase();   
        return matName === target || 
               matName.includes(target) || 
               target.includes(matName) || 
               cleanMat.includes(cleanTarget) || 
               cleanTarget.includes(cleanMat.replace('mat', ''));
      });

      if (!isTarget) {
        // Non-selected parts
        if (isolationMode === 'hidden') {
          mat.pbrMetallicRoughness.setBaseColorFactor([0, 0, 0, 0]);
        } else {
          mat.pbrMetallicRoughness.setBaseColorFactor([0.15, 0.18, 0.25, 0.09]);
          mat.pbrMetallicRoughness.setMetallicFactor(0.8);
          mat.pbrMetallicRoughness.setRoughnessFactor(0.1);
        }
        mat.setAlphaMode('BLEND');
      } else {
        // Selected part(s) - Highlight in INDRA red if enabled
        mat.pbrMetallicRoughness.setBaseColorFactor(
          highlightSelected 
            ? [1.0, 0.25, 0.15, 1.0] 
            : [...original]
        );
        mat.pbrMetallicRoughness.setMetallicFactor(0.3);
        mat.pbrMetallicRoughness.setRoughnessFactor(0.2);
        mat.setAlphaMode('OPAQUE');
      }
    });

    if (typeof mv.queueRender === 'function') mv.queueRender();
  }, [isolatedParts, isolationMode, highlightSelected]);

  useEffect(() => {
    const mv = modelViewerRef.current;
    if (!mv) return;

    const handleModelReady = () => {
    const materials = mv.model?.materials;
    if (materials) {
      const parts: string[] = [];
      materials.forEach((mat: any, index: number) => {
        // FALLBACK: If CAD software stripped the name, assign a temporary one
        const matName = mat.name || `Unnamed_Material_${index}`;
        
        // Force the name onto the material object so our isolation logic can find it later
        mat.name = matName; 
        parts.push(matName);

        if (!originalMaterialsRef.current.has(matName)) {
          // Fallback in case the material doesn't have a standard PBR color
          const color = mat.pbrMetallicRoughness?.baseColorFactor || [0.7, 0.7, 0.7, 1];
          originalMaterialsRef.current.set(matName, [...color]);
        }
      });
      setModelParts(parts);
    }
    applyIsolation();
  };
    mv.addEventListener('load', handleModelReady);
    mv.addEventListener('scene-graph-ready', handleModelReady);

    if (mv.model) handleModelReady();

    return () => {
      mv.removeEventListener('load', handleModelReady);
      mv.removeEventListener('scene-graph-ready', handleModelReady);
    };
  }, [activeModelUrl, applyIsolation]);

  // Reset isolation cache when switching models
  useEffect(() => {
    if (activeModelUrl) {
      originalMaterialsRef.current.clear();
      setIsolatedParts([]);
      setIsolationMode('ghost');
    }
  }, [activeModelUrl]);

  // ── Handlers ──
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); 
    setIsAuthLoading(true); 
    setAuthMessage(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authEmail)) { 
      setAuthMessage({ type: 'error', text: 'Invalid email address' }); 
      setIsAuthLoading(false); 
      return; 
    }
    if (authPassword.length < 6) { 
      setAuthMessage({ type: 'error', text: 'Password must be ≥ 6 characters' }); 
      setIsAuthLoading(false); 
      return; 
    }
    try {
      if (isSignUp) { 
        const { error } = await supabase.auth.signUp({ email: authEmail, password: authPassword }); 
        if (error) throw error; 
        setAuthMessage({ type: 'success', text: 'Access request submitted.' }); 
      } else { 
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword }); 
        if (error) throw error; 
      }
    } catch (err: any) { 
      setAuthMessage({ type: 'error', text: err.message || 'Authentication failed.' }); 
    } finally { 
      setIsAuthLoading(false); 
    }
  };

  const copyToClipboard = useCallback(async (text: string, id: string) => { 
    await navigator.clipboard.writeText(text); 
    setCopied(id); 
    setTimeout(() => setCopied(null), 2000); 
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const sanitized = sanitizeInput(text);
    if (!sanitized || isThinking) return;
    const now = Date.now();
    if (now - lastMessageTime < RATE_LIMIT_DELAY) return;
    setLastMessageTime(now);
    setMessages(p => [...p, { id: crypto.randomUUID(), role: "user", text: sanitized, timestamp: now }]);
    setInput(""); 
    setIsThinking(true);
    setActiveModelUrl(null); 
    setActiveModelMetadata(null); 
    setActiveCadNodes([]); 
    setIsolatedParts([]);
    setModelParts([]);

    try {
      if (!session?.access_token) throw new Error('Authentication token missing.');
      const res = await fetch(`${API_URL}/ask_indra`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ message: sanitized, domain: "Formula Bharat 2027 Full" }),
      });
      if (!res.ok) throw new Error(`Telemetry uplink failure: ${res.status}`);
      const data = await res.json();
      setMessages(p => [...p, { 
        id: crypto.randomUUID(), 
        role: "bot", 
        text: data.answer, 
        citations: data.citations, 
        model_url: data.model_url, 
        model_metadata: data.model_metadata, 
        cad_nodes: data.cad_nodes, 
        timestamp: Date.now() 
      }]);
      if (data.model_url) handle3DModelLoad(data.model_url, data.model_metadata, data.cad_nodes);
    } catch (err: any) { 
      setMessages(p => [...p, { id: crypto.randomUUID(), role: "error", text: err.message, timestamp: Date.now() }]); 
    } finally { 
      setIsThinking(false); 
      inputRef.current?.focus(); 
    }
  }, [isThinking, lastMessageTime, session]);

  const handle3DModelLoad = useCallback((url: string, meta?: ModelMetadata, nodes?: CadNode[]) => {
    originalMaterialsRef.current.clear();
    setActiveModelUrl(url);
    setActiveModelMetadata(meta || null);
    setActiveCadNodes(nodes || []);
    setIsolatedParts([]);
    setIsolationMode('ghost');
    setModelParts([]);
    setIsModelLoading(true);
    setModelLoadProgress(0);
    let prog = 0; 
    const iv = setInterval(() => { 
      prog += 15; 
      setModelLoadProgress(Math.min(prog, 100)); 
      if (prog >= 100) { 
        clearInterval(iv); 
        setIsModelLoading(false); 
      } 
    }, 150);
  }, []);

  const close3DModel = useCallback(() => {
    setActiveModelUrl(null);
    setActiveModelMetadata(null);
    setActiveCadNodes([]);
    setIsolatedParts([]);
    setModelParts([]);
    setIs3DFullscreen(false);
    if (focusedPanel === '3d') setFocusedPanel(null);
  }, [focusedPanel]);

  const togglePartIsolation = (partName: string) => {
    setIsolatedParts(prev => 
      prev.includes(partName) 
        ? prev.filter(p => p !== partName) 
        : [...prev, partName]
    );
  };

  const clearIsolation = () => {
    setIsolatedParts([]);
    setIsolationMode('ghost');
  };

  const downloadModel = useCallback(async () => {
    if (!activeModelUrl) return;
    try { 
      const res = await fetch(activeModelUrl); 
      const blob = await res.blob(); 
      const url = URL.createObjectURL(blob); 
      const a = document.createElement('a'); 
      a.href = url; 
      a.download = activeModelMetadata?.name || 'model.glb'; 
      document.body.appendChild(a); 
      a.click(); 
      URL.revokeObjectURL(url); 
      document.body.removeChild(a); 
    } catch { }
  }, [activeModelUrl, activeModelMetadata]);

  // ENHANCEMENT: Native WebGL Camera Zooming
  const zoomIn = useCallback(() => modelViewerRef.current?.zoom(-1), []);
  const zoomOut = useCallback(() => modelViewerRef.current?.zoom(1), []);
  const reset3DCamera = useCallback(() => modelViewerRef.current?.resetTurntableRotation(), []);

  // ─────────────────────────────────────────────────────────────────────────────
  // LOGIN SCREEN
  // ─────────────────────────────────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-[#060606] overflow-hidden" style={{ fontFamily: "'Rajdhani', 'DIN Next', system-ui, sans-serif" }}>
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(rgba(255,40,0,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,40,0,0.6) 1px, transparent 1px)', backgroundSize: '60px 60px' }} />
        <div className="relative z-10 w-full max-w-[420px] px-4">
          <div className="text-center mb-10">
            <h1 className="text-5xl font-black text-white tracking-tighter">INDRA</h1>
            <p className="text-[#FF2800] text-sm font-bold tracking-[0.25em] mt-1">FORMULA BHARAT 2027</p>
          </div>
          <form onSubmit={handleAuthSubmit} className="space-y-4 bg-[#0c0c0c] border border-white/[0.06] p-8">
            <div>
              <input 
                type="email" 
                required 
                value={authEmail} 
                onChange={e => setAuthEmail(e.target.value)} 
                className="w-full bg-[#111] border border-white/[0.07] px-4 py-3 text-white focus:border-[#FF2800]/40 outline-none" 
                placeholder="Email" 
              />
            </div>
            <div>
              <input 
                type="password" 
                required 
                value={authPassword} 
                onChange={e => setAuthPassword(e.target.value)} 
                className="w-full bg-[#111] border border-white/[0.07] px-4 py-3 text-white focus:border-[#FF2800]/40 outline-none" 
                placeholder="Password" 
              />
            </div>
            {authMessage && (
              <div className={`text-xs font-bold p-3 ${authMessage.type === 'success' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                {authMessage.text}
              </div>
            )}
            <button 
              type="submit" 
              disabled={isAuthLoading} 
              className="w-full py-4 bg-[#FF2800] text-white font-black text-[11px] tracking-[0.3em] uppercase hover:bg-[#FF4000] transition-colors"
            >
              {isAuthLoading ? "AUTHENTICATING..." : isSignUp ? "CREATE ACCOUNT" : "LAUNCH INDRA"}
            </button>
            <div className="text-center">
              <button type="button" onClick={() => setIsSignUp(!isSignUp)} className="text-slate-400 text-xs hover:text-white">
                {isSignUp ? "Already have access? Sign in" : "Request new access"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MAIN WORKSPACE
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-[#060606] text-slate-200 relative select-none" style={{ fontFamily: "'Rajdhani', 'DIN Next', system-ui, sans-serif" }}>
      <Scanlines />
      <div className="absolute inset-0 opacity-[0.025] pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,40,0,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,40,0,0.5) 1px, transparent 1px)', backgroundSize: '80px 80px' }} />
      
      {focusedPanel !== null && <div className="pointer-events-none fixed inset-0 z-[15] bg-black/25 transition-opacity duration-500" />}
      {focusedPanel !== null && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] pointer-events-auto animate-in fade-in slide-in-from-top-2 duration-300">
          <button onClick={() => setFocusedPanel(null)} className="flex items-center gap-2 px-4 py-2 bg-black/95 border border-[#FF2800]/25 text-[9px] font-black tracking-[0.3em] uppercase text-[#FF2800]/80 shadow-2xl">
            <Minimize2 size={9} /> EXIT FOCUS MODE
          </button>
        </div>
      )}

      {/* Mobile Sidebar Overlay */}
      {isSidebarOpen && <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[45] md:hidden" onClick={() => setIsSidebarOpen(false)} />}

      {/* ─── SIDEBAR ─────────────────────────────────────────────────────────── */}
      <PanelShell id="sidebar" focusedPanel={focusedPanel} className={`fixed inset-y-0 left-0 z-50 w-[280px] md:w-[260px] h-full md:relative md:translate-x-0 transition-transform duration-300 ease-out ${isSidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}`}>
        <aside className="flex flex-col h-full bg-[#080808] border-r border-white/[0.05]">
          <div className="px-6 pt-6 pb-5 border-b border-white/[0.05] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Zap size={16} className="text-[#FF2800]" />
              <div className="text-[11px] font-black text-white">INDRA OS</div>
            </div>
            <div className="flex items-center gap-2">
              <FocusButton panel="sidebar" focusedPanel={focusedPanel} onToggle={toggleFocus} />
              <button onClick={() => setIsSidebarOpen(false)} className="md:hidden p-2 text-slate-500">
                <X size={18} />
              </button>
            </div>
          </div>
          <div className="p-4">
            <button 
              onClick={() => { setAppMode("ask"); setMessages([]); setActiveModelUrl(null); setIsolatedParts([]); setIsSidebarOpen(false); }} 
              className="w-full flex items-center gap-2.5 px-4 py-3 bg-[#FF2800]/10 border border-[#FF2800]/20 text-[10px] font-bold text-[#FF2800] uppercase"
            >
              <Plus size={13} /> New Query
            </button>
          </div>
          <div className="px-4 mb-2 flex-1">
            <button 
              onClick={() => { setAppMode("ask"); setIsSidebarOpen(false); }} 
              className="w-full flex items-center gap-3 px-3 py-3 mb-1 text-left text-[#FF2800]"
            >
              <MessageSquare size={13} /> 
              <div className="text-[10px] font-bold uppercase">Regulation Query</div>
            </button>
            <button 
              onClick={() => { setAppMode("quiz"); setIsSidebarOpen(false); }} 
              className="w-full flex items-center gap-3 px-3 py-3 text-left text-slate-500 hover:text-slate-300"
            >
              <BrainCircuit size={13} /> 
              <div className="text-[10px] font-bold uppercase">Compliance Test</div>
            </button>
          </div>
        </aside>
      </PanelShell>

      {/* ─── MAIN FRAME ──────────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col h-full min-w-0 relative z-10">
        <header className="shrink-0 h-12 flex items-center justify-between px-4 md:px-6 border-b border-white/[0.05] bg-black/60 backdrop-blur-md relative z-30">
          <div className="flex items-center gap-3">
            <button onClick={() => setIsSidebarOpen(true)} className="md:hidden p-2 -ml-2 text-slate-500">
              <Menu size={20} />
            </button>
            <div className="flex items-center gap-2 text-[10px] md:text-[9px] font-bold tracking-[0.25em] uppercase">
              <span className="text-slate-700">INDRA</span>
              <ChevronRight size={10} className="text-slate-800" />
              <span className="text-slate-400">{appMode === 'ask' ? 'QUERY ENGINE' : 'COMPLIANCE TEST'}</span>
            </div>
          </div>
          <TelemetryStrip />
        </header>

        {/* REFACTORED FLEX CONTAINER */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
          {/* ── CHAT PANEL ── */}
          <PanelShell id="chat" focusedPanel={focusedPanel} className={`flex flex-col transition-all duration-500 ease-out ${activeModelUrl ? 'flex-1 md:h-full md:w-1/2 border-b md:border-b-0 md:border-r border-white/[0.05]' : 'h-full w-full'}`}>
            {appMode === 'ask' && (
              <>
                <div className="shrink-0 flex items-center justify-between px-4 md:px-6 pt-3 pb-1">
                  <span className="text-[8px] font-bold tracking-[0.3em] text-slate-700 uppercase">Query Engine</span>
                  <FocusButton panel="chat" focusedPanel={focusedPanel} onToggle={toggleFocus} />
                </div>
                
                <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 scroll-smooth">
                  {messages.length === 0 && !isThinking ? (
                    <div className="h-full flex flex-col items-center justify-center max-w-xl mx-auto text-center">
                      <Target size={28} className="text-[#FF2800]/70 mb-4" />
                      <h2 className="text-xl md:text-2xl font-black tracking-tight text-white mb-8 uppercase">Ready for Input</h2>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full">
                        {QUICK_QUERIES.map((q, i) => (
                          <button 
                            key={i} 
                            onClick={() => setInput(q.label)} 
                            className="flex items-center gap-3 px-4 py-3 md:py-4 bg-[#0c0c0c] border border-white/[0.06] hover:border-[#FF2800]/30 text-left"
                          >
                            <span className="text-[#FF2800]/50 shrink-0">{q.icon}</span>
                            <span className="text-[10px] font-bold tracking-wider uppercase text-slate-400">{q.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-3xl mx-auto space-y-6 pb-6">
                      {messages.map(msg => (
                        <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                          <span className={`text-[8px] tracking-[0.3em] uppercase mb-1.5 font-bold ${msg.role === 'user' ? 'text-slate-600' : 'text-[#FF2800]/60'}`}>
                            {msg.role === 'user' ? 'YOU' : 'INDRA'}
                          </span>
                          <div className={`relative p-4 md:p-5 text-sm leading-relaxed ${msg.role === 'user' ? 'bg-white/[0.06] border border-white/[0.08]' : 'bg-[#0c0c0c] border border-white/[0.07] border-l-2 border-l-[#FF2800]/60'}`}>
                            <p className="whitespace-pre-wrap">{msg.text}</p>
                            {msg.model_url && msg.role === 'bot' && (
                              <div className="mt-4 pt-4 border-t border-white/[0.07]">
                                <button 
                                  onClick={() => handle3DModelLoad(msg.model_url!, msg.model_metadata, msg.cad_nodes)} 
                                  className="flex items-center gap-2 px-4 py-3 md:py-2.5 text-[10px] font-black bg-[#FF2800]/10 border border-[#FF2800]/30 text-[#FF2800] uppercase w-full md:w-auto justify-center"
                                >
                                  <Box size={14} /> Load 3D Model
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      {isThinking && <div className="flex items-center gap-3 text-[9px] text-[#FF2800]/60 uppercase"><Loader2 size={12} className="animate-spin" /> Scanning...</div>}
                      <div ref={bottomRef} />
                    </div>
                  )}
                </div>

                <div className="shrink-0 px-4 md:px-6 py-4 pb-[env(safe-area-inset-bottom)] bg-[#060606] border-t border-white/[0.04]">
                  <div className="max-w-3xl mx-auto relative flex flex-row items-center gap-2">
                    <input 
                      ref={inputRef} 
                      value={input} 
                      onChange={e => setInput(e.target.value)} 
                      onKeyDown={e => { if (e.key === 'Enter') sendMessage(input); }} 
                      placeholder="Query regulations..." 
                      disabled={isThinking} 
                      className="flex-1 bg-[#0c0c0c] border border-white/[0.07] focus:border-[#FF2800]/30 px-4 py-4 text-sm text-white placeholder:text-slate-600 focus:outline-none" 
                    />
                    <button 
                      onClick={() => sendMessage(input)} 
                      disabled={isThinking || !input.trim()} 
                      className={`shrink-0 px-6 py-4 flex items-center justify-center gap-2 text-[10px] font-black uppercase transition-all ${input.trim() && !isThinking ? 'bg-[#FF2800] text-white' : 'bg-white/5 text-slate-600'}`}
                    >
                      {isThinking ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* Basic Quiz UI (implemented for completeness) */}
            {appMode === 'quiz' && (
              <div className="flex-1 flex flex-col p-6">
                <div className="flex-1 max-w-2xl mx-auto">
                  {!quizFinished ? (
                    <>
                      <div className="text-[#FF2800] text-xs font-black mb-2">QUESTION {qIndex + 1} / {QUIZ_QUESTIONS.length}</div>
                      <h2 className="text-xl font-bold text-white mb-8">{QUIZ_QUESTIONS[qIndex].question}</h2>
                      <div className="space-y-3">
                        {QUIZ_QUESTIONS[qIndex].options.map((opt, i) => (
                          <button
                            key={i}
                            onClick={() => { setSelectedAns(i); }}
                            className={`w-full text-left p-4 rounded-xl border transition-all ${selectedAns === i ? 'border-[#FF2800] bg-[#FF2800]/10' : 'border-white/10 hover:border-white/30'}`}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={() => {
                          if (selectedAns !== null) {
                            setIsAnsChecked(true);
                            if (selectedAns === QUIZ_QUESTIONS[qIndex].correctAnswer) setQuizScore(s => s + 1);
                          }
                        }}
                        disabled={selectedAns === null}
                        className="mt-8 w-full py-4 bg-[#FF2800] text-white font-black text-sm disabled:opacity-30"
                      >
                        CHECK ANSWER
                      </button>
                    </>
                  ) : (
                    <div className="text-center py-12">
                      <h2 className="text-3xl font-black">Quiz Complete!</h2>
                      <p className="text-6xl font-black text-[#FF2800] my-6">{quizScore}/{QUIZ_QUESTIONS.length}</p>
                      <button onClick={() => { setQIndex(0); setQuizFinished(false); setQuizScore(0); }} className="px-8 py-3 bg-white/10 text-white font-bold">RESTART QUIZ</button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </PanelShell>

          {/* ─── 3D VIEWER PANEL (Enhanced with full isolation UI & Native Zoom) ───────────────── */}
          {activeModelUrl && (
            <PanelShell id="3d" focusedPanel={focusedPanel} className={`${is3DFullscreen ? 'fixed inset-0 z-[60]' : 'flex h-[45vh] md:h-full w-full md:w-1/2'} flex-col bg-[#070707] relative`}>
              {/* Top Controls */}
              <div className="absolute top-3 left-3 right-3 z-30 flex items-center justify-between pointer-events-none">
                <div className="bg-black/80 backdrop-blur px-3 py-1.5 flex items-center gap-2 pointer-events-auto border border-[#FF2800]/20 rounded-lg">
                  <span className="w-1.5 h-1.5 bg-[#FF2800] animate-pulse rounded-full" />
                  <span className="text-[9px] font-black text-[#FF2800] uppercase tracking-wider">Live Render</span>
                </div>
                <div className="flex items-center gap-2 pointer-events-auto">
                  {/* Debug Panel Toggle */}
                  <button onClick={() => setShowDebug(!showDebug)} className={`px-2 py-1.5 text-[9px] font-black uppercase rounded transition-colors ${showDebug ? 'bg-[#FF2800] text-white' : 'bg-black/80 text-slate-400 hover:text-white'}`}>
                    Debug
                  </button>
                  <FocusButton panel="3d" focusedPanel={focusedPanel} onToggle={toggleFocus} />
                  <button onClick={() => setIs3DFullscreen(!is3DFullscreen)} className="p-2.5 bg-black/80 hover:bg-black text-white rounded-lg transition-colors"><Maximize2 size={14} /></button>
                  <button onClick={close3DModel} className="p-2.5 bg-[#FF2800] hover:bg-[#FF2800]/80 text-white rounded-lg transition-colors"><X size={14} /></button>
                </div>
              </div>

              {/* Debug Panel UI */}
              {showDebug && (
                <div className="absolute top-14 right-3 z-40 bg-black/95 border border-[#FF2800]/40 p-4 max-w-xs text-[9px] font-mono text-slate-300 rounded-lg shadow-2xl overflow-y-auto max-h-[40%] pointer-events-auto">
                  <h4 className="text-[#FF2800] mb-2 font-black uppercase tracking-widest border-b border-[#FF2800]/30 pb-1">CAD Node Inspector</h4>
                  <div className="mb-2">
                    <strong className="text-white">Active Targets:</strong> 
                    <span className="text-[#FF2800] ml-1">{isolatedParts.length > 0 ? isolatedParts.join(', ') : 'None (Full Assembly)'}</span>
                  </div>
                  <div><strong className="text-white">Detected Materials in .glb:</strong></div>
                  <ul className="mt-1 space-y-1">
                    {modelParts.map((mat, i) => (
                      <li key={i} className="pl-2 border-l border-slate-700">{mat}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 3D Canvas */}
              <div className="flex-1 w-full h-full cursor-move">
                <model-viewer 
                  ref={modelViewerRef} 
                  src={activeModelUrl} 
                  auto-rotate={autoRotateEnabled ? "true" : "false"} 
                  camera-controls="true" 
                  style={{ width: '100%', height: '100%', backgroundColor: '#080808' }} 
                />
              </div>

              {/* ENHANCED Bottom Controls with Multi-Isolation */}
              {showModelInfo && activeModelMetadata && (
                <div className="absolute bottom-3 left-3 right-3 z-30 bg-black/95 backdrop-blur-md border border-white/[0.08] p-4 rounded-xl shadow-2xl max-h-[55%] overflow-y-auto">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-black text-white">{activeModelMetadata.name}</h3>
                    <button 
                      onClick={clearIsolation} 
                      className="flex items-center gap-1.5 text-xs font-bold text-slate-400 hover:text-white"
                    >
                      <RefreshCw size={14} /> Reset All
                    </button>
                  </div>

                  {(modelParts.length > 0 || activeCadNodes.length > 0) && (
                    <div className="mb-6">
                      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                        <div className="flex items-center gap-2">
                          <Layers size={16} className="text-[#FF2800]" />
                          <span className="uppercase text-[10px] font-black tracking-widest text-white">Isolate Parts</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button 
                            onClick={() => setIsolationMode(m => m === 'ghost' ? 'hidden' : 'ghost')}
                            className={`flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-black rounded-md border tracking-widest uppercase transition-all ${isolationMode === 'hidden' ? 'bg-red-500/10 border-[#FF2800] text-[#FF2800]' : 'border-white/20 text-slate-400'}`}
                          >
                            {isolationMode === 'hidden' ? <><EyeOff size={10} /> OTHERS HIDDEN</> : <><Eye size={10} /> OTHERS GHOSTED</>}
                          </button>
                          <button 
                            onClick={() => setHighlightSelected(!highlightSelected)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-black rounded-md border tracking-widest uppercase transition-all ${highlightSelected ? 'bg-[#FF2800]/10 border-[#FF2800] text-[#FF2800]' : 'border-white/20 text-slate-400'}`}
                          >
                            {highlightSelected ? 'HIGHLIGHT ON' : 'HIGHLIGHT OFF'}
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2 mt-2">
                        <button 
                          onClick={clearIsolation}
                          className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${isolatedParts.length === 0 ? 'bg-[#FF2800] text-white shadow-[0_0_15px_rgba(255,40,0,0.4)]' : 'bg-white/5 hover:bg-white/10 text-slate-400'}`}
                        >
                          FULL ASSEMBLY
                        </button>

                        {(modelParts.length > 0 ? modelParts : activeCadNodes.map(n => n.cad_node_name)).map(partName => {
                          const isActive = isolatedParts.includes(partName);
                          // Clean name generation logic for display
                          const cleanName = partName
                            .replace(/_mat/gi, '')
                            .replace(/^[0-9]+_/, '') // removes prefix like "1_"
                            .replace(/_/g, ' ')
                            .replace(/\b\w/g, l => l.toUpperCase())
                            .trim() || partName;

                          return (
                            <button 
                              key={partName} 
                              onClick={() => togglePartIsolation(partName)}
                              className={`px-4 py-2 text-[10px] font-black uppercase tracking-wider rounded-lg transition-all border
                                ${isActive 
                                  ? 'bg-[#FF2800]/20 border-[#FF2800] text-[#FF2800] shadow-[0_0_10px_rgba(255,40,0,0.2)]' 
                                  : 'bg-white/5 border-transparent hover:border-white/20 text-slate-300'}`}
                            >
                              {cleanName}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ENHANCED Camera Controls with Native WebGL Zooming */}
                  <div className="flex items-center justify-between pt-4 border-t border-white/10">
                    <div className="flex gap-2">
                      <button onClick={() => setAutoRotateEnabled(!autoRotateEnabled)} className={`p-2.5 rounded-lg transition-colors ${autoRotateEnabled ? 'bg-[#FF2800]/20 text-[#FF2800]' : 'bg-white/5 text-slate-400 hover:text-white'}`}><Play size={16} /></button>
                      <button onClick={reset3DCamera} className="p-2.5 bg-white/5 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white transition-colors"><RotateCw size={16} /></button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={zoomOut} className="p-2.5 bg-white/5 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white transition-colors"><ZoomOut size={16} /></button>
                      <button onClick={zoomIn} className="p-2.5 bg-white/5 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white transition-colors"><ZoomIn size={16} /></button>
                    </div>
                    <button onClick={downloadModel} className="flex items-center gap-2 px-5 py-2.5 bg-white/5 hover:bg-white/10 rounded-lg text-[10px] font-black tracking-widest text-slate-300 hover:text-white transition-colors">
                      <Download size={14} /> DOWNLOAD
                    </button>
                  </div>
                </div>
              )}
            </PanelShell>
          )}
        </div>
      </main>
    </div>
  );
}