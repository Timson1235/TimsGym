import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Send, Bot, User, X, Loader2, Dumbbell, ArrowRight, Zap, RefreshCw, FileText, Trash2 } from 'lucide-react';
import { AIChatMessage, WorkoutSession } from '../types';
import { sendAIChatMessage } from '../lib/api';

interface AICoachDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeWorkout: WorkoutSession | null;
  initialPrompt?: string;
}

const CHAT_STORAGE_KEY = 'timsgym_ai_chat_history_v1';

const DEFAULT_DRAWER_WELCOME: AIChatMessage = {
  id: 'm1',
  role: 'assistant',
  content: "Hallo! Ich bin TimsGym AI, dein persönlicher Fitness- & Kraftcoach. Frag mich nach Gewichten, Übungen oder Trainingsplänen!",
  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
};

export const AICoachDrawer: React.FC<AICoachDrawerProps> = ({
  isOpen,
  onClose,
  activeWorkout,
  initialPrompt,
}) => {
  const [messages, setMessages] = useState<AIChatMessage[]>(() => {
    try {
      const saved = localStorage.getItem(CHAT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.error('Failed to parse chat drawer history:', e);
    }
    return [DEFAULT_DRAWER_WELCOME];
  });

  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const handledPromptRef = useRef<string>('');

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
    } catch (e) {
      console.error('Failed to save drawer chat history:', e);
    }
  }, [messages]);

  // Apply initial prompt if passed
  useEffect(() => {
    if (initialPrompt && isOpen && initialPrompt !== handledPromptRef.current) {
      handledPromptRef.current = initialPrompt;
      handleSendMessage(initialPrompt);
    }
  }, [initialPrompt, isOpen]);

  // Scroll to bottom on new message
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSendMessage = async (textToSend?: string) => {
    const text = textToSend || inputMessage;
    if (!text.trim() || isLoading) return;

    const userMsg: AIChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: text.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!textToSend) setInputMessage('');
    setIsLoading(true);

    try {
      const res = await sendAIChatMessage(userMsg.content, activeWorkout);
      const aiMsg: AIChatMessage = {
        id: `ai_${Date.now()}`,
        role: 'assistant',
        content: res.reply || "I analyzed your workout history.",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, aiMsg]);
    } catch (error) {
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSummariseChat = async () => {
    if (messages.length <= 1 || isLoading) return;
    setIsLoading(true);
    try {
      const res = await sendAIChatMessage("Summarise our conversation into 3-4 bullet points of key takeaways and recommendations.", activeWorkout);
      const summaryMsg: AIChatMessage = {
        id: `ai_summary_${Date.now()}`,
        role: 'assistant',
        content: `📋 **Conversation Summary**:\n\n${res.reply || 'Summary complete.'}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages([DEFAULT_DRAWER_WELCOME, summaryMsg]);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearChat = () => {
    setMessages([DEFAULT_DRAWER_WELCOME]);
    try {
      localStorage.removeItem(CHAT_STORAGE_KEY);
    } catch (e) {
      console.error(e);
    }
  };

  if (!isOpen) return null;

  const quickChips = [
    "How much weight did I do last time on Bench Press?",
    "How much weight should I squat today?",
    "Suggest next exercise for my workout",
    "Analyze my progressive overload progress",
    "Create a 4-day workout split",
  ];

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex justify-end">
      <div className="bg-slate-900 border-l border-slate-800 w-full max-w-md h-full flex flex-col shadow-2xl relative">
        
        {/* Header */}
        <div className="p-5 border-b border-slate-800 bg-slate-950 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-2xl bg-lime-400 text-slate-950 flex items-center justify-center font-bold shadow-md shadow-lime-400/20">
              <Sparkles className="h-5 w-5 fill-slate-950 text-slate-950" />
            </div>
            <div>
              <h3 className="font-black text-white text-sm uppercase tracking-wider flex items-center gap-2">
                GymPulse AI Coach
                <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-lime-400/10 text-lime-400 border border-lime-400/20">
                  Gemini
                </span>
              </h3>
              <p className="text-[10px] text-slate-400 font-mono">Realtime database intelligence</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSummariseChat}
              disabled={messages.length <= 1 || isLoading}
              className="p-1.5 rounded-lg bg-slate-800 text-lime-400 hover:bg-slate-700 text-xs font-semibold flex items-center gap-1 transition-colors disabled:opacity-40"
              title="Summarise Chat"
            >
              <FileText className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleClearChat}
              disabled={messages.length <= 1 || isLoading}
              className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-rose-400 hover:bg-slate-700 text-xs font-semibold flex items-center gap-1 transition-colors disabled:opacity-40"
              title="Delete Chat History"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Chat Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-950/50">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex items-start gap-3 ${
                msg.role === 'user' ? 'flex-row-reverse' : ''
              }`}
            >
              <div
                className={`h-8 w-8 rounded-xl flex items-center justify-center shrink-0 ${
                  msg.role === 'user'
                    ? 'bg-slate-800 text-slate-200 border border-slate-700'
                    : 'bg-lime-400/20 text-lime-400 border border-lime-400/30'
                }`}
              >
                {msg.role === 'user' ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
              </div>

              <div
                className={`max-w-[85%] rounded-2xl p-4 text-xs leading-relaxed space-y-1 ${
                  msg.role === 'user'
                    ? 'bg-lime-400 text-slate-950 font-semibold rounded-tr-none'
                    : 'bg-slate-900 border border-slate-800 text-slate-200 rounded-tl-none shadow-md'
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.content}</div>
                <div
                  className={`text-[9px] text-right font-mono ${
                    msg.role === 'user' ? 'text-slate-950/70' : 'text-slate-500'
                  }`}
                >
                  {msg.timestamp}
                </div>
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-xl bg-lime-400/20 text-lime-400 border border-lime-400/30 flex items-center justify-center">
                <Bot className="h-4 w-4 animate-bounce" />
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-2.5 text-xs text-slate-400 flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-lime-400" />
                <span>Checking workout logs & target recommendations...</span>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Quick Chips */}
        <div className="px-4 py-3 bg-slate-950 border-t border-slate-800">
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Suggested Queries:</p>
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            {quickChips.map((chip, idx) => (
              <button
                key={idx}
                onClick={() => handleSendMessage(chip)}
                className="px-3 py-1.5 rounded-full bg-slate-900 hover:bg-slate-800 text-[10px] font-bold uppercase tracking-wider text-slate-300 hover:text-lime-400 border border-slate-800 whitespace-nowrap transition-colors"
              >
                {chip}
              </button>
            ))}
          </div>
        </div>

        {/* Input Bar */}
        <div className="p-4 border-t border-slate-800 bg-slate-950">
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
              placeholder="Ask AI e.g. How much bench last time?"
              className="flex-1 bg-slate-900 border border-slate-800 text-white rounded-2xl px-4 py-3 text-xs focus:outline-none focus:border-lime-400"
            />
            <button
              type="submit"
              disabled={!inputMessage.trim() || isLoading}
              className="p-3 rounded-2xl bg-lime-400 hover:bg-lime-300 text-slate-950 font-black transition-all disabled:opacity-50"
            >
              <Send className="h-4 w-4 stroke-[2.5]" />
            </button>
          </form>
        </div>

      </div>
    </div>
  );
};

