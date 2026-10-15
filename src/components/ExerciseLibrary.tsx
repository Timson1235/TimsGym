import React, { useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { Dialog } from './Dialog';
import { Dumbbell, Plus, Search, Trophy, LineChart as ChartIcon, Info, Sparkles } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { DatabaseState, Exercise, MuscleCategory, EquipmentType } from '../types';
import { calculateOneRepMax, formatDateString } from '../lib/utils';

interface ExerciseLibraryProps {
  db: DatabaseState;
  onSaveExercise: (exercise: Exercise) => void;
  onAskAICoachAboutExercise: (exerciseName: string) => void;
}

export const ExerciseLibrary: React.FC<ExerciseLibraryProps> = ({
  db,
  onSaveExercise,
  onAskAICoachAboutExercise,
}) => {
  const { exercises, workouts, profile } = db;
  const reduceMotion = useReducedMotion();
  const unit = profile.preferredUnit;

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [inspectingExercise, setInspectingExercise] = useState<Exercise | null>(null);
  
  // Custom Exercise Modal
  const [isCustomModalOpen, setIsCustomModalOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customCategory, setCustomCategory] = useState<MuscleCategory>('Chest');
  const [customEquipment, setCustomEquipment] = useState<EquipmentType>('Dumbbell');
  const [customInstructions, setCustomInstructions] = useState('');

  const categories = ['All', 'Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core', 'Cardio', 'Plyometrics'];

  const filteredExercises = exercises
    .filter((ex) => {
      const matchesCat = selectedCategory === 'All' || ex.category === selectedCategory;
      const matchesQuery = ex.name.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCat && matchesQuery;
    })
    .sort((a, b) => {
      if (!!a.personalRecord === !!b.personalRecord) return 0;
      return a.personalRecord ? -1 : 1;
    });

  const handleCreateCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName.trim()) return;

    const newEx: Exercise = {
      id: `ex_custom_${Date.now()}`,
      name: customName.trim(),
      category: customCategory,
      equipment: customEquipment,
      instructions: customInstructions,
      isCustom: true,
    };

    onSaveExercise(newEx);
    setCustomName('');
    setCustomInstructions('');
    setIsCustomModalOpen(false);
  };

  // Extract history data for chart in Exercise Inspector
  const getExerciseChartData = (exerciseId: string) => {
    const dataPoints: { date: string; weight: number; reps: number; oneRepMax: number }[] = [];

    // Sort workouts oldest to newest
    const sorted = [...workouts].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    sorted.forEach((w) => {
      if (!w.isCompleted) return;
      w.exercises.forEach((we) => {
        if (we.exerciseId === exerciseId) {
          let highest1RM = 0;
          let bestW = 0;
          let bestR = 0;

          we.sets.forEach((s) => {
            if (s.completed && s.weight > 0 && s.reps > 0) {
              const est1RM = calculateOneRepMax(s.weight, s.reps);
              if (est1RM > highest1RM) {
                highest1RM = est1RM;
                bestW = s.weight;
                bestR = s.reps;
              }
            }
          });

          if (highest1RM > 0) {
            dataPoints.push({
              date: w.date.split('-').slice(1).join('/'),
              weight: bestW,
              reps: bestR,
              oneRepMax: highest1RM,
            });
          }
        }
      });
    });

    return dataPoints;
  };

  return (
    <div className="space-y-6 font-sans">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2.5 text-2xl font-semibold text-slate-900">
            <Dumbbell className="h-6 w-6 text-brand-700" />
            Exercises & PR Ledger
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Browse exercise library, track estimated 1RM progression, and add custom movements.
          </p>
        </div>

        <button
          onClick={() => setIsCustomModalOpen(true)}
          className="flex min-h-10 items-center gap-2 rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white shadow-xs hover:bg-brand-800"
        >
          <Plus className="h-4 w-4 stroke-[2.5]" />
          Create Custom Exercise
        </button>
      </div>

      {/* Search & Category Filter */}
      <div className="space-y-3 border-y border-slate-200 py-4">
        <div className="relative">
          <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
          <input
            type="text"
            aria-label="Search exercises"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search exercises by name..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-4 text-sm text-slate-800"
          />
        </div>

        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`min-h-9 rounded-lg px-3 text-sm font-medium whitespace-nowrap ${
                selectedCategory === cat
                  ? 'bg-brand-700 text-white shadow-xs'
                  : 'bg-slate-100 text-slate-600 hover:text-slate-900 border border-slate-200/60'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Exercise Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredExercises.map((ex) => (
          <div
            key={ex.id}
            onClick={() => setInspectingExercise(ex)}
            role="button"
            tabIndex={0}
            aria-label={`View ${ex.name}`}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setInspectingExercise(ex); } }}
            className="app-surface group cursor-pointer space-y-3 p-5 hover:border-brand-300 hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-slate-900 group-hover:text-brand-700">
                  {ex.name}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {ex.category} • {ex.equipment}
                </p>
              </div>

              {ex.isCustom && (
                <span className="text-xs font-bold tracking-normal px-2 py-0.5 rounded bg-brand-50 text-brand-700 border border-brand-200/80">
                  Custom
                </span>
              )}
            </div>

            {ex.personalRecord ? (
              <div className="border-t border-slate-200 pt-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-brand-600" />
                  <span className="text-sm font-semibold text-brand-800">PR record</span>
                </div>
                <div className="text-right text-xs font-mono">
                  <span className="font-bold text-slate-900">
                    {ex.personalRecord.maxWeight} {unit} × {ex.personalRecord.maxReps}
                  </span>
                  <p className="text-xs text-slate-500">Est. 1RM: {ex.personalRecord.calculatedOneRepMax} {unit}</p>
                </div>
              </div>
            ) : (
              <div className="border-t border-slate-200 pt-3 text-sm text-slate-500">
                No PR logged
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Custom Exercise Modal */}
      <Dialog isOpen={isCustomModalOpen} title="Add custom exercise" onClose={() => setIsCustomModalOpen(false)}>
          <form
            onSubmit={handleCreateCustom}
            className="space-y-4"
          >
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Exercise name</label>
              <input
                aria-label="Exercise name"
                type="text"
                required
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g., Cable Crossover Low to High"
                className="w-full bg-slate-50 border border-slate-200 text-slate-800 rounded-lg px-3.5 py-2 text-xs focus:outline-none focus:border-brand-600 focus:bg-white"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-bold tracking-normal text-slate-500">Category</label>
                <select
                  aria-label="Category"
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value as MuscleCategory)}
                  className="w-full bg-slate-50 border border-slate-200 text-slate-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-brand-600"
                >
                  <option value="Chest">Chest</option>
                  <option value="Back">Back</option>
                  <option value="Legs">Legs</option>
                  <option value="Shoulders">Shoulders</option>
                  <option value="Arms">Arms</option>
                  <option value="Core">Core</option>
                  <option value="Cardio">Cardio</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold tracking-normal text-slate-500">Equipment</label>
                <select
                  aria-label="Equipment"
                  value={customEquipment}
                  onChange={(e) => setCustomEquipment(e.target.value as EquipmentType)}
                  className="w-full bg-slate-50 border border-slate-200 text-slate-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-brand-600"
                >
                  <option value="Barbell">Barbell</option>
                  <option value="Dumbbell">Dumbbell</option>
                  <option value="Machine">Machine</option>
                  <option value="Cable">Cable</option>
                  <option value="Bodyweight">Bodyweight</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Instructions and form cues</label>
              <textarea
                aria-label="Instructions and form cues"
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="Optional form cues or setup details..."
                className="w-full bg-slate-50 border border-slate-200 text-slate-800 rounded-lg px-3.5 py-2 text-xs focus:outline-none focus:border-brand-600 h-20"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsCustomModalOpen(false)}
                className="px-4 py-2 rounded-lg text-xs font-bold tracking-normal text-slate-500 hover:text-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-brand-700 hover:bg-brand-800 text-white font-bold text-xs tracking-normal shadow-xs"
              >
                Save Movement
              </button>
            </div>
          </form>
      </Dialog>

      {/* Exercise Inspector Drawer Modal */}
      <Dialog isOpen={!!inspectingExercise} title={inspectingExercise?.name || "Exercise details"} onClose={() => setInspectingExercise(null)} wide>
      {inspectingExercise && (
          <div className="space-y-6">
            
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold tracking-normal px-2.5 py-0.5 rounded-full bg-brand-50 text-brand-700 border border-brand-200">
                    {inspectingExercise.category}
                  </span>
                  <span className="text-xs font-bold tracking-normal px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                    {inspectingExercise.equipment}
                  </span>
                </div>
                <h3 className="mt-2 text-xl font-semibold text-slate-900">{inspectingExercise.name}</h3>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const name = inspectingExercise.name;
                    setInspectingExercise(null);
                    onAskAICoachAboutExercise(`How much weight did I do last time on ${name} and how much should I do today?`);
                  }}
                  className="flex min-h-10 items-center gap-1.5 rounded-lg bg-brand-700 px-3.5 text-sm font-semibold text-white shadow-xs hover:bg-brand-800"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Ask AI
                </button>


              </div>
            </div>

            {/* Instructions */}
            {inspectingExercise.instructions && (
              <div className="border-t border-slate-200 pt-4 text-xs text-slate-700 space-y-1">
                <p className="text-sm font-semibold text-brand-800">Form cues and instructions</p>
                <p className="leading-relaxed">{inspectingExercise.instructions}</p>
              </div>
            )}

            {/* Personal Record Card */}
            {inspectingExercise.personalRecord && (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex items-center justify-between">
                <div>
                  <p className="app-eyebrow">All-time personal record</p>
                  <p className="text-xl font-mono font-bold text-brand-800 mt-0.5">
                    {inspectingExercise.personalRecord.maxWeight} {unit} × {inspectingExercise.personalRecord.maxReps} reps
                  </p>
                </div>
                <div className="text-right">
                  <p className="app-eyebrow">Estimated 1RM</p>
                  <p className="text-base font-mono font-bold text-slate-900">
                    {inspectingExercise.personalRecord.calculatedOneRepMax} {unit}
                  </p>
                </div>
              </div>
            )}

            {/* 1RM Progression Line Chart */}
            <div className="space-y-3">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
                <ChartIcon className="h-4 w-4 text-brand-600" />
                1RM Progression Chart ({unit})
              </h4>

              {getExerciseChartData(inspectingExercise.id).length > 0 ? (
                <div className="h-48 w-full bg-slate-50 border border-slate-200 rounded-lg p-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={getExerciseChartData(inspectingExercise.id)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="date" stroke="#64748b" fontSize={11} />
                      <YAxis stroke="#64748b" fontSize={11} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#ffffff', borderColor: '#cbd5e1', borderRadius: '12px', color: '#0f172a' }}
                      />
                      <Line isAnimationActive={!reduceMotion} animationDuration={300} type="monotone" dataKey="oneRepMax" name="Est 1RM" stroke="#0f766e" strokeWidth={2.5} dot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 text-center text-xs text-slate-400 font-semibold tracking-normal">
                  Log sets for this exercise to generate progress graphs.
                </div>
              )}
            </div>

          </div>
      )}
      </Dialog>

    </div>
  );
};
