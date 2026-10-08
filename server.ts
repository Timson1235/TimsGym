import 'dotenv/config'; // MUST be first: loads .env before any module (e.g. db/index.ts) reads process.env
import express from 'express';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
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

function requestedMemoryTool(message: string): 'save_personal_memory' | 'remove_personal_memory' | undefined {
  const normalized = (message || '').trim().toLowerCase();
  const remove = /\b(forget|remove|delete)\b.{0,35}\bmemory\b|\b(vergiss|lösche|entferne)\b.{0,25}\b(erinnerung|gedächtnis|memory)?\b/.test(normalized);
  if (remove) return 'remove_personal_memory';
  const save = /\b(add|save|store|remember)\b.{0,35}\bmemory\b|\bmemory\b.{0,35}\b(add|save|store)\b|\b(merk|merke|speicher|speichere)\b.{0,20}\b(dir|erinnerung|gedächtnis)?\b/.test(normalized);
  return save ? 'save_personal_memory' : undefined;
}

const EXERCISE_ALIASES: Record<string, string> = {
  kniebuge: 'Barbell Back Squat',
  kniebeuge: 'Barbell Back Squat',
  squat: 'Barbell Back Squat',
  'back squat': 'Barbell Back Squat',
  'barbell squat': 'Barbell Back Squat',
  rdl: 'Romanian Deadlift',
  'romanian dead lift': 'Romanian Deadlift',
  schragbank: 'Schrägbank 30°',
  'schragbank 30': 'Schrägbank 30°',
  'schragbank 30 grad': 'Schrägbank 30°',
  'schraegbank 30 grad': 'Schrägbank 30°',
  'incline barbell press': 'Schrägbank 30°',
  'rudern maschine': 'Rudermaschine',
  'chest supported row': 'Rudermaschine',
  'schulterdrucken kh': 'Schulterdrücken KH',
  'dumbbell shoulder press': 'Schulterdrücken KH',
  'cable bicep curl': 'Bizeps Kabel',
  'kabel bizeps': 'Bizeps Kabel',
  'kabel seitheben': 'Kabel-Seitheben',
  'pallof press kabelzug': 'Pallof Press',
};

function normalizeExerciseName(value: string) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveCanonicalExercise(exercises: any[], query: string) {
  const normalized = normalizeExerciseName(query);
  const byName = new Map(exercises.map((item) => [normalizeExerciseName(item.name), item]));
  const direct = byName.get(normalized);
  if (direct) return { match: direct, candidates: [] };
  const aliasTarget = EXERCISE_ALIASES[normalized];
  const aliasMatch = aliasTarget ? byName.get(normalizeExerciseName(aliasTarget)) : undefined;
  if (aliasMatch) return { match: aliasMatch, candidates: [] };
  const candidates = exercises.filter((item) => {
    const candidate = normalizeExerciseName(item.name);
    return normalized && (candidate.includes(normalized) || normalized.includes(candidate));
  });
  return { match: candidates.length === 1 ? candidates[0] : null, candidates };
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

let aiMetricsTableReady = false;
let chatSessionsTableReady = false;

async function ensureChatSessionsTable() {
  if (chatSessionsTableReady) return;
  await createPool().query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New chat',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ix_chat_sessions_user_id ON chat_sessions(user_id);
  `);
  chatSessionsTableReady = true;
}

async function ensureDefaultChatSession(userId: number) {
  await ensureChatSessionsTable();
  await createPool().query(
    `INSERT INTO chat_sessions (id, user_id, title) VALUES ($1, $2, 'Training chat')
     ON CONFLICT (id) DO NOTHING`,
    [String(userId), userId],
  );
}

async function ownsChatSession(userId: number, threadId: string) {
  const result = await createPool().query(
    'SELECT 1 FROM chat_sessions WHERE id = $1 AND user_id = $2',
    [threadId, userId],
  );
  return result.rowCount === 1;
}

async function compactChatIfNeeded(userId: number, threadId: string) {
  const result = await createPool().query(
    `SELECT id, role, content FROM messages
     WHERE user_id = $1 AND thread_id = $2 AND summary_id IS NULL
     ORDER BY id ASC`,
    [userId, threadId],
  );
  const tokenEstimate = result.rows.reduce((sum, row) => sum + String(row.content || '').length, 0) / 4;
  if (tokenEstimate <= 2400 || result.rows.length <= 4) return { compacted: false, usage: null };

  const rowsToCompact = result.rows.slice(0, -4);
  const transcript = rowsToCompact.map((row) => `[${row.role.toUpperCase()}] ${row.content}`).join('\n');
  const response = await generateContentResilient({
    contents: `Summarize this older fitness-coaching conversation. Preserve only user-stated constraints, preferences, corrections and open questions. Do not repeat workout loads already stored in the database. Be concise.\n\n${transcript.slice(0, 12000)}`,
    config: { systemInstruction: 'Return a concise factual memory summary without markdown preamble.' },
  });
  const summaryText = String(response.text || '').trim() || transcript.slice(0, 700);
  const summaryId = randomUUID().replace(/-/g, '').slice(0, 8);
  const client = await createPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO summaries (id, user_id, thread_id, description, summary_text, full_content)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [summaryId, userId, threadId, 'Earlier conversation', summaryText, transcript],
    );
    await client.query(
      'UPDATE messages SET summary_id = $1 WHERE user_id = $2 AND thread_id = $3 AND id = ANY($4::int[])',
      [summaryId, userId, threadId, rowsToCompact.map((row) => row.id)],
    );
    await client.query('COMMIT');
    return { compacted: true, usage: response.usage || null };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ensureAiMetricsTable() {
  if (aiMetricsTableReady) return;
  await createPool().query(`
    CREATE TABLE IF NOT EXISTS ai_request_metrics (
      id BIGSERIAL PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'success',
      provider TEXT,
      model TEXT,
      total_ms INTEGER NOT NULL DEFAULT 0,
      round_trip_ms INTEGER,
      agent_steps INTEGER NOT NULL DEFAULT 0,
      model_ms INTEGER NOT NULL DEFAULT 0,
      tool_ms INTEGER NOT NULL DEFAULT 0,
      context_ms INTEGER NOT NULL DEFAULT 0,
      persistence_ms INTEGER NOT NULL DEFAULT 0,
      slowest_step_name TEXT,
      slowest_step_kind TEXT,
      slowest_step_ms INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      tools_used JSONB,
      steps JSONB,
      error_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ix_ai_request_metrics_user_id ON ai_request_metrics(user_id);
    CREATE INDEX IF NOT EXISTS ix_ai_request_metrics_thread_id ON ai_request_metrics(thread_id);
    CREATE INDEX IF NOT EXISTS ix_ai_request_metrics_created_at ON ai_request_metrics(created_at);
  `);
  aiMetricsTableReady = true;
}

async function writeAiRequestMetric(params: {
  userId: number;
  threadId: string;
  trace: any;
  usage?: any;
  toolsUsed?: string[];
  status?: string;
  errorType?: string;
}) {
  try {
    await ensureAiMetricsTable();
    const usage = params.usage || {};
    const slowest = params.trace.slowestStep || {};
    await createPool().query(
      `INSERT INTO ai_request_metrics (
        request_id, user_id, thread_id, status, provider, model,
        total_ms, agent_steps, model_ms, tool_ms, context_ms, persistence_ms,
        slowest_step_name, slowest_step_kind, slowest_step_ms,
        input_tokens, output_tokens, total_tokens, estimated_cost_usd,
        tools_used, steps, error_type
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15,
        $16, $17, $18, $19,
        $20::jsonb, $21::jsonb, $22
      )`,
      [
        params.trace.requestId, params.userId, params.threadId,
        params.status || 'success', usage.provider || null, usage.model || null,
        params.trace.totalMs || 0, params.trace.agentSteps || 0,
        params.trace.modelMs || 0, params.trace.toolMs || 0,
        params.trace.contextMs || 0, params.trace.persistenceMs || 0,
        slowest.name || null, slowest.kind || null, slowest.durationMs || null,
        usage.inputTokens || 0, usage.outputTokens || 0, usage.totalTokens || 0,
        usage.estimatedCostUsd || 0, JSON.stringify(params.toolsUsed || []),
        JSON.stringify(params.trace.steps || []), params.errorType || null,
      ],
    );
  } catch (error: any) {
    console.warn(JSON.stringify({
      event: 'ai_metric_write_failed',
      requestId: params.trace?.requestId,
      errorType: error?.constructor?.name || 'Error',
    }));
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
  try {
    await ensureAiMetricsTable();
  } catch (error: any) {
    console.warn(`[observability] schema check failed: ${error?.constructor?.name || 'Error'}`);
  }

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

    await ensureDefaultChatSession(sqlUser.id);
    const threadId = String(req.query.threadId || sqlUser.id);
    if (!await ownsChatSession(sqlUser.id, threadId)) return res.status(404).json({ error: 'Chat session not found' });
    const result = await createPool().query(
      `SELECT id, role, content, created_at
       FROM messages
       WHERE user_id = $1 AND thread_id = $2 AND summary_id IS NULL
       ORDER BY id DESC
       LIMIT 200`,
      [sqlUser.id, threadId],
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

    await ensureDefaultChatSession(sqlUser.id);
    const threadId = String(req.query.threadId || sqlUser.id);
    if (!await ownsChatSession(sqlUser.id, threadId)) return res.status(404).json({ error: 'Chat session not found' });
    await createPool().query(
      'DELETE FROM messages WHERE user_id = $1 AND thread_id = $2',
      [sqlUser.id, threadId],
    );
    await createPool().query(
      'DELETE FROM summaries WHERE user_id = $1 AND thread_id = $2',
      [sqlUser.id, threadId],
    );
    res.json({ success: true });
  });

  app.get('/api/ai/sessions', async (req, res) => {
    const sqlUser = await getUserFromRequest(req);
    if (!sqlUser) return res.status(401).json({ error: 'Authentication required' });
    await ensureDefaultChatSession(sqlUser.id);
    const result = await createPool().query(
      `SELECT id, title, created_at, updated_at FROM chat_sessions
       WHERE user_id = $1 ORDER BY updated_at DESC, created_at DESC`,
      [sqlUser.id],
    );
    res.json({ sessions: result.rows.map((row) => ({
      id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
    })) });
  });

  app.get('/api/ai/usage', async (req, res) => {
    const sqlUser = await getUserFromRequest(req);
    if (!sqlUser) return res.status(401).json({ error: 'Authentication required' });
    await ensureAiMetricsTable();
    const result = await createPool().query(
      `SELECT
         COUNT(*)::int AS all_requests,
         COALESCE(SUM(input_tokens), 0)::bigint AS all_input_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint AS all_output_tokens,
         COALESCE(SUM(total_tokens), 0)::bigint AS all_total_tokens,
         COALESCE(SUM(estimated_cost_usd), 0)::double precision AS all_cost,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()))::int AS month_requests,
         COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::bigint AS month_input_tokens,
         COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::bigint AS month_output_tokens,
         COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::bigint AS month_total_tokens,
         COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::double precision AS month_cost,
         MIN(created_at) AS tracking_since
       FROM ai_request_metrics WHERE user_id = $1`,
      [sqlUser.id],
    );
    const row = result.rows[0];
    const period = (prefix: 'all' | 'month') => ({
      requests: Number(row[`${prefix}_requests`] || 0),
      inputTokens: Number(row[`${prefix}_input_tokens`] || 0),
      outputTokens: Number(row[`${prefix}_output_tokens`] || 0),
      totalTokens: Number(row[`${prefix}_total_tokens`] || 0),
      estimatedCostUsd: Number(row[`${prefix}_cost`] || 0),
    });
    res.json({ allTime: period('all'), currentMonth: period('month'), trackingSince: row.tracking_since });
  });

  app.post('/api/ai/sessions', async (req, res) => {
    const sqlUser = await getUserFromRequest(req);
    if (!sqlUser) return res.status(401).json({ error: 'Authentication required' });
    await ensureChatSessionsTable();
    const id = randomUUID();
    const title = String(req.body.title || 'New chat').trim().slice(0, 80) || 'New chat';
    await createPool().query(
      'INSERT INTO chat_sessions (id, user_id, title) VALUES ($1, $2, $3)',
      [id, sqlUser.id, title],
    );
    res.json({ session: { id, title } });
  });

  app.delete('/api/ai/sessions/:threadId', async (req, res) => {
    const sqlUser = await getUserFromRequest(req);
    if (!sqlUser) return res.status(401).json({ error: 'Authentication required' });
    const threadId = String(req.params.threadId);
    if (!await ownsChatSession(sqlUser.id, threadId)) return res.status(404).json({ error: 'Chat session not found' });
    const client = await createPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM tool_logs WHERE user_id = $1 AND thread_id = $2', [sqlUser.id, threadId]);
      await client.query('DELETE FROM messages WHERE user_id = $1 AND thread_id = $2', [sqlUser.id, threadId]);
      await client.query('DELETE FROM summaries WHERE user_id = $1 AND thread_id = $2', [sqlUser.id, threadId]);
      await client.query('DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2', [threadId, sqlUser.id]);
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  // Gemini AI Assistant Endpoint with full database write/action capabilities
  app.post('/api/ai/chat', async (req, res) => {
    const requestStarted = performance.now();
    const requestId = randomUUID();
    const traceSteps: any[] = [];
    let sqlUser: any = null;
    let requestThreadId = 'anonymous';
    try {
      const { message, activeWorkoutState } = req.body;
      let db = readDatabase();
      sqlUser = await getUserFromRequest(req);
      const threadId = String(req.body.threadId || sqlUser?.id || 'anonymous');
      requestThreadId = threadId;
      let chatHistory: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
      let summaryMemory = '';
      if (sqlUser) {
        try {
          await ensureDefaultChatSession(sqlUser.id);
          if (!await ownsChatSession(sqlUser.id, threadId)) return res.status(404).json({ error: 'Chat session not found' });
          const cloudDb = await getUserDatabaseState(sqlUser.id);
          if (cloudDb.exercises.length === 0) {
            cloudDb.exercises = INITIAL_DB.exercises;
          }
          db = cloudDb;
          const historyResult = await createPool().query(
            `SELECT role, content FROM messages
             WHERE user_id = $1 AND thread_id = $2 AND summary_id IS NULL
             ORDER BY id DESC LIMIT 20`,
            [sqlUser.id, threadId],
          );
          chatHistory = historyResult.rows.reverse().map((entry) => ({
            role: entry.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: entry.content }],
          }));
          const summaries = await createPool().query(
            `SELECT summary_text FROM summaries
             WHERE user_id = $1 AND thread_id = $2 ORDER BY created_at DESC LIMIT 3`,
            [sqlUser.id, threadId],
          );
          summaryMemory = summaries.rows.map((row) => row.summary_text).join('\n\n');
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

      const currentBerlinTime = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Berlin', weekday: 'long', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date());
      const systemInstruction = `You are GymPulse AI, a concise fitness assistant with direct read/write access to Tim's database.
CURRENT LOCAL DATE AND TIME: ${currentBerlinTime} (Europe/Berlin).
Resolve relative dates such as today, yesterday and tomorrow from this value before calling tools.
RESPONSE STYLE: DIRECT AND PRECISE.
- ZERO greetings, NO parasocial fluff, NO "Hey Tim!", NO "What are we tackling today?".
- Outside workout drafts, answer in 1-3 short lines or concise bullet points.
- Workout drafts must be complete enough to verify every exercise, set, rep and load.
- If the user explicitly asks to remember, save, or add a durable fact to memory, call \`save_personal_memory\` in that same turn. Do not claim that you cannot save it.
- Do not automatically store facts the user did not explicitly ask you to remember.

ACTIONS AVAILABLE:
- To save personal memory/goals: call \`save_personal_memory\`
- To remove personal memory: call \`remove_personal_memory\`
- To log a workout: call \`log_workout\`
- To add an exercise: call \`add_exercise\`
- To update profile: call \`update_profile\`
- To delete a workout: call \`delete_workout\`
- Resolve colloquial, abbreviated, translated, or non-library exercise names with
  \`resolve_exercise\`, then use its canonical exerciseName in every write tool.
- If resolution returns not_found, call \`add_exercise\` once and retry the original
  write. Never invent a temporary exercise ID or alternate spelling.
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

--- COMPRESSED MEMORY FROM EARLIER TURNS ---
${summaryMemory || 'None yet.'}
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
                  name: 'resolve_exercise',
                  description: 'Resolve colloquial German or English exercise wording to the permanent canonical library name and ID. Call before logging when a name was not copied exactly from the exercise library.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: { type: Type.STRING, description: 'Exercise wording to resolve, e.g. Kniebeuge or RDL' }
                    },
                    required: ['query']
                  }
                },
                {
                  name: 'log_workout',
                  description: 'Log a completed workout only when the user says it was performed. Exercise names must resolve to permanent library exercises; call resolve_exercise first for colloquial names. Preserve exact dates and sets and never invent values.',
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
      traceSteps.push({
        kind: 'context',
        name: 'Database and context',
        durationMs: Math.round(performance.now() - requestStarted),
      });

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
        const toolStarted = performance.now();
        const args: any = call.args || {};
        const actionCountBefore = actionsExecuted.length;
        let informationalResult: any = null;
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

          } else if (call.name === 'resolve_exercise') {
            const resolved = resolveCanonicalExercise(db.exercises, args.query || '');
            informationalResult = resolved.match
              ? { status: 'resolved', exerciseName: resolved.match.name, id: resolved.match.id, category: resolved.match.category }
              : resolved.candidates.length > 0
                ? { status: 'ambiguous', candidates: resolved.candidates.slice(0, 5).map((item: any) => item.name) }
                : { status: 'not_found', instruction: 'Call add_exercise before logging this genuinely new movement.' };

          } else if (call.name === 'log_workout') {
            const todayStr = new Date().toISOString().split('T')[0];
            const resolvedExercises = (args.exercises || []).map((item: any) => ({
              item,
              ...resolveCanonicalExercise(db.exercises, item.exerciseName || ''),
            }));
            const unresolved = resolvedExercises.filter((item: any) => !item.match);
            if (unresolved.length > 0) {
              traceSteps.push({ kind: 'tool', name: call.name, durationMs: Math.round(performance.now() - toolStarted), status: 'error' });
              return JSON.stringify({
                success: false,
                error: `Unknown or ambiguous exercises: ${unresolved.map((item: any) => item.item.exerciseName).join(', ')}`,
                instruction: 'Call resolve_exercise for aliases or add_exercise for a genuinely new movement, then retry log_workout.',
              });
            }
            const workoutExercises = (args.exercises || []).map((exItem: any, exIdx: number) => {
              const matchingEx = resolvedExercises[exIdx].match;
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
                exerciseId: matchingEx.id,
                exerciseName: matchingEx.name,
                category: matchingEx.category,
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
            const resolvedPlanned = (args.exercises || []).map((planned: any) => ({
              planned,
              ...resolveCanonicalExercise(db.exercises, planned.exerciseName || ''),
            }));
            const unresolved = resolvedPlanned.filter((item: any) => !item.match);
            if (unresolved.length > 0) {
              traceSteps.push({ kind: 'tool', name: call.name, durationMs: Math.round(performance.now() - toolStarted), status: 'error' });
              return JSON.stringify({
                success: false,
                error: `Unknown or ambiguous exercises: ${unresolved.map((item: any) => item.planned.exerciseName).join(', ')}`,
                instruction: 'Resolve or add every exercise before retrying start_workout_session.',
              });
            }
            const sessionExercises = (args.exercises || []).map((planned: any, idx: number) => {
              const matchingEx = resolvedPlanned[idx].match;
              return {
                id: `we_${Date.now()}_${idx}`,
                exerciseId: matchingEx.id,
                exerciseName: matchingEx.name,
                category: matchingEx.category,
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
        traceSteps.push({
          kind: 'tool',
          name: call.name,
          durationMs: Math.round(performance.now() - toolStarted),
          status: currentAction || informationalResult ? 'success' : 'no_change',
        });
        if (informationalResult) return JSON.stringify({ success: true, tool: call.name, result: informationalResult });
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
      const memoryToolName = requestedMemoryTool(message);
      for (let step = 0; step < 4; step += 1) {
        const modelStarted = performance.now();
        response = await generateContentResilient({
          ...aiRequest,
          forceToolName: step === 0
            ? (canStartWorkout ? 'start_workout_session' : memoryToolName)
            : undefined,
          claudeMessages,
        });
        traceSteps.push({
          kind: 'llm',
          name: `${response.provider === 'claude' ? 'Claude' : 'Gemini'} round ${step + 1}`,
          durationMs: Math.round(performance.now() - modelStarted),
          step: step + 1,
          provider: response.provider,
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
      } else if (memoryToolName && !toolsUsed.includes(memoryToolName)) {
        replyText = "Ich konnte die gewünschte Änderung nicht im persönlichen Gedächtnis speichern. Bitte versuche es erneut.";
      } else if (claimsWorkoutStartedWithoutTool(replyText, actionExecuted)) {
        replyText = canStartWorkout
          ? "Ich konnte das Workout-Tool nicht erfolgreich auslösen. Das Workout wurde nicht gestartet; bitte versuche die Bestätigung erneut."
          : `Das Workout wurde noch nicht gestartet. Ich muss zuerst den vollständigen Plan bestätigen lassen: ${WORKOUT_CONFIRMATION_QUESTION}`;
      }

      const persistenceStarted = performance.now();
      if (sqlUser) {
        await createPool().query(
          `INSERT INTO messages (user_id, thread_id, role, content)
           VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4)`,
          [sqlUser.id, threadId, message, replyText],
        );
        const cleanTitle = String(message || '').trim().replace(/\s+/g, ' ');
        await createPool().query(
          `UPDATE chat_sessions
           SET title = CASE WHEN title = 'New chat' THEN $1 ELSE title END, updated_at = NOW()
           WHERE id = $2 AND user_id = $3`,
          [cleanTitle.length > 57 ? `${cleanTitle.slice(0, 57)}...` : cleanTitle || 'New chat', threadId, sqlUser.id],
        );
      }
      traceSteps.push({
        kind: 'persistence',
        name: 'Persist response',
        durationMs: Math.round(performance.now() - persistenceStarted),
      });
      let historyCompacted = false;
      if (sqlUser) {
        const summaryStarted = performance.now();
        const compaction = await compactChatIfNeeded(sqlUser.id, threadId);
        historyCompacted = compaction.compacted;
        if (historyCompacted) {
          const summaryUsage = compaction.usage || {};
          usage.inputTokens += summaryUsage.inputTokens || 0;
          usage.outputTokens += summaryUsage.outputTokens || 0;
          usage.cacheCreationTokens += summaryUsage.cacheCreationTokens || 0;
          usage.cacheReadTokens += summaryUsage.cacheReadTokens || 0;
          usage.totalTokens += (summaryUsage.inputTokens || 0) + (summaryUsage.outputTokens || 0)
            + (summaryUsage.cacheCreationTokens || 0) + (summaryUsage.cacheReadTokens || 0);
          usage.estimatedCostUsd += summaryUsage.estimatedCostUsd || 0;
          traceSteps.push({
            kind: 'llm', name: 'Conversation summary',
            durationMs: Math.round(performance.now() - summaryStarted),
            provider: claude ? 'claude' : 'gemini',
          });
        }
      }
      const slowestStep = traceSteps.reduce(
        (slowest, item) => !slowest || item.durationMs > slowest.durationMs ? item : slowest,
        null,
      );
      const trace = {
        requestId,
        totalMs: Math.round(performance.now() - requestStarted),
        agentSteps: traceSteps.filter((item) => item.kind === 'llm').length,
        modelMs: traceSteps.filter((item) => item.kind === 'llm').reduce((sum, item) => sum + item.durationMs, 0),
        toolMs: traceSteps.filter((item) => item.kind === 'tool').reduce((sum, item) => sum + item.durationMs, 0),
        contextMs: traceSteps.filter((item) => item.kind === 'context').reduce((sum, item) => sum + item.durationMs, 0),
        persistenceMs: traceSteps.filter((item) => item.kind === 'persistence').reduce((sum, item) => sum + item.durationMs, 0),
        slowestStep,
        steps: traceSteps,
      };
      console.info(JSON.stringify({ event: 'ai_trace', ...trace }));
      if (sqlUser) {
        await writeAiRequestMetric({
          userId: sqlUser.id,
          threadId,
          trace,
          usage,
          toolsUsed,
        });
      }

      res.json({
        reply: replyText,
        actionExecuted,
        actionsExecuted,
        toolsUsed,
        usage,
        trace,
        db,
        historyCompacted,
      });
    } catch (error: any) {
      console.error("AI Chat Error:", error);
      if (sqlUser) {
        await writeAiRequestMetric({
          userId: sqlUser.id,
          threadId: requestThreadId,
          trace: {
            requestId,
            totalMs: Math.round(performance.now() - requestStarted),
            agentSteps: traceSteps.filter((item) => item.kind === 'llm').length,
            modelMs: traceSteps.filter((item) => item.kind === 'llm').reduce((sum, item) => sum + item.durationMs, 0),
            toolMs: traceSteps.filter((item) => item.kind === 'tool').reduce((sum, item) => sum + item.durationMs, 0),
            contextMs: traceSteps.filter((item) => item.kind === 'context').reduce((sum, item) => sum + item.durationMs, 0),
            persistenceMs: 0,
            slowestStep: null,
            steps: traceSteps,
          },
          status: 'error',
          errorType: error?.constructor?.name || 'Error',
        });
      }
      const temporary = isTransientGeminiError(error);
      res.status(temporary ? 503 : 500).json({
        error: error.message || "Failed to generate AI response",
        reply: temporary
          ? "Der AI-Coach ist gerade vorübergehend ausgelastet. Bitte sende die Nachricht in einem Moment erneut."
          : "Der AI-Coach konnte die Anfrage nicht verarbeiten. Bitte prüfe die Serverkonfiguration.",
      });
    }
  });

  app.patch('/api/ai/metrics/roundtrip', async (req, res) => {
    const sqlUser = await getUserFromRequest(req);
    if (!sqlUser) return res.status(401).json({ error: 'Authentication required' });
    try {
      await ensureAiMetricsTable();
      const result = await createPool().query(
        `UPDATE ai_request_metrics
         SET round_trip_ms = $1
         WHERE request_id = $2 AND user_id = $3`,
        [Math.max(0, Number(req.body.roundTripMs) || 0), String(req.body.requestId || ''), sqlUser.id],
      );
      res.json({ updated: result.rowCount === 1 });
    } catch (error: any) {
      console.warn(`[observability] roundtrip update failed: ${error?.constructor?.name || 'Error'}`);
      res.status(500).json({ updated: false });
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
