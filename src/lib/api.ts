import { DatabaseState, WorkoutSession, Exercise, UserProfile } from '../types';
import { auth } from './firebase';

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
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/db', { headers });
    if (!res.ok) throw new Error('Failed to fetch database');
    const data = await res.json();
    return data;
  } catch (error) {
    console.warn('API fetch failed, reading fallback local cache:', error);
    const cached = localStorage.getItem('gym_db_cache');
    if (cached) return JSON.parse(cached);
    throw error;
  }
}

export async function saveWorkoutApi(workout: WorkoutSession): Promise<DatabaseState> {
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/db/workout', {
      method: 'POST',
      headers,
      body: JSON.stringify(workout),
    });
    if (!res.ok) throw new Error('Failed to save workout');
    const data = await res.json();
    localStorage.setItem('gym_db_cache', JSON.stringify(data.db));
    return data.db;
  } catch (error) {
    console.error('Error saving workout:', error);
    throw error;
  }
}

export async function deleteWorkoutApi(id: string): Promise<DatabaseState> {
  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`/api/db/workout/${id}`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok) throw new Error('Failed to delete workout');
    const data = await res.json();
    localStorage.setItem('gym_db_cache', JSON.stringify(data.db));
    return data.db;
  } catch (error) {
    console.error('Error deleting workout:', error);
    throw error;
  }
}

export async function saveExerciseApi(exercise: Exercise): Promise<DatabaseState> {
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/db/exercise', {
      method: 'POST',
      headers,
      body: JSON.stringify(exercise),
    });
    if (!res.ok) throw new Error('Failed to save exercise');
    const data = await res.json();
    localStorage.setItem('gym_db_cache', JSON.stringify(data.db));
    return data.db;
  } catch (error) {
    console.error('Error saving exercise:', error);
    throw error;
  }
}

export async function updateProfileApi(profile: Partial<UserProfile>): Promise<DatabaseState> {
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/db/profile', {
      method: 'POST',
      headers,
      body: JSON.stringify(profile),
    });
    if (!res.ok) throw new Error('Failed to update profile');
    const data = await res.json();
    localStorage.setItem('gym_db_cache', JSON.stringify(data.db));
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
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/db/reset', {
      method: 'POST',
      headers,
    });
    if (!res.ok) throw new Error('Failed to reset database');
    const data = await res.json();
    localStorage.setItem('gym_db_cache', JSON.stringify(data.db));
    return data.db;
  } catch (error) {
    console.error('Error resetting database:', error);
    throw error;
  }
}

export async function sendAIChatMessage(message: string, activeWorkoutState?: any) {
  try {
    const headers = await getAuthHeaders();
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, activeWorkoutState }),
    });
    if (!res.ok) throw new Error('AI Chat request failed');
    return await res.json();
  } catch (error: any) {
    console.error('AI Chat Error:', error);
    return { reply: "Sorry, I couldn't reach the AI Coach right now. Please verify server connection." };
  }
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
