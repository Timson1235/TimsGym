import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChatCache, cacheChatSessions, cacheChatHistory, selectCachedChat, removeCachedChat } from '../src/lib/chatCache';

const stored = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
} });
const message = (id: string) => ({ id, role: 'user' as const, content: `Message ${id}`, timestamp: '12:00' });
const session = (id: string) => ({ id, title: `Chat ${id}` });

test('account caches are isolated and retain selected chats and reply metadata', () => {
  cacheChatSessions('alice', [session('one')]);
  selectCachedChat('alice', 'one');
  cacheChatHistory('alice', 'one', [{ ...message('reply'), toolsUsed: ['log_set'] }]);
  assert.equal(readChatCache('alice').activeThreadId, 'one');
  assert.deepEqual(readChatCache('alice').histories.one[0].toolsUsed, ['log_set']);
  assert.deepEqual(readChatCache('bob').sessions, []);
  assert.deepEqual(readChatCache('bob').histories, {});
});

test('restores a saved conversation from browser storage after a page reload', () => {
  stored.set('timsgym:chat-cache:v1:reload', JSON.stringify({
    version: 1, updatedAt: Date.now(), sessions: [session('one')],
    activeThreadId: 'one', histories: { one: [message('saved')] },
  }));
  assert.equal(readChatCache('reload').histories.one[0].content, 'Message saved');
});

test('expired, malformed, and invalid storage safely starts empty', () => {
  for (const [owner, raw] of [
    ['broken', '{'],
    ['invalid', JSON.stringify({ version: 1, updatedAt: Date.now(), sessions: [null] })],
    ['expired', JSON.stringify({ version: 1, updatedAt: 1, sessions: [], activeThreadId: '', histories: {} })],
  ]) {
    stored.set(`timsgym:chat-cache:v1:${owner}`, raw);
    assert.deepEqual(readChatCache(owner).histories, {});
  }
});

test('delete and server reconciliation remove histories and selected IDs', () => {
  cacheChatSessions('delete', [session('one'), session('two')]);
  cacheChatHistory('delete', 'one', [message('one')]);
  selectCachedChat('delete', 'one');
  removeCachedChat('delete', 'one');
  assert.equal(readChatCache('delete').activeThreadId, '');
  assert.equal(readChatCache('delete').histories.one, undefined);
  cacheChatHistory('delete', 'two', [message('two')]);
  cacheChatSessions('delete', []);
  assert.deepEqual(readChatCache('delete').histories, {});
});

test('limits stored histories and message counts', () => {
  for (let i = 0; i < 25; i++) cacheChatHistory('bounded', `${i}`, Array.from({ length: 250 }, (_, j) => message(`${j}`)));
  const cache = readChatCache('bounded');
  assert.equal(Object.keys(cache.histories).length, 20);
  assert.equal(cache.histories['24'].length, 200);
  assert.equal(cache.histories['24'][0].id, '50');
});

test('blocked storage retains working in-memory caching', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Blocked'); } });
  try {
    cacheChatHistory('blocked', 'one', [message('offline')]);
    assert.equal(readChatCache('blocked').histories.one[0].id, 'offline');
  } finally { Object.defineProperty(globalThis, 'localStorage', descriptor); }
});
