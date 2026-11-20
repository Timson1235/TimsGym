import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryForResponse, reconcileRetryHistory } from '../src/lib/chatRetry';
import type { AIChatMessage } from '../src/types';

test('only unsuccessful or interrupted turns offer a retry', () => {
  assert.equal(retryForResponse('Log this', { status: 'completed' }), undefined);
  assert.equal(retryForResponse('Log this', {}), undefined);
  assert.deepEqual(retryForResponse('Check my history', { status: 'interrupted', retrySafe: true }),
    { text: 'Check my history', needsReview: false });
});

const question: AIChatMessage = { id: 'local-user', role: 'user', content: 'Check my training', timestamp: '12:00' };
const failure: AIChatMessage = { id: 'local-error', role: 'assistant', content: 'Connection failed', timestamp: '12:00',
  retry: { text: question.content, needsReview: true } };

test('history refresh retains unresolved local failures without duplicating the question', () => {
  assert.deepEqual(reconcileRetryHistory([], [question, failure]), [question, failure]);
  assert.deepEqual(reconcileRetryHistory([{ ...question, id: 'server-user' }], [question, failure]),
    [{ ...question, id: 'server-user' }, failure]);
  const saved = { ...failure, id: 'server-error', retry: undefined };
  assert.deepEqual(reconcileRetryHistory([question, saved], [question, failure])[1].retry, failure.retry);
});

test('a completed server response or newer turn supersedes the local retry control', () => {
  const completed = { ...failure, id: 'server-answer', content: 'Completed', retry: undefined };
  assert.deepEqual(reconcileRetryHistory([question, completed], [question, failure]), [question, completed]);
  const newer = { ...question, id: 'newer', content: 'A different question' };
  assert.deepEqual(reconcileRetryHistory([question, newer], [question, failure]), [question, newer]);
});

test('unknown outcomes and mutation attempts require review before replay', () => {
  for (const response of [{ status: 'error' }, { status: 'interrupted', retrySafe: false },
    { trace: { terminationReason: 'round_limit' } }, { trace: { terminationReason: 'provider_error' } }]) {
    assert.deepEqual(retryForResponse('Log this', response), { text: 'Log this', needsReview: true });
  }
});
