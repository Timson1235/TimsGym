import React from 'react';
import { Zap, BarChart2, Calendar, Target, TrendingUp } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ResponsiveContainer, BarChart, Bar, Cell, LabelList, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { DatabaseState } from '../types';
import { formatDateString } from '../lib/utils';

interface AnalyticsProps {
  db: DatabaseState;
}

export const Analytics: React.FC<AnalyticsProps> = ({ db }) => {
  const { workouts, exercises, profile } = db;
  const unit = profile.preferredUnit;
  const reduceMotion = useReducedMotion();

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
    // One color per rep count, capped so unusually high-rep work remains legible.
    const normalizedReps = Math.min(Math.max(reps, 1), 15);
    const hue = 18 + ((normalizedReps - 1) / 14) * 192;
    return `hsl(${hue} 68% 42%)`;
  };

  return (
    <div className="space-y-6 font-sans">
      
      {/* Header */}
      <div>
        <h2 className="flex items-center gap-2.5 text-2xl font-semibold text-slate-900">
          <BarChart2 className="h-6 w-6 text-brand-700" />
          Analytics & Volume Ledger
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Detailed metrics, progressive overload tracking, and muscle group volume distribution.
        </p>
      </div>

      {/* Metric Summary Cards */}
      <div className="app-metric-strip grid grid-cols-1 sm:grid-cols-3">
        <div className="flex items-center gap-4 border-b border-slate-200/80 p-5 sm:border-b-0 sm:border-r">
          <div className="h-11 w-11 rounded-lg bg-brand-50 text-brand-700 border border-brand-200 flex items-center justify-center shrink-0">
            <Zap className="h-5 w-5" />
          </div>
          <div>
            <p className="app-eyebrow">Total lifetime volume</p>
            <p className="text-2xl font-mono font-bold text-slate-900 mt-0.5">
              {totalVolume.toLocaleString()} <span className="text-xs font-normal text-brand-800">{unit}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 border-b border-slate-200/80 p-5 sm:border-b-0 sm:border-r">
          <div className="h-11 w-11 rounded-lg bg-brand-50 text-brand-700 border border-brand-200 flex items-center justify-center shrink-0">
            <Target className="h-5 w-5" />
          </div>
          <div>
            <p className="app-eyebrow">Completed sets</p>
            <p className="text-2xl font-mono font-bold text-slate-900 mt-0.5">{totalSetsCompleted} <span className="text-xs font-normal text-slate-500">sets</span></p>
          </div>
        </div>

        <div className="flex items-center gap-4 p-5">
          <div className="h-11 w-11 rounded-lg bg-brand-50 text-brand-700 border border-brand-200 flex items-center justify-center shrink-0">
            <Calendar className="h-5 w-5" />
          </div>
          <div>
            <p className="app-eyebrow">Average session duration</p>
            <p className="text-2xl font-mono font-bold text-slate-900 mt-0.5">{avgDuration} <span className="text-xs font-normal text-slate-500">mins</span></p>
          </div>
        </div>
      </div>

      {/* Grid: Charts */}
      <section className="space-y-4 border-y border-slate-200/80 py-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <TrendingUp className="h-4 w-4 text-brand-600" />
            Exercise Progression
          </h3>
          <select
            value={selectedExercise?.id || ''}
            onChange={(event) => setSelectedExerciseId(event.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 sm:w-64"
            aria-label="Select exercise progression"
          >
            {exerciseOptions.map((exercise) => (
              <option key={exercise.id} value={exercise.id}>{exercise.name}</option>
            ))}
          </select>
        </div>

        {exerciseProgress.length > 0 ? (
          <>
            <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={selectedExercise?.id || 'no-exercise'}
              className="h-72 w-full"
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              transition={reduceMotion ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.3 }}
            >
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
                    isAnimationActive={!reduceMotion}
                    animationDuration={300}
                    dataKey="weight"
                    name="Max weight"
                    radius={[5, 5, 0, 0]}
                    maxBarSize={64}
                  >
                    {exerciseProgress.length <= 16 && <LabelList dataKey="reps" position="top" formatter={(value) => `${value}r`} fill="#475569" fontSize={12} />}
                    {exerciseProgress.map((point) => (
                      <Cell key={`${point.fullDate}-${point.weight}-${point.reps}`} fill={repColor(point.reps)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </motion.div>
            </AnimatePresence>
            <div className="max-w-sm space-y-2 text-xs font-medium text-slate-600" aria-label="Bar color shows repetitions completed at the maximum weight">
              <p>Reps at max weight</p>
              <div className="h-3 rounded-sm" aria-hidden="true" style={{ background: `linear-gradient(90deg, ${Array.from({ length: 15 }, (_, i) => `${repColor(i + 1)} ${i / 14 * 100}%`).join(', ')})` }} />
              <div className="relative mx-2 h-5">
                {[1, 5, 6, 10, 15].map((reps) => <span key={reps} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${(reps - 1) / 14 * 100}%` }}>{reps === 15 ? '15+' : reps}</span>)}
              </div>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer py-2 font-medium">Session values</summary>
              <div className="overflow-x-auto">
                <table className="w-full text-left tabular-nums">
                  <thead><tr className="border-b border-slate-300"><th className="py-2">Date</th><th>Max weight</th><th>Reps</th></tr></thead>
                  <tbody>{exerciseProgress.map((point, i) => <tr key={i} className="border-b border-slate-200"><td className="py-2">{point.fullDate}</td><td>{point.weight} {unit}</td><td>{point.reps}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
          </>
        ) : (
          <div className="py-12 text-center text-sm text-slate-500">
            Log completed weighted sets to see exercise progression.
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-0 border-b border-slate-200/80 lg:grid-cols-2">
        
        {/* Workout Volume Progression */}
        <section className="space-y-4 border-b border-slate-200/80 py-5 lg:border-b-0 lg:border-r lg:pr-6">
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <BarChart2 className="h-4 w-4 text-brand-600" />
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
                  <Bar isAnimationActive={!reduceMotion} animationDuration={300} dataKey="volume" name="Volume" fill="#2c6b46" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="py-12 text-center text-sm text-slate-500">
              Log workouts to visualize volume trends over time.
            </div>
          )}
        </section>

        {/* Muscle Group Distribution */}
        <section className="space-y-4 py-5 lg:pl-6">
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <Target className="h-4 w-4 text-brand-600" />
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
                  <Bar isAnimationActive={!reduceMotion} animationDuration={300} dataKey="sets" name="Sets" fill="#315fa8" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="py-12 text-center text-sm text-slate-500">
              Log sets to see muscle distribution analysis.
            </div>
          )}
        </section>

      </div>

    </div>
  );
};
