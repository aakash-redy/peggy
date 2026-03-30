"use client";
import { useState, useRef, useEffect } from "react";
import { Send, Sparkles, ShieldCheck, Gauge, Trash2, Copy, Plus, MessageSquare, BrainCircuit, CheckCircle2, XCircle, ChevronRight, LayoutDashboard, Menu, X, LogOut, Lock } from "lucide-react";
import { createClient } from '@supabase/supabase-js';

// ── Constants & Config ────────────────────────────────────────────────────────
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const API_TOKEN = import.meta.env.VITE_API_AUTH_TOKEN || '';
const RULES_COUNT = "1,362";

// Initialize Supabase Client for the Frontend
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

interface Citation { rule_id: string; content: string; }
interface Message { id: string; role: "user" | "bot" | "error"; text: string; citations?: Citation[]; timestamp: number; }

const QUIZ_QUESTIONS = [
  { question: "What is the minimum required force that the brake pedal system must be designed to withstand without failure?", options: ["1000 N", "1500 N", "2000 N", "2500 N"], correctAnswer: 2, explanation: "Rule T6.1.13: The brake pedal and its mounting must be designed to withstand a force of 2000 N without yielding." },
  { question: "Which material is strictly prohibited for use in the primary structure's main roll hoop?", options: ["Carbon Steel", "Aluminum Alloy", "Titanium", "Chromoly"], correctAnswer: 1, explanation: "Rule T3.2.1: Aluminum alloys are not permitted for the Main Roll Hoop or Front Roll Hoop." },
  { question: "What is the required color for the Cockpit Master Switch (Shutdown Button)?", options: ["Red", "Blue with Red outline", "Red with a Yellow background", "Black with a Red outline"], correctAnswer: 2, explanation: "Rule EV4.3.3: All shutdown buttons must be Red, mounted on a Yellow background for high visibility." }
];

export default function ChatWorkspace() {
  // ── State: Authentication ──
  const [session, setSession] = useState<any>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [authMessage, setAuthMessage] = useState<{type: 'error'|'success', text: string} | null>(null);

  // ── State: Layout & Navigation ──
  const [appMode, setAppMode] = useState<"ask" | "quiz">("ask");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState([
    { id: 1, title: "Brake Pedal Tolerances", date: "Today" },
    { id: 2, title: "TS Accumulator Rules", date: "Yesterday" }
  ]);

  // ── State: Chat & Quiz ──
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [qIndex, setQIndex] = useState(0);
  const [selectedAns, setSelectedAns] = useState<number | null>(null);
  const [isAnsChecked, setIsAnsChecked] = useState(false);
  const [quizScore, setQuizScore] = useState(0);
  const [quizFinished, setQuizFinished] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Effect: Check Auth Session ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setSession(session));
    return () => subscription.unsubscribe();
  }, []);

  // Auto-scroll chat
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isThinking]);

  // ── Logic: Authentication ──
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAuthLoading(true);
    setAuthMessage(null);

    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({ email: authEmail, password: authPassword });
        if (error) throw error;
        setAuthMessage({ type: 'success', text: 'Request sent! Tell Aakash to approve your account in the database.' });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
        if (error) throw error;
      }
    } catch (err: any) {
      setAuthMessage({ type: 'error', text: err.message });
    } finally {
      setIsAuthLoading(false);
    }
  };

  // ── Chat Logic ──
  const deleteSession = (idToRemove: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setChatHistory(prev => prev.filter(session => session.id !== idToRemove));
  };

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  async function sendMessage(text: string) {
    if (!text.trim() || isThinking) return;

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", text: text.trim(), timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setIsThinking(true);

    try {
      // Use the session token if logged in, otherwise fallback to the master API token
      const tokenToUse = session?.access_token || API_TOKEN;

      const response = await fetch(`${API_URL}/ask_sora`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenToUse}`
        },
        body: JSON.stringify({ message: text.trim(), domain: "Formula Bharat 2027 Full" }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || "Backend failure");

      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "bot", text: data.answer, citations: data.citations, timestamp: Date.now() }]);
    } catch (error: any) {
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "error", text: `⚠️ ${error.message}`, timestamp: Date.now() }]);
    } finally {
      setIsThinking(false);
      if (window.innerWidth > 768) inputRef.current?.focus();
    }
  }

  // ── Quiz Logic ──
  const handleAnswerSubmit = () => {
    if (selectedAns === null) return;
    setIsAnsChecked(true);
    if (selectedAns === QUIZ_QUESTIONS[qIndex].correctAnswer) setQuizScore(prev => prev + 1);
  };

  const nextQuestion = () => {
    if (qIndex < QUIZ_QUESTIONS.length - 1) {
      setQIndex(prev => prev + 1);
      setSelectedAns(null);
      setIsAnsChecked(false);
    } else setQuizFinished(true);
  };

  const resetQuiz = () => {
    setQIndex(0); setSelectedAns(null); setIsAnsChecked(false); setQuizScore(0); setQuizFinished(false);
  };

  // ============================================================================
  // ── RENDER: LOGIN SCREEN (If not authenticated) ─────────────────────────────
  // ============================================================================
  if (!session) {
    return (
      <div className="flex min-h-screen bg-[#050505] items-center justify-center p-4 relative overflow-hidden font-sans">
        <div className="absolute top-[-20%] left-[-10%] w-[80vw] md:w-[50vw] h-[80vw] md:h-[50vw] rounded-full bg-emerald-900/10 blur-[100px] md:blur-[150px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[60vw] md:w-[40vw] h-[60vw] md:h-[40vw] rounded-full bg-blue-900/10 blur-[100px] md:blur-[120px] pointer-events-none" />
        
        <div className="w-full max-w-md bg-white/5 border border-white/10 rounded-3xl p-8 backdrop-blur-xl relative z-10 shadow-2xl">
          <div className="flex justify-center mb-6">
            <div className="p-4 bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 rounded-2xl border border-emerald-500/20 shadow-[0_0_30px_rgba(16,185,129,0.15)]">
               <Lock size={32} className="text-emerald-400" />
            </div>
          </div>
          <h2 className="text-2xl font-bold text-center text-white tracking-tight mb-2">Hexawatts Racing</h2>
          <p className="text-center text-slate-400 text-sm mb-8">Sora Intelligence Portal</p>

          <form onSubmit={handleAuthSubmit} className="space-y-4">
            <div>
               <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Team Email</label>
               <input type="email" required value={authEmail} onChange={e => setAuthEmail(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500/50 transition-all text-sm" placeholder="driver@hexawatts.com" />
            </div>
            <div>
               <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Password</label>
               <input type="password" required value={authPassword} onChange={e => setAuthPassword(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500/50 transition-all text-sm" placeholder="••••••••" />
            </div>
            
            {authMessage && (
              <div className={`p-3 border rounded-lg text-xs text-center ${authMessage.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'}`}>
                {authMessage.text}
              </div>
            )}

            <button type="submit" disabled={isAuthLoading} className="w-full py-3.5 rounded-xl bg-emerald-500 text-white font-bold text-sm hover:brightness-110 active:scale-95 transition-all disabled:opacity-50 mt-4 shadow-[0_0_15px_rgba(16,185,129,0.3)]">
               {isAuthLoading ? "Authenticating..." : (isSignUp ? "Request Access" : "Secure Login")}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button type="button" onClick={() => { setIsSignUp(!isSignUp); setAuthMessage(null); }} className="text-xs text-slate-400 hover:text-emerald-400 transition-colors">
               {isSignUp ? "Already approved? Sign in here." : "New team member? Request access."}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ============================================================================
  // ── RENDER: MAIN WORKSPACE (If authenticated) ───────────────────────────────
  // ============================================================================
  return (
    <div className="flex h-screen w-full bg-[#050505] text-slate-200 font-sans overflow-hidden relative selection:bg-emerald-500/30">

      {/* ── Ambient Background Glows ── */}
      <div className="absolute top-[-20%] left-[-10%] w-[80vw] md:w-[50vw] h-[80vw] md:h-[50vw] rounded-full bg-emerald-900/10 blur-[100px] md:blur-[150px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[60vw] md:w-[40vw] h-[60vw] md:h-[40vw] rounded-full bg-blue-900/10 blur-[100px] md:blur-[120px] pointer-events-none" />

      {isSidebarOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden transition-opacity" onClick={() => setIsSidebarOpen(false)} />
      )}

      {/* ── Sidebar ── */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-[280px] h-full flex flex-col border-r border-white/5 bg-[#0a0a0a] md:bg-white/[0.02] md:backdrop-blur-xl shrink-0 transition-transform duration-300 ease-in-out md:relative md:translate-x-0 ${isSidebarOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"}`}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
               <div className="p-2 bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 rounded-lg border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.1)]">
                  <Gauge size={22} className="text-emerald-400" />
               </div>
               <div>
                 <h1 className="font-bold tracking-tight text-white uppercase text-sm">Hexawatts</h1>
                 <p className="text-[10px] text-emerald-500 font-mono">SORA INTELLIGENCE</p>
               </div>
            </div>
            <button onClick={() => setIsSidebarOpen(false)} className="md:hidden p-2 text-slate-400 hover:text-white"><X size={20} /></button>
          </div>

          <button onClick={() => { setAppMode("ask"); setMessages([]); setIsSidebarOpen(false); }} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all text-sm font-medium text-white group">
            <Plus size={16} className="text-emerald-400 group-hover:rotate-90 transition-transform duration-300" /> New Research
          </button>
        </div>

        <div className="px-4 space-y-1 mb-6">
          <p className="px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Modes</p>
          <button onClick={() => { setAppMode("ask"); setIsSidebarOpen(false); }} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${appMode === 'ask' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>
            <MessageSquare size={16} /> Ask Sora
          </button>
          <button onClick={() => { setAppMode("quiz"); setIsSidebarOpen(false); }} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${appMode === 'quiz' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>
            <BrainCircuit size={16} /> FB2027 Quiz Mode
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 mt-2">
           <p className="px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Recent Sessions</p>
           {chatHistory.length === 0 ? (
             <p className="px-3 text-xs text-slate-600 italic">No recent history.</p>
           ) : (
             chatHistory.map(chat => (
               <div key={chat.id} className="group relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm text-slate-400 hover:bg-white/5 hover:text-white transition-all cursor-pointer">
                  <span className="truncate pr-6">{chat.title}</span>
                  <button onClick={(e) => deleteSession(chat.id, e)} className="absolute right-2 p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all"><Trash2 size={14} /></button>
               </div>
             ))
           )}
        </div>

        {/* ── Sign Out Button ── */}
        <div className="p-4 border-t border-white/5 mt-auto">
           <p className="px-2 text-[10px] text-slate-500 uppercase tracking-wider mb-2 truncate">Logged in as: {session.user.email}</p>
           <button onClick={() => supabase.auth.signOut()} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 group">
             <LogOut size={16} className="group-hover:-translate-x-1 transition-transform" /> Secure Sign Out
           </button>
        </div>
      </aside>

      {/* ── Main Workspace ── */}
      <main className="flex-1 flex flex-col h-full relative z-10 w-full overflow-hidden">
        <header className="h-14 md:h-16 shrink-0 flex items-center justify-between px-4 md:px-8 border-b border-white/5 bg-transparent backdrop-blur-md">
           <div className="flex items-center gap-3">
             <button onClick={() => setIsSidebarOpen(true)} className="md:hidden p-2 -ml-2 text-slate-400 hover:text-white transition-colors"><Menu size={20} /></button>
             <div className="flex items-center gap-2 text-sm text-slate-400">
               <LayoutDashboard size={14} className="hidden sm:block" />
               <span className="hidden sm:inline">/</span>
               <span className="text-white font-medium truncate max-w-[150px] sm:max-w-none">{appMode === 'ask' ? 'Rulebook Research' : 'Knowledge Testing'}</span>
             </div>
           </div>
           <div className="flex items-center gap-2 md:gap-3 text-[10px] md:text-[11px] font-mono text-slate-500 bg-white/5 px-2 md:px-3 py-1.5 rounded-full border border-white/5">
              <span className="w-1.5 h-1.5 md:w-2 md:h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
              <span className="hidden sm:inline">DB: {RULES_COUNT} NODES ONLINE</span>
              <span className="sm:hidden">ONLINE</span>
           </div>
        </header>

        {appMode === 'ask' && (
          <>
            <div className="flex-1 overflow-y-auto px-4 sm:px-6 md:px-8 py-6 md:py-8 scroll-smooth">
              {messages.length === 0 && !isThinking ? (
                <div className="h-full flex flex-col items-center justify-center text-center max-w-lg mx-auto animate-in fade-in zoom-in duration-500">
                  <ShieldCheck size={48} className="text-emerald-500/50 mb-4 md:mb-6 md:w-14 md:h-14" />
                  <h2 className="text-2xl md:text-3xl font-light text-white mb-2 md:mb-3">What do you need to check?</h2>
                  <p className="text-slate-400 mb-8 text-xs md:text-sm px-4">Ask any question about the FB2027 Chassis, Powertrain, or Braking rules. Sora will find the exact clause.</p>
                </div>
              ) : (
                <div className="max-w-3xl mx-auto space-y-6 md:space-y-8 pb-4 md:pb-10">
                  {messages.map(msg => (
                    <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-2`}>
                      <div className={`
                        max-w-[90%] md:max-w-[85%] p-4 md:p-5 rounded-2xl relative group backdrop-blur-md
                        ${msg.role === 'user' ? 'bg-white/10 border border-white/10 text-white rounded-tr-sm' : 'bg-black/40 border border-emerald-500/10 rounded-tl-sm shadow-xl'}
                        ${msg.role === 'error' ? 'bg-red-500/10 border-red-500/30' : ''}
                      `}>
                        <p className="text-[13px] md:text-[14px] leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                        {msg.role === 'bot' && (
                          <button onClick={() => copyToClipboard(msg.text, msg.id)} className="absolute top-2 right-2 md:top-3 md:right-3 p-1.5 rounded-md bg-white/5 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all">
                            <Copy size={12} className={copied === msg.id ? 'text-emerald-400' : 'text-slate-400'} />
                          </button>
                        )}
                      </div>
                      {msg.citations && msg.citations.length > 0 && (
                        <div className="mt-2 md:mt-3 flex flex-wrap gap-2">
                          {msg.citations.map(c => (
                            <div key={c.rule_id} className="group/cite relative">
                              <span className="px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-[9px] md:text-[10px] text-emerald-400 font-mono cursor-help">RULE {c.rule_id}</span>
                              <div className="absolute bottom-full left-0 mb-2 w-[250px] md:w-72 p-3 md:p-4 bg-[#0a0a0a] border border-emerald-500/30 rounded-xl text-[11px] md:text-[12px] hidden group-hover/cite:block z-50 shadow-2xl">
                                <p className="text-emerald-500 mb-1 md:mb-2 font-mono border-b border-emerald-500/20 pb-1">{c.rule_id}</p>
                                <p className="text-slate-300 leading-relaxed">{c.content}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {isThinking && (
                    <div className="flex items-center gap-3 text-emerald-500/70 italic text-xs md:text-sm font-mono animate-pulse">
                      <Sparkles size={14} /> Scanning rulebook vectors...
                    </div>
                  )}
                  <div ref={bottomRef} />
                </div>
              )}
            </div>

            <div className="p-3 sm:p-4 md:p-6 shrink-0 relative z-20 bg-gradient-to-t from-[#050505] via-[#050505] to-transparent">
              <div className="max-w-3xl mx-auto relative flex items-center">
                <input
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
                  placeholder="Query the 2027 regulations..."
                  disabled={isThinking}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl md:rounded-3xl px-4 md:px-6 py-3 md:py-4 pr-14 md:pr-16 focus:outline-none focus:border-emerald-500/50 focus:bg-white/10 backdrop-blur-xl transition-all text-sm placeholder:text-slate-500 shadow-2xl"
                />
                <button
                  onClick={() => sendMessage(input)}
                  disabled={isThinking || !input.trim()}
                  className={`absolute right-1.5 md:right-2 top-1.5 md:top-2 bottom-1.5 md:bottom-2 px-3 md:px-4 rounded-xl flex items-center justify-center transition-all duration-300 ${input.trim() ? 'bg-gradient-to-r from-emerald-500 to-green-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)] hover:shadow-[0_0_25px_rgba(16,185,129,0.6)] md:hover:scale-105' : 'bg-white/5 text-slate-500 cursor-not-allowed'}`}
                >
                  <Send size={16} className={`md:w-[18px] md:h-[18px] ${input.trim() ? 'translate-x-[1px] -translate-y-[1px]' : ''}`} />
                </button>
              </div>
            </div>
          </>
        )}

        {/* QUIZ MODE UI REMAINS UNCHANGED */}
        {appMode === 'quiz' && (
          <div className="flex-1 overflow-y-auto px-4 py-6 md:py-8 flex flex-col items-center justify-center">
             <div className="max-w-2xl w-full">
                {!quizFinished ? (
                  <div className="bg-white/5 border border-white/10 rounded-2xl md:rounded-3xl p-5 md:p-8 backdrop-blur-xl relative overflow-hidden">
                    <div className="absolute top-0 left-0 h-1 bg-white/5 w-full"><div className="h-full bg-gradient-to-r from-emerald-500 to-green-400 transition-all duration-500" style={{ width: `${((qIndex) / QUIZ_QUESTIONS.length) * 100}%` }} /></div>
                    <div className="flex justify-between items-center mb-6 md:mb-8 mt-2 md:mt-0"><span className="text-emerald-500 font-mono text-[10px] md:text-xs font-bold tracking-widest bg-emerald-500/10 px-2 md:px-3 py-1 rounded-full">QUESTION {qIndex + 1}/{QUIZ_QUESTIONS.length}</span></div>
                    <h3 className="text-lg md:text-xl text-white font-medium mb-6 md:mb-8 leading-relaxed">{QUIZ_QUESTIONS[qIndex].question}</h3>
                    <div className="space-y-2 md:space-y-3">
                      {QUIZ_QUESTIONS[qIndex].options.map((opt, idx) => {
                        let btnStyle = "bg-white/5 border-white/10 hover:bg-white/10 text-slate-300";
                        if (isAnsChecked) {
                           if (idx === QUIZ_QUESTIONS[qIndex].correctAnswer) btnStyle = "bg-emerald-500/20 border-emerald-500 text-emerald-400";
                           else if (idx === selectedAns) btnStyle = "bg-red-500/20 border-red-500 text-red-400";
                           else btnStyle = "bg-white/5 border-white/10 opacity-50";
                        } else if (selectedAns === idx) {
                           btnStyle = "bg-white/10 border-emerald-500/50 text-white shadow-[0_0_15px_rgba(16,185,129,0.2)]";
                        }
                        return (
                          <button key={idx} onClick={() => !isAnsChecked && setSelectedAns(idx)} disabled={isAnsChecked} className={`w-full text-left p-3 md:p-4 rounded-xl border transition-all flex items-center justify-between ${btnStyle}`}>
                            <span className="text-xs md:text-sm">{opt}</span>
                            {isAnsChecked && idx === QUIZ_QUESTIONS[qIndex].correctAnswer && <CheckCircle2 size={16} className="md:w-[18px] md:h-[18px] shrink-0 ml-2" />}
                            {isAnsChecked && idx === selectedAns && idx !== QUIZ_QUESTIONS[qIndex].correctAnswer && <XCircle size={16} className="md:w-[18px] md:h-[18px] shrink-0 ml-2" />}
                          </button>
                        );
                      })}
                    </div>
                    {isAnsChecked && (
                       <div className="mt-6 md:mt-8 p-3 md:p-4 bg-black/40 border border-white/10 rounded-xl text-xs md:text-sm text-slate-400 animate-in fade-in slide-in-from-bottom-2"><strong className="text-white block mb-1">Rule Explanation:</strong>{QUIZ_QUESTIONS[qIndex].explanation}</div>
                    )}
                    <div className="mt-6 md:mt-8 flex justify-end">
                      {!isAnsChecked ? (
                        <button onClick={handleAnswerSubmit} disabled={selectedAns === null} className="w-full md:w-auto px-6 py-3 rounded-xl bg-emerald-500 text-white text-sm font-medium disabled:opacity-30 hover:brightness-110 transition-all">Check Answer</button>
                      ) : (
                        <button onClick={nextQuestion} className="w-full md:w-auto px-6 py-3 rounded-xl bg-white text-black text-sm font-bold flex items-center justify-center gap-2 hover:bg-slate-200 transition-all">{qIndex === QUIZ_QUESTIONS.length - 1 ? 'Finish Quiz' : 'Next Question'} <ChevronRight size={16} /></button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-center animate-in zoom-in duration-500 bg-white/5 border border-white/10 rounded-3xl p-8 md:p-12 backdrop-blur-xl">
                    <div className="inline-flex items-center justify-center w-24 h-24 md:w-32 md:h-32 rounded-full bg-gradient-to-br from-emerald-500/20 to-green-500/5 border border-emerald-500/30 mb-6 md:mb-8 shadow-[0_0_50px_rgba(16,185,129,0.2)]">
                      <span className="text-4xl md:text-5xl font-black text-transparent bg-clip-text bg-gradient-to-b from-white to-emerald-200">{quizScore}/{QUIZ_QUESTIONS.length}</span>
                    </div>
                    <h2 className="text-2xl font-bold text-white mb-2">Quiz Complete</h2>
                    <p className="text-slate-400 text-sm mb-8">{quizScore === QUIZ_QUESTIONS.length ? "Flawless. You know the rulebook inside and out." : "Good effort. Review the citations and try again."}</p>
                    <button onClick={resetQuiz} className="px-8 py-3 rounded-xl bg-emerald-500 text-white font-medium hover:brightness-110 transition-all">Restart Module</button>
                  </div>
                )}
             </div>
          </div>
        )}
      </main>
    </div>
  );
}