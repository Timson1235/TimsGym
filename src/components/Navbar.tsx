import React from 'react';
import { Dumbbell, History, LineChart, Sparkles, Play, LogIn, LogOut, User as UserIcon } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { WorkoutSession } from '../types';
import { User, signInWithPopup, signOut } from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase';

type AppTab = 'ai-coach' | 'active-workout' | 'history' | 'exercises' | 'analytics';

interface NavbarProps {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  activeWorkout: WorkoutSession | null;
  preferredUnit: 'lbs' | 'kg';
  onToggleUnit: () => void;
  onOpenAICoach: () => void;
  user?: User | null;
}

const tabs: Array<{ id: AppTab; label: string; shortLabel: string; icon: typeof Sparkles }> = [
  { id: 'ai-coach', label: 'Coach', shortLabel: 'Coach', icon: Sparkles },
  { id: 'active-workout', label: 'Workout', shortLabel: 'Workout', icon: Play },
  { id: 'history', label: 'History', shortLabel: 'History', icon: History },
  { id: 'exercises', label: 'Exercises', shortLabel: 'Exercises', icon: Dumbbell },
  { id: 'analytics', label: 'Progress', shortLabel: 'Progress', icon: LineChart },
];

export const Navbar: React.FC<NavbarProps> = ({ activeTab, setActiveTab, activeWorkout, user }) => {
  const reduceMotion = useReducedMotion();

  const handleGoogleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (error) {
      console.error('Google Sign-In failed:', error);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Sign-Out failed:', error);
    }
  };

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/60 bg-white/78 text-slate-800 backdrop-blur-xl">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between gap-3">
          <button
            className="flex min-w-0 items-center gap-2.5 rounded-lg text-left"
            onClick={() => setActiveTab('ai-coach')}
            aria-label="Go to AI Coach"
          >
            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-teal-700 text-white shadow-sm">
              <Dumbbell className="h-5 w-5 stroke-[2.2]" />
            </span>
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold leading-4 text-slate-900">TimsGym</span>
              <span className="hidden text-xs leading-4 text-slate-500 sm:block">Your strength companion</span>
            </span>
          </button>

          <nav className="hidden items-center gap-1 rounded-lg bg-slate-100/70 p-1 md:flex" aria-label="Main navigation">
            {tabs.map(({ id, label, icon: Icon }) => {
              const selected = activeTab === id;
              const workoutTab = id === 'active-workout';
              return (
                <motion.button
                  key={id}
                  className={`relative flex min-h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium ${selected ? 'text-slate-900' : 'text-slate-600 hover:text-slate-900'}`}
                  onClick={() => setActiveTab(id)}
                  whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                >
                  {selected && (
                    <motion.span
                      layoutId="desktop-active-tab"
                      className="absolute inset-0 rounded-md bg-white shadow-sm"
                      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 34 }}
                    />
                  )}
                  <span className="relative flex items-center gap-1.5">
                    {workoutTab && activeWorkout ? <span className="h-2 w-2 rounded-full bg-teal-600" aria-label="Workout in progress" /> : <Icon className={`h-3.5 w-3.5 ${selected || id === 'ai-coach' ? 'text-teal-700' : 'text-slate-500'}`} />}
                    {activeWorkout && workoutTab ? 'In workout' : label}
                  </span>
                </motion.button>
              );
            })}
          </nav>

          <div className="flex flex-none items-center gap-1.5">
            {user ? (
              <>
                <div className="hidden items-center gap-2 rounded-lg px-2 py-1.5 sm:flex">
                  {user.photoURL ? (
                    <img src={user.photoURL} alt="" className="h-5 w-5 rounded-full" />
                  ) : (
                    <UserIcon className="h-4 w-4 text-slate-500" />
                  )}
                  <span className="max-w-32 truncate text-sm font-medium text-slate-700">{user.displayName || user.email}</span>
                </div>
                <button onClick={handleSignOut} title="Sign out" aria-label="Sign out" className="app-icon-button text-slate-500 hover:bg-slate-100 hover:text-rose-700">
                  <LogOut className="h-4 w-4" />
                </button>
              </>
            ) : (
              <button onClick={handleGoogleSignIn} className="flex min-h-10 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800">
                <LogIn className="h-4 w-4" />
                <span className="hidden sm:inline">Sign in</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/70 bg-white/92 px-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-xl md:hidden" aria-label="Main navigation">
        <div className="mx-auto flex max-w-lg items-stretch justify-around">
          {tabs.map(({ id, shortLabel, icon: Icon }) => {
            const selected = activeTab === id;
            const workoutTab = id === 'active-workout';
            return (
              <motion.button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`relative flex min-h-12 min-w-13 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-medium ${selected ? 'text-teal-800' : 'text-slate-500'}`}
                whileTap={reduceMotion ? undefined : { scale: 0.94 }}
              >
                {selected && <motion.span layoutId="mobile-active-tab" className="absolute inset-0 rounded-lg bg-teal-50" transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 34 }} />}
                <span className="relative">
                  {workoutTab && activeWorkout ? <span className="mt-1 block h-2.5 w-2.5 rounded-full bg-teal-700" /> : <Icon className="h-4 w-4" />}
                </span>
                <span className="relative">{activeWorkout && workoutTab ? 'Active' : shortLabel}</span>
              </motion.button>
            );
          })}
        </div>
      </nav>
    </header>
  );
};
