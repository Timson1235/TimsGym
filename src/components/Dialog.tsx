import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AnimatePresence, animate, motion, useDragControls, useMotionValue, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';

interface DialogProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  role?: 'dialog' | 'alertdialog';
  wide?: boolean;
}

function DialogSurface({ title, onClose, children, role = 'dialog', wide }: Omit<DialogProps, 'isOpen'>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const reduceMotion = useReducedMotion();
  const dragControls = useDragControls();
  const y = useMotionValue(0);
  const returnAnimation = useRef<ReturnType<typeof animate> | null>(null);
  const release = useRef({ dismiss: false, velocity: 0 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    // Native modal dialogs keep focus inside and make the background inert.
    dialog.showModal();
    return () => {
      returnAnimation.current?.stop();
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return (
    <motion.dialog
      ref={ref}
      className="app-dialog"
      role={role}
      aria-labelledby={titleId}
      aria-modal="true"
      initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
      animate={{ opacity: 1, backdropFilter: reduceMotion ? 'blur(0px)' : 'blur(6px)' }}
      exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
      transition={{ duration: reduceMotion ? 0.1 : 0.16 }}
      onCancel={(event) => { event.preventDefault(); closeRef.current(); }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
        )).filter((element) => element.getClientRects().length > 0);
        const first = targets[0];
        const last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClick={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}
    >
      <motion.section
        className={`app-dialog-panel ${wide ? 'app-dialog-wide' : ''}`}
        initial={reduceMotion ? false : { y: 32, scale: 0.98 }}
        animate={{ y: 0, scale: 1 }}
        variants={{ dismiss: () => reduceMotion ? { opacity: 0 } : {
          y: release.current.dismiss ? window.innerHeight : 32,
          scale: release.current.dismiss ? 1 : 0.98,
          transition: { type: 'spring', bounce: 0, duration: 0.3, velocity: release.current.velocity },
        } }}
        exit="dismiss"
        transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
          style={{ y }}
          drag={reduceMotion ? false : 'y'}
          dragListener={false}
          dragControls={dragControls}
          dragMomentum={false}
          onDrag={(_, info) => {
            if (info.offset.y < 0) {
              const distance = Math.abs(info.offset.y);
              y.set(-(distance * 300 * 0.55) / (300 + 0.55 * distance));
            }
          }}
          onDragEnd={(_, info) => {
            // Project release position so both a short flick and a long pull work.
            const projected = y.get() + (info.velocity.y / 1000) * 0.995 / (1 - 0.995);
            if (projected > 130 && info.velocity.y >= 0) {
              release.current = { dismiss: true, velocity: info.velocity.y };
              closeRef.current();
            }
            else returnAnimation.current = animate(y, 0, { type: 'spring', bounce: 0, velocity: info.velocity.y });
          }}
        >
          <div className="app-sheet-handle sm:hidden" aria-hidden="true" onPointerDown={(event) => {
            returnAnimation.current?.stop();
            dragControls.start(event);
          }}><span /></div>
          <header className="app-dialog-header">
            <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
            <button type="button" className="app-icon-button flex-none" aria-label={`Close ${title}`} title="Close" onClick={onClose} autoFocus><X className="h-5 w-5" /></button>
          </header>
          <div className="app-dialog-body">{children}</div>
      </motion.section>
    </motion.dialog>
  );
}

export function Dialog({ isOpen, ...props }: DialogProps) {
  return <AnimatePresence>{isOpen && <DialogSurface key="dialog" {...props} />}</AnimatePresence>;
}
