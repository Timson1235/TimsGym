import React, { useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { fetchWorkoutReview } from '../lib/api';
import type { ProgressionRecommendation, WorkoutSession } from '../types';

export function ProgressionReview({ workout, onClose, onSave }: {
  workout: WorkoutSession; onClose: () => void; onSave: (workout: WorkoutSession) => Promise<void>;
}) {
  const [recommendations, setRecommendations] = useState<ProgressionRecommendation[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    fetchWorkoutReview(workout.id).then((result) => { if (!cancelled) setRecommendations(result.recommendations); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workout.id, attempt]);
  const accept = async (recommendation: ProgressionRecommendation) => {
    if (!recommendation.next || saving) return;
    setSaving(true); setError('');
    try {
      await onSave({ ...workout, exercises: workout.exercises.map((exercise) => exercise.exerciseId === recommendation.exerciseId
        ? { ...exercise, nextTarget: { version: 1, sourceWorkoutId: workout.id, acceptedAt: new Date().toISOString(), sets: recommendation.next!.sets } }
        : exercise) });
    } catch { setError('Das nächste Ziel konnte nicht gespeichert werden.'); }
    finally { setSaving(false); }
  };
  return <Dialog isOpen title="Workout gespeichert – nächste Ziele" onClose={saving ? () => {} : onClose} wide>
    <p className="mb-4 text-sm text-slate-600">Vorschläge werden erst nach deiner Übernahme beim Wiederholen dieses Workouts verwendet.</p>
    {loading && <p role="status">Trainingsdaten werden verglichen…</p>}
    {error && <div role="alert"><p>{error}</p><button onClick={() => setAttempt((value) => value + 1)}>Erneut versuchen</button></div>}
    <div className="space-y-3">{recommendations.map((recommendation) => {
      const accepted = workout.exercises.find((e) => e.exerciseId === recommendation.exerciseId)?.nextTarget;
      return <section key={recommendation.exerciseId} className="rounded-lg border border-slate-200 p-3">
        <h3 className="font-semibold">{recommendation.exerciseName}</h3>
        <p className="mt-1 text-sm">{recommendation.reasoning}</p>
        {recommendation.evidence[0] && <p className="mt-1 text-xs text-slate-500">
          Basis {recommendation.evidence[0].date}: {recommendation.evidence[0].actualReps.map((reps) => reps ?? '–').join(' / ')} Wdh.
        </p>}
        {recommendation.next && <>
          <p className="my-2 text-sm font-mono">Nächstes Ziel: {recommendation.next.sets.map((set) => `${set.weight} kg × ${set.reps}`).join(' · ')}</p>
          <button className="app-primary rounded-lg px-3 py-2 text-sm" disabled={saving || Boolean(accepted)} onClick={() => accept(recommendation)}>
            {accepted ? 'Ziel gespeichert' : 'Ziel übernehmen'}
          </button>
        </>}
      </section>;
    })}</div>
  </Dialog>;
}
