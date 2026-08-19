// Benchmark with the REAL app payload: big system instruction + the 7 tools.
// This reproduces what /api/ai/chat actually sends on every message.
import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const systemInstruction = `You are GymPulse AI, a concise fitness assistant with direct read/write access to Tim's database.
RESPONSE STYLE: EXTREMELY MINIMALIST AND DIRECT. Give facts, numbers, or action confirmations immediately.
=== USER DATABASE CONTEXT ===
Profile: Tim, Goal: Hypertrophy, Level: Intermediate.
Exercises: Bench Press [PR 85x5], Squat [PR 100x5], RDL [PR 85x8], Lat Pulldown [PR 68x10], OHP [PR 52x6].
Recent workouts: Push Day (bench 60x8x3), Pull Day (rows 70x10). Active session: none.`;

const tools = [{ functionDeclarations: [
  { name: 'save_personal_memory', description: 'Save a personal goal/constraint.', parameters: { type: Type.OBJECT, properties: { memory: { type: Type.STRING } }, required: ['memory'] } },
  { name: 'remove_personal_memory', description: 'Remove a memory.', parameters: { type: Type.OBJECT, properties: { memoryTextOrIndex: { type: Type.STRING } }, required: ['memoryTextOrIndex'] } },
  { name: 'log_workout', description: 'Log a completed workout.', parameters: { type: Type.OBJECT, properties: {
      title: { type: Type.STRING }, date: { type: Type.STRING }, durationMinutes: { type: Type.NUMBER }, notes: { type: Type.STRING },
      exercises: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
        exerciseName: { type: Type.STRING }, category: { type: Type.STRING },
        sets: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
          weight: { type: Type.NUMBER }, reps: { type: Type.NUMBER }, rpe: { type: Type.NUMBER }, type: { type: Type.STRING } }, required: ['weight','reps'] } } },
        required: ['exerciseName','sets'] } } }, required: ['title','exercises'] } },
  { name: 'add_exercise', description: 'Add an exercise.', parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, category: { type: Type.STRING }, equipment: { type: Type.STRING }, instructions: { type: Type.STRING } }, required: ['name','category','equipment'] } },
  { name: 'update_profile', description: 'Update profile.', parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, primaryGoal: { type: Type.STRING }, experienceLevel: { type: Type.STRING } } } },
  { name: 'delete_workout', description: 'Delete a workout by id or title.', parameters: { type: Type.OBJECT, properties: { searchOrId: { type: Type.STRING } }, required: ['searchOrId'] } },
  { name: 'start_workout_session', description: 'Start a session.', parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING }, exerciseNames: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ['title','exerciseNames'] } },
] }];

async function run(label, model, extraConfig) {
  const t0 = Date.now();
  try {
    const r = await ai.models.generateContent({ model, contents: 'hey', config: { systemInstruction, temperature: 0.2, tools, ...extraConfig } });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const u = r.usageMetadata || {};
    console.log(`${label}\n  ${secs}s  |  thinking tokens: ${u.thoughtsTokenCount ?? 0}  |  reply: "${(r.text||'').replace(/\n/g,' ').slice(0,35)}"`);
  } catch (e) {
    console.log(`${label}\n  ERROR: ${String(e.message).slice(0,80)}`);
  }
}

console.log('REAL payload (system prompt + 7 tools), message = "hey":\n');
await run('gemini-3.6-flash (old)', 'gemini-3.6-flash', {});
await run('gemini-2.5-flash + thinking off (new)', 'gemini-2.5-flash', { thinkingConfig: { thinkingBudget: 0 } });
