import type { AIChatMessage, AIChatSession } from '../types';

interface ChatCache {
  version: 1;
  updatedAt: number;
  sessions: AIChatSession[];
  activeThreadId: string;
  histories: Record<string, AIChatMessage[]>;
}

const memory = new Map<string, ChatCache>();
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const key = (owner: string) => `timsgym:chat-cache:v1:${owner}`;
const empty = (): ChatCache => ({ version: 1, updatedAt: Date.now(), sessions: [], activeThreadId: '', histories: {} });

export function readChatCache(owner: string): ChatCache {
  const cached = memory.get(owner);
  if (cached && Date.now() - cached.updatedAt < MAX_AGE) return cached;
  try {
    const raw = localStorage.getItem(key(owner));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.version === 1 && Number.isFinite(parsed.updatedAt)
      && Date.now() - parsed.updatedAt < MAX_AGE
      && typeof parsed.activeThreadId === 'string'
      && Array.isArray(parsed.sessions) && parsed.sessions.every((s: AIChatSession) => typeof s?.id === 'string' && typeof s.title === 'string')
      && parsed.histories && typeof parsed.histories === 'object' && !Array.isArray(parsed.histories)
      && Object.values(parsed.histories).every((history) => Array.isArray(history) && history.every((m) =>
        typeof m?.id === 'string' && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role)))) {
      memory.set(owner, parsed);
      return parsed;
    }
  } catch { /* Browser storage is optional; in-memory caching still works. */ }
  const fresh = empty();
  memory.set(owner, fresh);
  return fresh;
}

function update(owner: string, apply: (cache: ChatCache) => ChatCache) {
  const next = { ...apply(readChatCache(owner)), updatedAt: Date.now() };
  memory.set(owner, next);
  try { localStorage.setItem(key(owner), JSON.stringify(next)); } catch { /* Storage can be full or disabled. */ }
}

export function cacheChatSessions(owner: string, sessions: AIChatSession[]) {
  update(owner, (cache) => {
    const ids = new Set(sessions.map((s) => s.id));
    return {
      ...cache, sessions,
      activeThreadId: ids.has(cache.activeThreadId) ? cache.activeThreadId : '',
      histories: Object.fromEntries(Object.entries(cache.histories).filter(([id]) => ids.has(id))),
    };
  });
}

export function selectCachedChat(owner: string, threadId: string) {
  update(owner, (cache) => ({ ...cache, activeThreadId: threadId }));
}

export function cacheChatHistory(owner: string, threadId: string, messages: AIChatMessage[]) {
  update(owner, (cache) => ({
    ...cache,
    // Bound browser storage, retaining the most recently visited 20 chats.
    histories: Object.fromEntries([
      ...Object.entries(cache.histories).filter(([id]) => id !== threadId).slice(-19),
      [threadId, messages.filter((m) => m.id !== 'welcome_msg').slice(-200)],
    ]),
  }));
}

export function removeCachedChat(owner: string, threadId: string) {
  update(owner, (cache) => ({
    ...cache,
    sessions: cache.sessions.filter((s) => s.id !== threadId),
    activeThreadId: cache.activeThreadId === threadId ? '' : cache.activeThreadId,
    histories: Object.fromEntries(Object.entries(cache.histories).filter(([id]) => id !== threadId)),
  }));
}
