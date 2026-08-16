import React, { useState } from 'react';
import { Dumbbell, Sparkles, Database, ShieldCheck, Trophy, ArrowRight, Loader2, Brain } from 'lucide-react';
import { signInWithPopup } from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase';

interface LoginScreenProps {
  onGuestContinue?: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onGuestContinue }) => {
  const [isSigningIn, setIsSigningIn] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleGoogleSignIn = async () => {
    setIsSigningIn(true);
    setErrorMsg(null);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (error: any) {
      console.error('Google Sign-in error:', error);
      if (error?.code !== 'auth/popup-closed-by-user') {
        setErrorMsg('Anmeldung fehlgeschlagen. Bitte versuche es erneut.');
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-8 sm:px-6 lg:px-8 font-sans selection:bg-teal-100 selection:text-slate-900">
      
      {/* Container Card */}
      <div className="w-full max-w-md bg-white border border-slate-200/80 rounded-3xl p-8 shadow-sm space-y-8">
        
        {/* Brand Header */}
        <div className="text-center space-y-3">
          <div className="w-16 h-16 bg-teal-700 rounded-2xl flex items-center justify-center text-white mx-auto shadow-md">
            <Dumbbell className="h-8 w-8 stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center justify-center gap-2">
              <h1 className="text-2xl font-black tracking-tight text-slate-900 uppercase italic">
                TimsGym
              </h1>
              <span className="text-[11px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-md bg-teal-50 text-teal-800 border border-teal-200">
                AI Coach
              </span>
            </div>
            <p className="text-xs text-slate-500 font-medium mt-1">
              Dein persönlicher KI-Fitness-Coach & Workout-Logger
            </p>
          </div>
        </div>

        {/* Feature Highlights for Multi-User */}
        <div className="space-y-3 bg-slate-50/80 p-4 rounded-2xl border border-slate-200/60">
          <div className="flex items-start gap-3">
            <div className="p-1.5 rounded-lg bg-teal-100 text-teal-800 flex-shrink-0 mt-0.5">
              <Database className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-xs font-bold text-slate-800">Eigener Cloud SQL Speicher</h2>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Jeder Nutzer erhält automatisch eine eigene, private Datenbank für Workouts, PRs und Notizen.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="p-1.5 rounded-lg bg-teal-100 text-teal-800 flex-shrink-0 mt-0.5">
              <Brain className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-xs font-bold text-slate-800">Gemini KI-Gedächtnis</h2>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Merkt sich deine Ziele (Muskelaufbau, Sprungkraft, Fettabbau) und steuert deine Progression.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="p-1.5 rounded-lg bg-teal-100 text-teal-800 flex-shrink-0 mt-0.5">
              <Trophy className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-xs font-bold text-slate-800">Automatische PR-Erkennung</h2>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Errechnet sofort dein 1RM und feiert neue Bestleistungen.
              </p>
            </div>
          </div>
        </div>

        {/* Error Alert if any */}
        {errorMsg && (
          <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl font-medium text-center">
            {errorMsg}
          </div>
        )}

        {/* Action Buttons */}
        <div className="space-y-3">
          <button
            id="google-signin-btn"
            onClick={handleGoogleSignIn}
            disabled={isSigningIn}
            className="w-full flex items-center justify-center gap-3 py-3.5 px-4 rounded-2xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-sm shadow-xs hover:shadow transition-all disabled:opacity-50"
          >
            {isSigningIn ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>Anmeldung wird verarbeitet...</span>
              </>
            ) : (
              <>
                <svg className="h-5 w-5" viewBox="0 0 24 24">
                  <path
                    fill="#ffffff"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#ffffff"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#ffffff"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#ffffff"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                <span>Mit Google anmelden</span>
              </>
            )}
          </button>

          {onGuestContinue && (
            <button
              onClick={onGuestContinue}
              className="w-full py-2.5 text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors"
            >
              Ohne Anmeldung als Gast fortfahren →
            </button>
          )}
        </div>

        {/* Security & Multi-User Note */}
        <div className="flex items-center justify-center gap-1.5 text-[11px] text-slate-400 font-medium text-center">
          <ShieldCheck className="h-3.5 w-3.5 text-teal-600 flex-shrink-0" />
          <span>Sichere Authentifizierung & getrennter Speicher je Google-Konto</span>
        </div>

      </div>

    </div>
  );
};
