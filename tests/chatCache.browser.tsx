// Manual integration fixture: /tests/chatCache.browser.html (mock API, no real account data).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AICoachMainView } from '../src/components/AICoachMainView';
import { cacheChatSessions, cacheChatHistory, selectCachedChat } from '../src/lib/chatCache';
import { createGuestDatabase } from '../src/db/guest';
import '../src/index.css';

const sessions = [{ id: 'cache-test', title: 'Cache test' }, { id: 'second-test', title: 'Second chat' }];
const makeMessage = (content: string) => ({ id: content, role: 'assistant' as const, content, timestamp: '12:00' });
cacheChatSessions('guest', sessions);
cacheChatHistory('guest', 'cache-test', [makeMessage('Instant cached history')]);
cacheChatHistory('guest', 'second-test', [makeMessage('Second cached history')]);
selectCachedChat('guest', 'cache-test');
let offline = false;
let delayed = true;
const button = document.createElement('button');
button.textContent = 'Simulate offline';
button.onclick = () => { offline = !offline; button.textContent = offline ? 'Simulate online' : 'Simulate offline'; };
document.getElementById('controls')!.append(button);
const delayButton = document.createElement('button');
delayButton.textContent = 'Use fast responses';
delayButton.onclick = () => { delayed = false; delayButton.textContent = 'Fast responses enabled'; };
document.getElementById('controls')!.append(delayButton);
window.fetch = async (input, init) => {
  const url = String(input);
  const unavailable = offline;
  const wait = delayed && url.includes('/history') ? 10000 : 100;
  await new Promise((resolve) => setTimeout(resolve, wait));
  if (unavailable) throw new Error('Simulated offline');
  let body: unknown = {};
  if (url.endsWith('/usage')) body = null;
  if (url.includes('/sessions')) body = { sessions };
  if (url.includes('/history')) body = { messages: [{ ...makeMessage('Fresh server history'), createdAt: '2026-10-21T12:00:00Z' }] };
  if (url.endsWith('/chat') && init?.method === 'POST') body = { reply: 'New reply must survive the delayed refresh' };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
};

createRoot(document.getElementById('root')!).render(<React.StrictMode>
  <AICoachMainView db={createGuestDatabase()} activeWorkout={null}
    onUpdateActiveWorkout={() => {}} onUpdateDatabase={() => {}}
    onStartWorkoutSession={() => {}} onSelectTab={() => {}} />
</React.StrictMode>);
