import React, { useState, useEffect } from 'react';
import { 
  Play, Check, Plus, Trash2, Clock, Sparkles, AlertCircle, ChevronDown, 
  RotateCcw, Trophy, Dumbbell, Zap, Flame, Info, CheckCircle2, ArrowRight
} from 'lucide-react';
import { 
  WorkoutSession, WorkoutExercise, WorkoutSet, Exercise, SetType, DatabaseState 
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
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});

  // Timer interval
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

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
        weight: prevSet ? prevSet.weight : (exercise.personalRecord?.maxWeight || 100),
        reps: prevSet ? prevSet.reps : 8,
        rpe: prevSet?.rpe || 8,
        completed: false,
      });
    }

    const newWorkoutExercise: WorkoutExercise = {
      id: `we_${Date.now()}`,
      exerciseId: exercise.id,
      exerciseName: exercise.name,
      category: exercise.category,
      sets: defaultSets,
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
        weight: lastSet ? lastSet.weight : 100,
        reps: lastSet ? lastSet.reps : 8,
        rpe: lastSet?.rpe || 8,
        completed: false,
      };
      return { ...we, sets: [...we.sets, newSet] };
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

        const updatedSet = { ...s, [field]: value };

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
      rpe: ps.rpe || 8,
      completed: false,
    }));

    const updatedExercises = activeWorkout.exercises.map((item) =>
      item.id === we.id ? { ...item, sets: newSets } : item
    );

    onUpdateWorkout({ ...activeWorkout, exercises: updatedExercises });
  };

  const handleGetAISuggestion = async (we: WorkoutExercise) => {
    setLoadingAiExerciseId(we.id);
    const suggestion = await fetchAISuggestedWeight(we.exerciseName, 8, 8);
    setLoadingAiExerciseId(null);

    if (suggestion && suggestion.suggestedWeight) {
      setAiSuggestions((prev) => ({
        ...prev,
        [we.id]: `AI Target: ${suggestion.suggestedWeight} ${unit} × ${suggestion.suggestedReps} reps (${suggestion.recommendation})`,
      }));

      const updatedExercises = activeWorkout.exercises.map((item) => {
        if (item.id !== we.id) return item;
        const updatedSets = item.sets.map((s) => {
          if (!s.completed && s.type === 'working') {
            return {
              ...s,
              weight: suggestion.suggestedWeight || s.weight,
              reps: suggestion.suggestedReps || s.reps,
            };
          }
          return s;
        });
        return { ...item, sets: updatedSets };
      });

      onUpdateWorkout({ ...activeWorkout, exercises: updatedExercises });
    }
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

  const categories = ['All', 'Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core'];

  const filteredExercises = exercises.filter((ex) => {
    const matchesCat = selectedCategory === 'All' || ex.category === selectedCategory;
    const matchesQuery = ex.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCat && matchesQuery;
  });

  return (
    <div className="space-y-6 font-sans">
      
      {/* Top Header Card */}
      <div className="bg-white/95 border border-slate-200/80 rounded-2xl p-5 shadow-xs sticky top-20 z-20 backdrop-blur-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          
          <div className="flex-1 space-y-2">
            <input
              type="text"
              value={activeWorkout.title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Workout Session Title (e.g. Push Day)"
              className="text-xl md:text-2xl font-extrabold text-slate-900 uppercase tracking-tight bg-transparent border-b border-transparent hover:border-slate-300 focus:border-teal-600 focus:outline-none w-full py-1 transition-colors"
            />
            
            <div className="flex flex-wrap items-center gap-2.5 text-xs font-semibold">
              <span className="flex items-center gap-1.5 text-teal-800 bg-teal-50 px-3 py-1 rounded-full border border-teal-200 text-[11px] font-mono font-bold">
                <Clock className="h-3.5 w-3.5 text-teal-600" />
                <span>{formatTimer(elapsedSeconds)}</span>
              </span>

              <span className="bg-slate-100 px-3 py-1 rounded-full border border-slate-200 text-slate-700 text-[10px] font-bold uppercase tracking-wider">
                {activeWorkout.exercises.length} Exercises
              </span>

              <span className="bg-slate-100 px-3 py-1 rounded-full border border-slate-200 text-slate-900 font-mono text-[11px] font-bold">
                Volume: {calculateWorkoutVolume(activeWorkout).toLocaleString()} {unit}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={onCancelWorkout}
              className="px-4 py-2.5 rounded-xl border border-slate-200 text-rose-600 hover:bg-rose-50 text-xs font-bold uppercase tracking-wider transition-colors"
            >
              Discard
            </button>

            <button
              onClick={handleFinish}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs uppercase tracking-wider shadow-xs transition-all"
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
              className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs space-y-4 relative overflow-hidden"
            >
              
              {/* Exercise Header */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-3.5">
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-lg bg-teal-50 text-teal-700 font-mono font-bold text-xs flex items-center justify-center border border-teal-200">
                    #{exIdx + 1}
                  </span>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 uppercase tracking-tight flex items-center gap-2">
                      {we.exerciseName}
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                        {we.category}
                      </span>
                    </h3>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleGetAISuggestion(we)}
                    disabled={loadingAiExerciseId === we.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-teal-600" />
                    <span>{loadingAiExerciseId === we.id ? 'Analyzing...' : 'AI Target'}</span>
                  </button>

                  {lastPerf && (
                    <button
                      onClick={() => handleFillPreviousSets(we)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 text-xs font-bold transition-all"
                      title="Copy sets from last performance"
                    >
                      <RotateCcw className="h-3.5 w-3.5 text-teal-600" />
                      <span>Fill Previous</span>
                    </button>
                  )}

                  <button
                    onClick={() => handleRemoveExercise(we.id)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Previous Performance Badge */}
              {lastPerf && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 text-slate-700">
                    <Info className="h-4 w-4 text-teal-600" />
                    <span className="font-bold text-slate-800">Last Session ({lastPerf.date}):</span>
                    <span className="text-teal-800 font-mono font-bold">
                      {lastPerf.sets.map((s) => `${s.weight}${unit}×${s.reps}`).join(', ')}
                    </span>
                  </div>
                  <span className="text-slate-500 text-[11px] font-mono">
                    Best: {lastPerf.maxWeight} {unit} × {lastPerf.maxReps} reps
                  </span>
                </div>
              )}

              {/* AI Suggestion Banner */}
              {aiSuggestions[we.id] && (
                <div className="bg-teal-50 border border-teal-200 rounded-xl p-3 text-xs text-teal-900 flex items-center gap-2 font-medium">
                  <Sparkles className="h-4 w-4 text-teal-600 shrink-0" />
                  <span>{aiSuggestions[we.id]}</span>
                </div>
              )}

              {/* Sets Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-400 uppercase font-bold tracking-wider text-[10px]">
                      <th className="py-2 px-2 w-12">Set</th>
                      <th className="py-2 px-2 w-28">Type</th>
                      <th className="py-2 px-2 w-24">Last</th>
                      <th className="py-2 px-2 w-28">{unit.toUpperCase()}</th>
                      <th className="py-2 px-2 w-24">Reps</th>
                      <th className="py-2 px-2 w-20">RPE</th>
                      <th className="py-2 px-2 w-16 text-center">Done</th>
                      <th className="py-2 px-2 w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {we.sets.map((set, setIdx) => {
                      const prevSet = lastPerf && lastPerf.sets[setIdx] ? lastPerf.sets[setIdx] : null;

                      return (
                        <tr
                          key={set.id}
                          className={`transition-colors ${
                            set.completed ? 'bg-teal-50/50' : 'hover:bg-slate-50/50'
                          }`}
                        >
                          {/* Set Number */}
                          <td className="py-2.5 px-2 font-mono font-bold text-slate-700">
                            {set.setNumber}
                          </td>

                          {/* Set Type */}
                          <td className="py-2.5 px-2">
                            <select
                              value={set.type}
                              onChange={(e) => handleUpdateSet(we.id, set.id, 'type', e.target.value as SetType)}
                              className="bg-slate-50 border border-slate-200 text-slate-800 text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-teal-600"
                            >
                              <option value="working">Working</option>
                              <option value="warmup">Warmup</option>
                              <option value="drop">Drop</option>
                              <option value="failure">Failure</option>
                            </select>
                          </td>

                          {/* Last Set Preview */}
                          <td className="py-2.5 px-2 text-slate-400 font-mono">
                            {prevSet ? `${prevSet.weight} × ${prevSet.reps}` : '-'}
                          </td>

                          {/* Weight Input */}
                          <td className="py-2.5 px-2">
                            <input
                              type="number"
                              value={set.weight || ''}
                              onChange={(e) => handleUpdateSet(we.id, set.id, 'weight', parseFloat(e.target.value) || 0)}
                              placeholder="0"
                              className="w-20 bg-slate-50 border border-slate-200 font-mono font-bold text-slate-900 text-xs rounded-lg px-2.5 py-1 focus:outline-none focus:border-teal-600 focus:bg-white text-center"
                            />
                          </td>

                          {/* Reps Input */}
                          <td className="py-2.5 px-2">
                            <input
                              type="number"
                              value={set.reps || ''}
                              onChange={(e) => handleUpdateSet(we.id, set.id, 'reps', parseInt(e.target.value) || 0)}
                              placeholder="0"
                              className="w-16 bg-slate-50 border border-slate-200 font-mono font-bold text-slate-900 text-xs rounded-lg px-2.5 py-1 focus:outline-none focus:border-teal-600 focus:bg-white text-center"
                            />
                          </td>

                          {/* RPE Input */}
                          <td className="py-2.5 px-2">
                            <input
                              type="number"
                              step="0.5"
                              max="10"
                              min="1"
                              value={set.rpe || ''}
                              onChange={(e) => handleUpdateSet(we.id, set.id, 'rpe', parseFloat(e.target.value) || undefined)}
                              placeholder="8"
                              className="w-14 bg-slate-50 border border-slate-200 font-mono text-slate-700 text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-teal-600 focus:bg-white text-center"
                            />
                          </td>

                          {/* Completion Checkmark */}
                          <td className="py-2.5 px-2 text-center">
                            <button
                              onClick={() => handleUpdateSet(we.id, set.id, 'completed', !set.completed)}
                              className={`w-7 h-7 rounded-lg inline-flex items-center justify-center transition-all ${
                                set.completed
                                  ? 'bg-teal-700 text-white font-bold shadow-xs'
                                  : 'bg-slate-100 border border-slate-200 text-slate-400 hover:text-slate-700'
                              }`}
                            >
                              <Check className="h-4 w-4 stroke-[2.5]" />
                            </button>
                          </td>

                          {/* Delete Set */}
                          <td className="py-2.5 px-2">
                            <button
                              onClick={() => handleRemoveSet(we.id, set.id)}
                              className="p-1 text-slate-300 hover:text-rose-600 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Add Set Button */}
              <button
                onClick={() => handleAddSet(we.id)}
                className="w-full py-2 rounded-xl bg-slate-50 border border-dashed border-slate-200 hover:border-teal-400 hover:bg-teal-50/30 text-xs font-bold uppercase tracking-wider text-slate-600 hover:text-teal-800 transition-all flex items-center justify-center gap-1.5"
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
          className="w-full py-5 rounded-2xl bg-white border-2 border-dashed border-slate-200 hover:border-teal-400 text-slate-600 hover:text-teal-800 transition-all shadow-xs flex flex-col items-center justify-center gap-2 group"
        >
          <div className="w-9 h-9 rounded-xl bg-teal-50 text-teal-700 border border-teal-200 flex items-center justify-center group-hover:scale-105 transition-transform">
            <Plus className="h-5 w-5 stroke-[2.5]" />
          </div>
          <span className="font-bold text-xs uppercase tracking-wider">Add Exercise to Workout</span>
        </button>
      </div>

      {/* Exercise Picker Modal */}
      {isExerciseModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-xl w-full max-h-[85vh] flex flex-col shadow-xl overflow-hidden">
            
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900 flex items-center gap-2">
                <Dumbbell className="h-5 w-5 text-teal-700" />
                Select Exercise
              </h3>
              <button
                onClick={() => setIsExerciseModalOpen(false)}
                className="text-slate-400 hover:text-slate-700 text-xs font-bold uppercase tracking-wider"
              >
                ✕
              </button>
            </div>

            {/* Search & Category Filter */}
            <div className="p-4 border-b border-slate-200 space-y-3 bg-slate-50">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search exercise name (e.g. Bench Press, Squat)..."
                className="w-full bg-white border border-slate-200 text-slate-800 rounded-xl px-4 py-2.5 text-xs focus:outline-none focus:border-teal-600"
              />

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider whitespace-nowrap transition-colors ${
                      selectedCategory === cat
                        ? 'bg-teal-700 text-white'
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
                <div className="text-center py-8 text-slate-400 text-xs font-bold uppercase tracking-wider">
                  No exercises found.
                </div>
              ) : (
                filteredExercises.map((ex) => (
                  <div
                    key={ex.id}
                    onClick={() => handleAddExerciseToWorkout(ex)}
                    className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 hover:border-teal-300 hover:bg-teal-50/30 cursor-pointer transition-all flex items-center justify-between group"
                  >
                    <div>
                      <h4 className="font-bold text-slate-900 text-sm group-hover:text-teal-800">
                        {ex.name}
                      </h4>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider">
                        {ex.category} • {ex.equipment}
                      </p>
                    </div>

                    <div className="text-right font-mono">
                      {ex.personalRecord ? (
                        <span className="text-xs font-bold text-teal-800">
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

          </div>
        </div>
      )}

    </div>
  );

};
