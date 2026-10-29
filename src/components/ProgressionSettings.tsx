import React, { useState } from 'react';
import type { ProgressionConfig, WorkoutExercise } from '../types';

export function ProgressionSettings({ exercise, onChange }: { exercise: WorkoutExercise; onChange: (config: ProgressionConfig) => void }) {
  const [draft, setDraft] = useState<ProgressionConfig>(() => exercise.progression || {
    version: 1, strategy: 'double_progression', repMin: 6, repMax: 10, targetRir: 2, requiredSessions: 2,
  });
  const [error, setError] = useState('');
  const started = exercise.sets.some((set) => set.completed);
  return <details className="rounded-lg border border-slate-200 p-3 text-sm">
    <summary className="cursor-pointer font-medium">Progressionsziel {exercise.progression ? `· ${exercise.progression.repMin}–${exercise.progression.repMax} Wdh. · RIR ${exercise.progression.targetRir}` : 'einrichten'}</summary>
    <p className="my-2 text-xs text-slate-500">Vor dem ersten Satz festlegen. Ist-Werte verändern diesen Plan anschließend nicht.</p>
    {started && <p className="text-xs text-slate-600">Das Ziel dieser laufenden Einheit bleibt erhalten. Änderungen beim nächsten Workout vornehmen.</p>}
    <fieldset disabled={started} className="grid gap-3 sm:grid-cols-3 disabled:opacity-60">
      <label>Strategie<select className="block w-full rounded border p-2" value={draft.strategy} onChange={(event) => {
        const strategy = event.target.value as ProgressionConfig['strategy'];
        setDraft({ ...draft, strategy, goal: strategy === 'skill' ? draft.goal || {
          targetMovement: '', currentVariation: exercise.exerciseName,
          targetSets: exercise.sets.filter((set) => set.type === 'working').length || 3, targetReps: draft.repMax,
        } : undefined });
      }}><option value="double_progression">Wiederholungen, dann Gewicht</option><option value="skill">Übungsvariante / Skill-Ziel</option></select></label>
      {(['repMin', 'repMax', 'targetRir', 'requiredSessions'] as const).map((field) => <label key={field}>
        {{ repMin: 'Wdh. von', repMax: 'Wdh. bis', targetRir: 'Ziel-RIR', requiredSessions: 'Einheiten bis Laststeigerung' }[field]}
        <input className="block w-full rounded border p-2" type="number" min={field === 'targetRir' ? 0 : 1}
          max={field === 'requiredSessions' ? 3 : field === 'targetRir' ? 10 : 100}
          value={draft[field]} onChange={(event) => setDraft({ ...draft, [field]: Number(event.target.value) })} />
      </label>)}
      {draft.strategy === 'double_progression' && <label>Verfügbarer Gewichtsschritt (kg)
        <input className="block w-full rounded border p-2" type="number" step="0.25" min="0.25" placeholder="Noch unbekannt"
          value={draft.weightIncrement ?? ''} onChange={(event) => setDraft({ ...draft, weightIncrement: event.target.value ? Number(event.target.value) : undefined })} />
      </label>}
      {draft.strategy === 'skill' && draft.goal && <>
        {(['targetMovement', 'currentVariation'] as const).map((field) => <label key={field}>
          {field === 'targetMovement' ? 'Zielbewegung' : 'Aktuelle Variante'}
          <input className="block w-full rounded border p-2" maxLength={100} value={draft.goal![field]}
            onChange={(event) => setDraft({ ...draft, goal: { ...draft.goal!, [field]: event.target.value } })} />
        </label>)}
        {(['targetSets', 'targetReps'] as const).map((field) => <label key={field}>
          {field === 'targetSets' ? 'Kriterium: Sätze' : 'Kriterium: Wiederholungen'}
          <input className="block w-full rounded border p-2" type="number" min="1" max={field === 'targetSets' ? 20 : 100} value={draft.goal![field]}
            onChange={(event) => setDraft({ ...draft, goal: { ...draft.goal!, [field]: Number(event.target.value) } })} />
        </label>)}
      </>}
      <button className="app-primary rounded-lg px-3 py-2" onClick={() => {
        const numbers = [draft.repMin, draft.repMax, draft.targetRir, draft.requiredSessions];
        if (numbers.some((n) => !Number.isFinite(n)) || draft.repMin < 1 || draft.repMax > 100 || draft.repMax < draft.repMin
          || draft.targetRir < 0 || draft.targetRir > 10 || !Number.isInteger(draft.repMin) || !Number.isInteger(draft.repMax)
          || !Number.isInteger(draft.requiredSessions) || draft.requiredSessions < 1 || draft.requiredSessions > 3
          || (draft.weightIncrement != null && (!(draft.weightIncrement > 0) || draft.weightIncrement > 100))
          || (draft.strategy === 'skill' && (!draft.goal?.targetMovement.trim() || !draft.goal.currentVariation.trim()
            || !Number.isInteger(draft.goal.targetSets) || draft.goal.targetSets < 1 || draft.goal.targetSets > 20
            || !Number.isInteger(draft.goal.targetReps) || draft.goal.targetReps < draft.repMin || draft.goal.targetReps > draft.repMax))) {
          setError('Bitte einen gültigen Bereich und ein vollständiges Ziel angeben.'); return;
        }
        setError(''); onChange(draft);
      }}>Ziel festlegen</button>
    </fieldset>
    {error && <p role="alert" className="mt-2 text-rose-700">{error}</p>}
  </details>;
}
