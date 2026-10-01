import 'dotenv/config'; // MUST be first: loads .env before any module (e.g. db/index.ts) reads process.env
import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import dotenv from 'dotenv';
import { adminAuth } from './src/lib/firebase-admin.ts';
import {
  getOrCreateUser,
  getUserDatabaseState,
  updateUserProfile,
  saveUserExercise,
  saveUserWorkout,
  deleteUserWorkout,
} from './src/db/users.ts';
import { createPool } from './src/db/index.ts';
import { DatabaseState } from './src/types.ts';

dotenv.config();

const PORT = 3000;
const DB_FILE_PATH = path.join(process.cwd(), 'gym_database.json');
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.7-flash';
const GEMINI_LAST_RESORT_MODEL = process.env.GEMINI_LAST_RESORT_MODEL || 'gemini-2.5-flash';
const WORKOUT_CONFIRMATION_QUESTION = 'Soll ich dieses Workout so starten?';

function isTransientGeminiError(error: any) {
  const status = Number(error?.status || error?.code || 0);
  const message = String(error?.message || error || '').toUpperCase();
  return status === 408
    || status === 429
    || status >= 500
    || message.includes('UNAVAILABLE')
    || message.includes('RESOURCE_EXHAUSTED')
    || message.includes('INTERNAL')
    || message.includes('FETCH FAILED')
    || message.includes('TIMEOUT');
}

async function generateContentResilient(request: any) {
  let lastError: any;
  if (claude) {
    try {
      const allDeclarations = request.config?.tools?.[0]?.functionDeclarations || [];
      const declarations = request.forceToolName
        ? allDeclarations.filter((item: any) => item.name === request.forceToolName)
        : allDeclarations;
      const tools = declarations.map((declaration: any) => ({
        name: declaration.name,
        description: declaration.description,
        input_schema: normalizeJsonSchema(declaration.parameters),
        strict: true,
      }));
      const rawContents = Array.isArray(request.contents)
        ? request.contents
        : [{ role: 'user', parts: [{ text: String(request.contents || '') }] }];
      const messages = request.claudeMessages || rawContents.map((content: any) => ({
        role: content.role === 'model' ? 'assistant' : 'user',
        content: (content.parts || []).map((part: any) => part.text || '').join('\n'),
      }));
      const response = await claude.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        system: `${request.config?.systemInstruction || ''}${request.forceToolName
          ? `\n\nMANDATORY FOR THIS TURN: Call ${request.forceToolName}. Do not answer with text instead.`
          : ''}`,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(request.forceToolName ? {
          tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        } : {}),
      } as any);
      return {
        text: response.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('\n'),
        functionCalls: response.content
          .filter((block: any) => block.type === 'tool_use')
          .map((block: any) => ({ id: block.id, name: block.name, args: block.input })),
        provider: 'claude',
        rawContent: response.content,
        claudeMessages: messages,
        usage: {
          provider: 'claude',
          model: CLAUDE_MODEL,
          inputTokens: response.usage.input_tokens || 0,
          outputTokens: response.usage.output_tokens || 0,
          cacheCreationTokens: response.usage.cache_creation_input_tokens || 0,
          cacheReadTokens: response.usage.cache_read_input_tokens || 0,
          estimatedCostUsd: (
            (response.usage.input_tokens || 0) * 2
            + (response.usage.output_tokens || 0) * 10
            + (response.usage.cache_creation_input_tokens || 0) * 2.5
            + (response.usage.cache_read_input_tokens || 0) * 0.2
          ) / 1_000_000,
        },
      };
    } catch (error: any) {
      lastError = error;
      console.warn(`Claude ${CLAUDE_MODEL} failed; trying Gemini fallback: ${error.message}`);
    }
  }

  if (!ai) throw lastError || new Error('No AI provider is configured');

  const models = [...new Set([
    GEMINI_MODEL,
    GEMINI_FALLBACK_MODEL,
    GEMINI_LAST_RESORT_MODEL,
  ])];
  for (const model of models) {
    try {
      const {
        forceToolName: _forceToolName,
        claudeMessages: _claudeMessages,
        ...geminiRequest
      } = request;
      const response: any = await ai.models.generateContent({ ...geminiRequest, model });
      response.provider = 'gemini';
      response.usage = {
        provider: 'gemini',
        model,
        inputTokens: response.usageMetadata?.promptTokenCount || 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        cacheCreationTokens: 0,
        cacheReadTokens: response.usageMetadata?.cachedContentTokenCount || 0,
        estimatedCostUsd: 0,
      };
      return response;
    } catch (error: any) {
      lastError = error;
      if (!isTransientGeminiError(error)) throw error;
      console.warn(`Gemini ${model} temporarily unavailable; trying next model.`);
      await new Promise((resolve) => setTimeout(resolve, 350 + Math.random() * 250));
    }
  }
  throw lastError;
}

function normalizeJsonSchema(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeJsonSchema);
  if (!value || typeof value !== 'object') return value;

  const typeMap: Record<string, string> = {
    OBJECT: 'object',
    ARRAY: 'array',
    STRING: 'string',
    NUMBER: 'number',
    INTEGER: 'integer',
    BOOLEAN: 'boolean',
  };
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      key === 'type' && typeof nested === 'string'
        ? (typeMap[nested.toUpperCase()] || nested.toLowerCase())
        : normalizeJsonSchema(nested),
    ]),
  );
  if (normalized.type === 'object' && normalized.additionalProperties === undefined) {
    normalized.additionalProperties = false;
  }
  return normalized;
}

function isExplicitWorkoutConfirmation(message: string) {
  const normalized = (message || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return [
    /^(ja|yes|jep|jo)([,!. ]|$)/,
    /\b(starte|start|lade|übernimm)\b.*\b(workout|training|plan)\b/,
    /\b(workout|training|plan)\b.*\b(starten|laden|übernehmen)\b/,
    /^(los geht'?s|leg los|auf geht'?s|los|start|starte|mach das|genau so|passt so)[!. ]*$/,
  ].some((pattern) => pattern.test(normalized));
}

function hasPendingWorkoutDraftText(content: string | undefined) {
  const normalized = (content || '').toLowerCase();
  if (normalized.includes(WORKOUT_CONFIRMATION_QUESTION.toLowerCase())) return true;

  const looksLikePlan = /\b(workout|training|trainingsplan|plan)\b/.test(normalized);
  const setPrescriptions = normalized.match(/\b\d+\s*[x×]\s*\d+\b/g) || [];
  return looksLikePlan && setPrescriptions.length >= 2;
}

function claimsWorkoutStartedWithoutTool(reply: string, actionExecuted: any) {
  if (actionExecuted?.type === 'workout_proposed') return false;
  return /(workout|training).{0,30}(gestartet|erstellt|vorbereitet)|tool.{0,30}(genutzt|verwendet|erstellt)/i.test(reply);
}

async function getUserFromRequest(req: express.Request) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    const sqlUser = await getOrCreateUser(
      decodedToken.uid,
      decodedToken.email || `${decodedToken.uid}@user.com`,
      decodedToken.name
    );
    return sqlUser;
  } catch (error) {
    console.error('Token verification error:', error);
    return null;
  }
}

// Initialize Gemini Client server-side
const apiKey = process.env.GEMINI_API_KEY;
const claudeApiKey = process.env.CLAUDE_API_KEY;
const claude = claudeApiKey ? new Anthropic({ apiKey: claudeApiKey }) : null;
let ai: GoogleGenAI | null = null;
if (apiKey) {
  ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Initial Seed Data
const INITIAL_DB: DatabaseState = {
  profile: {
    name: "Tim",
    preferredUnit: "kg",
    experienceLevel: "Intermediate",
    primaryGoal: "Hypertrophy",
    personalMemories: [
      "Fokus auf progressive Überlastung & saubere Technik",
      "Ziel: Muskelaufbau & Kraftsteigerung"
    ],
    notes: ""
  },
  exercises: [
    {
      id: "ex_1",
      name: "Barbell Bench Press",
      category: "Chest",
      equipment: "Barbell",
      instructions: "Lie on bench, grip bar slightly wider than shoulder width. Lower bar smoothly to mid-chest and press up explosively.",
      isCustom: false,
      personalRecord: { maxWeight: 85, maxReps: 5, calculatedOneRepMax: 99, date: "2026-08-10" }
    },
    {
      id: "ex_2",
      name: "Incline Dumbbell Press",
      category: "Chest",
      equipment: "Dumbbell",
      instructions: "Set bench to 30-45 degree incline. Press dumbbells up over upper chest while maintaining core tension.",
      isCustom: false,
      personalRecord: { maxWeight: 32, maxReps: 8, calculatedOneRepMax: 40, date: "2026-08-10" }
    },
    {
      id: "ex_3",
      name: "Barbell Back Squat",
      category: "Legs",
      equipment: "Barbell",
      instructions: "Place bar across upper traps. Stand shoulder-width apart, brace core, sit hips down and back below parallel.",
      isCustom: false,
      personalRecord: { maxWeight: 100, maxReps: 5, calculatedOneRepMax: 116, date: "2026-08-08" }
    },
    {
      id: "ex_4",
      name: "Romanian Deadlift",
      category: "Legs",
      equipment: "Barbell",
      instructions: "Hinge at hips with slight knee bend, push glutes back until hamstring stretch, then drive hips forward.",
      isCustom: false,
      personalRecord: { maxWeight: 85, maxReps: 8, calculatedOneRepMax: 105, date: "2026-08-08" }
    },
    {
      id: "ex_5",
      name: "Lat Pulldown",
      category: "Back",
      equipment: "Cable",
      instructions: "Grip wide bar, pull down to upper chest while squeezing shoulder blades down and back.",
      isCustom: false,
      personalRecord: { maxWeight: 68, maxReps: 10, calculatedOneRepMax: 85, date: "2026-08-11" }
    },
    {
      id: "ex_6",
      name: "Barbell Overhead Press",
      category: "Shoulders",
      equipment: "Barbell",
      instructions: "Stand tall, rack bar on collarbone, press straight up overhead while locking out shoulders and glutes.",
      isCustom: false,
      personalRecord: { maxWeight: 52, maxReps: 6, calculatedOneRepMax: 62, date: "2026-08-10" }
    },
    {
      id: "ex_7",
      name: "Dumbbell Bicep Curl",
      category: "Arms",
      equipment: "Dumbbell",
      instructions: "Stand shoulder-width apart, curl weight up keeping elbows pinned to sides, squeeze peak contraction.",
      isCustom: false,
      personalRecord: { maxWeight: 16, maxReps: 10, calculatedOneRepMax: 20, date: "2026-08-11" }
    },
    {
      id: "ex_8",
      name: "Tricep Rope Pushdown",
      category: "Arms",
      equipment: "Cable",
      instructions: "Keep elbows fixed by torso, extend arms down and pull rope ends apart at bottom for full tricep lock.",
      isCustom: false,
      personalRecord: { maxWeight: 28, maxReps: 12, calculatedOneRepMax: 36, date: "2026-08-10" }
    }
  ],
  workouts: [
    {
      id: "wk_101",
      title: "Push Day - Chest, Shoulders & Triceps",
      date: "2026-08-10",
      durationMinutes: 55,
      totalVolume: 3820,
      isCompleted: true,
      notes: "Felt strong on Bench Press! Increased top set by 2.5 kg.",
      exercises: [
        {
          id: "we_1",
          exerciseId: "ex_1",
          exerciseName: "Barbell Bench Press",
          category: "Chest",
          sets: [
            { id: "s1", setNumber: 1, type: "warmup", weight: 60, reps: 10, completed: true },
            { id: "s2", setNumber: 2, type: "working", weight: 80, reps: 8, rpe: 8, completed: true },
            { id: "s3", setNumber: 3, type: "working", weight: 85, reps: 5, rpe: 9, completed: true, notes: "New PR!" },
            { id: "s4", setNumber: 4, type: "working", weight: 85, reps: 5, rpe: 9.5, completed: true }
          ]
        },
        {
          id: "we_2",
          exerciseId: "ex_2",
          exerciseName: "Incline Dumbbell Press",
          category: "Chest",
          sets: [
            { id: "s5", setNumber: 1, type: "working", weight: 30, reps: 10, rpe: 8, completed: true },
            { id: "s6", setNumber: 2, type: "working", weight: 32, reps: 8, rpe: 9, completed: true }
          ]
        },
        {
          id: "we_3",
          exerciseId: "ex_6",
          exerciseName: "Barbell Overhead Press",
          category: "Shoulders",
          sets: [
            { id: "s7", setNumber: 1, type: "working", weight: 48, reps: 8, rpe: 8, completed: true },
            { id: "s8", setNumber: 2, type: "working", weight: 52, reps: 6, rpe: 9, completed: true }
          ]
        }
      ]
    },
    {
      id: "wk_102",
      title: "Pull Day - Back & Biceps",
      date: "2026-08-11",
      durationMinutes: 48,
      totalVolume: 2620,
      isCompleted: true,
      notes: "Great lat pump. Focused on slow eccentrics.",
      exercises: [
        {
          id: "we_4",
          exerciseId: "ex_5",
          exerciseName: "Lat Pulldown",
          category: "Back",
          sets: [
            { id: "s9", setNumber: 1, type: "working", weight: 60, reps: 12, rpe: 7, completed: true },
            { id: "s10", setNumber: 2, type: "working", weight: 68, reps: 10, rpe: 8.5, completed: true },
            { id: "s11", setNumber: 3, type: "working", weight: 68, reps: 9, rpe: 9, completed: true }
          ]
        },
        {
          id: "we_5",
          exerciseId: "ex_7",
          exerciseName: "Dumbbell Bicep Curl",
          category: "Arms",
          sets: [
            { id: "s12", setNumber: 1, type: "working", weight: 14, reps: 12, rpe: 8, completed: true },
            { id: "s13", setNumber: 2, type: "working", weight: 16, reps: 10, rpe: 9, completed: true }
          ]
        }
      ]
    }
  ],
  templates: [
    {
      id: "tpl_1",
      name: "Push Day (Chest, Shoulders, Triceps)",
      description: "Classic heavy push session targeting chest, delts, and triceps.",
      category: "Push",
      exercises: [
        { exerciseId: "ex_1", defaultSets: 4, defaultReps: 8 },
        { exerciseId: "ex_2", defaultSets: 3, defaultReps: 10 },
        { exerciseId: "ex_6", defaultSets: 3, defaultReps: 8 },
        { exerciseId: "ex_8", defaultSets: 3, defaultReps: 12 }
      ]
    },
    {
      id: "tpl_2",
      name: "Pull Day (Back & Biceps)",
      description: "Focus on vertical and horizontal pulls for back thickness and arms.",
      category: "Pull",
      exercises: [
        { exerciseId: "ex_5", defaultSets: 4, defaultReps: 10 },
        { exerciseId: "ex_7", defaultSets: 3, defaultReps: 12 }
      ]
    },
    {
      id: "tpl_3",
      name: "Leg Day (Quads & Hamstrings)",
      description: "Heavy squatting and hamstring posterior chain work.",
      category: "Legs",
      exercises: [
        { exerciseId: "ex_3", defaultSets: 4, defaultReps: 6 },
        { exerciseId: "ex_4", defaultSets: 3, defaultReps: 8 }
      ]
    }
  ]
};

// Database Read / Write Utilities
function readDatabase() {
  try {
    if (fs.existsSync(DB_FILE_PATH)) {
      const data = fs.readFileSync(DB_FILE_PATH, 'utf-8');
      return JSON.parse(data);
    } else {
      writeDatabase(INITIAL_DB);
      return INITIAL_DB;
    }
  } catch (error) {
    console.error("Error reading database, reverting to seed:", error);
    return INITIAL_DB;
  }
}

function writeDatabase(data: any) {
  try {
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error("Error writing database:", error);
  }
}

// Update PRs when saving a workout
function updatePersonalRecords(db: any, workout: any) {
  if (!workout.exercises) return;

  workout.exercises.forEach((we: any) => {
    const exercise = db.exercises.find((e: any) => e.id === we.exerciseId);
    if (!exercise) return;

    let highestWeight = exercise.personalRecord?.maxWeight || 0;
    let highestReps = exercise.personalRecord?.maxReps || 0;
    let highest1RM = exercise.personalRecord?.calculatedOneRepMax || 0;
    let prUpdated = false;

    we.sets.forEach((set: any) => {
      if (set.completed && set.weight > 0 && set.reps > 0) {
        // Epley Formula for 1RM: Weight * (1 + Reps/30)
        const est1RM = Math.round(set.weight * (1 + set.reps / 30));
        if (est1RM > highest1RM) {
          highest1RM = est1RM;
          highestWeight = set.weight;
          highestReps = set.reps;
          prUpdated = true;
        }
      }
    });

    if (prUpdated) {
      exercise.personalRecord = {
        maxWeight: highestWeight,
        maxReps: highestReps,
        calculatedOneRepMax: highest1RM,
        date: workout.date || new Date().toISOString().split('T')[0]
      };
    }
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Initialize DB file
  readDatabase();

  // API Routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Get full database
  app.get('/api/db', async (req, res) => {
    try {
      const sqlUser = await getUserFromRequest(req);
      if (sqlUser) {
        const cloudDb = await getUserDatabaseState(sqlUser.id);
        if (cloudDb.exercises.length === 0) {
          cloudDb.exercises = INITIAL_DB.exercises;
        }
        return res.json(cloudDb);
      }
    } catch (e) {
      console.error('Cloud SQL read error:', e);
      if (req.headers.authorization) {
        return res.status(500).json({ error: 'Failed to load authenticated cloud data' });
      }
    }
    if (req.headers.authorization) {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }
    const db = readDatabase();
    res.json(db);
  });

  // Save / Update Workout
  app.post('/api/db/workout', async (req, res) => {
    const newWorkout = req.body;

    if (!newWorkout || !newWorkout.id) {
      return res.status(400).json({ error: 'Invalid workout payload' });
    }

    try {
      const sqlUser = await getUserFromRequest(req);
      if (sqlUser) {
        await saveUserWorkout(sqlUser.id, newWorkout);
        const cloudDb = await getUserDatabaseState(sqlUser.id);
        if (cloudDb.exercises.length === 0) {
          cloudDb.exercises = INITIAL_DB.exercises;
        }
        updatePersonalRecords(cloudDb, newWorkout);
        for (const ex of cloudDb.exercises) {
          if (ex.personalRecord) {
            await saveUserExercise(sqlUser.id, ex);
          }
        }
        return res.json({ success: true, db: cloudDb });
      }
    } catch (e) {
      console.error('Cloud SQL save workout error:', e);
    }

    const db = readDatabase();
    const existingIndex = db.workouts.findIndex((w: any) => w.id === newWorkout.id);
    if (existingIndex >= 0) {
      db.workouts[existingIndex] = newWorkout;
    } else {
      db.workouts.unshift(newWorkout);
    }

    updatePersonalRecords(db, newWorkout);
    writeDatabase(db);

    res.json({ success: true, db });
  });

  // Delete Workout
  app.delete('/api/db/workout/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const sqlUser = await getUserFromRequest(req);
      if (sqlUser) {
        await deleteUserWorkout(sqlUser.id, id);
        const cloudDb = await getUserDatabaseState(sqlUser.id);
        if (cloudDb.exercises.length === 0) {
          cloudDb.exercises = INITIAL_DB.exercises;
        }
        return res.json({ success: true, db: cloudDb });
      }
    } catch (e) {
      console.error('Cloud SQL delete workout error:', e);
    }

    const db = readDatabase();
    db.workouts = db.workouts.filter((w: any) => w.id !== id);
    writeDatabase(db);
    res.json({ success: true, db });
  });

  // Create or Update Exercise
  app.post('/api/db/exercise', async (req, res) => {
    const newExercise = req.body;

    if (!newExercise || !newExercise.id) {
      return res.status(400).json({ error: 'Invalid exercise payload' });
    }

    try {
      const sqlUser = await getUserFromRequest(req);
      if (sqlUser) {
        await saveUserExercise(sqlUser.id, newExercise);
        const cloudDb = await getUserDatabaseState(sqlUser.id);
        if (cloudDb.exercises.length === 0) {
          cloudDb.exercises = INITIAL_DB.exercises;
        }
        return res.json({ success: true, db: cloudDb });
      }
    } catch (e) {
      console.error('Cloud SQL save exercise error:', e);
    }

    const db = readDatabase();
    const index = db.exercises.findIndex((e: any) => e.id === newExercise.id);
    if (index >= 0) {
      db.exercises[index] = newExercise;
    } else {
      db.exercises.push(newExercise);
    }

    writeDatabase(db);
    res.json({ success: true, db });
  });

  // Update Profile
  app.post('/api/db/profile', async (req, res) => {
    try {
      const sqlUser = await getUserFromRequest(req);
      if (sqlUser) {
        await updateUserProfile(sqlUser.id, req.body);
        const cloudDb = await getUserDatabaseState(sqlUser.id);
        if (cloudDb.exercises.length === 0) {
          cloudDb.exercises = INITIAL_DB.exercises;
        }
        return res.json({ success: true, db: cloudDb });
      }
    } catch (e) {
      console.error('Cloud SQL update profile error:', e);
    }

    const db = readDatabase();
    db.profile = { ...db.profile, ...req.body };
    writeDatabase(db);
    res.json({ success: true, db });
  });

  // Reset to Seed
  app.post('/api/db/reset', (req, res) => {
    writeDatabase(INITIAL_DB);
    res.json({ success: true, db: INITIAL_DB });
  });

  app.get('/api/ai/history', async (req, res) => {
    const sqlUser = await getUserFromRequest(req);
    if (!sqlUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await createPool().query(
      `SELECT id, role, content, created_at
       FROM messages
       WHERE user_id = $1 AND thread_id = $2
       ORDER BY id DESC
       LIMIT 200`,
      [sqlUser.id, String(sqlUser.id)],
    );
    res.json({
      messages: result.rows.reverse().map((message) => ({
        id: `server_${message.id}`,
        role: message.role,
        content: message.content,
        createdAt: message.created_at,
      })),
    });
  });

  app.delete('/api/ai/history', async (req, res) => {
    const sqlUser = await getUserFromRequest(req);
    if (!sqlUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    await createPool().query(
      'DELETE FROM messages WHERE user_id = $1 AND thread_id = $2',
      [sqlUser.id, String(sqlUser.id)],
    );
    res.json({ success: true });
  });

  // Gemini AI Assistant Endpoint with full database write/action capabilities
  app.post('/api/ai/chat', async (req, res) => {
    try {
      const { message, activeWorkoutState } = req.body;
      let db = readDatabase();
      const sqlUser = await getUserFromRequest(req);
      let chatHistory: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
      if (sqlUser) {
        try {
          const cloudDb = await getUserDatabaseState(sqlUser.id);
          if (cloudDb.exercises.length === 0) {
            cloudDb.exercises = INITIAL_DB.exercises;
          }
          db = cloudDb;
          const historyResult = await createPool().query(
            `SELECT role, content FROM messages
             WHERE user_id = $1 AND thread_id = $2
             ORDER BY id DESC LIMIT 20`,
            [sqlUser.id, String(sqlUser.id)],
          );
          chatHistory = historyResult.rows.reverse().map((entry) => ({
            role: entry.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: entry.content }],
          }));
        } catch (e) {
          console.error('Error fetching cloud db for AI chat:', e);
        }
      }

      const hasPendingDraft = [...chatHistory]
        .reverse()
        .filter((entry) => entry.role === 'model')
        .slice(0, 4)
        .some((entry) => hasPendingWorkoutDraftText(entry.parts[0]?.text));
      const canStartWorkout = isExplicitWorkoutConfirmation(message) && hasPendingDraft;

      if (!ai && !claude) {
        return res.json({
          reply: "Der AI-Coach ist nicht konfiguriert. Bitte setze CLAUDE_API_KEY oder GEMINI_API_KEY in den Server-Secrets."
        });
      }

      // Format database summary for LLM context
      const memoriesList = (db.profile.personalMemories && db.profile.personalMemories.length > 0)
        ? db.profile.personalMemories.map((m: string) => `- ${m}`).join('\n')
        : '- None saved yet.';

      const profileInfo = `User Profile: Name: ${db.profile.name}, Goal: ${db.profile.primaryGoal}, Level: ${db.profile.experienceLevel}.\n\n--- PERSONAL USER MEMORIES & PERMANENT GOALS ---\n${memoriesList}\n(ALWAYS consider these personal memories when generating advice, exercise selections, or progressive overload recommendations!)`;
      
      const exerciseRecords = db.exercises.map((e: any) => {
        const pr = e.personalRecord ? `[PR: ${e.personalRecord.maxWeight} x ${e.personalRecord.maxReps} reps, Est 1RM: ${e.personalRecord.calculatedOneRepMax} on ${e.personalRecord.date}]` : "[No PR logged yet]";
        return `- ${e.name} (${e.category}, ${e.equipment}): ${pr}`;
      }).join('\n');

      const recentWorkouts = db.workouts.slice(0, 10).map((w: any) => {
        const exList = w.exercises.map((we: any) => {
          const setsList = we.sets.filter((s: any) => s.completed).map((s: any) => `${s.weight} x ${s.reps}`).join(', ');
          return `   * ${we.exerciseName}: ${setsList || 'No completed sets'}`;
        }).join('\n');
        return `ID: ${w.id} | Date: ${w.date} | Title: "${w.title}" | Total Vol: ${w.totalVolume}\n${exList}`;
      }).join('\n\n');

      let activeWorkoutContext = "No active workout currently in progress.";
      if (activeWorkoutState && activeWorkoutState.exercises && activeWorkoutState.exercises.length > 0) {
        activeWorkoutContext = `Active Workout Session right now:\nTitle: ${activeWorkoutState.title}\nExercises in session:\n` +
          activeWorkoutState.exercises.map((we: any) => {
            const setsStr = we.sets.map((s: any) => `Set ${s.setNumber} (${s.type}): ${s.weight} x ${s.reps} [${s.completed ? 'DONE' : 'PENDING'}]`).join(' | ');
            return `- ${we.exerciseName}: ${setsStr}`;
          }).join('\n');
      }

      const systemInstruction = `You are GymPulse AI, a concise fitness assistant with direct read/write access to Tim's database.
RESPONSE STYLE: DIRECT AND PRECISE.
- ZERO greetings, NO parasocial fluff, NO "Hey Tim!", NO "What are we tackling today?".
- Outside workout drafts, answer in 1-3 short lines or concise bullet points.
- Workout drafts must be complete enough to verify every exercise, set, rep and load.
- If the user shares a goal (e.g. "Ich will Muskeln aufbauen", "Gewicht verlieren", "Sprungkraft verbessern", "Habe Schulterschmerzen"), call \`save_personal_memory\` to permanently remember it!

ACTIONS AVAILABLE:
- To save personal memory/goals: call \`save_personal_memory\`
- To remove personal memory: call \`remove_personal_memory\`
- To log a workout: call \`log_workout\`
- To add an exercise: call \`add_exercise\`
- To update profile: call \`update_profile\`
- To delete a workout: call \`delete_workout\`
- \`start_workout_session\` is available only after explicit confirmation.
- If one user message requests multiple actions, execute every required tool in the same turn.
  Example: deleting an empty workout and logging the completed replacement requires both
  \`delete_workout\` and \`log_workout\`; never stop after only the first action.
- When the user says "wie geplant", reconstruct the latest agreed plan from conversation
  history, apply all later corrections, and use those exact values for \`log_workout\`.

WORKOUT CREATION IS ALWAYS TWO PHASES:
1. DRAFT/REVISION: Write the full workout in text with every set, rep and load.
   Never claim it is started. End the complete draft with exactly:
   "${WORKOUT_CONFIRMATION_QUESTION}"
2. CONFIRMATION: Only after the user explicitly confirms the latest draft,
   call \`start_workout_session\` once and copy every agreed set exactly.

=== USER DATABASE CONTEXT ===
${profileInfo}

--- EXERCISE LIBRARY & PRs ---
${exerciseRecords}

--- RECENT WORKOUTS ---
${recentWorkouts}

--- CURRENT ACTIVE SESSION ---
${activeWorkoutContext}
=============================`;

      const aiRequest = {
        contents: [...chatHistory, { role: 'user', parts: [{ text: message }] }],
        config: {
          systemInstruction,
          thinkingConfig: {
            thinkingLevel: activeWorkoutState ? ThinkingLevel.LOW : ThinkingLevel.MEDIUM,
          },
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'save_personal_memory',
                  description: 'Save or remember a personal fitness goal (e.g. "Gewicht verlieren", "Muskeln aufbauen", "Sprungkraft / Vertical Jump verbessern"), injury constraint, sport preference, or personal note permanently into user memory.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      memory: { type: Type.STRING, description: 'The personal goal, preference, constraint, or fact to remember.' }
                    },
                    required: ['memory']
                  }
                },
                {
                  name: 'remove_personal_memory',
                  description: 'Remove or forget a specific personal goal or memory from the user profile.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      memoryTextOrIndex: { type: Type.STRING, description: 'The memory text or keyword to remove.' }
                    },
                    required: ['memoryTextOrIndex']
                  }
                },
                {
                  name: 'log_workout',
                  description: 'Log a completed workout only when the user says it was performed. Preserve the exact agreed date, exercises, ordered sets, weights, reps, set types, and RPE; do not invent missing values.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING, description: 'Title of workout session e.g. Push Day' },
                      date: { type: Type.STRING, description: 'ISO date YYYY-MM-DD (default to today if unspecified)' },
                      durationMinutes: { type: Type.NUMBER, description: 'Duration in minutes (e.g. 45)' },
                      notes: { type: Type.STRING, description: 'Notes or performance highlights' },
                      exercises: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            exerciseName: { type: Type.STRING, description: 'Name of exercise e.g. Barbell Bench Press' },
                            category: { type: Type.STRING, description: 'Chest, Back, Legs, Shoulders, Arms, Core, Cardio, or Other' },
                            sets: {
                              type: Type.ARRAY,
                              items: {
                                type: Type.OBJECT,
                                properties: {
                                  weight: { type: Type.NUMBER, description: 'Weight in kg' },
                                  reps: { type: Type.NUMBER, description: 'Number of reps' },
                                  rpe: { type: Type.NUMBER, description: 'RPE 1-10' },
                                  type: { type: Type.STRING, description: 'working, warmup, or drop' }
                                },
                                required: ['weight', 'reps']
                              }
                            }
                          },
                          required: ['exerciseName', 'sets']
                        }
                      }
                    },
                    required: ['title', 'exercises']
                  }
                },
                {
                  name: 'add_exercise',
                  description: 'Add a new movement to the exercise library.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING, description: 'Exercise name' },
                      category: { type: Type.STRING, description: 'Chest, Back, Legs, Shoulders, Arms, Core, Cardio, or Other' },
                      equipment: { type: Type.STRING, description: 'Barbell, Dumbbell, Machine, Cable, Bodyweight, or Other' },
                      instructions: { type: Type.STRING, description: 'Form instructions' }
                    },
                    required: ['name', 'category', 'equipment']
                  }
                },
                {
                  name: 'update_profile',
                  description: 'Update user profile goals or experience level.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      primaryGoal: { type: Type.STRING, description: 'Strength, Hypertrophy, Endurance, General Fitness, Weight Loss, or Athleticism & Jump Power' },
                      experienceLevel: { type: Type.STRING, description: 'Beginner, Intermediate, or Advanced' }
                    }
                  }
                },
                {
                  name: 'delete_workout',
                  description: 'Delete one workout session from history by its exact ID or a sufficiently specific title. Use this as well as any other tool required by the same user request.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      searchOrId: { type: Type.STRING, description: 'Workout ID or title match string' }
                    },
                    required: ['searchOrId']
                  }
                },
                ...(canStartWorkout ? [{
                  name: 'start_workout_session',
                  description: 'Create the confirmation card for the latest workout explicitly approved by the user.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING, description: 'Workout session title' },
                      sessionNotes: { type: Type.STRING, description: 'Warm-up, cooldown, and session-wide guidance' },
                      exercises: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            exerciseName: { type: Type.STRING },
                            notes: { type: Type.STRING },
                            sets: {
                              type: Type.ARRAY,
                              items: {
                                type: Type.OBJECT,
                                properties: {
                                  weight: { type: Type.NUMBER },
                                  reps: { type: Type.INTEGER },
                                  setType: { type: Type.STRING, enum: ['warmup', 'working', 'drop', 'failure'] },
                                  rir: { type: Type.NUMBER },
                                  notes: { type: Type.STRING }
                                },
                                required: ['weight', 'reps', 'setType']
                              }
                            }
                          },
                          required: ['exerciseName', 'sets']
                        },
                        description: 'Exercises with every agreed set explicitly expanded'
                      }
                    },
                    required: ['title', 'exercises']
                  }
                }] : [])
              ]
            }
          ]
        },
      };

      let actionExecuted: any = null;
      const actionsExecuted: any[] = [];
      const toolsUsed: string[] = [];
      const usage = {
        provider: '',
        model: '',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      };

      const executeToolCall = async (call: any) => {
        const args: any = call.args || {};
        const actionCountBefore = actionsExecuted.length;
        toolsUsed.push(call.name);

          if (call.name === 'save_personal_memory') {
            if (!Array.isArray(db.profile.personalMemories)) {
              db.profile.personalMemories = [];
            }
            if (args.memory && !db.profile.personalMemories.includes(args.memory)) {
              db.profile.personalMemories.push(args.memory);
            }
            if (sqlUser) {
              await updateUserProfile(sqlUser.id, { personalMemories: db.profile.personalMemories });
            } else {
              writeDatabase(db);
            }
            actionExecuted = { type: 'memory_saved', data: args.memory };
            actionsExecuted.push(actionExecuted);

          } else if (call.name === 'remove_personal_memory') {
            if (Array.isArray(db.profile.personalMemories)) {
              const query = (args.memoryTextOrIndex || '').toLowerCase();
              db.profile.personalMemories = db.profile.personalMemories.filter((m: string) => !m.toLowerCase().includes(query));
            }
            if (sqlUser) {
              await updateUserProfile(sqlUser.id, { personalMemories: db.profile.personalMemories });
            } else {
              writeDatabase(db);
            }
            actionExecuted = { type: 'memory_removed', data: args.memoryTextOrIndex };
            actionsExecuted.push(actionExecuted);

          } else if (call.name === 'log_workout') {
            const todayStr = new Date().toISOString().split('T')[0];
            const workoutExercises = (args.exercises || []).map((exItem: any, exIdx: number) => {
              // Find or default exercise ID
              const matchingEx = db.exercises.find((e: any) => e.name.toLowerCase() === (exItem.exerciseName || '').toLowerCase());
              const sets = (exItem.sets || []).map((s: any, sIdx: number) => ({
                id: `s_${Date.now()}_${exIdx}_${sIdx}`,
                setNumber: sIdx + 1,
                type: s.type || 'working',
                weight: s.weight || 0,
                reps: s.reps || 0,
                rpe: s.rpe || 8,
                completed: true
              }));

              return {
                id: `we_${Date.now()}_${exIdx}`,
                exerciseId: matchingEx ? matchingEx.id : `ex_dyn_${Date.now()}_${exIdx}`,
                exerciseName: exItem.exerciseName || 'Custom Movement',
                category: exItem.category || (matchingEx ? matchingEx.category : 'Chest'),
                sets
              };
            });

            // Calculate total volume
            let totalVolume = 0;
            workoutExercises.forEach((we: any) => {
              we.sets.forEach((s: any) => {
                totalVolume += (s.weight || 0) * (s.reps || 0);
              });
            });

            const newWorkout = {
              id: `wk_${Date.now()}`,
              title: args.title || 'Logged Session',
              date: args.date || todayStr,
              durationMinutes: args.durationMinutes || 45,
              totalVolume,
              isCompleted: true,
              notes: args.notes || 'Logged via GymPulse AI Coach',
              exercises: workoutExercises
            };

            if (sqlUser) {
              await saveUserWorkout(sqlUser.id, newWorkout);
              db.workouts.unshift(newWorkout);
              updatePersonalRecords(db, newWorkout);
              for (const ex of db.exercises) {
                if (ex.personalRecord) await saveUserExercise(sqlUser.id, ex);
              }
            } else {
              db.workouts.unshift(newWorkout);
              updatePersonalRecords(db, newWorkout);
              writeDatabase(db);
            }
            actionExecuted = { type: 'workout_logged', data: newWorkout };
            actionsExecuted.push(actionExecuted);

          } else if (call.name === 'add_exercise') {
            const newEx = {
              id: `ex_${Date.now()}`,
              name: args.name,
              category: args.category || 'Chest',
              equipment: args.equipment || 'Barbell',
              instructions: args.instructions || 'Added via GymPulse AI Coach',
              isCustom: true
            };
            if (sqlUser) {
              await saveUserExercise(sqlUser.id, newEx);
            }
            db.exercises.push(newEx);
            if (!sqlUser) writeDatabase(db);
            actionExecuted = { type: 'exercise_added', data: newEx };
            actionsExecuted.push(actionExecuted);

          } else if (call.name === 'update_profile') {
            if (args.name) db.profile.name = args.name;
            if (args.primaryGoal) db.profile.primaryGoal = args.primaryGoal;
            if (args.experienceLevel) db.profile.experienceLevel = args.experienceLevel;
            db.profile.preferredUnit = 'kg'; // Enforce kg
            if (sqlUser) {
              await updateUserProfile(sqlUser.id, db.profile);
            } else {
              writeDatabase(db);
            }
            actionExecuted = { type: 'profile_updated', data: db.profile };
            actionsExecuted.push(actionExecuted);

          } else if (call.name === 'delete_workout') {
            const search = (args.searchOrId || '').toLowerCase();
            const target = db.workouts.find((w: any) => w.id === search || w.title.toLowerCase().includes(search));
            if (target) {
              if (sqlUser) {
                await deleteUserWorkout(sqlUser.id, target.id);
              }
              db.workouts = db.workouts.filter((w: any) => w.id !== target.id);
              if (!sqlUser) writeDatabase(db);
              actionExecuted = { type: 'workout_deleted', data: target };
              actionsExecuted.push(actionExecuted);
            }

          } else if (call.name === 'start_workout_session') {
            const sessionExercises = (args.exercises || []).map((planned: any, idx: number) => {
              const name = planned.exerciseName;
              const matchingEx = db.exercises.find((e: any) => e.name.toLowerCase() === name.toLowerCase());
              return {
                id: `we_${Date.now()}_${idx}`,
                exerciseId: matchingEx ? matchingEx.id : `ex_temp_${idx}`,
                exerciseName: matchingEx ? matchingEx.name : name,
                category: matchingEx ? matchingEx.category : 'Other',
                notes: planned.notes,
                sets: (planned.sets || []).map((set: any, setIdx: number) => ({
                  id: `s_${Date.now()}_${idx}_${setIdx}`,
                  setNumber: setIdx + 1,
                  type: set.setType,
                  weight: set.weight,
                  reps: set.reps,
                  rpe: set.rir == null ? undefined : 10 - set.rir,
                  notes: set.notes,
                  completed: false
                }))
              };
            });

            const newActiveSession = {
              id: `wk_${Date.now()}`,
              title: args.title || 'AI Initiated Session',
              date: new Date().toISOString().split('T')[0],
              durationMinutes: 0,
              totalVolume: 0,
              isCompleted: false,
              notes: args.sessionNotes,
              exercises: sessionExercises
            };

            actionExecuted = { type: 'workout_proposed', data: newActiveSession };
            actionsExecuted.push(actionExecuted);
          }
        const currentAction = actionsExecuted.length > actionCountBefore
          ? actionsExecuted[actionsExecuted.length - 1]
          : null;
        return JSON.stringify({
          success: Boolean(currentAction),
          tool: call.name,
          action: currentAction?.type || null,
          error: currentAction ? undefined : 'No matching record was changed.',
        });
      };

      let response: any = null;
      let replyText = '';
      let claudeMessages: any[] | undefined;
      for (let step = 0; step < 4; step += 1) {
        response = await generateContentResilient({
          ...aiRequest,
          forceToolName: step === 0 && canStartWorkout ? 'start_workout_session' : undefined,
          claudeMessages,
        });
        if (response.usage) {
          usage.provider = response.usage.provider;
          usage.model = response.usage.model;
          usage.inputTokens += response.usage.inputTokens || 0;
          usage.outputTokens += response.usage.outputTokens || 0;
          usage.cacheCreationTokens += response.usage.cacheCreationTokens || 0;
          usage.cacheReadTokens += response.usage.cacheReadTokens || 0;
          usage.estimatedCostUsd += response.usage.estimatedCostUsd || 0;
        }

        const calls = response.functionCalls || [];
        if (calls.length === 0) {
          replyText = response.text || '';
          break;
        }

        const toolResults = [];
        for (const call of calls) {
          const feedback = await executeToolCall(call);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: feedback,
          });
        }

        if (actionExecuted?.type === 'workout_proposed' || response.provider !== 'claude') {
          break;
        }
        claudeMessages = [
          ...(response.claudeMessages || []),
          { role: 'assistant', content: response.rawContent },
          { role: 'user', content: toolResults },
        ];
      }
      usage.totalTokens = usage.inputTokens + usage.outputTokens
        + usage.cacheCreationTokens + usage.cacheReadTokens;

      // Generate response text
      if (!replyText || replyText.trim() === '') {
        if (actionExecuted) {
          if (actionExecuted.type === 'memory_saved') {
            replyText = `🧠 **Erinnerung gespeichert!**\nIch habe deine Information/dein Ziel **"${actionExecuted.data}"** in deinem persönlichen KI-Profil gespeichert und werde es bei allen zukünftigen Trainingsplänen und Gewichts-Tipps berücksichtigen.`;
          } else if (actionExecuted.type === 'memory_removed') {
            replyText = `🗑️ **Erinnerung entfernt!**\nIch habe die Information aus deinem persönlichen KI-Gedächtnis gelöscht.`;
          } else if (actionExecuted.type === 'workout_logged') {
            replyText = `✅ **Workout Logged Successfully!**\nI've recorded **"${actionExecuted.data.title}"** with ${actionExecuted.data.exercises.length} exercises and a total volume of **${actionExecuted.data.totalVolume.toLocaleString()}**. Personal records have been updated!`;
          } else if (actionExecuted.type === 'exercise_added') {
            replyText = `✅ **Movement Added!**\nI've added **"${actionExecuted.data.name}"** (${actionExecuted.data.category} • ${actionExecuted.data.equipment}) to your exercise library.`;
          } else if (actionExecuted.type === 'profile_updated') {
            replyText = `✅ **Profile Updated!**\nYour profile goals have been set to **${actionExecuted.data.primaryGoal}** (${actionExecuted.data.experienceLevel} level).`;
          } else if (actionExecuted.type === 'workout_deleted') {
            replyText = `🗑️ **Workout Removed!**\nI've deleted **"${actionExecuted.data.title}"** (${actionExecuted.data.date}) from your workout log history.`;
          } else if (actionExecuted.type === 'workout_proposed') {
            replyText = `Der exakt bestätigte Plan ist jetzt unten als Workout-Karte vorbereitet. Prüf ihn kurz und klick **Workout starten**.`;
          }
        } else {
          replyText = "I have analyzed your request against your database logs. How else can I assist your workout today?";
        }
      }

      if (actionExecuted?.type === 'workout_proposed') {
        replyText = "Der bestätigte Plan ist jetzt als Workout-Karte vorbereitet. Prüf ihn kurz und klick auf **Workout starten**.";
      } else if (canStartWorkout) {
        replyText = "Ich konnte das Workout-Tool nicht erfolgreich auslösen. Das Workout wurde nicht gestartet; bitte versuche die Bestätigung erneut.";
      } else if (claimsWorkoutStartedWithoutTool(replyText, actionExecuted)) {
        replyText = canStartWorkout
          ? "Ich konnte das Workout-Tool nicht erfolgreich auslösen. Das Workout wurde nicht gestartet; bitte versuche die Bestätigung erneut."
          : `Das Workout wurde noch nicht gestartet. Ich muss zuerst den vollständigen Plan bestätigen lassen: ${WORKOUT_CONFIRMATION_QUESTION}`;
      }

      if (sqlUser) {
        await createPool().query(
          `INSERT INTO messages (user_id, thread_id, role, content)
           VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4)`,
          [sqlUser.id, String(sqlUser.id), message, replyText],
        );
      }

      res.json({
        reply: replyText,
        actionExecuted,
        actionsExecuted,
        toolsUsed,
        usage,
        db,
      });
    } catch (error: any) {
      console.error("AI Chat Error:", error);
      const temporary = isTransientGeminiError(error);
      res.status(temporary ? 503 : 500).json({
        error: error.message || "Failed to generate AI response",
        reply: temporary
          ? "Der AI-Coach ist gerade vorübergehend ausgelastet. Bitte sende die Nachricht in einem Moment erneut."
          : "Der AI-Coach konnte die Anfrage nicht verarbeiten. Bitte prüfe die Serverkonfiguration.",
      });
    }
  });

  // Gemini Weight Recommendation Helper Endpoint
  app.post('/api/ai/suggest-weight', async (req, res) => {
    try {
      const { exerciseName, targetReps, targetRpe } = req.body;
      const db = readDatabase();

      if (!ai && !claude) {
        return res.json({
          recommendation: "API key not configured.",
          suggestedWeight: 0,
          reasoning: "Set GEMINI_API_KEY in Secrets."
        });
      }

      const exercise = db.exercises.find((e: any) => e.name.toLowerCase() === exerciseName.toLowerCase());
      const pastSets: string[] = [];

      db.workouts.forEach((w: any) => {
        w.exercises.forEach((we: any) => {
          if (we.exerciseName.toLowerCase() === exerciseName.toLowerCase()) {
            we.sets.forEach((s: any) => {
              if (s.completed) {
                pastSets.push(`${w.date}: ${s.weight}${db.profile.preferredUnit} x ${s.reps} reps (RPE ${s.rpe || 'N/A'})`);
              }
            });
          }
        });
      });

      const prompt = `Give a precise weight recommendation for ${exerciseName}.
Target Reps: ${targetReps || 8}
Target RPE: ${targetRpe || 8}
User Unit: ${db.profile.preferredUnit}
Personal Record: ${exercise?.personalRecord ? `${exercise.personalRecord.maxWeight}${db.profile.preferredUnit} x ${exercise.personalRecord.maxReps} reps` : 'None'}
Recent Past Sets Performance:
${pastSets.slice(0, 10).join('\n') || 'No past sets recorded yet'}

Return JSON format with keys:
"suggestedWeight": number (rounded to nearest 5),
"suggestedReps": number,
"recommendation": string (short 1 sentence summary),
"reasoning": string (1-2 sentences rationale based on progressive overload)`;

      const response = await generateContentResilient({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.3,
          thinkingConfig: { thinkingBudget: 0 },
        }
      });

      const parsed = JSON.parse(response.text || '{}');
      res.json(parsed);
    } catch (error: any) {
      console.error("Suggest Weight Error:", error);
      res.status(500).json({ error: error.message || "Failed to generate recommendation" });
    }
  });

  // Vite Dev Server Middleware vs Production Static
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
