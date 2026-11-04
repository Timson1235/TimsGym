import type { WorkoutSet, WorkoutExercise, WorkoutSession, SetPlan } from '../types';

export function setPlan(set: Pick<WorkoutSet, 'weight' | 'reps' | 'type'>, rir?: number): SetPlan {
  return { weight: set.weight, reps: set.reps, type: set.type, ...(rir == null ? {} : { rir }) };
}

/** Outcome edits never modify the original prescription. */
export function updateOutcome(set: WorkoutSet, field: keyof WorkoutSet, value: unknown): WorkoutSet {
  const planned = set.planned || (!set.completed && set.reps > 0 ? setPlan(set) : undefined);
  return { ...set, [field]: value, ...(planned ? { planned } : {}) };
}

export function applyTargets(exercise: WorkoutExercise, targets: SetPlan[]): WorkoutExercise {
  let index = 0;
  return { ...exercise, sets: exercise.sets.map((set) => {
    if (set.type !== 'working') return set;
    const target = targets[index++];
    if (set.completed) return set;
    return target ? { ...set, weight: target.weight, reps: target.reps,
      planned: { ...target }, rpe: undefined } : set;
  }) };
}

export function repeatWithTargets(session: WorkoutSession, now = Date.now()): WorkoutSession {
  return { ...session, id: `wk_${now}`, title: `${session.title} (Repeat)`,
    date: new Date(now).toISOString().split('T')[0], startTime: new Date(now).toISOString(),
    endTime: undefined, isCompleted: false, durationMinutes: 0, totalVolume: 0,
    exercises: session.exercises.map((exercise, i) => {
      const { nextTarget, ...rest } = exercise;
      let workingIndex = 0;
      return { ...rest, id: `we_${now}_${i}`, sets: exercise.sets.map((set, j) => {
        const accepted = set.type === 'working' ? nextTarget?.sets[workingIndex++] : undefined;
        const target = accepted || setPlan(set, exercise.progression?.targetRir);
        return { ...set, id: `set_${now}_${i}_${j}`, completed: false,
          weight: target.weight, reps: target.reps, type: target.type, planned: { ...target }, rpe: undefined };
      }) };
    }) };
}
