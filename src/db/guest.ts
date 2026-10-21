import { DatabaseState } from '../types';
import { DEFAULT_SEED_EXERCISES, DEFAULT_TEMPLATES } from './users';

export function createGuestDatabase(): DatabaseState {
  const exercises = DEFAULT_SEED_EXERCISES.map((exercise) => ({
    ...exercise,
    id: `guest_${exercise.id}`,
  }));

  return {
    profile: {
      name: 'Gast',
      preferredUnit: 'kg',
      experienceLevel: 'Intermediate',
      primaryGoal: 'General Fitness',
      personalMemories: [],
    },
    exercises,
    workouts: [],
    templates: DEFAULT_TEMPLATES.map((template) => ({
      ...template,
      exercises: template.exercises.map((item) => ({
        ...item,
        exerciseId: `guest_${item.exerciseId}`,
      })),
    })),
  };
}
