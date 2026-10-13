import React, { useState, useEffect } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth } from './lib/firebase';
import { 
  DatabaseState, WorkoutSession, Exercise, UserProfile
} from './types';
import { 
  fetchDatabase, saveWorkoutApi, deleteWorkoutApi, saveExerciseApi, updateProfileApi 
} from './lib/api';
import { Navbar } from './components/Navbar';
import { AICoachMainView } from './components/AICoachMainView';
import { ActiveWorkout } from './components/ActiveWorkout';
import { WorkoutHistory } from './components/WorkoutHistory';
import { ExerciseLibrary } from './components/ExerciseLibrary';
import { Analytics } from './components/Analytics';
import { RestTimerModal } from './components/RestTimerModal';
import { PRCelebrationModal } from './components/PRCelebrationModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { LoginScreen } from './components/LoginScreen';
import { Loader2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

type AppTab = 'ai-coach' | 'active-workout' | 'history' | 'exercises' | 'analytics';

export default function App() {
  const [db, setDb] = useState<DatabaseState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [guestMode, setGuestMode] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<AppTab>('ai-coach');

  // Active Workout Session state
  const [activeWorkout, setActiveWorkout] = useState<WorkoutSession | null>(null);

  // Modals state
  const [aiInitialPrompt, setAiInitialPrompt] = useState<string>('');
  
  const [restTimerSeconds, setRestTimerSeconds] = useState<number | null>(null);
  const [activePRCelebration, setActivePRCelebration] = useState<{ exerciseName: string; weight: number; reps: number } | null>(null);
  const [isDiscardDialogOpen, setIsDiscardDialogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const reduceMotion = useReducedMotion();

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
        <Loader2 className="h-8 w-8 text-brand-700 animate-spin" />
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
        <Loader2 className="h-8 w-8 text-brand-700 animate-spin" />
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

  const handleFinishWorkout = async (completedSession: WorkoutSession) => {
    const updatedDb = await saveWorkoutApi(completedSession);
    setDb(updatedDb);
    setActiveWorkout(null);
    setActiveTab('history');
  };

  const handleCancelWorkout = () => {
    setIsDiscardDialogOpen(true);
  };

  const confirmCancelWorkout = () => {
    setActiveWorkout(null);
    setActiveTab('ai-coach');
    setIsDiscardDialogOpen(false);
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

  const contentTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, bounce: 0, duration: 0.3 };

  const content = activeTab === 'ai-coach' ? (
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
  ) : activeTab === 'active-workout' ? (
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
      <section className="mx-auto my-8 max-w-lg text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
          <span className="text-xl" aria-hidden="true">+</span>
        </div>
        <h2 className="mt-4 text-xl font-semibold text-slate-900">Ready when you are</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-600">Ask the coach to prepare a workout, or start a blank one and shape it as you go.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button onClick={() => setActiveTab('ai-coach')} className="min-h-10 rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white hover:bg-brand-800">Ask the coach</button>
          <button onClick={handleStartBlankWorkout} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50">Start a blank workout</button>
        </div>
      </section>
    )
  ) : activeTab === 'history' ? (
    <WorkoutHistory db={db} onDeleteWorkout={handleDeleteWorkout} onRepeatWorkout={handleRepeatWorkout} />
  ) : activeTab === 'exercises' ? (
    <ExerciseLibrary db={db} onSaveExercise={handleSaveExercise} onAskAICoachAboutExercise={handleQuickAskAI} />
  ) : (
    <Analytics db={db} />
  );

  return (
    <div className="min-h-screen text-slate-800 selection:bg-brand-100 selection:text-slate-900">
      
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
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* Main Content Area */}
      <main className="mx-auto max-w-7xl px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 md:pb-12 lg:px-8">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={activeTab}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={contentTransition}
          >
            {content}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Floating Rest Timer Modal */}
      <AnimatePresence>
      {restTimerSeconds !== null && (
        <RestTimerModal
          key="rest-timer"
          initialSeconds={restTimerSeconds}
          onClose={() => setRestTimerSeconds(null)}
        />
      )}
      </AnimatePresence>

      {/* Personal Record Celebration Confetti Modal */}
      <PRCelebrationModal
          isOpen={activePRCelebration !== null}
          exerciseName={activePRCelebration?.exerciseName || ''}
          weight={activePRCelebration?.weight || 0}
          reps={activePRCelebration?.reps || 0}
          unit={db.profile.preferredUnit}
          onClose={() => setActivePRCelebration(null)}
        />

      <SettingsDialog isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} db={db} onUpdateDatabase={setDb} />

      <ConfirmDialog
        isOpen={isDiscardDialogOpen}
        title="Discard this workout?"
        description="Your unfinished sets will be removed. Completed workouts in your history are not affected."
        confirmLabel="Discard workout"
        onConfirm={confirmCancelWorkout}
        onClose={() => setIsDiscardDialogOpen(false)}
      />

    </div>
  );
}
