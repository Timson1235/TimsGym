import React from 'react';
import { Dumbbell, History, LineChart, Sparkles, Play, LogIn, LogOut, Database, User as UserIcon } from 'lucide-react';
import { WorkoutSession } from '../types';
import { User, signInWithPopup, signOut } from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase';

interface NavbarProps {
  activeTab: 'ai-coach' | 'active-workout' | 'history' | 'exercises' | 'analytics';
  setActiveTab: (tab: 'ai-coach' | 'active-workout' | 'history' | 'exercises' | 'analytics') => void;
  activeWorkout: WorkoutSession | null;
  preferredUnit: 'lbs' | 'kg';
  onToggleUnit: () => void;
  onOpenAICoach: () => void;
  user?: User | null;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  activeWorkout,
  user,
}) => {
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
    <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-md border-b border-slate-200/80 text-slate-800 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          
          {/* Logo & Brand */}
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setActiveTab('ai-coach')}>
            <div className="w-9 h-9 bg-teal-700 rounded-xl flex items-center justify-center text-white shadow-xs">
              <Dumbbell className="h-5 w-5 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-black text-base tracking-tight text-slate-900 uppercase italic">TIMSGYM</span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200/80">
                  AI
                </span>
                <span className="hidden sm:inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200/80">
                  <Database className="h-3 w-3" />
                  Cloud SQL
                </span>
              </div>
              <p className="text-[10px] text-slate-500 uppercase tracking-[0.15em] leading-none hidden sm:block">AI Strength Assistant</p>
            </div>
          </div>

          {/* Desktop Navigation Tabs */}
          <nav className="hidden md:flex items-center space-x-1 bg-slate-100/80 p-1 rounded-xl border border-slate-200/80">
            <button
              onClick={() => setActiveTab('ai-coach')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all ${
                activeTab === 'ai-coach'
                  ? 'bg-white text-teal-800 shadow-xs font-bold border border-slate-200/80'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5 text-teal-600 stroke-[2]" />
              AI Coach
            </button>

            <button
              onClick={() => setActiveTab('active-workout')}
              className={`relative flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all ${
                activeTab === 'active-workout'
                  ? 'bg-white text-teal-800 shadow-xs font-bold border border-slate-200/80'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
              }`}
            >
              {activeWorkout ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-500 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-600"></span>
                  </span>
                  <span className="text-teal-700 font-bold italic">In Workout</span>
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5 text-slate-500" />
                  Workout
                </>
              )}
            </button>

            <button
              onClick={() => setActiveTab('history')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all ${
                activeTab === 'history'
                  ? 'bg-white text-slate-900 shadow-xs font-bold border border-slate-200/80'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
              }`}
            >
              <History className="h-3.5 w-3.5 text-slate-500" />
              Logs
            </button>

            <button
              onClick={() => setActiveTab('exercises')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all ${
                activeTab === 'exercises'
                  ? 'bg-white text-slate-900 shadow-xs font-bold border border-slate-200/80'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
              }`}
            >
              <Dumbbell className="h-3.5 w-3.5 text-slate-500" />
              Exercises
            </button>

            <button
              onClick={() => setActiveTab('analytics')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all ${
                activeTab === 'analytics'
                  ? 'bg-white text-slate-900 shadow-xs font-bold border border-slate-200/80'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
              }`}
            >
              <LineChart className="h-3.5 w-3.5 text-slate-500" />
              Analytics
            </button>
          </nav>

          {/* Right Action Controls */}
          <div className="flex items-center gap-2 sm:gap-3">
            {user ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 border border-slate-200 text-xs font-medium text-slate-700">
                  {user.photoURL ? (
                    <img src={user.photoURL} alt="Avatar" className="w-4 h-4 rounded-full" />
                  ) : (
                    <UserIcon className="w-3.5 h-3.5 text-slate-500" />
                  )}
                  <span className="hidden sm:inline font-semibold">{user.displayName || user.email}</span>
                </div>
                <button
                  onClick={handleSignOut}
                  title="Sign Out"
                  className="p-1.5 text-slate-500 hover:text-red-600 rounded-lg hover:bg-slate-100 transition-colors"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={handleGoogleSignIn}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs uppercase tracking-wider shadow-xs transition-all"
              >
                <LogIn className="h-3.5 w-3.5" />
                <span>Sign In</span>
              </button>
            )}

            {/* AI Direct Chat Trigger */}
            <button
              onClick={() => setActiveTab('ai-coach')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs uppercase tracking-wider shadow-xs transition-all"
            >
              <Sparkles className="h-3.5 w-3.5 fill-white" />
              <span className="hidden sm:inline">AI Hub</span>
              <span className="sm:hidden">AI</span>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Bottom Tab Navigation */}
      <div className="md:hidden border-t border-slate-200 bg-white/95 backdrop-blur-md fixed bottom-0 left-0 right-0 z-40 px-2 py-2">
        <div className="flex justify-around items-center">
          <button
            onClick={() => setActiveTab('ai-coach')}
            className={`flex flex-col items-center gap-1 p-1.5 text-[10px] uppercase font-bold tracking-wider rounded-lg transition-colors ${
              activeTab === 'ai-coach' ? 'text-teal-700' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Sparkles className="h-5 w-5" />
            <span>AI Coach</span>
          </button>

          <button
            onClick={() => setActiveTab('active-workout')}
            className={`flex flex-col items-center gap-1 p-1.5 text-[10px] uppercase font-bold tracking-wider rounded-lg transition-colors relative ${
              activeTab === 'active-workout' ? 'text-teal-700' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {activeWorkout && (
              <span className="absolute top-1 right-2 flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-500 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-600"></span>
              </span>
            )}
            <Play className="h-5 w-5" />
            <span>Workout</span>
          </button>

          <button
            onClick={() => setActiveTab('history')}
            className={`flex flex-col items-center gap-1 p-1.5 text-[10px] uppercase font-bold tracking-wider rounded-lg transition-colors ${
              activeTab === 'history' ? 'text-teal-700' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <History className="h-5 w-5" />
            <span>Logs</span>
          </button>

          <button
            onClick={() => setActiveTab('exercises')}
            className={`flex flex-col items-center gap-1 p-1.5 text-[10px] uppercase font-bold tracking-wider rounded-lg transition-colors ${
              activeTab === 'exercises' ? 'text-teal-700' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Dumbbell className="h-5 w-5" />
            <span>PRs</span>
          </button>

          <button
            onClick={() => setActiveTab('analytics')}
            className={`flex flex-col items-center gap-1 p-1.5 text-[10px] uppercase font-bold tracking-wider rounded-lg transition-colors ${
              activeTab === 'analytics' ? 'text-teal-700' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <LineChart className="h-5 w-5" />
            <span>Analytics</span>
          </button>
        </div>
      </div>
    </header>
  );
};
