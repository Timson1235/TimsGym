import { eq, and } from 'drizzle-orm';
import { db } from './index.ts';
import { users, profiles, exercises, workouts } from './schema.ts';
import { DatabaseState, Exercise, WorkoutSession, UserProfile } from '../types.ts';

const DEFAULT_SEED_EXERCISES: Omit<Exercise, 'personalRecord'>[] = [
  {
    id: "ex_1",
    name: "Barbell Bench Press",
    category: "Chest",
    equipment: "Barbell",
    instructions: "Lie on bench, grip bar slightly wider than shoulder width. Lower bar smoothly to mid-chest and press up explosively.",
    isCustom: false,
  },
  {
    id: "ex_2",
    name: "Incline Dumbbell Press",
    category: "Chest",
    equipment: "Dumbbell",
    instructions: "Set bench to 30-45 degree incline. Press dumbbells up over upper chest while maintaining core tension.",
    isCustom: false,
  },
  {
    id: "ex_3",
    name: "Barbell Back Squat",
    category: "Legs",
    equipment: "Barbell",
    instructions: "Place bar across upper traps. Stand shoulder-width apart, brace core, sit hips down and back below parallel.",
    isCustom: false,
  },
  {
    id: "ex_4",
    name: "Romanian Deadlift",
    category: "Legs",
    equipment: "Barbell",
    instructions: "Hinge at hips with slight knee bend, push glutes back until hamstring stretch, then drive hips forward.",
    isCustom: false,
  },
  {
    id: "ex_5",
    name: "Lat Pulldown",
    category: "Back",
    equipment: "Cable",
    instructions: "Grip wide bar, pull down to upper chest while squeezing shoulder blades down and back.",
    isCustom: false,
  },
  {
    id: "ex_6",
    name: "Barbell Overhead Press",
    category: "Shoulders",
    equipment: "Barbell",
    instructions: "Stand tall, rack bar on collarbone, press straight up overhead while locking out shoulders and glutes.",
    isCustom: false,
  },
  {
    id: "ex_7",
    name: "Dumbbell Bicep Curl",
    category: "Arms",
    equipment: "Dumbbell",
    instructions: "Stand shoulder-width apart, curl weight up keeping elbows pinned to sides, squeeze peak contraction.",
    isCustom: false,
  },
  {
    id: "ex_8",
    name: "Tricep Rope Pushdown",
    category: "Arms",
    equipment: "Cable",
    instructions: "Keep elbows fixed by torso, extend arms down and pull rope ends apart at bottom for full tricep lock.",
    isCustom: false,
  }
];

const DEFAULT_TEMPLATES = [
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
];

export async function getOrCreateUser(uid: string, email: string, displayName?: string) {
  try {
    const result = await db
      .insert(users)
      .values({ uid, email })
      .onConflictDoUpdate({
        target: users.uid,
        set: { email },
      })
      .returning();

    const user = result[0];
    const initialName = displayName || email.split('@')[0] || 'Athlete';

    // Ensure default profile exists
    const existingProfiles = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, user.id));

    if (existingProfiles.length === 0) {
      await db.insert(profiles).values({
        userId: user.id,
        name: initialName,
        preferredUnit: 'kg',
        experienceLevel: 'Intermediate',
        primaryGoal: 'Hypertrophy',
        personalMemories: [
          'Fokus auf progressive Überlastung & saubere Technik',
          'Ziel: Muskelaufbau & Kraftsteigerung'
        ],
        notes: '',
      });
    }

    // Ensure initial exercise set is seeded for this user
    const userExerciseCount = await db
      .select()
      .from(exercises)
      .where(eq(exercises.userId, user.id));

    if (userExerciseCount.length === 0) {
      for (const ex of DEFAULT_SEED_EXERCISES) {
        await db.insert(exercises).values({
          id: `${ex.id}_${user.id}`,
          userId: user.id,
          name: ex.name,
          category: ex.category,
          equipment: ex.equipment,
          instructions: ex.instructions || null,
          isCustom: false,
          personalRecord: null,
        }).onConflictDoNothing();
      }
    }

    return user;
  } catch (error) {
    console.error('Error in getOrCreateUser:', error);
    throw new Error('Database operation failed', { cause: error });
  }
}

export async function getUserDatabaseState(userId: number): Promise<DatabaseState> {
  try {
    // 1. Fetch profile
    const profileRows = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));

    const userProfile: UserProfile = profileRows.length > 0
      ? {
          name: profileRows[0].name,
          preferredUnit: (profileRows[0].preferredUnit as 'lbs' | 'kg') || 'kg',
          experienceLevel: (profileRows[0].experienceLevel as any) || 'Intermediate',
          primaryGoal: (profileRows[0].primaryGoal as any) || 'Hypertrophy',
          personalMemories: Array.isArray(profileRows[0].personalMemories) ? (profileRows[0].personalMemories as string[]) : [],
          notes: profileRows[0].notes || undefined,
        }
      : {
          name: 'Athlete',
          preferredUnit: 'kg',
          experienceLevel: 'Intermediate',
          primaryGoal: 'Hypertrophy',
          personalMemories: ['Fokus auf progressive Überlastung & saubere Technik'],
        };

    // 2. Fetch custom/user exercises
    const exerciseRows = await db
      .select()
      .from(exercises)
      .where(eq(exercises.userId, userId));

    let userExercises: Exercise[] = exerciseRows.map((ex) => ({
      id: ex.id,
      name: ex.name,
      category: ex.category as any,
      equipment: ex.equipment as any,
      instructions: ex.instructions || undefined,
      isCustom: ex.isCustom || false,
      personalRecord: (ex.personalRecord as any) || undefined,
    }));

    if (userExercises.length === 0) {
      userExercises = DEFAULT_SEED_EXERCISES.map(e => ({ ...e, id: `${e.id}_${userId}` }));
    }

    // 3. Fetch workouts
    const workoutRows = await db
      .select()
      .from(workouts)
      .where(eq(workouts.userId, userId));

    const userWorkouts: WorkoutSession[] = workoutRows.map((w) => {
      const exData = (w.exercisesData as any) || [];
      return {
        id: w.id,
        title: w.title,
        date: w.date,
        durationMinutes: w.durationMinutes,
        totalVolume: w.totalVolume,
        isCompleted: w.isCompleted ?? true,
        notes: w.notes || undefined,
        exercises: exData,
      };
    });

    // Map template exercise IDs to this user's exercise IDs
    const templatesWithUserIds = DEFAULT_TEMPLATES.map(tpl => ({
      ...tpl,
      exercises: tpl.exercises.map(item => {
        const matchingEx = userExercises.find(e => e.name.toLowerCase() === DEFAULT_SEED_EXERCISES.find(se => se.id === item.exerciseId)?.name.toLowerCase());
        return {
          ...item,
          exerciseId: matchingEx ? matchingEx.id : item.exerciseId
        };
      })
    }));

    return {
      profile: userProfile,
      exercises: userExercises,
      workouts: userWorkouts,
      templates: templatesWithUserIds,
    };
  } catch (error) {
    console.error('Error fetching database state:', error);
    throw new Error('Failed to load user data', { cause: error });
  }
}

export async function updateUserProfile(userId: number, newProfile: Partial<UserProfile>) {
  try {
    await db
      .update(profiles)
      .set({
        ...(newProfile.name !== undefined && { name: newProfile.name }),
        ...(newProfile.preferredUnit !== undefined && { preferredUnit: newProfile.preferredUnit }),
        ...(newProfile.experienceLevel !== undefined && { experienceLevel: newProfile.experienceLevel }),
        ...(newProfile.primaryGoal !== undefined && { primaryGoal: newProfile.primaryGoal }),
        ...(newProfile.personalMemories !== undefined && { personalMemories: newProfile.personalMemories }),
        ...(newProfile.notes !== undefined && { notes: newProfile.notes }),
      })
      .where(eq(profiles.userId, userId));
  } catch (error) {
    console.error('Error updating profile:', error);
    throw new Error('Failed to update profile', { cause: error });
  }
}

export async function saveUserExercise(userId: number, exercise: Exercise) {
  try {
    await db
      .insert(exercises)
      .values({
        id: exercise.id,
        userId: userId,
        name: exercise.name,
        category: exercise.category,
        equipment: exercise.equipment,
        instructions: exercise.instructions || null,
        isCustom: exercise.isCustom || false,
        personalRecord: exercise.personalRecord || null,
      })
      .onConflictDoUpdate({
        target: exercises.id,
        set: {
          name: exercise.name,
          category: exercise.category,
          equipment: exercise.equipment,
          instructions: exercise.instructions || null,
          personalRecord: exercise.personalRecord || null,
        },
      });
  } catch (error) {
    console.error('Error saving exercise:', error);
    throw new Error('Failed to save exercise', { cause: error });
  }
}

export async function saveUserWorkout(userId: number, session: WorkoutSession) {
  try {
    await db
      .insert(workouts)
      .values({
        id: session.id,
        userId: userId,
        title: session.title,
        date: session.date,
        durationMinutes: session.durationMinutes,
        totalVolume: session.totalVolume,
        isCompleted: session.isCompleted,
        notes: session.notes || null,
        exercisesData: session.exercises,
      })
      .onConflictDoUpdate({
        target: workouts.id,
        set: {
          title: session.title,
          date: session.date,
          durationMinutes: session.durationMinutes,
          totalVolume: session.totalVolume,
          isCompleted: session.isCompleted,
          notes: session.notes || null,
          exercisesData: session.exercises,
        },
      });
  } catch (error) {
    console.error('Error saving workout:', error);
    throw new Error('Failed to save workout', { cause: error });
  }
}

export async function deleteUserWorkout(userId: number, workoutId: string) {
  try {
    await db
      .delete(workouts)
      .where(and(eq(workouts.id, workoutId), eq(workouts.userId, userId)));
  } catch (error) {
    console.error('Error deleting workout:', error);
    throw new Error('Failed to delete workout', { cause: error });
  }
}
