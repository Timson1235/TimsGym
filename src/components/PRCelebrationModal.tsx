import { useEffect } from 'react';
import confetti from 'canvas-confetti';
import { Trophy } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { Dialog } from './Dialog';

interface PRCelebrationModalProps {
  isOpen: boolean;
  exerciseName: string;
  weight: number;
  reps: number;
  unit: string;
  onClose: () => void;
}

export function PRCelebrationModal({ isOpen, exerciseName, weight, reps, unit, onClose }: PRCelebrationModalProps) {
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (!isOpen || reduceMotion) return;
    confetti({ particleCount: 60, spread: 60, origin: { y: 0.6 }, disableForReducedMotion: true });
    return () => { confetti.reset(); };
  }, [isOpen, reduceMotion]);

  return (
    <Dialog isOpen={isOpen} title="New personal record" onClose={onClose}>
      <div className="space-y-5 text-center">
        <Trophy className="mx-auto h-12 w-12 text-amber-600" />
        <h3 className="text-xl font-semibold">{exerciseName}</h3>
        <p className="text-3xl font-semibold tabular-nums">{weight} <span className="text-base font-normal">{unit}</span> &times; {reps} <span className="text-base font-normal">reps</span></p>
        <button onClick={onClose} className="app-primary w-full rounded-lg px-4 font-semibold">Continue workout</button>
      </div>
    </Dialog>
  );
}
