import React from 'react';
import { LineChart as ChartIcon, Trophy, Flame, Zap, BarChart2, Calendar, Target } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell } from 'recharts';
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
