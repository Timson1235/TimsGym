import React, { useState, useRef, useEffect } from 'react';
import { 
  Sparkles, Send, Bot, User, Loader2, Dumbbell, 
  CheckCircle2, Play, ArrowRight, Zap,
  Trash2, Plus, MessagesSquare
} from 'lucide-react';
import { DatabaseState, WorkoutSession, WorkoutSet, AIChatMessage, AIChatSession, AIUsageSummary } from '../types';
import {
  createAIChatSession,
  deleteAIChatSession,
  fetchAIChatHistory,
  fetchAIChatSessions,
  fetchAIUsageSummary,
  sendAIChatMessage,
} from '../lib/api';
import { ChatMarkdown } from './ChatMarkdown';
import { AITraceDetails } from './AITraceDetails';
import { ConfirmDialog } from './ConfirmDialog';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
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
  const [isSwitchingThread, setIsSwitchingThread] = useState(false);
  const [threadError, setThreadError] = useState('');
  const threadRequest = useRef(0);
  const [lastAction, setLastAction] = useState<any>(null);
  const [proposedWorkout, setProposedWorkout] = useState<WorkoutSession | null>(null);
  const [sessionUsage, setSessionUsage] = useState(EMPTY_AI_USAGE);
  const [accountUsage, setAccountUsage] = useState<AIUsageSummary | null>(null);
  const [chatSessions, setChatSessions] = useState<AIChatSession[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>('');
  const [isDeleteChatDialogOpen, setIsDeleteChatDialogOpen] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const handledPromptRef = useRef<string>('');
  const reduceMotion = useReducedMotion();

  const loadThread = async (threadId: string) => {
    const request = ++threadRequest.current;
    setIsSwitchingThread(true);
    setThreadError('');
    try {
    const history = await fetchAIChatHistory(threadId);
    if (request !== threadRequest.current) return;
    setMessages([DEFAULT_WELCOME_MSG, ...history]);
    setActiveThreadId(threadId);
    localStorage.setItem('active_ai_thread_id', threadId);
    setLastAction(null);
    setProposedWorkout(null);
    setSessionUsage(EMPTY_AI_USAGE);
    } catch {
      if (request === threadRequest.current) setThreadError('Could not load this chat. Please try again.');
    } finally {
      if (request === threadRequest.current) setIsSwitchingThread(false);
    }
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
    if (!text.trim() || isLoading || isSwitchingThread) return;

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
    <div className="font-sans">
      
      {/* Main Grid: Interactive Chat + Quick Commands */}
      <div className="overflow-hidden bg-white/80">

        {/* Left 2-Cols: Pastel Light AI Chat Workspace */}
        <div className="flex h-[calc(100dvh-9rem)] min-h-80 flex-col md:h-[calc(100dvh-4rem)]">
          
          {/* Chat Stream Header - Light Theme */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 bg-white/70 px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-brand-50 border border-brand-200 text-brand-700 flex items-center justify-center font-bold">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">
                  TimsGym Coach
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
                className="max-w-[130px] rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-medium text-slate-700 sm:max-w-[190px]"
                title="Chat wechseln"
              >
                {chatSessions.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}
              </select>
              <button
                onClick={handleNewChat}
                disabled={isLoading}
                className="app-icon-button min-h-9 min-w-9 bg-brand-50 text-brand-800 hover:bg-brand-100 disabled:opacity-40"
                title="Neuer Chat"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>

              <button
                onClick={() => setIsDeleteChatDialogOpen(true)}
                disabled={!activeThreadId || isLoading}
                className="app-icon-button min-h-9 min-w-9 border border-slate-200 bg-white text-slate-600 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                title="Diesen Chat löschen"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Messages Stream Container */}
          {threadError && <p role="alert" className="px-4 py-2 text-sm text-rose-700">{threadError}</p>}
          {isSwitchingThread && <p role="status" className="px-4 py-2 text-sm text-slate-600">Loading chat...</p>}
          <div 
            ref={messagesContainerRef}
            aria-busy={isSwitchingThread}
            className="min-h-0 flex-1 overflow-y-auto bg-slate-50/50 p-4 font-sans"
          >
            <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={activeThreadId || 'new-chat'}
              initial={reduceMotion ? false : { opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 10 }}
              transition={reduceMotion ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.3 }}
              className="mx-auto max-w-4xl space-y-3"
            >
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex gap-2.5 ${
                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                {msg.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-lg bg-brand-50 border border-brand-200 text-brand-700 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Bot className="h-3.5 w-3.5" />
                  </div>
                )}

                <div
                  className={`max-w-[88%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed sm:max-w-[80%] ${
                    msg.role === 'user'
                      ? 'bg-brand-700 text-white font-medium rounded-tr-none shadow-xs'
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
                        <span key={i} className="text-xs font-mono px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700">
                          🔧 {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {msg.role === 'assistant' && msg.usage && (
                    <div className="mt-1 text-xs font-mono text-slate-400">
                      {formatAIUsage(msg.usage)}
                    </div>
                  )}

                  {msg.role === 'assistant' && msg.trace && (
                    <AITraceDetails trace={msg.trace} />
                  )}

                  <span className={`block text-xs font-mono mt-1 text-right ${msg.role === 'user' ? 'text-brand-100' : 'text-slate-400'}`}>
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
            </motion.div>
            </AnimatePresence>

            {isLoading && (
              <div className="flex gap-2.5 justify-start">
                <div className="w-7 h-7 rounded-lg bg-brand-50 border border-brand-200 text-brand-700 flex items-center justify-center flex-shrink-0">
                  <Bot className="h-3.5 w-3.5" />
                </div>
                <div className="flex items-center gap-2 rounded-lg rounded-tl-none border border-slate-200 bg-white px-3.5 py-2 shadow-xs">
                  <Loader2 className="h-3.5 w-3.5 text-brand-600 animate-spin" />
                  <span className="text-xs text-slate-500 font-medium">
                    Thinking through this...
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Workout Proposal Card — user confirms before it actually starts */}
          <AnimatePresence>
          {proposedWorkout && (
            <motion.div
              className="mx-4 mb-1 mt-2 rounded-lg border border-brand-200 bg-brand-50/70 p-3 shadow-sm"
              initial={reduceMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
              transition={reduceMotion ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.3 }}
            >
              <div className="flex items-center gap-1.5 mb-2 text-brand-800">
                <Dumbbell className="h-4 w-4" />
                <span className="text-sm font-semibold">Workout proposal: {proposedWorkout.title}</span>
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
                  className="app-primary flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-semibold shadow-sm"
                >
                  <Play className="h-3.5 w-3.5" /> Workout starten
                </button>
                <button
                  onClick={() => setProposedWorkout(null)}
                  className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Verwerfen
                </button>
              </div>
              <p className="mt-2 text-center text-xs text-slate-500">To change it, just tell me what to adjust.</p>
            </motion.div>
          )}

          </AnimatePresence>

          {/* Action Confirmation Banner (proposals use the card above instead) */}
          {lastAction && lastAction.type !== 'workout_proposed' && (
            <div className="px-4 py-2 bg-brand-50 border-t border-b border-brand-200 flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 text-brand-800 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5 text-brand-600" />
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
                className="text-brand-700 underline font-semibold hover:text-brand-900"
              >
                View
              </button>
            </div>
          )}

          {messages.length <= 1 && (
            <div className="flex flex-wrap gap-2 px-4 py-2">
              {quickActionPrompts.map((cmd) => (
                <button key={cmd.title} disabled={isLoading} onClick={() => setInputMessage(cmd.prompt)} className="rounded-lg px-3 text-sm font-medium text-green-900 hover:bg-green-50">{cmd.title}</button>
              ))}
            </div>
          )}

          {/* Input Prompt Controls */}
          <div className="border-t border-slate-200 bg-white/70 p-3">
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
                placeholder="Ask about training, nutrition, or your next session"
                aria-label="Message the coach"
                className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder-slate-400"
                disabled={isLoading}
              />
              <button
                type="submit"
                aria-label="Send message"
                title="Send message"
                disabled={!inputMessage.trim() || isLoading || isSwitchingThread}
                className="app-icon-button app-primary shadow-sm disabled:opacity-40"
              >
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </form>
          </div>

        </div>



      </div>

      <ConfirmDialog
        isOpen={isDeleteChatDialogOpen}
        title="Delete this chat?"
        description="This removes the conversation and its saved messages. Your training history and personal memory stay intact."
        confirmLabel="Delete chat"
        onConfirm={() => {
          setIsDeleteChatDialogOpen(false);
          handleDeleteChat();
        }}
        onClose={() => setIsDeleteChatDialogOpen(false)}
      />

    </div>
  );
};
