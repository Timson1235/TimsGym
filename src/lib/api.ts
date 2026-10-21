import { AIChatMessage, DatabaseState, WorkoutSession, Exercise, UserProfile } from '../types';
import { auth } from './firebase';
import { readChatStream, type ChatStreamEvent } from './chatStream';
import { cacheChatHistory, removeCachedChat, readChatCache } from './chatCache';
import { createGuestDatabase } from '../db/guest';

const guestCacheKey = 'gym_db_cache:guest';

function readGuestDatabase(): DatabaseState {
  const cached = localStorage.getItem(guestCacheKey);
  if (cached) return JSON.parse(cached) as DatabaseState;
  const database = createGuestDatabase();
  localStorage.setItem(guestCacheKey, JSON.stringify(database));
  return database;
}

function writeGuestDatabase(database: DatabaseState): DatabaseState {
  localStorage.setItem(guestCacheKey, JSON.stringify(database));
  return database;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (auth.currentUser) {
    try {
      const token = await auth.currentUser.getIdToken();
      headers['Authorization'] = `Bearer ${token}`;
    } catch (e) {
      console.error('Error getting id token:', e);
    }
  }
  return headers;
}

export async function fetchDatabase(): Promise<DatabaseState> {
  if (!auth.currentUser) return readGuestDatabase();
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/db', { headers });
    if (!res.ok) throw new Error('Failed to fetch database');
    const data = await res.json();
    return data;
  } catch (error) {
    console.warn('API fetch failed, reading fallback local cache:', error);
    const cached = localStorage.getItem(`gym_db_cache:${auth.currentUser?.uid || 'guest'}`);
    if (cached) return JSON.parse(cached);
    throw error;
  }
}

export async function saveWorkoutApi(workout: WorkoutSession): Promise<DatabaseState> {
  if (!auth.currentUser) {
    const database = readGuestDatabase();
    return writeGuestDatabase({ ...database, workouts: [workout, ...database.workouts] });
  }
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/db/workout', {
      method: 'POST',
      headers,
      body: JSON.stringify(workout),
    });
    if (!res.ok) throw new Error('Failed to save workout');
    const data = await res.json();
    localStorage.setItem(`gym_db_cache:${auth.currentUser?.uid || 'guest'}`, JSON.stringify(data.db));
    return data.db;
  } catch (error) {
    console.error('Error saving workout:', error);
    throw error;
  }
}

export async function deleteWorkoutApi(id: string): Promise<DatabaseState> {
  if (!auth.currentUser) {
    const database = readGuestDatabase();
    return writeGuestDatabase({
      ...database,
      workouts: database.workouts.filter((workout) => workout.id !== id),
    });
  }
  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`/api/db/workout/${id}`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok) throw new Error('Failed to delete workout');
    const data = await res.json();
    localStorage.setItem(`gym_db_cache:${auth.currentUser?.uid || 'guest'}`, JSON.stringify(data.db));
    return data.db;
  } catch (error) {
    console.error('Error deleting workout:', error);
    throw error;
  }
}

export async function saveExerciseApi(exercise: Exercise): Promise<DatabaseState> {
  if (!auth.currentUser) {
    const database = readGuestDatabase();
    const exercises = database.exercises.filter((item) => item.id !== exercise.id);
    return writeGuestDatabase({ ...database, exercises: [...exercises, exercise] });
  }
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/db/exercise', {
      method: 'POST',
      headers,
      body: JSON.stringify(exercise),
    });
    if (!res.ok) throw new Error('Failed to save exercise');
    const data = await res.json();
    localStorage.setItem(`gym_db_cache:${auth.currentUser?.uid || 'guest'}`, JSON.stringify(data.db));
    return data.db;
  } catch (error) {
    console.error('Error saving exercise:', error);
    throw error;
  }
}

export async function updateProfileApi(profile: Partial<UserProfile>): Promise<DatabaseState> {
  if (!auth.currentUser) {
    const database = readGuestDatabase();
    return writeGuestDatabase({
      ...database,
      profile: { ...database.profile, ...profile },
    });
  }
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/db/profile', {
      method: 'POST',
      headers,
      body: JSON.stringify(profile),
    });
    if (!res.ok) throw new Error('Failed to update profile');
    const data = await res.json();
    localStorage.setItem(`gym_db_cache:${auth.currentUser?.uid || 'guest'}`, JSON.stringify(data.db));
    return data.db;
  } catch (error) {
    console.error('Error updating profile:', error);
    throw error;
  }
}

export async function addPersonalMemoryApi(currentProfile: UserProfile, newMemory: string): Promise<DatabaseState> {
  const currentMemories = Array.isArray(currentProfile.personalMemories) ? [...currentProfile.personalMemories] : [];
  if (!currentMemories.includes(newMemory.trim())) {
    currentMemories.push(newMemory.trim());
  }
  return updateProfileApi({ personalMemories: currentMemories });
}

export async function removePersonalMemoryApi(currentProfile: UserProfile, memoryToRemove: string): Promise<DatabaseState> {
  const currentMemories = Array.isArray(currentProfile.personalMemories) ? [...currentProfile.personalMemories] : [];
  const updated = currentMemories.filter((m) => m !== memoryToRemove);
  return updateProfileApi({ personalMemories: updated });
}

export async function resetDatabaseApi(): Promise<DatabaseState> {
  if (!auth.currentUser) {
    return writeGuestDatabase(createGuestDatabase());
  }
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/db/reset', {
      method: 'POST',
      headers,
    });
    if (!res.ok) throw new Error('Failed to reset database');
    const data = await res.json();
    localStorage.setItem(`gym_db_cache:${auth.currentUser?.uid || 'guest'}`, JSON.stringify(data.db));
    return data.db;
  } catch (error) {
    console.error('Error resetting database:', error);
    throw error;
  }
}

export async function sendAIChatMessage(message: string, activeWorkoutState?: any, threadId?: string, onEvent?: (event: ChatStreamEvent) => void) {
  const requestStarted = performance.now();
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, activeWorkoutState, threadId, stream: Boolean(onEvent) }),
    });
    if (onEvent && !res.ok) throw new Error(`Coach request failed (HTTP ${res.status})`);
    const payload = res.headers.get('Content-Type')?.includes('text/event-stream') && onEvent
      ? await readChatStream(res, onEvent)
      : await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('AI Chat request failed:', res.status, payload.error);
      return {
        reply: payload.reply || `Der AI-Coach ist momentan nicht erreichbar (HTTP ${res.status}).`,
      };
    }
    if (payload.trace) {
      const roundTripMs = Math.round(performance.now() - requestStarted);
      payload.trace.roundTripMs = roundTripMs;
      if (headers.Authorization && payload.trace.requestId) {
        void fetch('/api/ai/metrics/roundtrip', {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            requestId: payload.trace.requestId,
            roundTripMs,
          }),
        }).catch((error) => console.warn('Failed to store AI roundtrip metric:', error));
      }
    }
    return payload;
  } catch (error: any) {
    console.error('AI Chat Error:', error);
    if (onEvent) throw error;
    return { reply: "Sorry, I couldn't reach the AI Coach right now. Please verify server connection." };
  }
}

export async function fetchAIChatHistory(threadId?: string): Promise<AIChatMessage[]> {
  const headers = await getAuthHeaders();
  const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : '';
  const res = await fetch(`/api/ai/history${query}`, { headers });
  if (!res.ok) throw new Error('Failed to fetch AI chat history');
  const data = await res.json();
  return (data.messages || []).map((message: any) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.createdAt
      ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '',
  }));
}

export async function clearAIChatHistory(threadId?: string): Promise<void> {
  const owner = auth.currentUser?.uid || 'guest';
  const headers = await getAuthHeaders();
  const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : '';
  const res = await fetch(`/api/ai/history${query}`, { method: 'DELETE', headers });
  if (!res.ok) throw new Error('Failed to clear AI chat history');
  if (threadId) cacheChatHistory(owner, threadId, []);
  else {
    // Legacy callers omit the default thread ID: invalidate the account snapshot.
    for (const id of Object.keys(readChatCache(owner).histories)) cacheChatHistory(owner, id, []);
  }
}

export async function fetchAIChatSessions() {
  const headers = await getAuthHeaders();
  const res = await fetch('/api/ai/sessions', { headers });
  if (!res.ok) throw new Error('Failed to fetch AI chat sessions');
  const data = await res.json();
  return data.sessions || [];
}

export async function createAIChatSession(title = 'New chat') {
  const headers = await getAuthHeaders();
  const res = await fetch('/api/ai/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error('Failed to create AI chat session');
  return (await res.json()).session;
}

export async function deleteAIChatSession(threadId: string) {
  const owner = auth.currentUser?.uid || 'guest';
  const headers = await getAuthHeaders();
  const res = await fetch(`/api/ai/sessions/${encodeURIComponent(threadId)}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) throw new Error('Failed to delete AI chat session');
  removeCachedChat(owner, threadId);
}

export async function fetchAIUsageSummary() {
  const headers = await getAuthHeaders();
  const res = await fetch('/api/ai/usage', { headers });
  if (!res.ok) throw new Error('Failed to fetch AI usage summary');
  return await res.json();
}

export async function fetchAISuggestedWeight(exerciseName: string, targetReps = 8, targetRpe = 8) {
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/ai/suggest-weight', {
      method: 'POST',
      headers,
      body: JSON.stringify({ exerciseName, targetReps, targetRpe }),
    });
    if (!res.ok) throw new Error('AI Weight Suggestion failed');
    return await res.json();
  } catch (error: any) {
    console.error('AI Weight Suggestion Error:', error);
    return null;
  }
}
