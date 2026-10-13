import { useState } from 'react';
import { Brain, Loader2, Plus, Trash2 } from 'lucide-react';
import { DatabaseState } from '../types';
import { addPersonalMemoryApi, removePersonalMemoryApi } from '../lib/api';
import { Dialog } from './Dialog';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  db: DatabaseState;
  onUpdateDatabase: (db: DatabaseState) => void;
}

export function SettingsDialog({ isOpen, onClose, db, onUpdateDatabase }: SettingsDialogProps) {
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const memories = db.profile.personalMemories || [];

  const saveMemory = async (text: string, remove = false) => {
    if (!text.trim() || pending) return;
    setPending(true);
    setError('');
    setStatus('');
    try {
      const updated = remove
        ? await removePersonalMemoryApi(db.profile, text)
        : await addPersonalMemoryApi(db.profile, text.trim());
      onUpdateDatabase(updated);
      if (!remove) setDraft('');
      setStatus(remove ? 'Memory removed.' : 'Memory saved.');
    } catch {
      setError('Could not save your changes. Please try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} title="Settings" onClose={onClose}>
      <section aria-labelledby="memory-heading" className="space-y-4">
        <div className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-green-800" />
          <h3 id="memory-heading" className="font-semibold">AI Memory</h3>
          <span className="ml-auto text-sm text-slate-500">{memories.length} saved</span>
        </div>
        <p className="text-sm leading-6 text-slate-600">Goals and preferences shared across your chats.</p>
        <ul className="divide-y divide-slate-200">
          {memories.map((memory, index) => (
            <li key={`${index}-${memory}`} className="flex items-start gap-3 py-3">
              <span className="min-w-0 flex-1 break-words text-sm leading-6">{memory}</span>
              <button className="app-icon-button flex-none text-slate-500 hover:bg-rose-50 hover:text-rose-700" title="Remove memory" aria-label={`Remove memory: ${memory}`} disabled={pending} onClick={() => saveMemory(memory, true)}><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
        {memories.length === 0 && <p className="text-sm text-slate-500">No memories saved yet.</p>}
        <form onSubmit={(event) => { event.preventDefault(); saveMemory(draft); }} className="space-y-2">
          <label htmlFor="new-memory" className="text-sm font-medium">New memory</label>
          <div className="flex gap-2">
            <input id="new-memory" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={pending} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2" placeholder="I prefer compound exercises" />
            <button type="submit" className="app-icon-button app-primary" disabled={pending || !draft.trim()} aria-label="Save memory" title="Save memory">{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-5 w-5" />}</button>
          </div>
        </form>
        <p role="status" className="text-sm text-green-800">{status}</p>
        {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
      </section>
    </Dialog>
  );
}
