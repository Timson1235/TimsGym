import React, { useState, useRef, useEffect } from 'react';
import { 
  Sparkles, Send, Bot, User, Loader2,
  CheckCircle2, Play, ArrowRight, Zap,
  Trash2, Plus, MessagesSquare
} from 'lucide-react';
import { DatabaseState, WorkoutSession, AIChatMessage, AIChatSession, AIUsageSummary } from '../types';
import {
  createAIChatSession,
  deleteAIChatSession,
  fetchAIChatHistory,
  fetchAIChatSessions,
  fetchAIUsageSummary,
  sendAIChatMessage,
} from '../lib/api';
import { auth } from '../lib/firebase';
import { readChatCache, cacheChatSessions, cacheChatHistory, selectCachedChat, removeCachedChat } from '../lib/chatCache';
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
  onUpdateActiveWorkout: (workout: WorkoutSession) => void;
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

function attachWorkoutProposal(messages: AIChatMessage[], workout: WorkoutSession | null): AIChatMessage[] {
  if (!workout) return messages;
  const lastAssistantIndex = messages.reduce(
    (lastIndex, message, index) => message.role === 'assistant' ? index : lastIndex,
    -1,
  );
  if (lastAssistantIndex < 0) return messages;

  return messages.map((message, index) => index === lastAssistantIndex
    ? { ...message, suggestedAction: { type: 'workout_proposed' as const, workout } }
    : message);
}

export const AICoachMainView: React.FC<AICoachMainViewProps> = ({
  db,
  activeWorkout,
  onUpdateDatabase,
  onUpdateActiveWorkout,
  onStartWorkoutSession,
  onSelectTab,
  initialPrompt = '',
}) => {
  const cacheOwner = auth.currentUser?.uid || 'guest';
  const [initialCache] = useState(() => readChatCache(cacheOwner));
  const initialThread = initialCache.activeThreadId || initialCache.sessions[0]?.id || '';
  const [messages, setMessages] = useState<AIChatMessage[]>(() =>
    [DEFAULT_WELCOME_MSG, ...(initialCache.histories[initialThread] || [])]);

  const [inputMessage, setInputMessage] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamStatus, setStreamStatus] = useState('Thinking through your request…');
  const [isSwitchingThread, setIsSwitchingThread] = useState(false);
  const [threadError, setThreadError] = useState('');
  const threadRequest = useRef(0);
  const [lastAction, setLastAction] = useState<any>(null);
  const [sessionUsage, setSessionUsage] = useState(EMPTY_AI_USAGE);
  const [accountUsage, setAccountUsage] = useState<AIUsageSummary | null>(null);
  const [chatSessions, setChatSessions] = useState<AIChatSession[]>(initialCache.sessions);
  const [activeThreadId, setActiveThreadId] = useState<string>(initialThread);
  const loadedThread = useRef(initialCache.histories[initialThread] !== undefined ? initialThread : '');
  const sessionsRequest = useRef(0);
  const [isDeleteChatDialogOpen, setIsDeleteChatDialogOpen] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const handledPromptRef = useRef<string>('');
  const reduceMotion = useReducedMotion();

  const decorateHistory = (history: AIChatMessage[], threadId: string) => {
    let savedProposal: WorkoutSession | null = null;
    try {
      const saved = localStorage.getItem(`timsgym:proposal:${cacheOwner}:${threadId}`);
      savedProposal = saved ? JSON.parse(saved) as WorkoutSession : null;
    } catch { /* Proposal storage is optional. */ }
    return [DEFAULT_WELCOME_MSG, ...attachWorkoutProposal(history, savedProposal)];
  };

  const loadThread = async (threadId: string) => {
    const request = ++threadRequest.current;
    const cached = readChatCache(cacheOwner).histories[threadId];
    loadedThread.current = cached !== undefined ? threadId : '';
    setActiveThreadId(threadId);
    selectCachedChat(cacheOwner, threadId);
    setMessages(decorateHistory(cached || [], threadId));
    setIsSwitchingThread(cached === undefined);
    setThreadError('');
    setLastAction(null);
    setSessionUsage(EMPTY_AI_USAGE);
    try {
      const history = await fetchAIChatHistory(threadId);
      if (request !== threadRequest.current) return;
      loadedThread.current = threadId;
      const decorated = decorateHistory(history, threadId);
      cacheChatHistory(cacheOwner, threadId, decorated);
      setMessages(decorated);
    } catch {
      if (request === threadRequest.current) {
        setThreadError(cached !== undefined
          ? 'Showing saved messages. Could not refresh this chat.'
          : 'Could not load this chat. Please try again.');
      }
    } finally {
      if (request === threadRequest.current) setIsSwitchingThread(false);
    }
  };

  const dismissProposal = () => {
    setMessages((current) => current.map((message) => ({
      ...message,
      suggestedAction: message.suggestedAction?.type === 'workout_proposed'
        ? undefined
        : message.suggestedAction,
    })));
    try {
      localStorage.removeItem(`timsgym:proposal:${auth.currentUser?.uid || 'guest'}:${activeThreadId}`);
    } catch { /* Storage may be unavailable. */ }
  };

  const refreshSessions = async () => {
    const request = ++sessionsRequest.current;
    const sessions = await fetchAIChatSessions() as AIChatSession[];
    if (request === sessionsRequest.current) {
      cacheChatSessions(cacheOwner, sessions);
      setChatSessions(sessions);
    }
    return sessions;
  };

  useEffect(() => {
    let cancelled = false;
    // Revalidate the selected cached history concurrently with the chat list.
    if (initialThread) void loadThread(initialThread);
    const initialHistoryRequest = threadRequest.current;
    void refreshSessions().then((sessions) => {
      if (cancelled || threadRequest.current !== initialHistoryRequest) return;
      if (sessions.length === 0) {
        ++threadRequest.current;
        loadedThread.current = '';
        setActiveThreadId('');
        setMessages([DEFAULT_WELCOME_MSG]);
        setIsSwitchingThread(false);
        return;
      }
      const selected = sessions.find((item) => item.id === initialThread) || sessions[0];
      if (!initialThread || selected.id !== initialThread) void loadThread(selected.id);
    }).catch(() => {
      if (!cancelled && threadRequest.current === initialHistoryRequest) {
        setThreadError('Could not refresh chats. Saved conversations remain available.');
      }
    });
    return () => {
      cancelled = true;
      ++threadRequest.current;
      ++sessionsRequest.current;
    };
  }, []);

  // Persist visible replies and proposal dismissals, but not an unfinished send.
  useEffect(() => {
    if (activeThreadId && loadedThread.current === activeThreadId && !isLoading && !isSwitchingThread) {
      cacheChatHistory(cacheOwner, activeThreadId, messages);
    }
  }, [messages, activeThreadId, isLoading, isSwitchingThread, cacheOwner]);

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
  }, [messages, isLoading, streamingText]);

  useEffect(() => {
    if (initialPrompt && activeThreadId && !isSwitchingThread && initialPrompt !== handledPromptRef.current) {
      handledPromptRef.current = initialPrompt;
      handleSendMessage(initialPrompt);
    }
  }, [initialPrompt, activeThreadId, isSwitchingThread]);

  const handleSendMessage = async (textToSend?: string) => {
    const text = textToSend || inputMessage;
    if (!text.trim() || isLoading || isSwitchingThread || !activeThreadId) return;
    // A background history response must never overwrite a new message.
    const request = ++threadRequest.current;
    setThreadError('');

    const userMsg: AIChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!textToSend) setInputMessage('');
    setIsLoading(true);
    setStreamingText('');
    setStreamStatus('Connecting to the coach…');

    try {
      const response = await sendAIChatMessage(text, activeWorkout, activeThreadId, (event) => {
        if (request !== threadRequest.current) return;
        if (event.type === 'delta') {
          setStreamingText((current) => current + event.text);
          setStreamStatus('Writing your answer…');
        } else if (event.type === 'reset') setStreamingText('');
        else if (event.type === 'status') setStreamStatus(event.message);
      });
      if (request !== threadRequest.current) return;

      if (response.usage) {
        setSessionUsage((current) => mergeAIUsage(current, response.usage));
      }

      if (response.db) {
        onUpdateDatabase(response.db);
      }

      if (response.activeWorkoutState) {
        onUpdateActiveWorkout(response.activeWorkoutState);
      }

      const actions = response.actionsExecuted || (response.actionExecuted ? [response.actionExecuted] : []);
      const workoutProposal = actions.find((action: any) => action.type === 'workout_proposed');

      for (const action of actions) {
        setLastAction(action);
        if (action.type === 'workout_proposed') {
          // Show a proposal card with a confirm button — do NOT auto-start.
          try {
            localStorage.setItem(`timsgym:proposal:${auth.currentUser?.uid || 'guest'}:${activeThreadId}`, JSON.stringify(action.data));
          } catch { /* The current card remains usable when browser storage is full. */ }
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
        suggestedAction: workoutProposal
          ? { type: 'workout_proposed', workout: workoutProposal.data }
          : undefined,
      };

      if (response.historyCompacted && activeThreadId) {
        const activeHistory = await fetchAIChatHistory(activeThreadId);
        if (request !== threadRequest.current) return;
        setMessages(decorateHistory(activeHistory, activeThreadId));
      } else {
        setMessages((prev) => [...prev, assistantMsg]);
      }
      void refreshSessions().catch(() => setThreadError('Reply saved. Could not refresh the chat list.'));
      fetchAIUsageSummary()
        .then(setAccountUsage)
        .catch((error) => console.error('Failed to refresh account AI usage:', error));
    } catch (error) {
      if (request !== threadRequest.current) return;
      console.error('Failed to communicate with AI Coach:', error);
      const errorMsg: AIChatMessage = {
        id: `msg_err_${Date.now()}`,
        role: 'assistant',
        content: "Die Verbindung zum Coach wurde unterbrochen. Änderungen könnten bereits gespeichert sein. Lade den Chat neu und prüfe dein Workout, bevor du die Anfrage wiederholst.",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      if (request === threadRequest.current) {
        setIsLoading(false);
        setStreamingText('');
      }
    }
  };

  const handleNewChat = async () => {
    ++threadRequest.current;
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
      ++threadRequest.current;
      await deleteAIChatSession(activeThreadId);
      removeCachedChat(cacheOwner, activeThreadId);
      setActiveThreadId('');
      setMessages([DEFAULT_WELCOME_MSG]);
      try { localStorage.removeItem(`timsgym:proposal:${cacheOwner}:${activeThreadId}`); } catch { /* Optional storage. */ }
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
        <div className="flex h-[calc(100dvh-9rem)] min-h-80 flex-col overflow-hidden md:h-[calc(100dvh-4rem)]">
          
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

                  {msg.role === 'assistant'
                    && msg.suggestedAction?.type === 'workout_proposed'
                    && msg.suggestedAction.workout && (
                    <button
                      onClick={() => {
                        const workout = msg.suggestedAction?.workout;
                        if (!workout) return;
                        dismissProposal();
                        onStartWorkoutSession(workout);
                      }}
                      className="app-primary mt-3 flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold shadow-sm"
                    >
                      <Play className="h-3.5 w-3.5" /> Workout starten
                    </button>
                  )}

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

            {isLoading && streamingText && (
              <div className="flex gap-2.5 justify-start" aria-live="polite">
                <div className="w-7 h-7 rounded-lg bg-brand-50 border border-brand-200 text-brand-700 flex items-center justify-center flex-shrink-0">
                  <Bot className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 max-w-[90%] rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm leading-relaxed">
                  <ChatMarkdown content={streamingText} />
                </div>
              </div>
            )}
            {isLoading && (
              <div className="flex gap-2.5 justify-start">
                <div className="w-7 h-7 rounded-lg bg-brand-50 border border-brand-200 text-brand-700 flex items-center justify-center flex-shrink-0">
                  <Bot className="h-3.5 w-3.5" />
                </div>
                <div className="flex items-center gap-2 rounded-lg rounded-tl-none border border-slate-200 bg-white px-3.5 py-2 shadow-xs">
                  <Loader2 className="h-3.5 w-3.5 text-brand-600 animate-spin" />
                  <span className="text-xs text-slate-500 font-medium">
                    {streamStatus}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Action Confirmation Banner for non-workout actions */}
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
                disabled={!inputMessage.trim() || !activeThreadId || isLoading || isSwitchingThread}
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
