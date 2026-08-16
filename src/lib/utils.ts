import { WorkoutSession, WorkoutSet } from '../types';

export function calculateOneRepMax(weight: number, reps: number): number {
  if (reps <= 0 || weight <= 0) return 0;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30));
}

export function calculateWorkoutVolume(workout: WorkoutSession): number {
  let total = 0;
  workout.exercises.forEach((ex) => {
    ex.sets.forEach((s) => {
      if (s.completed && s.weight > 0 && s.reps > 0) {
        total += s.weight * s.reps;
      }
    });
  });
  return total;
}

export interface PreviousPerformance {
  date: string;
  workoutTitle: string;
  sets: { weight: number; reps: number; rpe?: number }[];
  maxWeight: number;
  maxReps: number;
}

export function getLastPerformanceForExercise(
  exerciseId: string,
  workouts: WorkoutSession[]
): PreviousPerformance | null {
  // Sort workouts newest to oldest
  const sorted = [...workouts].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  for (const w of sorted) {
    if (!w.isCompleted) continue;
    for (const ex of w.exercises) {
      if (ex.exerciseId === exerciseId) {
        const completedSets = ex.sets.filter((s) => s.completed && s.weight > 0 && s.reps > 0);
        if (completedSets.length > 0) {
          let maxW = 0;
          let maxR = 0;
          completedSets.forEach((s) => {
            if (s.weight > maxW) {
              maxW = s.weight;
              maxR = s.reps;
            }
          });
          return {
            date: w.date,
            workoutTitle: w.title,
            sets: completedSets.map((s) => ({ weight: s.weight, reps: s.reps, rpe: s.rpe })),
            maxWeight: maxW,
            maxReps: maxR,
          };
        }
      }
    }
  }

  return null;
}

export function formatDateString(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function playTimerBeep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime); // A5 note
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {
    console.log('Audio playback not allowed or supported', e);
  }
}
