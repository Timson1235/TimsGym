import React, { useState } from 'react';
import { History, Calendar, Trash2, Clock, Dumbbell, Search, ChevronDown, ChevronUp, Repeat, Download, CloudUpload, Check } from 'lucide-react';
import { DatabaseState, WorkoutSession } from '../types';
import { formatDateString } from '../lib/utils';
import { exportDatabaseAsJson } from '../lib/drive';
import { ConfirmDialog } from './ConfirmDialog';

interface WorkoutHistoryProps {
  db: DatabaseState;
  onDeleteWorkout: (id: string) => void;
  onRepeatWorkout: (session: WorkoutSession) => void;
}

export const WorkoutHistory: React.FC<WorkoutHistoryProps> = ({
  db,
  onDeleteWorkout,
  onRepeatWorkout,
}) => {
  const { workouts, profile } = db;
  const unit = profile.preferredUnit;

  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [backedUp, setBackedUp] = useState<boolean>(false);
  const [workoutPendingDelete, setWorkoutPendingDelete] = useState<WorkoutSession | null>(null);

  const handleBackup = () => {
    exportDatabaseAsJson(db);
    setBackedUp(true);
    setTimeout(() => setBackedUp(false), 3000);
  };

  const completedWorkouts = workouts
    .filter((w) => w.isCompleted)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const filteredWorkouts = completedWorkouts.filter((w) => {
    const titleMatch = w.title.toLowerCase().includes(searchQuery.toLowerCase());
    const exMatch = w.exercises.some((e) => e.exerciseName.toLowerCase().includes(searchQuery.toLowerCase()));
    return titleMatch || exMatch;
  });

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div className="space-y-6 font-sans">
      
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2.5 text-2xl font-semibold text-slate-900">
            <History className="h-6 w-6 text-teal-700" />
            Workout History & Logs
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Browse past gym sessions, view set-by-set details, or repeat previous routines.
          </p>
        </div>

        {/* Search Bar & Backup */}
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-60">
            <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search workouts..."
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-4 text-sm text-slate-800 shadow-xs"
            />
          </div>

          <button
            onClick={handleBackup}
            title="Datenbank als JSON exportieren / sichern"
            className="flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-xs hover:bg-slate-100"
          >
            {backedUp ? (
              <>
                <Check className="h-4 w-4 text-teal-600" />
                <span className="hidden sm:inline text-teal-700">Gesichert</span>
              </>
            ) : (
              <>
                <Download className="h-4 w-4 text-slate-500" />
                <span className="hidden sm:inline">Backup</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Workout Logs List */}
      <div className="space-y-4">
        {filteredWorkouts.length === 0 ? (
          <div className="app-surface p-12 text-center text-slate-500">
            <History className="h-10 w-10 text-slate-300 mx-auto mb-3" />
            <p className="text-base font-semibold text-slate-800">No workout logs found</p>
            <p className="mt-1 text-sm text-slate-500">Completed gym sessions will appear here.</p>
          </div>
        ) : (
          filteredWorkouts.map((w) => {
            const isExpanded = expandedId === w.id;

            return (
              <div
                key={w.id}
                className="app-surface overflow-hidden"
              >
                {/* Main Card Header */}
                <div
                  onClick={() => toggleExpand(w.id)}
                  className="flex cursor-pointer flex-col justify-between gap-4 p-5 hover:bg-slate-50/60 sm:flex-row sm:items-center"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold text-teal-800 flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5 text-teal-600" />
                        {formatDateString(w.date)}
                      </span>
                    </div>
                    <h3 className="text-base font-semibold text-slate-900">{w.title}</h3>
                    {w.notes && (
                      <p className="text-xs text-slate-500 italic line-clamp-1">"{w.notes}"</p>
                    )}
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right text-xs space-y-0.5">
                      <p className="font-mono font-bold text-slate-900">
                        Vol: <span className="text-teal-800">{w.totalVolume.toLocaleString()} {unit}</span>
                      </p>
                      <p className="text-xs text-slate-500">
                        {w.exercises.length} ex • {w.durationMinutes} mins
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRepeatWorkout(w);
                        }}
                        className="flex min-h-10 items-center gap-1.5 rounded-lg bg-teal-50 px-3 text-sm font-medium text-teal-800 hover:bg-teal-100"
                        title="Repeat this workout in a new session"
                      >
                        <Repeat className="h-3.5 w-3.5 text-teal-600" />
                        <span>Repeat</span>
                      </button>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setWorkoutPendingDelete(w);
                        }}
                        className="app-icon-button text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                        aria-label={`Delete ${w.title}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>

                      <div className="text-slate-400">
                        {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Expanded Set Details */}
                {isExpanded && (
                  <div className="border-t border-slate-200 bg-slate-50/50 p-5 space-y-4">
                    <h4 className="app-eyebrow">
                      Exercise and set details
                    </h4>

                    <div className="space-y-3">
                      {w.exercises.map((we) => (
                        <div key={we.id} className="app-surface-subtle space-y-2 p-3.5">
                          <p className="text-sm font-semibold text-slate-900">{we.exerciseName}</p>
                          <div className="flex flex-wrap gap-2">
                            {we.sets.map((s) => (
                              <span
                                key={s.id}
                                className={`text-[11px] font-mono px-2.5 py-1 rounded-lg border ${
                                  s.completed
                                    ? 'bg-teal-50 border-teal-200 text-teal-900 font-semibold'
                                    : 'bg-slate-100 border-slate-200 text-slate-500'
                                }`}
                              >
                                Set {s.setNumber}: {s.weight} {unit} × {s.reps} reps
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <ConfirmDialog
        isOpen={Boolean(workoutPendingDelete)}
        title="Delete this workout log?"
        description={workoutPendingDelete ? `“${workoutPendingDelete.title}” and its recorded sets will be removed from your history.` : ''}
        confirmLabel="Delete workout"
        onConfirm={() => {
          if (workoutPendingDelete) onDeleteWorkout(workoutPendingDelete.id);
          setWorkoutPendingDelete(null);
        }}
        onClose={() => setWorkoutPendingDelete(null)}
      />

    </div>
  );
};
