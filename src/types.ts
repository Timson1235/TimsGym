export type MuscleCategory = 
  | 'Chest' 
  | 'Back' 
  | 'Legs' 
  | 'Shoulders' 
  | 'Arms' 
  | 'Core' 
  | 'Cardio' 
  | 'Other';

export type EquipmentType = 
  | 'Barbell' 
  | 'Dumbbell' 
  | 'Machine' 
  | 'Cable' 
  | 'Bodyweight' 
  | 'Other';

export type SetType = 'warmup' | 'working' | 'drop' | 'failure';

export interface PersonalRecord {
  maxWeight: number;
  maxReps: number;
  calculatedOneRepMax: number;
  date: string; // ISO string
}

export interface Exercise {
  id: string;
  name: string;
  category: MuscleCategory;
  equipment: EquipmentType;
  instructions?: string;
  isCustom?: boolean;
  personalRecord?: PersonalRecord;
}

export interface WorkoutSet {
  id: string;
  setNumber: number;
  type: SetType;
  weight: number;
  reps: number;
  rpe?: number; // 1-10
  completed: boolean;
  notes?: string;
}

export interface WorkoutExercise {
  id: string;
  exerciseId: string;
  exerciseName: string;
  category: MuscleCategory;
  sets: WorkoutSet[];
  notes?: string;
}

export interface WorkoutSession {
  id: string;
  title: string;
  date: string; // ISO date format YYYY-MM-DD
  startTime?: string;
  endTime?: string;
  durationMinutes: number;
  exercises: WorkoutExercise[];
  notes?: string;
  totalVolume: number;
  isCompleted: boolean;
}

export interface RoutineTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  exercises: { exerciseId: string; defaultSets: number; defaultReps: number }[];
}

export interface UserProfile {
  name: string;
  preferredUnit: 'lbs' | 'kg';
  experienceLevel: 'Beginner' | 'Intermediate' | 'Advanced';
  primaryGoal: 'Strength' | 'Hypertrophy' | 'Endurance' | 'General Fitness' | 'Weight Loss' | 'Athleticism & Jump Power';
  personalMemories?: string[]; // Permanent memories & constraints (e.g. goals, injuries, preferences)
  notes?: string;
}

export interface DatabaseState {
  profile: UserProfile;
  exercises: Exercise[];
  workouts: WorkoutSession[];
  templates: RoutineTemplate[];
}

export interface AIChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  suggestedAction?: {
    type: 'apply_weight' | 'add_exercise' | 'start_routine';
    exerciseId?: string;
    exerciseName?: string;
    weight?: number;
    reps?: number;
    routineId?: string;
  };
}

export interface AISuggestionResponse {
  recommendation: string;
  suggestedWeight?: number;
  suggestedReps?: number;
  suggestedSets?: number;
  reasoning: string;
}
