import React, { useState } from 'react';
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

  const categories = ['All', 'Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core', 'Cardio'];

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
          <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight uppercase flex items-center gap-2.5">
            <Dumbbell className="h-6 w-6 text-teal-700" />
            Exercises & PR Ledger
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Browse exercise library, track estimated 1RM progression, and add custom movements.
          </p>
        </div>

        <button
          onClick={() => setIsCustomModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs uppercase tracking-wider shadow-xs transition-all"
        >
          <Plus className="h-4 w-4 stroke-[2.5]" />
          Create Custom Exercise
        </button>
      </div>

      {/* Search & Category Filter */}
      <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs space-y-3">
        <div className="relative">
          <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search exercises by name..."
            className="w-full bg-slate-50 border border-slate-200 text-slate-800 text-xs rounded-xl pl-10 pr-4 py-2.5 focus:outline-none focus:border-teal-600 focus:bg-white transition-colors"
          />
        </div>

        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider whitespace-nowrap transition-colors ${
                selectedCategory === cat
                  ? 'bg-teal-700 text-white shadow-xs'
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
            className="bg-white border border-slate-200/80 hover:border-teal-300 rounded-2xl p-5 cursor-pointer shadow-xs hover:shadow-md transition-all space-y-3 group"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-bold text-slate-900 text-base uppercase tracking-tight group-hover:text-teal-700 transition-colors">
                  {ex.name}
                </h3>
                <p className="text-[10px] text-slate-400 uppercase tracking-wider mt-0.5">
                  {ex.category} • {ex.equipment}
                </p>
              </div>

              {ex.isCustom && (
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200/80">
                  Custom
                </span>
              )}
            </div>

            {ex.personalRecord ? (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-teal-600" />
                  <span className="text-xs font-bold uppercase tracking-wider text-teal-800">PR Record</span>
                </div>
                <div className="text-right text-xs font-mono">
                  <span className="font-bold text-slate-900">
                    {ex.personalRecord.maxWeight} {unit} × {ex.personalRecord.maxReps}
                  </span>
                  <p className="text-[10px] text-slate-500 uppercase">Est 1RM: {ex.personalRecord.calculatedOneRepMax} {unit}</p>
                </div>
              </div>
            ) : (
              <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3 text-[10px] text-slate-400 uppercase font-semibold tracking-wider">
                No PR logged
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Custom Exercise Modal */}
      {isCustomModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateCustom}
            className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900">Add Custom Exercise</h3>
              <button
                type="button"
                onClick={() => setIsCustomModalOpen(false)}
                className="text-slate-400 hover:text-slate-700 font-bold"
              >
                ✕
              </button>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Exercise Name</label>
              <input
                type="text"
                required
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g., Cable Crossover Low to High"
                className="w-full bg-slate-50 border border-slate-200 text-slate-800 rounded-xl px-3.5 py-2 text-xs focus:outline-none focus:border-teal-600 focus:bg-white"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Category</label>
                <select
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value as MuscleCategory)}
                  className="w-full bg-slate-50 border border-slate-200 text-slate-800 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-teal-600"
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
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Equipment</label>
                <select
                  value={customEquipment}
                  onChange={(e) => setCustomEquipment(e.target.value as EquipmentType)}
                  className="w-full bg-slate-50 border border-slate-200 text-slate-800 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-teal-600"
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
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Instructions / Form Cues</label>
              <textarea
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="Optional form cues or setup details..."
                className="w-full bg-slate-50 border border-slate-200 text-slate-800 rounded-xl px-3.5 py-2 text-xs focus:outline-none focus:border-teal-600 h-20"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsCustomModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider text-slate-500 hover:text-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs uppercase tracking-wider shadow-xs"
              >
                Save Movement
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Exercise Inspector Drawer Modal */}
      {inspectingExercise && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:p-8 space-y-6 shadow-xl">
            
            <div className="flex items-start justify-between border-b border-slate-200 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200">
                    {inspectingExercise.category}
                  </span>
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                    {inspectingExercise.equipment}
                  </span>
                </div>
                <h3 className="text-xl font-bold text-slate-900 uppercase tracking-tight mt-2">{inspectingExercise.name}</h3>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const name = inspectingExercise.name;
                    setInspectingExercise(null);
                    onAskAICoachAboutExercise(`How much weight did I do last time on ${name} and how much should I do today?`);
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs uppercase tracking-wider shadow-xs"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Ask AI
                </button>

                <button
                  onClick={() => setInspectingExercise(null)}
                  className="text-slate-400 hover:text-slate-700 text-xs font-bold uppercase tracking-wider p-2"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Instructions */}
            {inspectingExercise.instructions && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-700 space-y-1">
                <p className="font-bold uppercase tracking-wider text-teal-800 text-[10px]">Form Cues & Instructions:</p>
                <p className="leading-relaxed">{inspectingExercise.instructions}</p>
              </div>
            )}

            {/* Personal Record Card */}
            {inspectingExercise.personalRecord && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">All-Time Personal Record</p>
                  <p className="text-xl font-mono font-bold text-teal-800 mt-0.5">
                    {inspectingExercise.personalRecord.maxWeight} {unit} × {inspectingExercise.personalRecord.maxReps} reps
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Est. 1RM</p>
                  <p className="text-base font-mono font-bold text-slate-900">
                    {inspectingExercise.personalRecord.calculatedOneRepMax} {unit}
                  </p>
                </div>
              </div>
            )}

            {/* 1RM Progression Line Chart */}
            <div className="space-y-3">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                <ChartIcon className="h-4 w-4 text-teal-600" />
                1RM Progression Chart ({unit})
              </h4>

              {getExerciseChartData(inspectingExercise.id).length > 0 ? (
                <div className="h-48 w-full bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={getExerciseChartData(inspectingExercise.id)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="date" stroke="#64748b" fontSize={11} />
                      <YAxis stroke="#64748b" fontSize={11} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#ffffff', borderColor: '#cbd5e1', borderRadius: '12px', color: '#0f172a' }}
                      />
                      <Line type="monotone" dataKey="oneRepMax" name="Est 1RM" stroke="#0f766e" strokeWidth={2.5} dot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 text-center text-xs text-slate-400 uppercase font-semibold tracking-wider">
                  Log sets for this exercise to generate progress graphs.
                </div>
              )}
            </div>

          </div>
        </div>
      )}

    </div>
  );
};
