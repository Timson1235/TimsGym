import { Dialog } from './Dialog';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  tone?: 'danger' | 'default';
}

export function ConfirmDialog({ isOpen, title, description, confirmLabel, onConfirm, onClose, tone = 'danger' }: ConfirmDialogProps) {
  return (
    <Dialog isOpen={isOpen} title={title} onClose={onClose} role="alertdialog">
      <p className="text-sm leading-6 text-slate-600">{description}</p>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button className="rounded-lg px-4 text-sm font-medium hover:bg-slate-100" onClick={onClose}>Cancel</button>
        <button className={`rounded-lg px-4 text-sm font-semibold ${tone === 'danger' ? 'bg-rose-700 text-white hover:bg-rose-800' : 'app-primary'}`} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Dialog>
  );
}
