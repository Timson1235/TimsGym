import React, { useState, useEffect } from 'react';
import { Clock, Plus, Minus, X, Volume2 } from 'lucide-react';
import { playTimerBeep } from '../lib/utils';

interface RestTimerModalProps {
  initialSeconds: number;
  onClose: () => void;
}

export const RestTimerModal: React.FC<RestTimerModalProps> = ({
  initialSeconds,
  onClose,
}) => {
  const [secondsLeft, setSecondsLeft] = useState<number>(initialSeconds);
  const [totalSeconds, setTotalSeconds] = useState<number>(initialSeconds);

  useEffect(() => {
    if (secondsLeft <= 0) {
      playTimerBeep();
      return;
    }

    const timer = setInterval(() => {
      setSecondsLeft((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [secondsLeft]);

  const addTime = (secs: number) => {
    setSecondsLeft((prev) => Math.max(0, prev + secs));
    setTotalSeconds((prev) => Math.max(1, prev + secs));
  };

  const percentage = Math.max(0, Math.min(100, (secondsLeft / totalSeconds) * 100));

  const formatSecs = (total: number) => {
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed bottom-20 right-4 sm:bottom-6 sm:right-6 z-50 bg-slate-900 border border-emerald-500/50 rounded-2xl p-4 shadow-2xl w-80 animate-slide-up">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-emerald-400 animate-spin-slow" />
          <span className="text-xs font-bold text-white">Rest Interval Timer</span>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white p-1"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Countdown Timer Display */}
      <div className="text-center py-2">
        <div className="text-3xl font-black text-emerald-400 font-mono">
          {formatSecs(secondsLeft)}
        </div>
        <p className="text-[11px] text-slate-400 mt-0.5">
          {secondsLeft === 0 ? "Rest complete! Time for next set 💪" : "Recovering for next set..."}
        </p>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden my-3">
        <div
          className="bg-emerald-500 h-full transition-all duration-1000 ease-linear"
          style={{ width: `${percentage}%` }}
        ></div>
      </div>

      {/* Action Controls */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          onClick={() => addTime(-15)}
          className="flex-1 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-colors flex items-center justify-center gap-1"
        >
          <Minus className="h-3 w-3" /> 15s
        </button>

        <button
          onClick={() => addTime(15)}
          className="flex-1 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-colors flex items-center justify-center gap-1"
        >
          <Plus className="h-3 w-3" /> 15s
        </button>

        <button
          onClick={onClose}
          className="flex-1 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black transition-colors"
        >
          Skip
        </button>
      </div>
    </div>
  );
};
