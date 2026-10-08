import React, { useState, useRef, useEffect } from 'react';
import { 
  Sparkles, Send, Bot, User, Loader2, Dumbbell, 
  CheckCircle2, Play, ArrowRight, Zap, RefreshCw, History, LayoutDashboard,
  Trash2, Brain, Plus, X, Target, MessagesSquare
} from 'lucide-react';
import { DatabaseState, WorkoutSession, WorkoutSet, AIChatMessage, AIChatSession, AIUsageSummary } from '../types';
import {
  addPersonalMemoryApi,
  createAIChatSession,
  deleteAIChatSession,
  fetchAIChatHistory,
  fetchAIChatSessions,
  fetchAIUsageSummary,
  removePersonalMemoryApi,
  sendAIChatMessage,
} from '../lib/api';
import { ChatMarkdown } from './ChatMarkdown';
import { AITraceDetails } from './AITraceDetails';
import {
  AIUsageMeter,
  EMPTY_AI_USAGE,
  formatAIUsage,
  mergeAIUsage,
} from './AIUsageMeter';

interface AICoachMainViewProps {
  db: DatabaseState;
  activeWorkout: WorkoutSession | null;
  onUpdateDatabase: (newDb: DatabaseState) => void;
  onStartWorkoutSession: (session: WorkoutSession) => void;
  onSelectTab: (tab: 'ai-coach' | 'active-workout' | 'history' | 'exercises' | 'analytics') => void;
  initialPrompt?: string;
}

const DEFAULT_WELCOME_MSG: AIChatMessage = {
  id: 'welcome_msg',
  role: 'assistant',
  content: `TimsGym AI online. Frag mich nach Gewichten, Workouts oder neuen Übungen.`,
  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
};

function formatSetScheme(sets: WorkoutSet[]): string {
  const groups: Array<{ count: number; set: WorkoutSet }> = [];
  for (const set of sets) {
    const previous = groups[groups.length - 1];
    if (
      previous
      && previous.set.weight === set.weight
      && previous.set.reps === set.reps
      && previous.set.type === set.type
    ) {
      previous.count += 1;
    } else {
      groups.push({ count: 1, set });
    }
  }

  return groups.map(({ count, set }) => {
    const load = set.weight > 0 ? ` @ ${set.weight} kg` : ' Körpergewicht';
    const type = set.type === 'warmup' ? ' (WU)' : '';
    return `${count} × ${set.reps}${load}${type}`;
  }).join(' + ');
}

export const AICoachMainView: React.FC<AICoachMainViewProps> = ({
  db,
  activeWorkout,
  onUpdateDatabase,
  onStartWorkoutSession,
  onSelectTab,
  initialPrompt = '',
}) => {
  const [messages, setMessages] = useState<AIChatMessage[]>([DEFAULT_WELCOME_MSG]);

  const [inputMessage, setInputMessage] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [lastAction, setLastAction] = useState<any>(null);
  const [newMemoryInput, setNewMemoryInput] = useState<string>('');
  const [isSavingMemory, setIsSavingMemory] = useState<boolean>(false);
  const [proposedWorkout, setProposedWorkout] = useState<WorkoutSession | null>(null);
  const [sessionUsage, setSessionUsage] = useState(EMPTY_AI_USAGE);
  const [accountUsage, setAccountUsage] = useState<AIUsageSummary | null>(null);
  const [chatSessions, setChatSessions] = useState<AIChatSession[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>('');
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const handledPromptRef = useRef<string>('');

  const userMemories = Array.isArray(db.profile.personalMemories) ? db.profile.personalMemories : [];

  const handleAddMemory = async (customText?: string) => {
    const memoryText = (customText || newMemoryInput).trim();
    if (!memoryText || isSavingMemory) return;

    setIsSavingMemory(true);
    try {
      const updatedDb = await addPersonalMemoryApi(db.profile, memoryText);
      onUpdateDatabase(updatedDb);
      if (!customText) setNewMemoryInput('');
    } catch (e) {
      console.error('Failed to save memory:', e);
    } finally {
      setIsSavingMemory(false);
    }
  };

  const handleRemoveMemory = async (memoryToRemove: string) => {
    if (isSavingMemory) return;
    setIsSavingMemory(true);
    try {
      const updatedDb = await removePersonalMemoryApi(db.profile, memoryToRemove);
      onUpdateDatabase(updatedDb);
    } catch (e) {
      console.error('Failed to remove memory:', e);
    } finally {
      setIsSavingMemory(false);
    }
  };

  const loadThread = async (threadId: string) => {
    const history = await fetchAIChatHistory(threadId);
    setMessages([DEFAULT_WELCOME_MSG, ...history]);
    setActiveThreadId(threadId);
    localStorage.setItem('active_ai_thread_id', threadId);
    setLastAction(null);
    setProposedWorkout(null);
    setSessionUsage(EMPTY_AI_USAGE);
  };

  const refreshSessions = async () => {
    const sessions = await fetchAIChatSessions();
    setChatSessions(sessions);
    return sessions as AIChatSession[];
  };

  useEffect(() => {
    let cancelled = false;
    fetchAIChatSessions()
      .then(async (sessions: AIChatSession[]) => {
        if (cancelled || sessions.length === 0) return;
        setChatSessions(sessions);
        const saved = localStorage.getItem('active_ai_thread_id');
        const selected = sessions.find((item) => item.id === saved) || sessions[0];
        const history = await fetchAIChatHistory(selected.id);
        if (!cancelled) {
          setActiveThreadId(selected.id);
          setMessages([DEFAULT_WELCOME_MSG, ...history]);
        }
      })
      .catch((error) => console.error('Failed to load chat sessions:', error));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    fetchAIUsageSummary()
      .then(setAccountUsage)
      .catch((error) => console.error('Failed to load account AI usage:', error));
  }, []);

  // Scroll only the chat container internally to prevent page jump on mobile
  const scrollToBottom = () => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    if (messages.length > 1 || isLoading) {
      scrollToBottom();
    }
  }, [messages, isLoading]);

  useEffect(() => {
    if (initialPrompt && initialPrompt !== handledPromptRef.current) {
      handledPromptRef.current = initialPrompt;
      handleSendMessage(initialPrompt);
    }
  }, [initialPrompt]);

  const handleSendMessage = async (textToSend?: string) => {
    const text = textToSend || inputMessage;
    if (!text.trim() || isLoading) return;

    const userMsg: AIChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!textToSend) setInputMessage('');
    setIsLoading(true);

    try {
      const response = await sendAIChatMessage(text, activeWorkout, activeThreadId);

      if (response.usage) {
        setSessionUsage((current) => mergeAIUsage(current, response.usage));
      }

      if (response.db) {
        onUpdateDatabase(response.db);
      }

      if (response.actionExecuted) {
        setLastAction(response.actionExecuted);
        if (response.actionExecuted.type === 'workout_proposed') {
          // Show a proposal card with a confirm button — do NOT auto-start.
          setProposedWorkout(response.actionExecuted.data);
        }
      }

      const assistantMsg: AIChatMessage = {
        id: `msg_${Date.now() + 1}`,
        role: 'assistant',
        content: response.reply || "Done.",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        toolsUsed: response.toolsUsed,
        usage: response.usage,
        trace: response.trace,
      };

      if (response.historyCompacted && activeThreadId) {
        const activeHistory = await fetchAIChatHistory(activeThreadId);
        setMessages([DEFAULT_WELCOME_MSG, ...activeHistory]);
      } else {
        setMessages((prev) => [...prev, assistantMsg]);
      }
      await refreshSessions();
      fetchAIUsageSummary()
        .then(setAccountUsage)
        .catch((error) => console.error('Failed to refresh account AI usage:', error));
    } catch (error) {
      console.error('Failed to communicate with AI Coach:', error);
      const errorMsg: AIChatMessage = {
        id: `msg_err_${Date.now()}`,
        role: 'assistant',
        content: "Der AI-Coach ist gerade nicht erreichbar. Bitte prüfe die Serververbindung und versuche es erneut.",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleNewChat = async () => {
    try {
      const created = await createAIChatSession();
      await refreshSessions();
      await loadThread(created.id);
    } catch (error) {
      console.error('Failed to create chat session:', error);
    }
  };

  const handleDeleteChat = async () => {
    if (!activeThreadId) return;
    try {
      await deleteAIChatSession(activeThreadId);
      let sessions = await refreshSessions();
      if (sessions.length === 0) {
        const created = await createAIChatSession();
        sessions = await refreshSessions();
        await loadThread(created.id);
      } else {
        await loadThread(sessions[0].id);
      }
    } catch (error) {
      console.error('Failed to delete chat session:', error);
    }
  };

  const quickActionPrompts = [
    {
      title: "Log Workout",
      prompt: "Log chest session: Bench Press 80kg 3x10, Incline Press 30kg 3x8.",
    },
    {
      title: "Target Weight",
      prompt: "What weight should I Bench Press today for 8 reps at RPE 8?",
    },
    {
      title: "Start Session",
      prompt: "Start a Push Day workout session with Bench Press and Overhead Press.",
    },
    {
      title: "Add Exercise",
      prompt: "Add exercise 'Cable Woodchoppers' for Core using Cable.",
    },
  ];

  return (
    <div className="space-y-4 font-sans">
      
      {/* Main Grid: Interactive Chat + Quick Commands */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        
        {/* Left 2-Cols: Pastel Light AI Chat Workspace */}
        <div className="lg:col-span-2 bg-white border border-slate-200/80 rounded-2xl flex flex-col h-[580px] sm:h-[620px] overflow-hidden shadow-xs">
          
          {/* Chat Stream Header - Light Theme */}
          <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-teal-50 border border-teal-200 text-teal-700 flex items-center justify-center font-bold">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                  GymPulse AI
                </h3>
                <AIUsageMeter usage={sessionUsage} summary={accountUsage} />
              </div>
            </div>

            <div className="flex items-center gap-1.5 min-w-0">
              <MessagesSquare className="h-3.5 w-3.5 text-slate-400 hidden sm:block" />
              <select
                value={activeThreadId}
                onChange={(event) => loadThread(event.target.value)}
                disabled={isLoading}
                className="max-w-[130px] sm:max-w-[190px] bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-700 focus:outline-none focus:border-teal-600"
                title="Chat wechseln"
              >
                {chatSessions.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}
              </select>
              <button
                onClick={handleNewChat}
                disabled={isLoading}
                className="p-1.5 rounded-lg bg-teal-50 border border-teal-200 hover:bg-teal-100 disabled:opacity-40 text-teal-800 transition-colors"
                title="Neuer Chat"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>

              <button
                onClick={handleDeleteChat}
                disabled={!activeThreadId || isLoading}
                className="p-1.5 rounded-lg bg-white border border-slate-200 hover:bg-rose-50 hover:border-rose-200 hover:text-rose-600 disabled:opacity-40 text-slate-600 transition-colors"
                title="Diesen Chat löschen"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Messages Stream Container */}
          <div 
            ref={messagesContainerRef}
            className="flex-1 overflow-y-auto p-4 space-y-3 font-sans bg-slate-50/30 scroll-smooth"
          >
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-2.5 ${
                  msg.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                {msg.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-lg bg-teal-50 border border-teal-200 text-teal-700 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Bot className="h-3.5 w-3.5" />
                  </div>
                )}

                <div
                  className={`max-w-[88%] sm:max-w-[80%] rounded-xl px-3.5 py-2.5 text-xs sm:text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-teal-700 text-white font-medium rounded-tr-none shadow-xs'
                      : 'bg-white border border-slate-200 text-slate-800 shadow-xs rounded-tl-none'
                  }`}
                >
                  <ChatMarkdown
                    content={msg.content}
                    variant={msg.role === 'user' ? 'user' : 'light'}
                  />

                  {msg.role === 'assistant' && msg.toolsUsed && msg.toolsUsed.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {msg.toolsUsed.map((t, i) => (
                        <span key={i} className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700">
                          🔧 {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {msg.role === 'assistant' && msg.usage && (
                    <div className="mt-1 text-[9px] font-mono text-slate-400">
                      {formatAIUsage(msg.usage)}
                    </div>
                  )}

                  {msg.role === 'assistant' && msg.trace && (
                    <AITraceDetails trace={msg.trace} />
                  )}

                  <span className={`block text-[9px] font-mono mt-1 text-right ${msg.role === 'user' ? 'text-teal-100' : 'text-slate-400'}`}>
                    {msg.timestamp}
                  </span>
                </div>

                {msg.role === 'user' && (
                  <div className="w-7 h-7 rounded-lg bg-slate-200 text-slate-700 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <User className="h-3.5 w-3.5" />
                  </div>
                )}
              </div>
            ))}

            {isLoading && (
              <div className="flex gap-2.5 justify-start">
                <div className="w-7 h-7 rounded-lg bg-teal-50 border border-teal-200 text-teal-700 flex items-center justify-center flex-shrink-0">
                  <Bot className="h-3.5 w-3.5" />
                </div>
                <div className="bg-white border border-slate-200 rounded-xl rounded-tl-none px-3.5 py-2 flex items-center gap-2 shadow-xs">
                  <Loader2 className="h-3.5 w-3.5 text-teal-600 animate-spin" />
                  <span className="text-xs text-slate-500 font-medium">
                    Updating database...
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Workout Proposal Card — user confirms before it actually starts */}
          {proposedWorkout && (
            <div className="mx-4 mb-1 mt-2 rounded-xl border border-teal-300 bg-teal-50/60 p-3 shadow-sm">
              <div className="flex items-center gap-1.5 mb-2 text-teal-800">
                <Dumbbell className="h-4 w-4" />
                <span className="text-xs font-bold uppercase tracking-wider">Vorschlag: {proposedWorkout.title}</span>
              </div>
              <ul className="space-y-1 mb-3">
                {proposedWorkout.exercises.map((ex, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 text-xs text-slate-700 bg-white rounded-lg px-2.5 py-1.5 border border-slate-200">
                    <span className="font-medium">{ex.exerciseName}</span>
                    <span className="text-right text-slate-500 font-mono leading-relaxed">{formatSetScheme(ex.sets)}</span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { onStartWorkoutSession(proposedWorkout); setProposedWorkout(null); }}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold uppercase tracking-wider transition-colors"
                >
                  <Play className="h-3.5 w-3.5" /> Workout starten
                </button>
                <button
                  onClick={() => setProposedWorkout(null)}
                  className="px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-600 hover:bg-slate-100 text-xs font-semibold transition-colors"
                >
                  Verwerfen
                </button>
              </div>
              <p className="text-[10px] text-slate-500 mt-2 text-center">Zum Ändern schreib einfach, was angepasst werden soll.</p>
            </div>
          )}

          {/* Action Confirmation Banner (proposals use the card above instead) */}
          {lastAction && lastAction.type !== 'workout_proposed' && (
            <div className="px-4 py-2 bg-teal-50 border-t border-b border-teal-200 flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 text-teal-800 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5 text-teal-600" />
                <span>
                  Updated: <strong className="capitalize">{lastAction.type.replace('_', ' ')}</strong>
                </span>
              </div>
              <button
                onClick={() => {
                  if (lastAction.type === 'session_started') onSelectTab('active-workout');
                  else if (lastAction.type === 'workout_logged') onSelectTab('history');
                  else if (lastAction.type === 'exercise_added') onSelectTab('exercises');
                }}
                className="text-teal-700 underline font-semibold hover:text-teal-900"
              >
                View
              </button>
            </div>
          )}

          {/* Input Prompt Controls */}
          <div className="p-3 border-t border-slate-200 bg-slate-50">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                placeholder="Type command or question..."
                className="flex-1 bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-teal-600 focus:ring-1 focus:ring-teal-600 transition-colors"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={!inputMessage.trim() || isLoading}
                className="p-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 disabled:opacity-40 text-white font-bold transition-all flex items-center justify-center shadow-xs"
              >
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </form>
          </div>

        </div>

        {/* Right 1-Col: Soft Light Quick Command Cards & AI Memory */}
        <div className="space-y-4">

          {/* AI Persistent Memory & Personal Goals Card */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-4 space-y-3 shadow-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-teal-800">
                <Brain className="h-4 w-4 text-teal-600" />
                <span>KI-Gedächtnis & Ziele</span>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200">
                {userMemories.length} aktiv
              </span>
            </div>

            <p className="text-[11px] text-slate-500 leading-tight">
              TimsGym AI merkt sich deine persönlichen Ziele & Infos für alle Trainingspläne und Empfehlungen.
            </p>

            {/* List of active memories */}
            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {userMemories.length === 0 ? (
                <div className="p-3 text-center bg-slate-50 border border-dashed border-slate-200 rounded-xl text-slate-400 text-xs">
                  Noch keine persönlichen Infos gespeichert.
                </div>
              ) : (
                userMemories.map((mem, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200/70 text-xs text-slate-800 hover:border-slate-300 transition-colors group"
                  >
                    <div className="flex items-start gap-1.5 min-w-0">
                      <Target className="h-3.5 w-3.5 text-teal-600 flex-shrink-0 mt-0.5" />
                      <span className="text-xs font-medium text-slate-800 break-words">{mem}</span>
                    </div>
                    <button
                      onClick={() => handleRemoveMemory(mem)}
                      disabled={isSavingMemory}
                      className="p-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 opacity-80 group-hover:opacity-100 transition-all flex-shrink-0"
                      title="Erinnerung löschen"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Add memory form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleAddMemory();
              }}
              className="flex items-center gap-1.5 pt-1"
            >
              <input
                type="text"
                value={newMemoryInput}
                onChange={(e) => setNewMemoryInput(e.target.value)}
                placeholder="z.B. Sprungkraft für Basketball verbessern..."
                disabled={isSavingMemory}
                className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-teal-600 focus:bg-white transition-colors"
              />
              <button
                type="submit"
                disabled={!newMemoryInput.trim() || isSavingMemory}
                className="p-1.5 rounded-xl bg-teal-700 hover:bg-teal-800 disabled:opacity-40 text-white font-bold transition-all shadow-xs flex items-center justify-center"
                title="Erinnerung speichern"
              >
                {isSavingMemory ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              </button>
            </form>

            {/* Quick Memory Suggestion Chips */}
            <div className="pt-1 flex flex-wrap gap-1.5">
              {[
                "Sprungkraft verbessern",
                "Gewicht verlieren / Fettabbau",
                "Muskelaufbau Fokus",
                "Schultern schonen",
              ].filter(chip => !userMemories.includes(chip)).slice(0, 2).map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => handleAddMemory(chip)}
                  disabled={isSavingMemory}
                  className="text-[10px] font-semibold px-2 py-1 rounded-lg bg-teal-50 text-teal-800 border border-teal-200 hover:bg-teal-100 hover:border-teal-300 transition-colors text-left"
                >
                  + {chip}
                </button>
              ))}
            </div>
          </div>
          
          <div className="bg-white border border-slate-200/80 rounded-2xl p-4 space-y-3 shadow-xs">
            <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-teal-800">
              <Zap className="h-3.5 w-3.5 text-teal-600" />
              <span>Quick Actions</span>
            </div>

            <div className="space-y-2">
              {quickActionPrompts.map((cmd, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(cmd.prompt)}
                  disabled={isLoading}
                  className="w-full text-left p-3 rounded-xl bg-slate-50 border border-slate-200/80 hover:border-teal-300 hover:bg-teal-50/40 text-xs text-slate-700 hover:text-slate-900 transition-all group flex items-center justify-between gap-2"
                >
                  <div>
                    <p className="font-bold text-teal-800 text-xs">{cmd.title}</p>
                    <p className="text-[11px] text-slate-500 truncate max-w-[200px]">{cmd.prompt}</p>
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 text-slate-400 group-hover:text-teal-700 transition-colors flex-shrink-0" />
                </button>
              ))}
            </div>
          </div>

          {/* Quick Navigation Cards */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-4 space-y-2.5 shadow-xs">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Navigation</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onSelectTab('active-workout')}
                className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 hover:border-teal-300 hover:bg-teal-50/50 text-xs font-medium text-slate-700 hover:text-slate-900 transition-colors flex items-center justify-center gap-1.5"
              >
                <Play className="h-3.5 w-3.5 text-teal-600" />
                <span>Workout</span>
              </button>
              <button
                onClick={() => onSelectTab('history')}
                className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 hover:border-teal-300 hover:bg-teal-50/50 text-xs font-medium text-slate-700 hover:text-slate-900 transition-colors flex items-center justify-center gap-1.5"
              >
                <History className="h-3.5 w-3.5 text-teal-600" />
                <span>History</span>
              </button>
              <button
                onClick={() => onSelectTab('exercises')}
                className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 hover:border-teal-300 hover:bg-teal-50/50 text-xs font-medium text-slate-700 hover:text-slate-900 transition-colors flex items-center justify-center gap-1.5"
              >
                <Dumbbell className="h-3.5 w-3.5 text-teal-600" />
                <span>PR Ledger</span>
              </button>
              <button
                onClick={() => onSelectTab('analytics')}
                className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 hover:border-teal-300 hover:bg-teal-50/50 text-xs font-medium text-slate-700 hover:text-slate-900 transition-colors flex items-center justify-center gap-1.5"
              >
                <LayoutDashboard className="h-3.5 w-3.5 text-teal-600" />
                <span>Overview</span>
              </button>
            </div>
          </div>

        </div>

      </div>

    </div>
  );
};
