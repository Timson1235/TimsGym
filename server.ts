import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
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
import { DatabaseState } from './src/types.ts';

dotenv.config();

const PORT = 3000;
const DB_FILE_PATH = path.join(process.cwd(), 'gym_database.json');

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

  // Gemini AI Assistant Endpoint with full database write/action capabilities
  app.post('/api/ai/chat', async (req, res) => {
    try {
      const { message, activeWorkoutState } = req.body;
      let db = readDatabase();
      const sqlUser = await getUserFromRequest(req);
      if (sqlUser) {
        try {
          const cloudDb = await getUserDatabaseState(sqlUser.id);
          if (cloudDb.exercises.length === 0) {
            cloudDb.exercises = INITIAL_DB.exercises;
          }
          db = cloudDb;
        } catch (e) {
          console.error('Error fetching cloud db for AI chat:', e);
        }
      }

      if (!ai) {
        return res.json({
          reply: "I am ready to assist, but GEMINI_API_KEY environment variable is not configured. Please set the key in Settings -> Secrets."
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
RESPONSE STYLE: EXTREMELY MINIMALIST AND DIRECT. 
- ZERO greetings, NO parasocial fluff, NO "Hey Tim!", NO "What are we tackling today?".
- Give facts, numbers, or action confirmations immediately. Max 1-3 short lines or concise bullet points.
- If the user shares a goal (e.g. "Ich will Muskeln aufbauen", "Gewicht verlieren", "Sprungkraft verbessern", "Habe Schulterschmerzen"), call \`save_personal_memory\` to permanently remember it!

ACTIONS AVAILABLE:
- To save personal memory/goals: call \`save_personal_memory\`
- To remove personal memory: call \`remove_personal_memory\`
- To log a workout: call \`log_workout\`
- To add an exercise: call \`add_exercise\`
- To update profile: call \`update_profile\`
- To delete a workout: call \`delete_workout\`
- To start a session: call \`start_workout_session\`

=== USER DATABASE CONTEXT ===
${profileInfo}

--- EXERCISE LIBRARY & PRs ---
${exerciseRecords}

--- RECENT WORKOUTS ---
${recentWorkouts}

--- CURRENT ACTIVE SESSION ---
${activeWorkoutContext}
=============================`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: message,
        config: {
          systemInstruction,
          temperature: 0.2,
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
                  description: 'Log a new completed workout session directly into the user history log.',
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
                  description: 'Delete a workout session from history by workout ID or title.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      searchOrId: { type: Type.STRING, description: 'Workout ID or title match string' }
                    },
                    required: ['searchOrId']
                  }
                },
                {
                  name: 'start_workout_session',
                  description: 'Start or pre-load an active workout session.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING, description: 'Workout session title' },
                      exerciseNames: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'List of exercise names to pre-load'
                      }
                    },
                    required: ['title', 'exerciseNames']
                  }
                }
              ]
            }
          ]
        },
      });

      let actionExecuted: any = null;

      // Handle function calls if triggered by Gemini
      if (response.functionCalls && response.functionCalls.length > 0) {
        for (const call of response.functionCalls) {
          const args: any = call.args || {};

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
            }

          } else if (call.name === 'start_workout_session') {
            const sessionExercises = (args.exerciseNames || []).map((name: string, idx: number) => {
              const matchingEx = db.exercises.find((e: any) => e.name.toLowerCase() === name.toLowerCase());
              const defaultWeight = matchingEx?.personalRecord?.maxWeight || 60;
              return {
                id: `we_${Date.now()}_${idx}`,
                exerciseId: matchingEx ? matchingEx.id : `ex_temp_${idx}`,
                exerciseName: matchingEx ? matchingEx.name : name,
                category: matchingEx ? matchingEx.category : 'Chest',
                sets: [
                  { id: `s_${Date.now()}_${idx}_1`, setNumber: 1, type: 'working', weight: defaultWeight, reps: 10, rpe: 8, completed: false },
                  { id: `s_${Date.now()}_${idx}_2`, setNumber: 2, type: 'working', weight: defaultWeight, reps: 10, rpe: 8, completed: false },
                  { id: `s_${Date.now()}_${idx}_3`, setNumber: 3, type: 'working', weight: defaultWeight, reps: 10, rpe: 8, completed: false }
                ]
              };
            });

            const newActiveSession = {
              id: `wk_${Date.now()}`,
              title: args.title || 'AI Initiated Session',
              date: new Date().toISOString().split('T')[0],
              durationMinutes: 0,
              totalVolume: 0,
              isCompleted: false,
              exercises: sessionExercises
            };

            actionExecuted = { type: 'session_started', data: newActiveSession };
          }
        }
      }

      // Generate response text
      let replyText = response.text;
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
          } else if (actionExecuted.type === 'session_started') {
            replyText = `🚀 **Workout Session Prepared!**\nI've pre-loaded **"${actionExecuted.data.title}"** with ${actionExecuted.data.exercises.length} exercises. Click **Resume / Jump to Active Workout** to start tracking set by set!`;
          }
        } else {
          replyText = "I have analyzed your request against your database logs. How else can I assist your workout today?";
        }
      }

      res.json({ reply: replyText, actionExecuted, db });
    } catch (error: any) {
      console.error("AI Chat Error:", error);
      res.status(500).json({ error: error.message || "Failed to generate AI response" });
    }
  });

  // Gemini Weight Recommendation Helper Endpoint
  app.post('/api/ai/suggest-weight', async (req, res) => {
    try {
      const { exerciseName, targetReps, targetRpe } = req.body;
      const db = readDatabase();

      if (!ai) {
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

      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.3,
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
