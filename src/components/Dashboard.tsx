import React from 'react';
import { Play, Sparkles, Trophy, Flame, Calendar, Plus, ChevronRight, Zap, Dumbbell, History, Target, ArrowUpRight, Brain } from 'lucide-react';
import { DatabaseState, RoutineTemplate, WorkoutSession } from '../types';
import { formatDateString } from '../lib/utils';

interface DashboardProps {
  db: DatabaseState;
  activeWorkout: WorkoutSession | null;
  onStartBlankWorkout: () => void;
  onStartTemplateWorkout: (template: RoutineTemplate) => void;
  onResumeWorkout: () => void;
  onSelectTab: (tab: 'active-workout' | 'history' | 'exercises' | 'analytics') => void;
  onQuickAskAI: (prompt: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  db,
  activeWorkout,
  onStartBlankWorkout,
  onStartTemplateWorkout,
  onResumeWorkout,
  onSelectTab,
  onQuickAskAI,
}) => {
  const { profile, exercises, workouts, templates } = db;
  const unit = profile.preferredUnit;

  // Calculate high-level metrics
  const completedWorkouts = workouts.filter((w) => w.isCompleted);
  const totalVolume = completedWorkouts.reduce((acc, w) => acc + (w.totalVolume || 0), 0);
  const totalPRs = exercises.filter((e) => e.personalRecord).length;

  const quickPrompts = [
    { label: "How much did I Bench last time?", icon: "💪" },
    { label: "How much weight should I Squat today?", icon: "🏋️‍♂️" },
    { label: "Suggest next exercise for a Push day", icon: "⚡" },
    { label: "Analyze my progressive overload progress", icon: "📈" },
  ];

  return (
    <div className="space-y-6">
      
      {/* Active Session Alert Banner (if workout is active) */}
      {activeWorkout && (
        <div className="bg-teal-50 border border-teal-200 rounded-2xl p-5 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-teal-700 text-white flex items-center justify-center">
              <Play className="h-5 w-5 fill-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-teal-600 animate-ping"></span>
                <p className="text-[10px] font-bold uppercase tracking-wider text-teal-800">Workout Session Active</p>
              </div>
              <h3 className="text-base font-bold text-slate-900 mt-0.5 uppercase tracking-tight">{activeWorkout.title || "Active Workout"}</h3>
              <p className="text-xs text-slate-500">
                {activeWorkout.exercises.length} exercise{activeWorkout.exercises.length === 1 ? '' : 's'} added
              </p>
            </div>
          </div>
          <button
            onClick={onResumeWorkout}
            className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs uppercase tracking-wider shadow-xs transition-all"
          >
            Resume Session
          </button>
        </div>
      )}

      {/* Main Hero Bento Banner */}
      <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xs relative overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative z-10">
          <div>
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-teal-50 border border-teal-200 text-teal-800 text-[10px] font-bold uppercase tracking-wider mb-2">
              <Sparkles className="h-3 w-3 text-teal-600" />
              <span>TimsGym AI</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight uppercase">
              Welcome Back, <span className="text-teal-700 italic">{profile.name}</span>
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 mt-1 max-w-xl">
              Target goal: <span className="text-slate-800 font-semibold">{profile.primaryGoal}</span> ({profile.experienceLevel}).
            </p>

            {/* Active AI Memories / Personal Goals */}
            {profile.personalMemories && profile.personalMemories.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-md">
                  <Brain className="h-3 w-3 text-teal-600" />
                  KI-Gedächtnis:
                </span>
                {profile.personalMemories.map((mem, idx) => (
                  <span
                    key={idx}
                    className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-slate-700"
                  >
                    {mem}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={onStartBlankWorkout}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs uppercase tracking-wider shadow-xs transition-all"
            >
              <Plus className="h-4 w-4 stroke-[2.5]" />
              Start Blank Session
            </button>
          </div>
        </div>

        {/* Routine Launchers - Bento Row */}
        <div className="mt-6 pt-5 border-t border-slate-200/80">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">
            Quick Launch Routine Templates
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {templates.map((tpl) => (
              <div
                key={tpl.id}
                onClick={() => onStartTemplateWorkout(tpl)}
                className="group p-4 rounded-xl bg-slate-50 border border-slate-200 hover:border-teal-300 hover:bg-teal-50/40 transition-all cursor-pointer relative overflow-hidden"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200 uppercase">
                    {tpl.category}
                  </span>
                  <Play className="h-4 w-4 text-slate-400 group-hover:text-teal-700 transition-colors" />
                </div>
                <h4 className="font-bold text-slate-900 text-sm group-hover:text-teal-800 transition-colors">
                  {tpl.name}
                </h4>
                <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                  {tpl.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* AI Assistant Quick Prompt Bar - Bento Row */}
      <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-teal-800 mb-3">
          <Sparkles className="h-3.5 w-3.5 text-teal-600" />
          <span>Quick AI Coach Questions</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {quickPrompts.map((item, idx) => (
            <button
              key={idx}
              onClick={() => onQuickAskAI(item.label)}
              className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-200 hover:border-teal-300 hover:bg-teal-50/40 text-left text-xs font-medium text-slate-700 hover:text-slate-900 transition-all group"
            >
              <span className="text-base">{item.icon}</span>
              <span className="flex-1 line-clamp-2">{item.label}</span>
              <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-teal-700 group-hover:translate-x-0.5 transition-all" />
            </button>
          ))}
        </div>
      </div>

      {/* Bento Grid: 3-Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        
        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Workouts Completed</p>
            <p className="font-mono text-2xl font-bold text-slate-900 mt-1">{completedWorkouts.length}</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-teal-50 border border-teal-200 flex items-center justify-center text-teal-700">
            <Flame className="h-5 w-5" />
          </div>
        </div>

        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Total Volume Moved</p>
            <p className="font-mono text-2xl font-bold text-slate-900 mt-1">
              {totalVolume.toLocaleString()} <span className="text-xs font-normal text-slate-500">{unit}</span>
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-teal-50 border border-teal-200 flex items-center justify-center text-teal-700">
            <Zap className="h-5 w-5" />
          </div>
        </div>

        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Personal Records (PRs)</p>
            <p className="font-mono text-2xl font-bold text-teal-700 mt-1">{totalPRs}</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-teal-50 border border-teal-200 flex items-center justify-center text-teal-700">
            <Trophy className="h-5 w-5" />
          </div>
        </div>

      </div>

      {/* Bento Grid: Personal Records & Recent Workout Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Personal Records Highlight */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Trophy className="h-4 w-4 text-teal-600" />
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Top PR Highlights</h3>
              </div>
              <button
                onClick={() => onSelectTab('exercises')}
                className="text-[10px] font-bold uppercase tracking-wider text-teal-700 hover:text-teal-900 flex items-center gap-1"
              >
                View All <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="space-y-3">
              {exercises
                .filter((e) => e.personalRecord)
                .slice(0, 4)
                .map((ex) => (
                  <div
                    key={ex.id}
                    className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 border border-slate-200"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-teal-100 border border-teal-200 flex items-center justify-center text-teal-800 font-mono font-bold text-xs">
                        PR
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-900">{ex.name}</p>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider">{ex.category} • {ex.equipment}</p>
                      </div>
                    </div>

                    <div className="text-right font-mono">
                      <p className="text-sm font-bold text-teal-800">
                        {ex.personalRecord?.maxWeight} {unit} × {ex.personalRecord?.maxReps}
                      </p>
                      <p className="text-[10px] text-slate-500 uppercase">
                        Est 1RM: <span className="font-bold text-slate-700">{ex.personalRecord?.calculatedOneRepMax} {unit}</span>
                      </p>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>

        {/* Recent Workouts Log Feed */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-teal-600" />
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Recent Activity Logs</h3>
              </div>
              <button
                onClick={() => onSelectTab('history')}
                className="text-[10px] font-bold uppercase tracking-wider text-teal-700 hover:text-teal-900 flex items-center gap-1"
              >
                Log History <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="space-y-3">
              {completedWorkouts.length === 0 ? (
                <div className="text-center py-10 text-slate-400 text-xs font-medium uppercase tracking-wider">
                  No completed workouts logged yet. Start a session above!
                </div>
              ) : (
                completedWorkouts.slice(0, 3).map((w) => (
                  <div
                    key={w.id}
                    className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-bold text-slate-900 uppercase tracking-tight">{w.title}</h4>
                      <span className="text-[10px] font-mono text-slate-500 flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5 text-teal-600" />
                        {formatDateString(w.date)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 font-mono text-[11px]">
                        {w.exercises.length} ex
                      </span>
                      <span className="px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 font-mono text-[11px]">
                        {w.durationMinutes} mins
                      </span>
                      <span className="px-2 py-0.5 rounded bg-teal-50 text-teal-800 border border-teal-200 font-mono font-bold text-[11px]">
                        Vol: {w.totalVolume.toLocaleString()} {unit}
                      </span>
                    </div>

                    {w.notes && (
                      <p className="text-xs text-slate-500 italic line-clamp-1">"{w.notes}"</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

      </div>

    </div>
  );
};
