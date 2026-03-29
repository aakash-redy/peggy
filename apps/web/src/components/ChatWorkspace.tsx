"use client";
import { useState, useRef, useEffect } from "react";
import { Send, Sparkles, ShieldCheck, Gauge, Trash2, Copy, Plus, MessageSquare, BrainCircuit, CheckCircle2, XCircle, ChevronRight, LayoutDashboard } from "lucide-react";

// ── Constants & Config ────────────────────────────────────────────────────────
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const API_TOKEN = import.meta.env.VITE_API_AUTH_TOKEN || '';
const RULES_COUNT = "1,362";

interface Citation { rule_id: string; content: string; }
interface Message { id: string; role: "user" | "bot" | "error"; text: string; citations?: Citation[]; timestamp: number; }

// ── Mock Quiz Data (FB2027 Rules) ─────────────────────────────────────────────
const QUIZ_QUESTIONS = [
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

export default function ChatWorkspace() {
  // ── State: Layout & Navigation ──
  const [appMode, setAppMode] = useState<"ask" | "quiz">("ask");
  const [chatHistory, setChatHistory] = useState([
    { id: 1, title: "Brake Pedal Tolerances", date: "Today" },
    { id: 2, title: "TS Accumulator Rules", date: "Yesterday" }
  ]);

  // ── State: Chat ──
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  
  // ── State: Quiz ──
  const [qIndex, setQIndex] = useState(0);
  const [selectedAns, setSelectedAns] = useState<number | null>(null);
  const [isAnsChecked, setIsAnsChecked] = useState(false);
  const [quizScore, setQuizScore] = useState(0);
  const [quizFinished, setQuizFinished] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll chat
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isThinking]);

  // ── Logic: Delete Session ──
  const deleteSession = (idToRemove: number, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevents the session from being "clicked/opened" when hitting the trash can
    setChatHistory(prev => prev.filter(session => session.id !== idToRemove));
  };

  // ── Chat Logic ──
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
      const response = await fetch(`${API_URL}/ask_sora`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_TOKEN}`
        },
        body: JSON.stringify({ message: text.trim(), domain: "Formula Bharat 2027 Full" }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Backend failure");

      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "bot", text: data.answer, citations: data.citations, timestamp: Date.now() }]);
    } catch (error: any) {
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "error", text: `⚠️ ${error.message}`, timestamp: Date.now() }]);
    } finally {
      setIsThinking(false);
      inputRef.current?.focus();
    }
  }

  // ── Quiz Logic ──
  const handleAnswerSubmit = () => {
    if (selectedAns === null) return;
    setIsAnsChecked(true);
    if (selectedAns === QUIZ_QUESTIONS[qIndex].correctAnswer) {
      setQuizScore(prev => prev + 1);
    }
  };

  const nextQuestion = () => {
    if (qIndex < QUIZ_QUESTIONS.length - 1) {
      setQIndex(prev => prev + 1);
      setSelectedAns(null);
      setIsAnsChecked(false);
    } else {
      setQuizFinished(true);
    }
  };

  const resetQuiz = () => {
    setQIndex(0);
    setSelectedAns(null);
    setIsAnsChecked(false);
    setQuizScore(0);
    setQuizFinished(false);
  };

  return (
    <div className="flex h-screen w-full bg-[#050505] text-slate-200 font-sans overflow-hidden relative selection:bg-emerald-500/30">
      
      {/* ── Ambient Background Glows ── */}
      <div className="absolute top-[-20%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-emerald-900/10 blur-[150px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40vw] h-[40vw] rounded-full bg-blue-900/10 blur-[120px] pointer-events-none" />

      {/* ── Sidebar ── */}
      <aside className="w-[280px] h-full flex flex-col border-r border-white/5 bg-white/[0.02] backdrop-blur-xl z-20 shrink-0">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-8">
             <div className="p-2 bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 rounded-lg border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.1)]">
                <Gauge size={22} className="text-emerald-400" />
             </div>
             <div>
               <h1 className="font-bold tracking-tight text-white uppercase text-sm">Hexawatts</h1>
               <p className="text-[10px] text-emerald-500 font-mono">SORA INTELLIGENCE</p>
             </div>
          </div>

          <button 
            onClick={() => { setAppMode("ask"); setMessages([]); }}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all text-sm font-medium text-white group"
          >
            <Plus size={16} className="text-emerald-400 group-hover:rotate-90 transition-transform duration-300" />
            New Research
          </button>
        </div>

        <div className="px-4 space-y-1 mb-6">
          <p className="px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Modes</p>
          <button onClick={() => setAppMode("ask")} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${appMode === 'ask' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>
            <MessageSquare size={16} /> Ask Sora
          </button>
          <button onClick={() => setAppMode("quiz")} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${appMode === 'quiz' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>
            <BrainCircuit size={16} /> FB2027 Quiz Mode
          </button>
        </div>

        {/* ── Chat History with Delete Option ── */}
        <div className="flex-1 overflow-y-auto px-4 mt-2">
           <p className="px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Recent Sessions</p>
           {chatHistory.length === 0 ? (
             <p className="px-3 text-xs text-slate-600 italic">No recent history.</p>
           ) : (
             chatHistory.map(chat => (
               <div 
                 key={chat.id} 
                 className="group relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm text-slate-400 hover:bg-white/5 hover:text-white transition-all cursor-pointer"
               >
                  <span className="truncate pr-6">{chat.title}</span>
                  <button 
                    onClick={(e) => deleteSession(chat.id, e)}
                    className="absolute right-2 p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all"
                    title="Delete session"
                  >
                    <Trash2 size={14} />
                  </button>
               </div>
             ))
           )}
        </div>
      </aside>

      {/* ── Main Workspace ── */}
      <main className="flex-1 flex flex-col h-full relative z-10">
        
        {/* Workspace Header */}
        <header className="h-16 shrink-0 flex items-center justify-between px-8 border-b border-white/5 bg-transparent backdrop-blur-md">
           <div className="flex items-center gap-2 text-sm text-slate-400">
             <LayoutDashboard size={14} />
             <span>/</span>
             <span className="text-white font-medium">{appMode === 'ask' ? 'Rulebook Research' : 'Knowledge Testing'}</span>
           </div>
           <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500 bg-white/5 px-3 py-1.5 rounded-full border border-white/5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
              DB: {RULES_COUNT} NODES ONLINE
           </div>
        </header>

        {/* ── MODE: ASK SORA ── */}
        {appMode === 'ask' && (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-8">
              {messages.length === 0 && !isThinking ? (
                <div className="h-full flex flex-col items-center justify-center text-center max-w-lg mx-auto animate-in fade-in zoom-in duration-500">
                  <ShieldCheck size={56} className="text-emerald-500/50 mb-6" />
                  <h2 className="text-3xl font-light text-white mb-3">What do you need to check?</h2>
                  <p className="text-slate-400 mb-8 text-sm">Ask any question about the FB2027 Chassis, Powertrain, or Braking rules. Sora will find the exact clause.</p>
                </div>
              ) : (
                <div className="max-w-3xl mx-auto space-y-8 pb-10">
                  {messages.map(msg => (
                    <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-2`}>
                      <div className={`
                        max-w-[85%] p-5 rounded-2xl relative group backdrop-blur-md
                        ${msg.role === 'user' ? 'bg-white/10 border border-white/10 text-white rounded-tr-sm' : 'bg-black/40 border border-emerald-500/10 rounded-tl-sm shadow-xl'}
                        ${msg.role === 'error' ? 'bg-red-500/10 border-red-500/30' : ''}
                      `}>
                        <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                        
                        {msg.role === 'bot' && (
                          <button onClick={() => copyToClipboard(msg.text, msg.id)} className="absolute top-3 right-3 p-1.5 rounded-md bg-white/5 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all">
                            <Copy size={12} className={copied === msg.id ? 'text-emerald-400' : 'text-slate-400'} />
                          </button>
                        )}
                      </div>

                      {msg.citations && msg.citations.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {msg.citations.map(c => (
                            <div key={c.rule_id} className="group/cite relative">
                              <span className="px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-[10px] text-emerald-400 font-mono cursor-help">
                                RULE {c.rule_id}
                              </span>
                              <div className="absolute bottom-full left-0 mb-2 w-72 p-4 bg-[#0a0a0a] border border-emerald-500/30 rounded-xl text-[12px] hidden group-hover/cite:block z-50 shadow-2xl">
                                <p className="text-emerald-500 mb-2 font-mono border-b border-emerald-500/20 pb-1">{c.rule_id}</p>
                                <p className="text-slate-300 leading-relaxed">{c.content}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  
                  {isThinking && (
                    <div className="flex items-center gap-3 text-emerald-500/70 italic text-sm font-mono animate-pulse">
                      <Sparkles size={14} /> Scanning rulebook vectors...
                    </div>
                  )}
                  <div ref={bottomRef} />
                </div>
              )}
            </div>

            {/* Input Area */}
            <div className="p-6 shrink-0 relative z-20">
              <div className="max-w-3xl mx-auto relative">
                <input
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
                  placeholder="Query the 2027 technical regulations..."
                  disabled={isThinking}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 pr-16 focus:outline-none focus:border-emerald-500/50 focus:bg-white/10 backdrop-blur-xl transition-all text-sm placeholder:text-slate-500 shadow-2xl"
                />
                
                <button
                  onClick={() => sendMessage(input)}
                  disabled={isThinking || !input.trim()}
                  className={`absolute right-2 top-2 bottom-2 px-4 rounded-xl flex items-center justify-center transition-all duration-300
                    ${input.trim() 
                      ? 'bg-gradient-to-r from-emerald-500 to-green-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)] hover:shadow-[0_0_25px_rgba(16,185,129,0.6)] hover:scale-105' 
                      : 'bg-white/5 text-slate-500 cursor-not-allowed'
                    }
                  `}
                >
                  <Send size={18} className={input.trim() ? 'translate-x-[1px] -translate-y-[1px]' : ''} />
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── MODE: QUIZ MODE ── */}
        {appMode === 'quiz' && (
          <div className="flex-1 overflow-y-auto px-4 py-8 flex flex-col items-center justify-center">
             <div className="max-w-2xl w-full">
                
                {!quizFinished ? (
                  <div className="bg-white/5 border border-white/10 rounded-3xl p-8 backdrop-blur-xl relative overflow-hidden">
                    {/* Progress Bar */}
                    <div className="absolute top-0 left-0 h-1 bg-white/5 w-full">
                       <div 
                         className="h-full bg-gradient-to-r from-emerald-500 to-green-400 transition-all duration-500" 
                         style={{ width: `${((qIndex) / QUIZ_QUESTIONS.length) * 100}%` }} 
                       />
                    </div>

                    <div className="flex justify-between items-center mb-8">
                       <span className="text-emerald-500 font-mono text-xs font-bold tracking-widest bg-emerald-500/10 px-3 py-1 rounded-full">QUESTION {qIndex + 1}/{QUIZ_QUESTIONS.length}</span>
                    </div>
                    
                    <h3 className="text-xl text-white font-medium mb-8 leading-relaxed">
                      {QUIZ_QUESTIONS[qIndex].question}
                    </h3>

                    <div className="space-y-3">
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
                          <button
                            key={idx}
                            onClick={() => !isAnsChecked && setSelectedAns(idx)}
                            disabled={isAnsChecked}
                            className={`w-full text-left p-4 rounded-xl border transition-all flex items-center justify-between ${btnStyle}`}
                          >
                            <span className="text-sm">{opt}</span>
                            {isAnsChecked && idx === QUIZ_QUESTIONS[qIndex].correctAnswer && <CheckCircle2 size={18} />}
                            {isAnsChecked && idx === selectedAns && idx !== QUIZ_QUESTIONS[qIndex].correctAnswer && <XCircle size={18} />}
                          </button>
                        );
                      })}
                    </div>

                    {isAnsChecked && (
                       <div className="mt-8 p-4 bg-black/40 border border-white/10 rounded-xl text-sm text-slate-400 animate-in fade-in slide-in-from-bottom-2">
                         <strong className="text-white block mb-1">Rule Explanation:</strong>
                         {QUIZ_QUESTIONS[qIndex].explanation}
                       </div>
                    )}

                    <div className="mt-8 flex justify-end">
                      {!isAnsChecked ? (
                        <button 
                          onClick={handleAnswerSubmit} 
                          disabled={selectedAns === null}
                          className="px-6 py-3 rounded-xl bg-emerald-500 text-white font-medium disabled:opacity-30 hover:brightness-110 transition-all"
                        >
                          Check Answer
                        </button>
                      ) : (
                        <button 
                          onClick={nextQuestion}
                          className="px-6 py-3 rounded-xl bg-white text-black font-bold flex items-center gap-2 hover:bg-slate-200 transition-all"
                        >
                          {qIndex === QUIZ_QUESTIONS.length - 1 ? 'Finish Quiz' : 'Next Question'} <ChevronRight size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  // Score Screen
                  <div className="text-center animate-in zoom-in duration-500">
                    <div className="inline-flex items-center justify-center w-32 h-32 rounded-full bg-gradient-to-br from-emerald-500/20 to-green-500/5 border border-emerald-500/30 mb-8 shadow-[0_0_50px_rgba(16,185,129,0.2)]">
                      <span className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-b from-white to-emerald-200">
                        {quizScore}/{QUIZ_QUESTIONS.length}
                      </span>
                    </div>
                    <h2 className="text-3xl font-bold text-white mb-3">Inspection Complete</h2>
                    <p className="text-slate-400 mb-8">
                      {quizScore === QUIZ_QUESTIONS.length ? "Perfect compliance. You are ready for Scrutineering." : "Review the rulebook. Some subsystems need work."}
                    </p>
                    <button onClick={resetQuiz} className="px-8 py-3 rounded-xl bg-white text-black font-bold hover:bg-slate-200 transition-all">
                      Retake Quiz
                    </button>
                  </div>
                )}

             </div>
          </div>
        )}
      </main>
    </div>
  );
}