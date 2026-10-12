import { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  tone?: 'danger' | 'default';
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
  tone = 'danger',
}: ConfirmDialogProps) {
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const transition = reduceMotion ? { duration: 0 } : { type: 'spring' as const, stiffness: 420, damping: 32 };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/30 p-4 backdrop-blur-sm sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
          role="presentation"
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-description"
            className="w-full max-w-md app-surface p-5 shadow-2xl"
            initial={reduceMotion ? false : { opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.99 }}
            transition={transition}
          >
            <div className="flex items-start gap-3">
              <div className={`flex h-10 w-10 flex-none items-center justify-center rounded-lg ${tone === 'danger' ? 'bg-rose-50 text-rose-700' : 'bg-teal-50 text-teal-700'}`}>
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="confirm-dialog-title" className="text-base font-semibold text-slate-900">{title}</h2>
                <p id="confirm-dialog-description" className="mt-1 text-sm leading-5 text-slate-600">{description}</p>
              </div>
              <button className="app-icon-button -mr-2 -mt-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose} aria-label="Close confirmation">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button className="min-h-10 rounded-lg px-4 text-sm font-medium text-slate-700 hover:bg-slate-100" onClick={onClose}>
                Keep it
              </button>
              <button
                className={`min-h-10 rounded-lg px-4 text-sm font-semibold text-white ${tone === 'danger' ? 'bg-rose-700 hover:bg-rose-800' : 'bg-teal-700 hover:bg-teal-800'}`}
                onClick={onConfirm}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
