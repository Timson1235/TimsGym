import React, { useState, useEffect } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth } from './lib/firebase';
import { 
  DatabaseState, WorkoutSession, RoutineTemplate, Exercise, UserProfile 
} from './types';
import { 
  fetchDatabase, saveWorkoutApi, deleteWorkoutApi, saveExerciseApi, updateProfileApi 
} from './lib/api';
import { Navbar } from './components/Navbar';
import { AICoachMainView } from './components/AICoachMainView';
import { Dashboard } from './components/Dashboard';
import { ActiveWorkout } from './components/ActiveWorkout';
import { WorkoutHistory } from './components/WorkoutHistory';
import { ExerciseLibrary } from './components/ExerciseLibrary';
import { Analytics } from './components/Analytics';
import { AICoachDrawer } from './components/AICoachDrawer';
import { RestTimerModal } from './components/RestTimerModal';
import { PRCelebrationModal } from './components/PRCelebrationModal';
import { LoginScreen } from './components/LoginScreen';
import { Loader2 } from 'lucide-react';

export default function App() {
  const [db, setDb] = useState<DatabaseState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [guestMode, setGuestMode] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'ai-coach' | 'dashboard' | 'active-workout' | 'history' | 'exercises' | 'analytics'>('ai-coach');

  // Active Workout Session state
  const [activeWorkout, setActiveWorkout] = useState<WorkoutSession | null>(null);

  // Modals state
  const [isAICoachOpen, setIsAICoachOpen] = useState<boolean>(false);
  const [aiInitialPrompt, setAiInitialPrompt] = useState<string>('');
  
  const [restTimerSeconds, setRestTimerSeconds] = useState<number | null>(null);
  const [activePRCelebration, setActivePRCelebration] = useState<{ exerciseName: string; weight: number; reps: number } | null>(null);

  // Listen to Auth State Changes and Sync Database
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      setLoading(true);
      try {
        const data = await fetchDatabase();
        setDb(data);
      } catch (err) {
        console.error('Failed to load database:', err);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col items-center justify-center space-y-3 font-sans">
        <Loader2 className="h-8 w-8 text-teal-700 animate-spin" />
        <p className="text-xs font-semibold text-slate-600">Lade TimsGym AI...</p>
      </div>
    );
  }

  // If user is not logged in and hasn't chosen guest mode, show the Login Gatekeeper Screen
  if (!currentUser && !guestMode) {
    return <LoginScreen onGuestContinue={() => setGuestMode(true)} />;
  }

  if (!db) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col items-center justify-center space-y-3 font-sans">
        <Loader2 className="h-8 w-8 text-teal-700 animate-spin" />
        <p className="text-xs font-semibold text-slate-600">Initialisiere Trainingsdatenbank...</p>
      </div>
    );
  }

  // Action Handlers
  const handleToggleUnit = async () => {
    // Keep fixed in kg
    const updatedDb = await updateProfileApi({ preferredUnit: 'kg' });
    setDb(updatedDb);
  };

  const handleStartBlankWorkout = () => {
    const newSession: WorkoutSession = {
      id: `wk_${Date.now()}`,
      title: 'Gym Workout Session',
      date: new Date().toISOString().split('T')[0],
      durationMinutes: 0,
      exercises: [],
      totalVolume: 0,
      isCompleted: false,
    };

    setActiveWorkout(newSession);
    setActiveTab('active-workout');
  };

  const handleStartTemplateWorkout = (tpl: RoutineTemplate) => {
    const templateExercises = tpl.exercises.map((item, idx) => {
      const exerciseObj = db.exercises.find((e) => e.id === item.exerciseId);
      const defaultSets = [];
      const numSets = item.defaultSets || 3;
      const defaultWeight = exerciseObj?.personalRecord?.maxWeight || 60;

      for (let i = 1; i <= numSets; i++) {
        defaultSets.push({
          id: `set_${Date.now()}_${idx}_${i}`,
          setNumber: i,
          type: 'working' as const,
          weight: defaultWeight,
          reps: item.defaultReps || 8,
          rpe: 8,
          completed: false,
        });
      }

      return {
        id: `we_${Date.now()}_${idx}`,
        exerciseId: item.exerciseId,
        exerciseName: exerciseObj ? exerciseObj.name : 'Custom Movement',
        category: exerciseObj ? exerciseObj.category : 'Chest',
        sets: defaultSets,
      };
    });

    const newSession: WorkoutSession = {
      id: `wk_${Date.now()}`,
      title: tpl.name,
      date: new Date().toISOString().split('T')[0],
      durationMinutes: 0,
      exercises: templateExercises,
      totalVolume: 0,
      isCompleted: false,
    };

    setActiveWorkout(newSession);
    setActiveTab('active-workout');
  };

  const handleFinishWorkout = async (completedSession: WorkoutSession) => {
    const updatedDb = await saveWorkoutApi(completedSession);
    setDb(updatedDb);
    setActiveWorkout(null);
    setActiveTab('history');
  };

  const handleCancelWorkout = () => {
    if (confirm('Discard current workout session?')) {
      setActiveWorkout(null);
      setActiveTab('ai-coach');
    }
  };

  const handleDeleteWorkout = async (id: string) => {
    const updatedDb = await deleteWorkoutApi(id);
    setDb(updatedDb);
  };

  const handleSaveExercise = async (newEx: Exercise) => {
    const updatedDb = await saveExerciseApi(newEx);
    setDb(updatedDb);
  };

  const handleRepeatWorkout = (session: WorkoutSession) => {
    const newExercises = session.exercises.map((we, idx) => ({
      ...we,
      id: `we_${Date.now()}_${idx}`,
      sets: we.sets.map((s, sIdx) => ({
        ...s,
        id: `set_${Date.now()}_${idx}_${sIdx}`,
        completed: false,
      })),
    }));

    const newSession: WorkoutSession = {
      id: `wk_${Date.now()}`,
      title: `${session.title} (Repeat)`,
      date: new Date().toISOString().split('T')[0],
      durationMinutes: 0,
      exercises: newExercises,
      totalVolume: 0,
      isCompleted: false,
    };

    setActiveWorkout(newSession);
    setActiveTab('active-workout');
  };

  // AI Prompt Helper
  const handleQuickAskAI = (prompt: string) => {
    setAiInitialPrompt(prompt);
    setActiveTab('ai-coach');
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans selection:bg-teal-100 selection:text-slate-900">
      
      {/* Top Navbar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        activeWorkout={activeWorkout}
        preferredUnit={db.profile.preferredUnit}
        onToggleUnit={handleToggleUnit}
        onOpenAICoach={() => {
          setActiveTab('ai-coach');
        }}
        user={currentUser}
      />

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-12">
        {activeTab === 'ai-coach' && (
          <AICoachMainView
            db={db}
            activeWorkout={activeWorkout}
            onUpdateDatabase={(updatedDb) => setDb(updatedDb)}
            onStartWorkoutSession={(session) => {
              setActiveWorkout(session);
              setActiveTab('active-workout');
            }}
            onSelectTab={setActiveTab}
            initialPrompt={aiInitialPrompt}
          />
        )}

        {activeTab === 'dashboard' && (
          <Dashboard
            db={db}
            activeWorkout={activeWorkout}
            onStartBlankWorkout={handleStartBlankWorkout}
            onStartTemplateWorkout={handleStartTemplateWorkout}
            onResumeWorkout={() => setActiveTab('active-workout')}
            onSelectTab={(tab) => setActiveTab(tab)}
            onQuickAskAI={handleQuickAskAI}
          />
        )}

        {activeTab === 'active-workout' && (
          activeWorkout ? (
            <ActiveWorkout
              db={db}
              activeWorkout={activeWorkout}
              onUpdateWorkout={setActiveWorkout}
              onFinishWorkout={handleFinishWorkout}
              onCancelWorkout={handleCancelWorkout}
              onStartRestTimer={(secs) => setRestTimerSeconds(secs)}
              onNewPR={(exerciseName, weight, reps) => setActivePRCelebration({ exerciseName, weight, reps })}
            />
          ) : (
            <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center max-w-lg mx-auto space-y-4 shadow-sm my-8">
              <div className="h-14 w-14 bg-teal-50 text-teal-700 border border-teal-200 rounded-2xl flex items-center justify-center mx-auto text-2xl">
                🏋️‍♂️
              </div>
              <h2 className="text-xl font-bold text-slate-900">No Active Workout Session</h2>
              <p className="text-xs text-slate-500">
                Ask your AI Coach to start a workout or choose a template routine.
              </p>
              <div className="flex justify-center gap-3 pt-2">
                <button
                  onClick={() => setActiveTab('ai-coach')}
                  className="px-4 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs uppercase tracking-wider shadow-xs transition-all"
                >
                  Ask AI Coach
                </button>
                <button
                  onClick={handleStartBlankWorkout}
                  className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200 font-semibold text-xs uppercase tracking-wider transition-all"
                >
                  Start Blank Workout
                </button>
              </div>
            </div>
          )
        )}

        {activeTab === 'history' && (
          <WorkoutHistory
            db={db}
            onDeleteWorkout={handleDeleteWorkout}
            onRepeatWorkout={handleRepeatWorkout}
          />
        )}

        {activeTab === 'exercises' && (
          <ExerciseLibrary
            db={db}
            onSaveExercise={handleSaveExercise}
            onAskAICoachAboutExercise={handleQuickAskAI}
          />
        )}

        {activeTab === 'analytics' && (
          <Analytics db={db} />
        )}
      </main>

      {/* Floating Rest Timer Modal */}
      {restTimerSeconds !== null && (
        <RestTimerModal
          initialSeconds={restTimerSeconds}
          onClose={() => setRestTimerSeconds(null)}
        />
      )}

      {/* Personal Record Celebration Confetti Modal */}
      {activePRCelebration && (
        <PRCelebrationModal
          exerciseName={activePRCelebration.exerciseName}
          weight={activePRCelebration.weight}
          reps={activePRCelebration.reps}
          unit={db.profile.preferredUnit}
          onClose={() => setActivePRCelebration(null)}
        />
      )}

    </div>
  );
}
