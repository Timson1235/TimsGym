import React from 'react';
import { Zap, BarChart2, Calendar, Target, TrendingUp } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { DatabaseState } from '../types';
import { formatDateString } from '../lib/utils';

interface AnalyticsProps {
  db: DatabaseState;
}

export const Analytics: React.FC<AnalyticsProps> = ({ db }) => {
  const { workouts, exercises, profile } = db;
  const unit = profile.preferredUnit;

  const completedWorkouts = workouts
    .filter((w) => w.isCompleted)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Volume history per workout
  const volumeChartData = completedWorkouts.slice(-10).map((w) => ({
    date: w.date.split('-').slice(1).join('/'),
    volume: w.totalVolume,
    title: w.title,
  }));

  // Sets distribution by muscle category
  const categoryCounts: Record<string, number> = {};
  completedWorkouts.forEach((w) => {
    w.exercises.forEach((ex) => {
      const cat = ex.category || 'Other';
      const doneSets = ex.sets.filter((s) => s.completed).length;
      categoryCounts[cat] = (categoryCounts[cat] || 0) + doneSets;
    });
  });

  const categoryChartData = Object.keys(categoryCounts).map((cat) => ({
    name: cat,
    sets: categoryCounts[cat],
  }));

  const totalSetsCompleted = completedWorkouts.reduce((acc, w) => {
    return acc + w.exercises.reduce((exAcc, ex) => exAcc + ex.sets.filter((s) => s.completed).length, 0);
  }, 0);

  const totalVolume = completedWorkouts.reduce((acc, w) => acc + w.totalVolume, 0);
  const avgDuration = completedWorkouts.length
    ? Math.round(completedWorkouts.reduce((acc, w) => acc + w.durationMinutes, 0) / completedWorkouts.length)
    : 0;

  const exerciseOptions = exercises
    .map((exercise) => ({
      exercise,
      workoutCount: completedWorkouts.filter((workout) => workout.exercises.some(
        (entry) => entry.exerciseId === exercise.id || entry.exerciseName.toLowerCase() === exercise.name.toLowerCase(),
      )).length,
    }))
    .filter((item) => item.workoutCount > 0)
    .sort((a, b) => b.workoutCount - a.workoutCount || a.exercise.name.localeCompare(b.exercise.name))
    .map((item) => item.exercise);
  const [selectedExerciseId, setSelectedExerciseId] = React.useState<string>('');
  const selectedExercise = exerciseOptions.find((exercise) => exercise.id === selectedExerciseId) || exerciseOptions[0];

  const exerciseProgress = selectedExercise ? completedWorkouts.flatMap((workout) => {
    const entry = workout.exercises.find((item) => (
      item.exerciseId === selectedExercise.id
      || item.exerciseName.toLowerCase() === selectedExercise.name.toLowerCase()
    ));
    if (!entry) return [];
    const validSets = entry.sets.filter((set) => set.completed && set.weight > 0 && set.reps > 0);
    if (validSets.length === 0) return [];
    const heaviest = validSets.reduce((best, set) => (
      set.weight > best.weight || (set.weight === best.weight && set.reps > best.reps) ? set : best
    ));
    return [{
      date: workout.date.split('-').slice(1).join('/'),
      fullDate: formatDateString(workout.date),
      weight: heaviest.weight,
      reps: heaviest.reps,
      title: workout.title,
    }];
  }) : [];

  const repColor = (reps: number) => {
    if (reps <= 4) return '#eab308';
    if (reps <= 8) return '#0d9488';
    return '#2563eb';
  };

  return (
    <div className="space-y-6 font-sans">
      
      {/* Header */}
      <div>
        <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight uppercase flex items-center gap-2.5">
          <BarChart2 className="h-6 w-6 text-teal-700" />
          Analytics & Volume Ledger
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Detailed metrics, progressive overload tracking, and muscle group volume distribution.
        </p>
      </div>

      {/* Metric Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs flex items-center gap-4">
          <div className="h-11 w-11 rounded-xl bg-teal-50 text-teal-700 border border-teal-200 flex items-center justify-center shrink-0">
            <Zap className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Total Lifetime Volume</p>
            <p className="text-2xl font-mono font-bold text-slate-900 mt-0.5">
              {totalVolume.toLocaleString()} <span className="text-xs font-normal text-teal-800">{unit}</span>
            </p>
          </div>
        </div>

        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs flex items-center gap-4">
          <div className="h-11 w-11 rounded-xl bg-teal-50 text-teal-700 border border-teal-200 flex items-center justify-center shrink-0">
            <Target className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Total Completed Sets</p>
            <p className="text-2xl font-mono font-bold text-slate-900 mt-0.5">{totalSetsCompleted} <span className="text-xs font-normal text-slate-500">sets</span></p>
          </div>
        </div>

        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs flex items-center gap-4">
          <div className="h-11 w-11 rounded-xl bg-teal-50 text-teal-700 border border-teal-200 flex items-center justify-center shrink-0">
            <Calendar className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Avg Session Duration</p>
            <p className="text-2xl font-mono font-bold text-slate-900 mt-0.5">{avgDuration} <span className="text-xs font-normal text-slate-500">mins</span></p>
          </div>
        </div>
      </div>

      {/* Grid: Charts */}
      <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-teal-600" />
            Exercise Progression
          </h3>
          <select
            value={selectedExercise?.id || ''}
            onChange={(event) => setSelectedExerciseId(event.target.value)}
            className="w-full sm:w-64 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-semibold text-slate-700 focus:outline-none focus:border-teal-600"
            aria-label="Select exercise progression"
          >
            {exerciseOptions.map((exercise) => (
              <option key={exercise.id} value={exercise.id}>{exercise.name}</option>
            ))}
          </select>
        </div>

        {exerciseProgress.length > 0 ? (
          <>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={exerciseProgress} margin={{ top: 14, right: 18, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" stroke="#64748b" fontSize={11} />
                  <YAxis stroke="#64748b" fontSize={11} unit={` ${unit}`} domain={['dataMin - 5', 'dataMax + 5']} />
                  <Tooltip
                    formatter={(value, name, item) => [
                      `${value} ${unit} × ${item.payload.reps} reps`,
                      'Heaviest set',
                    ]}
                    labelFormatter={(_, payload) => payload[0]?.payload.fullDate || ''}
                    contentStyle={{ backgroundColor: '#ffffff', borderColor: '#cbd5e1', borderRadius: '8px', color: '#0f172a' }}
                  />
                  <Bar
                    dataKey="weight"
                    name="Max weight"
                    radius={[5, 5, 0, 0]}
                    maxBarSize={64}
                  >
                    {exerciseProgress.map((point) => (
                      <Cell key={`${point.fullDate}-${point.weight}-${point.reps}`} fill={repColor(point.reps)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-4 text-[10px] font-semibold text-slate-500">
              <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-yellow-500" />1-4 reps</span>
              <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-teal-600" />5-8 reps</span>
              <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-blue-600" />9+ reps</span>
            </div>
          </>
        ) : (
          <div className="py-12 text-center text-slate-400 text-xs uppercase font-medium tracking-wider">
            Log completed weighted sets to see exercise progression.
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Workout Volume Progression */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-teal-600" />
            Workout Volume History ({unit})
          </h3>

          {volumeChartData.length > 0 ? (
            <div className="h-64 w-full pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={volumeChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" stroke="#64748b" fontSize={11} />
                  <YAxis stroke="#64748b" fontSize={11} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#ffffff', borderColor: '#cbd5e1', borderRadius: '12px', color: '#0f172a' }}
                  />
                  <Bar dataKey="volume" name="Volume" fill="#0f766e" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="py-12 text-center text-slate-400 text-xs uppercase font-medium tracking-wider">
              Log workouts to visualize volume trends over time.
            </div>
          )}
        </div>

        {/* Muscle Group Distribution */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 flex items-center gap-2">
            <Target className="h-4 w-4 text-teal-600" />
            Sets Completed by Muscle Category
          </h3>

          {categoryChartData.length > 0 ? (
            <div className="h-64 w-full pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryChartData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis type="number" stroke="#64748b" fontSize={11} />
                  <YAxis type="category" dataKey="name" stroke="#64748b" fontSize={11} width={75} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#ffffff', borderColor: '#cbd5e1', borderRadius: '12px', color: '#0f172a' }}
                  />
                  <Bar dataKey="sets" name="Sets" fill="#0d9488" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="py-12 text-center text-slate-400 text-xs uppercase font-medium tracking-wider">
              Log sets to see muscle distribution analysis.
            </div>
          )}
        </div>

      </div>

    </div>
  );
};
