import React, { useState, useEffect } from 'react';
import { Clock, Plus, Minus, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
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
  const reduceMotion = useReducedMotion();

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
    <motion.div
      className="app-timer fixed bottom-20 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-lime-300/25 bg-[#1c2b20] p-4 shadow-2xl md:bottom-6 sm:right-6"
      role="region"
      aria-label="Rest timer"
      initial={reduceMotion ? false : { opacity: 0, y: 28, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 28, scale: 0.96 }}
      transition={reduceMotion ? { duration: 0.1 } : { type: 'spring', bounce: 0, duration: 0.3 }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-lime-300 animate-spin-slow" />
          <span className="text-xs font-bold text-white">Rest Interval Timer</span>
        </div>
        <button
          onClick={onClose}
          className="app-icon-button text-slate-300 hover:text-white"
          aria-label="Close rest timer"
          title="Close rest timer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Countdown Timer Display */}
      <div className="text-center py-2">
        <div className="text-3xl font-black text-lime-300 font-mono">
          {formatSecs(secondsLeft)}
        </div>
        <p role="status" className="text-sm text-slate-300 mt-0.5">
          {secondsLeft === 0 ? "Rest complete! Time for next set 💪" : "Recovering for next set..."}
        </p>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden my-3">
        <div
          className="h-full origin-left bg-lime-300 transition-transform duration-1000 ease-linear"
          style={{ transform: `scaleX(${percentage / 100})` }}
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
          className="flex-1 rounded-lg bg-lime-300 py-1.5 text-xs font-black text-[#1c2b20] hover:bg-lime-200"
        >
          Skip
        </button>
      </div>
    </motion.div>
  );
};
