// Synthetic browser fixture. Run on a separate port; never uses an account/API.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AICoachMainView } from '../src/components/AICoachMainView';
import { ActiveWorkout } from '../src/components/ActiveWorkout';
import { createGuestDatabase } from '../src/db/guest';
import { cacheChatSessions, cacheChatHistory, selectCachedChat } from '../src/lib/chatCache';
import type { WorkoutSession } from '../src/types';
import '../src/index.css';

const db = createGuestDatabase();
const sessions = [{ id: 'controls-test', title: 'Interaction test' }];
cacheChatSessions('guest', sessions);
cacheChatHistory('guest', 'controls-test', []);
selectCachedChat('guest', 'controls-test');
const pending = new Map<string, () => void>();
const attempts = new Map<string, number>();
const fixture = { requests: [] as string[], interrupts: 0 };
Object.assign(window, { interactionFixture: fixture });
window.fetch = async (input, init) => {
  const url = String(input);
  let body: unknown = {};
  if (url.endsWith('/usage')) body = null;
  if (url.endsWith('/sessions')) body = { sessions };
  if (url.includes('/history')) body = { messages: [] };
  if (url.endsWith('/interrupt')) {
    fixture.interrupts++;
    pending.get(decodeURIComponent(url.split('/').at(-2)!))?.();
    body = { interrupted: true };
  }
  if (url.endsWith('/chat') && init?.method === 'POST') {
    const request = JSON.parse(String(init.body));
    fixture.requests.push(request.message);
    const attempt = (attempts.get(request.message) || 0) + 1;
    attempts.set(request.message, attempt);
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      send({ type: 'ready', requestId: request.clientRequestId });
      if (request.message === 'fail' && attempt === 1) {
        send({ type: 'error', message: 'Synthetic connection failure' });
      } else {
        let interrupted = false;
        if (request.message === 'slow' && attempt === 1) {
          send({ type: 'delta', text: 'Checking your training history…' });
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 15000);
            pending.set(request.clientRequestId, () => { interrupted = true; clearTimeout(timer); resolve(); });
          });
          pending.delete(request.clientRequestId);
        }
        send({ type: 'final', result: { reply: interrupted ? 'Stopped. No changes were made.' : 'Your request is complete.',
          status: interrupted ? 'interrupted' : 'completed', retrySafe: true, actionsExecuted: [] } });
      }
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
};

const initial: WorkoutSession = { id: 'controls-workout', title: 'Full body', date: '2026-11-04',
  isCompleted: false, totalVolume: 0, durationMinutes: 0, exercises: db.exercises.slice(0, 3).map((exercise, index) => ({
    id: `exercise-${index}`, exerciseId: exercise.id, exerciseName: exercise.name, category: exercise.category,
    sets: [1, 2, 3].map((number) => ({ id: `set-${index}-${number}`, setNumber: number,
      type: 'working', weight: 40, reps: 8, completed: false,
      planned: { weight: 40, reps: 8, type: 'working', rir: 2 } })),
  })) };

function Fixture() {
  const [tab, setTab] = useState('chat');
  const [workout, setWorkout] = useState(initial);
  return <>
    <nav className="flex gap-2 border-b bg-white px-4 py-2">
      <button className="min-h-10 px-3" onClick={() => setTab('chat')}>Chat</button>
      <button className="min-h-10 px-3" onClick={() => setTab('workout')}>Active Workout</button>
    </nav>
    {tab === 'chat' ? <AICoachMainView db={db} activeWorkout={workout} onUpdateActiveWorkout={setWorkout}
      onUpdateDatabase={() => {}} onStartWorkoutSession={setWorkout} onSelectTab={() => {}} />
      : <main className="mx-auto max-w-5xl p-3"><ActiveWorkout db={db} activeWorkout={workout}
        onUpdateWorkout={setWorkout} onFinishWorkout={() => {}} onCancelWorkout={() => {}}
        onStartRestTimer={() => {}} onNewPR={() => {}} /></main>}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
