import React, { useEffect } from 'react';
import confetti from 'canvas-confetti';
import { Trophy, Sparkles, X, Flame } from 'lucide-react';

interface PRCelebrationModalProps {
  exerciseName: string;
  weight: number;
  reps: number;
  unit: string;
  onClose: () => void;
}

export const PRCelebrationModal: React.FC<PRCelebrationModalProps> = ({
  exerciseName,
  weight,
  reps,
  unit,
  onClose,
}) => {
  useEffect(() => {
    // Trigger confetti
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 },
    });
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-slate-900 border-2 border-amber-500/50 rounded-3xl p-6 sm:p-8 max-w-sm w-full text-center space-y-5 shadow-2xl shadow-amber-500/20 relative overflow-hidden animate-scale-up">
        
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-slate-400 hover:text-white text-sm"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="h-16 w-16 bg-amber-500/20 border-2 border-amber-500/40 rounded-2xl flex items-center justify-center mx-auto text-amber-400 shadow-lg shadow-amber-500/30">
          <Trophy className="h-9 w-9 stroke-[2.5]" />
        </div>

        <div>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-bold uppercase tracking-wider mb-2">
            <Sparkles className="h-3.5 w-3.5" />
            New Personal Record!
          </span>
          <h3 className="text-xl font-black text-white">{exerciseName}</h3>
        </div>

        <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-4 space-y-1">
          <p className="text-xs text-slate-400 uppercase font-mono tracking-wider">Record Lifted</p>
          <p className="text-3xl font-black text-amber-300">
            {weight} <span className="text-sm font-normal text-slate-300">{unit}</span> × {reps} <span className="text-sm font-normal text-slate-300">reps</span>
          </p>
        </div>

        <p className="text-xs text-slate-400">
          Awesome work! Your progressive overload history and estimated 1RM have been updated in the database.
        </p>

        <button
          onClick={onClose}
          className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-sm shadow-lg shadow-amber-500/25 transition-all transform hover:scale-[1.02]"
        >
          Keep Crushing It! 💪
        </button>

      </div>
    </div>
  );
};
