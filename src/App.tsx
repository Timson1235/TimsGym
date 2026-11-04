import React, { useState, useEffect } from 'react';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import { auth } from './lib/firebase';
import { 
  DatabaseState, WorkoutSession, Exercise, UserProfile
} from './types';
import { 
  fetchAppAccess, fetchDatabase, saveWorkoutApi, deleteWorkoutApi, saveExerciseApi, updateProfileApi
} from './lib/api';
import { Navbar } from './components/Navbar';
import { ExecutionTraces } from './components/ExecutionTraces';
import { AICoachMainView } from './components/AICoachMainView';
import { ProgressionReview } from './components/ProgressionReview';
import { repeatWithTargets } from './lib/trainingTargets';
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
  const [access, setAccess] = useState<{canUseApp:boolean;canInspectTraces:boolean}|null>(null);
  const [accessError, setAccessError] = useState('');
  const [activeTab, setActiveTab] = useState<AppTab>('ai-coach');

  // Active Workout Session state
  const [reviewWorkoutId, setReviewWorkoutId] = useState<string | null>(null);
  const [activeWorkout, setActiveWorkout] = useState<WorkoutSession | null>(null);

  const [workoutOwner, setWorkoutOwner] = useState<string | null>(null);
  const [draftError, setDraftError] = useState('');

  // Restore only this account's unfinished workout before enabling autosave.
  useEffect(() => {
    if (loading || !currentUser || !access?.canUseApp) return;
    const key = `timsgym:active-workout:${currentUser?.uid || 'guest'}`;
    if (workoutOwner === key) return;
    setWorkoutOwner(null);
    try {
      const saved = localStorage.getItem(key);
      const draft = saved ? JSON.parse(saved) : null;
      if (draft && (typeof draft.id !== 'string' || !Array.isArray(draft.exercises))) {
        throw new Error('Invalid saved workout');
      }
      setActiveWorkout(draft);
      if (draft) setActiveTab('active-workout');
      setDraftError('');
      setWorkoutOwner(key);
    } catch {
      setActiveWorkout(null);
      setDraftError('Could not restore your saved workout. Reload to try again.');
    }
  }, [loading, currentUser?.uid, access?.canUseApp]);

  useEffect(() => {
    const key = `timsgym:active-workout:${currentUser?.uid || 'guest'}`;
    if (loading || !currentUser || !access?.canUseApp || workoutOwner !== key) return;
    try {
      if (activeWorkout) localStorage.setItem(key, JSON.stringify(activeWorkout));
      else localStorage.removeItem(key);
      setDraftError('');
    } catch {
      setDraftError('Workout changes could not be saved on this device. Keep this page open.');
    }
  }, [activeWorkout, loading, currentUser?.uid, access?.canUseApp, workoutOwner]);

  // Modals state
  const [aiInitialPrompt, setAiInitialPrompt] = useState<string>('');
  
  const [restTimerSeconds, setRestTimerSeconds] = useState<number | null>(null);
  const [activePRCelebration, setActivePRCelebration] = useState<{ exerciseName: string; weight: number; reps: number } | null>(null);
  const [isDiscardDialogOpen, setIsDiscardDialogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  // Listen to Auth State Changes and Sync Database
  useEffect(() => {
    let revision = 0;
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      const request = ++revision;
      setCurrentUser(user);
      setDb(null);
      setAccess(null);
      setAccessError('');
      setActiveWorkout(null);
      setWorkoutOwner(null);
      setLoading(true);
      if (!user) { setLoading(false); return; }
      try {
        const permission = await fetchAppAccess();
        if (request !== revision) return;
        if (!permission.canUseApp) throw new Error('This app is currently private.');
        setAccess(permission);
        const data = await fetchDatabase();
        if (request !== revision) return;
        setDb(data);
      } catch (err) {
        if (request !== revision) return;
        setAccess(null);
        setAccessError((err as Error).message);
      } finally {
        if (request === revision) setLoading(false);
      }
    });
    return () => { revision++; unsubscribe(); };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col items-center justify-center space-y-3 font-sans">
        <Loader2 className="h-8 w-8 text-brand-700 animate-spin" />
        <p className="text-xs font-semibold text-slate-600">Lade TimsGym AI...</p>
      </div>
    );
  }

  if (!currentUser) return <LoginScreen />;

  if (!access?.canUseApp) {
    return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <section className="max-w-md rounded-2xl border bg-white p-6 text-center">
        <h1 className="text-xl font-semibold">Private access</h1>
        <p role="alert" className="my-4 text-sm text-slate-600">{accessError || 'This account does not have access.'}</p>
        <div className="flex justify-center gap-3">
          <button className="app-secondary rounded-lg px-4 py-2" onClick={() => window.location.reload()}>Retry</button>
          <button className="app-primary rounded-lg px-4 py-2" onClick={() => void signOut(auth)}>Sign out</button>
        </div>
      </section>
    </main>;
  }

  if (currentUser && new URLSearchParams(window.location.search).get('view') === 'traces') {
    return access.canInspectTraces ? <ExecutionTraces key={currentUser.uid} />
      : <main className="p-6"><p role="alert">Administrator access required.</p><a href="/">Back to app</a></main>;
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

    setActiveWorkout({ ...newSession, startTime: new Date().toISOString() });
    setActiveTab('active-workout');
  };

  const handleFinishWorkout = async (completedSession: WorkoutSession) => {
    const updatedDb = await saveWorkoutApi(completedSession);
    setDb(updatedDb);
    setActiveWorkout(null);
    setActiveTab('history');
    setReviewWorkoutId(completedSession.id);
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
    setActiveWorkout(repeatWithTargets(session));
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
      key={currentUser?.uid || 'guest'}
      db={db}
      activeWorkout={activeWorkout}
      onUpdateActiveWorkout={(updated) => setActiveWorkout((current) => current?.id === updated.id ? updated : current)}
      onUpdateDatabase={(updatedDb) => setDb(updatedDb)}
      onStartWorkoutSession={(session) => {
        setActiveWorkout({ ...session, startTime: new Date().toISOString() });
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
    <WorkoutHistory db={db} onDeleteWorkout={handleDeleteWorkout} onRepeatWorkout={handleRepeatWorkout} onReviewWorkout={setReviewWorkoutId} />
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
        user={currentUser} canInspectTraces={access.canInspectTraces}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {draftError && <p role="alert" className="px-4 py-2 text-sm text-amber-800 bg-amber-50">{draftError}</p>}

      {/* Main Content Area */}
      <main className={activeTab === 'ai-coach'
        ? "w-full px-0 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-0 md:pb-0"
        : "mx-auto max-w-7xl px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 md:pb-12 lg:px-8"}>
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

      {reviewWorkoutId && db.workouts.find((workout) => workout.id === reviewWorkoutId) && (
        <ProgressionReview workout={db.workouts.find((workout) => workout.id === reviewWorkoutId)!}
          onClose={() => setReviewWorkoutId(null)}
          onSave={async (workout) => { const updated = await saveWorkoutApi(workout); setDb(updated); }} />
      )}

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
