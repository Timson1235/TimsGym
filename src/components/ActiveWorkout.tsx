import { ProgressionSettings } from './ProgressionSettings';
import { setPlan, updateOutcome, applyTargets } from '../lib/trainingTargets';
import { Dialog } from './Dialog';
import React, { useState, useEffect } from 'react';
import { 
  Play, Check, Plus, Trash2, Clock, Sparkles, AlertCircle, ChevronDown, 
  RotateCcw, Trophy, Dumbbell, Zap, Flame, Info, CheckCircle2, ArrowRight
} from 'lucide-react';
import { 
  WorkoutSession, WorkoutExercise, WorkoutSet, Exercise, SetType, DatabaseState, ProgressionRecommendation, ProgressionConfig
} from '../types';
import { 
  getLastPerformanceForExercise, calculateOneRepMax, calculateWorkoutVolume, PreviousPerformance 
} from '../lib/utils';
import { fetchAISuggestedWeight } from '../lib/api';

interface ActiveWorkoutProps {
  db: DatabaseState;
  activeWorkout: WorkoutSession;
  onUpdateWorkout: (updated: WorkoutSession) => void;
  onFinishWorkout: (completed: WorkoutSession) => void;
  onCancelWorkout: () => void;
  onStartRestTimer: (seconds: number) => void;
  onNewPR: (exerciseName: string, weight: number, reps: number) => void;
}

export const ActiveWorkout: React.FC<ActiveWorkoutProps> = ({
  db,
  activeWorkout,
  onUpdateWorkout,
  onFinishWorkout,
  onCancelWorkout,
  onStartRestTimer,
  onNewPR,
}) => {
  const { exercises, workouts, profile } = db;
  const unit = profile.preferredUnit;

  // Live Timer State
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [isExerciseModalOpen, setIsExerciseModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  
  // AI Suggestion State
  const [loadingAiExerciseId, setLoadingAiExerciseId] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, ProgressionRecommendation>>({});
  const [suggestionError, setSuggestionError] = useState('');

  // Derive duration from the persisted start time, including after tab switches.
  useEffect(() => {
    const started = Date.parse(activeWorkout.startTime || '');
    const update = () => setElapsedSeconds(Number.isFinite(started)
      ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0);
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [activeWorkout.id, activeWorkout.startTime]);

  const formatTimer = (totalSec: number) => {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Helper to update workout state
  const handleTitleChange = (title: string) => {
    onUpdateWorkout({ ...activeWorkout, title });
  };

  const handleNotesChange = (notes: string) => {
    onUpdateWorkout({ ...activeWorkout, notes });
  };

  // Exercise Management
  const handleAddExerciseToWorkout = (exercise: Exercise) => {
    const existing = activeWorkout.exercises.find((we) => we.exerciseId === exercise.id);
    if (existing) {
      setIsExerciseModalOpen(false);
      return;
    }

    const lastPerf = getLastPerformanceForExercise(exercise.id, workouts);

    const defaultSets: WorkoutSet[] = [];
    const numSets = 3;

    for (let i = 1; i <= numSets; i++) {
      const prevSet = lastPerf && lastPerf.sets[i - 1] ? lastPerf.sets[i - 1] : null;
      defaultSets.push({
        id: `set_${Date.now()}_${i}`,
        setNumber: i,
        type: 'working',
        weight: prevSet ? prevSet.weight : 0,
        reps: prevSet ? prevSet.reps : 8,
        rpe: undefined,
        completed: false,
      });
    }

    const newWorkoutExercise: WorkoutExercise = {
      id: `we_${Date.now()}`,
      exerciseId: exercise.id,
      exerciseName: exercise.name,
      category: exercise.category,
      sets: defaultSets.map((set) => ({ ...set, planned: setPlan(set) })),
    };

    onUpdateWorkout({
      ...activeWorkout,
      exercises: [...activeWorkout.exercises, newWorkoutExercise],
    });

    setIsExerciseModalOpen(false);
  };

  const handleRemoveExercise = (weId: string) => {
    onUpdateWorkout({
      ...activeWorkout,
      exercises: activeWorkout.exercises.filter((we) => we.id !== weId),
    });
  };

  // Set Operations
  const handleAddSet = (weId: string) => {
    const updatedExercises = activeWorkout.exercises.map((we) => {
      if (we.id !== weId) return we;
      const lastSet = we.sets[we.sets.length - 1];
      const newSet: WorkoutSet = {
        id: `set_${Date.now()}`,
        setNumber: we.sets.length + 1,
        type: lastSet ? lastSet.type : 'working',
        weight: lastSet ? lastSet.weight : 0,
        reps: lastSet ? lastSet.reps : 8,
        rpe: undefined,
        completed: false,
      };
      return { ...we, sets: [...we.sets, { ...newSet, planned: setPlan(newSet, we.progression?.targetRir) }] };
    });

    onUpdateWorkout({ ...activeWorkout, exercises: updatedExercises });
  };

  const handleRemoveSet = (weId: string, setId: string) => {
    const updatedExercises = activeWorkout.exercises.map((we) => {
      if (we.id !== weId) return we;
      const filtered = we.sets.filter((s) => s.id !== setId);
      const renumbered = filtered.map((s, idx) => ({ ...s, setNumber: idx + 1 }));
      return { ...we, sets: renumbered };
    });

    onUpdateWorkout({ ...activeWorkout, exercises: updatedExercises });
  };

  const handleUpdateSet = (weId: string, setId: string, field: keyof WorkoutSet, value: any) => {
    const updatedExercises = activeWorkout.exercises.map((we) => {
      if (we.id !== weId) return we;
      const updatedSets = we.sets.map((s) => {
        if (s.id !== setId) return s;

        const updatedSet = updateOutcome(s, field, value);

        if (field === 'completed' && value === true) {
          onStartRestTimer(90);

          const exerciseObj = db.exercises.find((e) => e.id === we.exerciseId);
          const currentMax1RM = exerciseObj?.personalRecord?.calculatedOneRepMax || 0;
          const setEst1RM = calculateOneRepMax(updatedSet.weight, updatedSet.reps);

          if (setEst1RM > currentMax1RM && updatedSet.weight > 0 && updatedSet.reps > 0) {
            onNewPR(we.exerciseName, updatedSet.weight, updatedSet.reps);
          }
        }

        return updatedSet;
      });

      return { ...we, sets: updatedSets };
    });

    onUpdateWorkout({ ...activeWorkout, exercises: updatedExercises });
  };

  const handleFillPreviousSets = (we: WorkoutExercise) => {
    const lastPerf = getLastPerformanceForExercise(we.exerciseId, workouts);
    if (!lastPerf || lastPerf.sets.length === 0) return;

    const newSets: WorkoutSet[] = lastPerf.sets.map((ps, idx) => ({
      id: `set_${Date.now()}_${idx}`,
      setNumber: idx + 1,
      type: 'working',
      weight: ps.weight,
      reps: ps.reps,
      rpe: undefined,
      completed: false,
    }));

    const updatedExercises = activeWorkout.exercises.map((item) =>
      item.id === we.id ? { ...item, sets: newSets.map((set) => ({ ...set, planned: setPlan(set, we.progression?.targetRir) })) } : item
    );

    onUpdateWorkout({ ...activeWorkout, exercises: updatedExercises });
  };

  const handleGetAISuggestion = async (we: WorkoutExercise) => {
    setSuggestionError('');
    setLoadingAiExerciseId(we.id);
    const suggestion = await fetchAISuggestedWeight(we.exerciseName, 8, 8, we.exerciseId, we.progression);
    setLoadingAiExerciseId(null);
    if (suggestion) setAiSuggestions((previous) => ({ ...previous, [we.id]: suggestion }));
    else setSuggestionError('Ziel konnte nicht geprüft werden. Bitte Anmeldung und Verbindung prüfen und erneut versuchen.');
  };

  const configureProgression = (we: WorkoutExercise, progression: ProgressionConfig) => {
    if (we.sets.some((set) => set.completed)) return;
    onUpdateWorkout({ ...activeWorkout, exercises: activeWorkout.exercises.map((exercise) => exercise.id === we.id
      ? { ...exercise, progression, sets: exercise.sets.map((set) => {
        const reps = set.type === 'working' ? Math.max(progression.repMin, Math.min(progression.repMax, set.reps)) : set.reps;
        return { ...set, reps, rpe: undefined, planned: setPlan({ ...set, reps }, set.type === 'working' ? progression.targetRir : undefined) };
      }) } : exercise) });
    setAiSuggestions((previous) => { const next = { ...previous }; delete next[we.id]; return next; });
  };

  const handleFinish = () => {
    const totalVol = calculateWorkoutVolume(activeWorkout);
    const completedSession: WorkoutSession = {
      ...activeWorkout,
      durationMinutes: Math.max(1, Math.round(elapsedSeconds / 60)),
      totalVolume: totalVol,
      isCompleted: true,
      date: activeWorkout.date || new Date().toISOString().split('T')[0],
    };

    onFinishWorkout(completedSession);
  };

  const categories = ['All', 'Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core', 'Plyometrics'];

  const filteredExercises = exercises.filter((ex) => {
    const matchesCat = selectedCategory === 'All' || ex.category === selectedCategory;
    const matchesQuery = ex.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCat && matchesQuery;
  });

  return (
    <div className="space-y-6 font-sans">
      
      {/* Top Header Card */}
      <div className="app-workout-toolbar sticky top-16 z-20 bg-white/92 py-4 backdrop-blur-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          
          <div className="flex-1 space-y-2">
            <input
              type="text"
              aria-label="Workout title"
              value={activeWorkout.title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Workout Session Title (e.g. Push Day)"
              className="w-full border-b border-transparent bg-transparent py-1 text-xl font-semibold text-slate-900 hover:border-slate-300 focus:border-brand-600 md:text-2xl"
            />
            
            <div className="flex flex-wrap items-center gap-2.5 text-xs font-semibold">
              <span className="flex items-center gap-1.5 text-brand-800 bg-brand-50 px-3 py-1 rounded-full border border-brand-200 text-xs font-mono font-bold">
                <Clock className="h-3.5 w-3.5 text-brand-600" />
                <span>{formatTimer(elapsedSeconds)}</span>
              </span>

              <span className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                {activeWorkout.exercises.length} Exercises
              </span>

              <span className="bg-slate-100 px-3 py-1 rounded-full border border-slate-200 text-slate-900 font-mono text-xs font-bold">
                Volume: {calculateWorkoutVolume(activeWorkout).toLocaleString()} {unit}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={onCancelWorkout}
              className="min-h-10 rounded-lg border border-slate-200 px-4 text-sm font-medium text-rose-700 hover:bg-rose-50"
            >
              Discard
            </button>

            <button
              onClick={handleFinish}
              className="app-primary flex min-h-10 items-center gap-2 rounded-lg px-5 text-sm font-semibold shadow-sm"
            >
              <Check className="h-4 w-4 stroke-[2.5]" />
              Finish Session
            </button>
          </div>

        </div>
      </div>

      {/* Exercises Section */}
      <div className="space-y-5">
        {activeWorkout.exercises.map((we, exIdx) => {
          const lastPerf = getLastPerformanceForExercise(we.exerciseId, workouts);

          return (
            <div
              key={we.id}
              className="app-surface relative space-y-4 overflow-hidden p-5"
            >
              
              {/* Exercise Header */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-3.5">
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-lg bg-brand-50 text-brand-700 font-mono font-bold text-xs flex items-center justify-center border border-brand-200">
                    #{exIdx + 1}
                  </span>
                  <div>
                    <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                      {we.exerciseName}
                      <span className="text-xs font-bold tracking-normal px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                        {we.category}
                      </span>
                    </h3>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleGetAISuggestion(we)}
                    disabled={loadingAiExerciseId === we.id}
                    className="flex min-h-9 items-center gap-1.5 rounded-lg bg-brand-50 px-3 text-sm font-medium text-brand-800 hover:bg-brand-100 disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-brand-600" />
                    <span>{loadingAiExerciseId === we.id ? 'Vergleiche…' : 'Nächstes Ziel prüfen'}</span>
                  </button>

                  {lastPerf && (
                    <button
                      onClick={() => handleFillPreviousSets(we)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 text-xs font-bold transition-all"
                      title="Copy sets from last performance"
                    >
                      <RotateCcw className="h-3.5 w-3.5 text-brand-600" />
                      <span>Fill Previous</span>
                    </button>
                  )}

                  <button
                    onClick={() => handleRemoveExercise(we.id)}
                    aria-label={`Remove ${we.exerciseName}`}
                    title="Remove exercise"
                    className="app-icon-button min-h-9 min-w-9 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Previous Performance Badge */}
              {lastPerf && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-slate-700">
                    <Info className="h-4 w-4 text-brand-600" />
                    <span className="font-bold text-slate-800">Last Session ({lastPerf.date}):</span>
                    <span className="text-brand-800 font-mono font-bold">
                      {lastPerf.sets.map((s) => `${s.weight}${unit}×${s.reps}`).join(', ')}
                    </span>
                  </div>
                  <span className="text-slate-500 text-xs font-mono">
                    Best: {lastPerf.maxWeight} {unit} × {lastPerf.maxReps} reps
                  </span>
                </div>
              )}

              {/* AI Suggestion Banner */}
              {aiSuggestions[we.id] && (
                <div className="bg-brand-50 border border-brand-200 rounded-lg p-3 text-xs text-brand-900 flex items-center gap-2 font-medium">
                  <Sparkles className="h-4 w-4 text-brand-600 shrink-0" />
                  <div>
                    <p>{aiSuggestions[we.id].reasoning}</p>
                    {aiSuggestions[we.id].next && <button className="mt-2 rounded border border-brand-300 px-2 py-1" onClick={() => {
                      onUpdateWorkout({ ...activeWorkout, exercises: activeWorkout.exercises.map((exercise) => exercise.id === we.id
                        ? applyTargets(exercise, aiSuggestions[we.id].next!.sets) : exercise) });
                      setAiSuggestions((previous) => { const next = { ...previous }; delete next[we.id]; return next; });
                    }}>Ziel für offene Arbeitssätze übernehmen</button>}
                  </div>
                </div>
              )}

              <ProgressionSettings exercise={we} onChange={(config) => configureProgression(we, config)} />
              {suggestionError && <p role="alert" className="text-sm text-rose-700">{suggestionError}</p>}

              {/* Focused set editor: each completed set remains visible, but every value is thumb-sized. */}
              <div className="space-y-2">
                {we.sets.map((set, setIdx) => {
                  const prevSet = lastPerf && lastPerf.sets[setIdx] ? lastPerf.sets[setIdx] : null;
                  return (
                    <div
                      key={set.id}
                      className={`grid gap-3 border-b border-slate-200/80 py-3 last:border-b-0 sm:grid-cols-[2.5rem_8rem_minmax(0,1fr)_3rem] sm:items-center ${set.completed ? 'bg-emerald-50/45' : ''}`}
                    >
                      <div className="flex items-center gap-2 sm:block">
                        <span className="app-eyebrow sm:block">Set</span>
                        <span className="font-mono text-lg font-semibold text-slate-900">{set.setNumber}</span>
                      </div>

                      <label className="block">
                        <span className="app-eyebrow mb-1 block">Type</span>
                        <select
                          value={set.type}
                          onChange={(e) => handleUpdateSet(we.id, set.id, 'type', e.target.value as SetType)}
                          className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 text-sm text-slate-800"
                        >
                          <option value="working">Working</option>
                          <option value="warmup">Warm-up</option>
                          <option value="drop">Drop set</option>
                          <option value="failure">Failure</option>
                        </select>
                      </label>

                      <div>
                      {set.planned && <p className="mb-1 text-xs text-slate-500">
                        Plan: {set.planned.weight} {unit} × {set.planned.reps}{set.planned.rir != null ? ` · RIR ${set.planned.rir}` : ''}
                      </p>}
                      <div className="grid grid-cols-3 gap-2">
                        <label>
                          <span className="app-eyebrow mb-1 block">{unit}</span>
                          <input
                            type="number"
                            value={set.weight || ''}
                            onChange={(e) => handleUpdateSet(we.id, set.id, 'weight', parseFloat(e.target.value) || 0)}
                            placeholder="0"
                            className="h-12 w-full rounded-lg border border-slate-200 bg-white px-2 text-center font-mono text-lg font-semibold text-slate-900"
                          />
                        </label>
                        <label>
                          <span className="app-eyebrow mb-1 block">Reps</span>
                          <input
                            type="number"
                            value={set.reps || ''}
                            onChange={(e) => handleUpdateSet(we.id, set.id, 'reps', parseInt(e.target.value) || 0)}
                            placeholder="0"
                            className="h-12 w-full rounded-lg border border-slate-200 bg-white px-2 text-center font-mono text-lg font-semibold text-slate-900"
                          />
                        </label>
                        <label>
                          <span className="app-eyebrow mb-1 block">RIR (Ist)</span>
                          <input
                            type="number"
                            step="0.5"
                            max="10"
                            min="0"
                            value={set.rpe == null ? '' : 10 - set.rpe}
                            onChange={(e) => handleUpdateSet(we.id, set.id, 'rpe', e.target.value === '' ? undefined : 10 - Number(e.target.value))}
                            placeholder="?"
                            className="h-12 w-full rounded-lg border border-slate-200 bg-white px-2 text-center font-mono text-base text-slate-700"
                          />
                        </label>
                      </div>

                      </div>
                      <div className="flex items-end justify-end gap-1">
                        <button
                          onClick={() => handleUpdateSet(we.id, set.id, 'completed', !set.completed)}
                          className={`inline-flex h-12 w-12 items-center justify-center rounded-lg ${set.completed ? 'app-primary shadow-sm' : 'border border-slate-200 bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                          aria-label={`Mark set ${set.setNumber} as ${set.completed ? 'not completed' : 'completed'}`}
                        >
                          <Check className="h-5 w-5 stroke-[2.5]" />
                        </button>
                        <button
                          onClick={() => handleRemoveSet(we.id, set.id)}
                          className="app-icon-button h-12 w-10 text-slate-300 hover:bg-rose-50 hover:text-rose-600"
                          aria-label={`Remove set ${set.setNumber}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>

                      {prevSet && (
                        <p className="col-span-full text-xs text-slate-500 sm:col-start-3">Last time: <span className="font-mono text-slate-700">{prevSet.weight} {unit} × {prevSet.reps}</span></p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Add Set Button */}
              <button
                onClick={() => handleAddSet(we.id)}
                className="flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-200 bg-slate-50 py-2 text-sm font-medium text-slate-600 hover:border-brand-400 hover:bg-brand-50/30 hover:text-brand-800"
              >
                <Plus className="h-4 w-4" />
                Add Set
              </button>

            </div>
          );
        })}

        {/* Big Add Exercise Button */}
        <button
          onClick={() => setIsExerciseModalOpen(true)}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-200 bg-white py-5 text-slate-600 shadow-xs hover:border-brand-400 hover:text-brand-800 group"
        >
          <div className="w-9 h-9 rounded-lg bg-brand-50 text-brand-700 border border-brand-200 flex items-center justify-center group-hover:scale-105 transition-transform">
            <Plus className="h-5 w-5 stroke-[2.5]" />
          </div>
          <span className="text-sm font-medium">Add exercise to workout</span>
        </button>
      </div>

      {/* Exercise Picker Modal */}
      <Dialog isOpen={isExerciseModalOpen} title="Select exercise" onClose={() => setIsExerciseModalOpen(false)} wide>
            {/* Search & Category Filter */}
            <div className="p-4 border-b border-slate-200 space-y-3 bg-slate-50">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search exercises"
                placeholder="Search exercise name (e.g. Bench Press, Squat)..."
                className="w-full bg-white border border-slate-200 text-slate-800 rounded-lg px-4 py-2.5 text-xs focus:outline-none focus:border-brand-600"
              />

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3 py-1 rounded-lg text-xs font-bold tracking-normal whitespace-nowrap transition-colors ${
                      selectedCategory === cat
                        ? 'bg-brand-700 text-white'
                        : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Exercise List */}
            <div className="p-4 overflow-y-auto space-y-2 flex-1">
              {filteredExercises.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-xs font-bold tracking-normal">
                  No exercises found.
                </div>
              ) : (
                filteredExercises.map((ex) => (
                  <div
                    key={ex.id}
                    onClick={() => handleAddExerciseToWorkout(ex)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handleAddExerciseToWorkout(ex); } }}
                    className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 hover:border-brand-300 hover:bg-brand-50/30 cursor-pointer transition-all flex items-center justify-between group"
                  >
                    <div>
                      <h4 className="font-bold text-slate-900 text-sm group-hover:text-brand-800">
                        {ex.name}
                      </h4>
                      <p className="text-xs text-slate-500 tracking-normal">
                        {ex.category} • {ex.equipment}
                      </p>
                    </div>

                    <div className="text-right font-mono">
                      {ex.personalRecord ? (
                        <span className="text-xs font-bold text-brand-800">
                          PR: {ex.personalRecord.maxWeight} {unit}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">No PR</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

      </Dialog>

    </div>
  );

};
